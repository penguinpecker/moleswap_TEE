# MoleSwap 🦔

**Privacy-Preserving DEX with iExec TEE + Uniswap v4 Hooks**

MoleSwap is a decentralized exchange that enables private token swaps using stealth addresses generated inside iExec's Trusted Execution Environment (TEE). Users can swap tokens without revealing their receiving address on-chain.

![MoleSwap Architecture](https://img.shields.io/badge/Chain-Arbitrum%20Sepolia-blue) ![TEE](https://img.shields.io/badge/TEE-iExec%20SGX-green) ![License](https://img.shields.io/badge/License-MIT-yellow)

## 🤔 Why MoleSwap?

### The Problem with Current "Private" DEXs

Most TEE-based DEXs today focus on protecting **trade parameters**:
- Slippage tolerance
- MEV protection (front-running, sandwich attacks)
- Order details before execution

While useful, **this isn't real privacy**. After the swap executes, anyone can see:
- ❌ Who sent the tokens
- ❌ Who received the tokens  
- ❌ The full transaction trail
- ❌ Your complete wallet history

Your financial activity remains **fully transparent** on-chain.

### MoleSwap: Actual Privacy

MoleSwap takes privacy **several steps further**:

| Feature | Other TEE DEXs | MoleSwap |
|---------|---------------|----------|
| MEV Protection | ✅ | ✅ |
| Hidden Slippage | ✅ | ✅ |
| **Hidden Recipient** | ❌ | ✅ |
| **Stealth Addresses** | ❌ | ✅ |
| **Unlinkable Outputs** | ❌ | ✅ |
| **Time-Delayed Release** | ❌ | ✅ |

**With MoleSwap:**
- ✅ Output tokens go to a **freshly generated stealth address**
- ✅ No on-chain link between your main wallet and received funds
- ✅ Stealth private keys generated **inside TEE** — never exposed
- ✅ Only you can decrypt and access your stealth wallet
- ✅ Time delay adds **temporal privacy** (harder to correlate)

### Real-World Impact

```
Traditional DEX:
  Alice (0xA1..) → Swap 1000 USDC → Alice (0xA1..) receives 0.5 ETH
  Result: Everyone knows Alice's balance and trading activity

MoleSwap:
  Alice (0xA1..) → Swap 1000 USDC → Stealth (0xF7..) receives 0.5 ETH
  Result: No public link between Alice and her received ETH
```

This is the difference between **hiding how you trade** vs **hiding that you traded at all**.

---

## 🔐 iExec TEE: The Heart of MoleSwap

### Why TEE is Critical

The entire privacy guarantee of MoleSwap depends on one thing: **stealth private keys must never be exposed**. 

If generated outside a TEE:
- Oracle operator could steal keys
- Memory dumps could leak keys
- Side-channel attacks could extract keys

With iExec TEE (Intel SGX):
- Keys generated in **hardware-encrypted memory**
- Not even the machine owner can access enclave data
- Cryptographic attestation proves code integrity

```
┌─────────────────────────────────────────────────────────────────┐
│                     iExec TEE (SGX Enclave)                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   PROTECTED MEMORY                        │  │
│  │                                                           │  │
│  │   🔐 Stealth Key Generation                               │  │
│  │   🔐 Private Key Encryption                               │  │
│  │   🔐 Batch Signing                                        │  │
│  │                                                           │  │
│  │   ⛔ Cannot be read by:                                   │  │
│  │      - Host operating system                              │  │
│  │      - Hypervisor                                         │  │
│  │      - Physical machine owner                             │  │
│  │      - Other processes                                    │  │
│  │                                                           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│                    Encrypted Output Only                         │
│            (encryptedStealthKey, signature)                      │
└─────────────────────────────────────────────────────────────────┘
```

### What Happens Inside the TEE

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        TEE EXECUTION FLOW                                │
└──────────────────────────────────────────────────────────────────────────┘

     INPUT (from Oracle)                    OUTPUT (to Blockchain)
            │                                        ▲
            ▼                                        │
┌──────────────────┐                    ┌──────────────────────┐
│  Intent Data     │                    │  Settlement Batch    │
│  ─────────────   │                    │  ─────────────────   │
│  • intentId      │                    │  • stealthAddress    │
│  • sender        │                    │  • amountOut         │
│  • tokenIn/Out   │                    │  • releaseTime       │
│  • amountIn      │                    │  • encryptedKey 🔐   │
│  • viewingPubKey │                    │  • teeSignature ✍️   │
└────────┬─────────┘                    └──────────▲───────────┘
         │                                         │
         │         ┌─────────────────────────────┐ │
         │         │      SGX ENCLAVE            │ │
         │         │  ┌───────────────────────┐  │ │
         └────────►│  │ 1. GENERATE STEALTH   │  │ │
                   │  │    WALLET             │  │ │
                   │  │    ┌─────────────┐    │  │ │
                   │  │    │ Random seed │    │  │ │
                   │  │    │     ↓       │    │  │ │
                   │  │    │ privateKey  │────┼──┼─┼──► NEVER LEAVES
                   │  │    │ publicKey   │    │  │ │
                   │  │    │     ↓       │    │  │ │
                   │  │    │ stealthAddr │────┼──┼─┼──► Goes to blockchain
                   │  │    └─────────────┘    │  │ │
                   │  └───────────────────────┘  │ │
                   │                             │ │
                   │  ┌───────────────────────┐  │ │
                   │  │ 2. ENCRYPT PRIVATE    │  │ │
                   │  │    KEY                │  │ │
                   │  │    ┌─────────────┐    │  │ │
                   │  │    │ privateKey  │    │  │ │
                   │  │    │     +       │    │  │ │
                   │  │    │ viewingKey  │    │  │ │
                   │  │    │     ↓       │    │  │ │
                   │  │    │ ECIES enc.  │────┼──┼─┼──► encryptedStealthKey
                   │  │    └─────────────┘    │  │ │    (only user can decrypt)
                   │  └───────────────────────┘  │ │
                   │                             │ │
                   │  ┌───────────────────────┐  │ │
                   │  │ 3. SIGN BATCH         │  │ │
                   │  │    ┌─────────────┐    │  │ │
                   │  │    │ batchHash   │    │  │ │
                   │  │    │     +       │    │  │ │
                   │  │    │ TEE privKey │    │  │ │
                   │  │    │     ↓       │    │  │ │
                   │  │    │ signature   │────┼──┼─┼──► teeSignature
                   │  │    └─────────────┘    │  │ │    (proves TEE executed)
                   │  └───────────────────────┘  │ │
                   │                             │ │
                   └─────────────────────────────┘ │
                                                   │
                                    ───────────────┘
```

### TEE Security Guarantees

| Guarantee | How TEE Provides It |
|-----------|---------------------|
| **Confidentiality** | Private keys exist only in encrypted enclave memory |
| **Integrity** | Code hash verified before execution (attestation) |
| **Authenticity** | TEE signature proves batch came from valid enclave |
| **Isolation** | Even root/kernel cannot access enclave memory |

### Key Generation Inside TEE

```javascript
// This code runs INSIDE the iExec SGX enclave
// tee-app/src/app.js

const generateStealthWallet = (viewingPubKey) => {
  // 1. Generate random wallet (entropy from SGX hardware RNG)
  const stealthWallet = ethers.Wallet.createRandom();
  
  // 2. Encrypt private key with user's viewing public key
  //    Only the user can decrypt this with their viewing private key
  const encryptedKey = eciesEncrypt(
    viewingPubKey,           // User's public key
    stealthWallet.privateKey // Stealth private key (NEVER exposed raw)
  );
  
  // 3. Return only public data + encrypted key
  return {
    stealthAddress: stealthWallet.address,  // Public: goes on-chain
    encryptedStealthKey: encryptedKey       // Encrypted: only user can decrypt
    // privateKey: NEVER RETURNED - exists only in enclave memory
  };
};
```

### Attestation: Proving TEE Execution

iExec provides cryptographic proof that our code ran inside a genuine SGX enclave:

```
┌─────────────────────────────────────────────────────────────┐
│                    ATTESTATION FLOW                         │
└─────────────────────────────────────────────────────────────┘

  1. TEE App deployed to iExec
         │
         ▼
  2. iExec verifies app hash matches registered code
         │
         ▼
  3. SGX enclave initialized with app code
         │
         ▼
  4. Intel SGX generates attestation report
     ┌─────────────────────────────────────┐
     │  Attestation Report                 │
     │  ─────────────────────              │
     │  • MRENCLAVE (code hash)            │
     │  • MRSIGNER (developer identity)    │
     │  • Platform info                    │
     │  • Intel signature                  │
     └─────────────────────────────────────┘
         │
         ▼
  5. Smart contract verifies TEE signature
     - If valid: Settlement accepted ✅
     - If invalid: Transaction reverts ❌
```

### Why iExec for This Hackathon

| iExec Feature | How MoleSwap Uses It |
|---------------|----------------------|
| **Confidential Computing** | Stealth key generation in protected memory |
| **Decentralized Workers** | Oracle doesn't need to trust single node |
| **On-chain Verification** | TEE signature verified by smart contract |
| **DataProtector** | Could extend to protect viewing keys |
| **Result Encryption** | Encrypted keys delivered securely |

---

## 🎯 Features

- **Privacy-First Swaps**: Output tokens sent to freshly generated stealth addresses
- **TEE-Protected Key Generation**: Stealth keys generated inside iExec SGX enclaves
- **Time-Delayed Releases**: Configurable 60-180s delay adds temporal privacy
- **Encrypted Key Recovery**: Only the recipient can decrypt their stealth wallet private key
- **Uniswap v4 Integration**: Swaps executed through Uniswap v4 hooks for best pricing
- **Intent-Based Architecture**: Submit intents, let the oracle handle execution

## 🏗️ Architecture

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│                 │      │                 │      │                 │
│    Frontend     │─────▶│  MoleSwap Hook  │◀─────│     Oracle      │
│   (Vercel)      │      │  (Uniswap v4)   │      │   (Railway)     │
│                 │      │                 │      │                 │
└─────────────────┘      └─────────────────┘      └────────┬────────┘
                                                           │
                                                           ▼
                                                  ┌─────────────────┐
                                                  │                 │
                                                  │   iExec TEE     │
                                                  │  (SGX Enclave)  │
                                                  │                 │
                                                  └─────────────────┘
```

### Flow

1. **User submits intent** on-chain with viewing public key
2. **Oracle picks up intent** and sends to iExec TEE
3. **TEE generates stealth address** + encrypts private key with user's viewing key
4. **Oracle settles batch** on MoleSwap Hook contract
5. **Uniswap v4 swap executes**, tokens held in contract
6. **After time delay**, tokens released to stealth address
7. **User decrypts** stealth wallet private key and claims funds

## 📁 Project Structure

```
moleswap-v3/
├── contracts/           # Solidity smart contracts
│   ├── src/
│   │   └── MoleSwapHook.sol    # Uniswap v4 hook + settlement logic
│   └── script/
│       └── Deploy.s.sol        # Deployment scripts
├── oracle/              # Node.js oracle service
│   ├── src/
│   │   └── index.js            # Oracle main entry point
│   └── package.json
├── tee-app/             # iExec TEE application
│   ├── src/
│   │   └── app.js              # TEE stealth address generator
│   └── iexec.json
├── frontend/            # Web interface
│   └── index.html              # Single-page application
└── README.md
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Foundry (for contracts)
- MetaMask wallet
- Arbitrum Sepolia ETH (for gas)

### 1. Clone Repository

```bash
git clone https://github.com/penguinpecker/moleswap_TEE.git
cd moleswap_TEE
```

### 2. Deploy Contracts (Optional - Already Deployed)

```bash
cd contracts
forge install
cp .env.example .env
# Add PRIVATE_KEY and RPC_URL to .env

forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
```

### 3. Setup Oracle

```bash
cd oracle
npm install
cp .env.example .env
```

Edit `.env`:
```env
PRIVATE_KEY=your_private_key_here
RPC_URL=https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY
HTTP_PORT=3001
```

Run locally:
```bash
node src/index.js
```

### 4. Deploy TEE App to iExec (Optional - Already Deployed)

```bash
cd tee-app
npm install -g iexec

iexec init --skip-wallet
iexec wallet import your_private_key
iexec app deploy --chain arbitrum-sepolia
iexec app publish --chain arbitrum-sepolia
```

### 5. Run Frontend Locally

```bash
cd frontend
# Simply open index.html in a browser, or use a local server:
npx serve .
```

## ☁️ Deployment

### Oracle → Railway

1. Push code to GitHub
2. Connect Railway to your repo
3. Set **Root Directory**: (leave empty, uses nixpacks.toml)
4. Add environment variables:
   - `PRIVATE_KEY`: Oracle wallet private key
   - `RPC_URL`: Alchemy Arbitrum Sepolia URL
5. Deploy and get your URL (e.g., `https://your-app.up.railway.app`)
6. Generate domain in Settings → Networking (Port: 3001)

### Frontend → Vercel

1. Connect Vercel to your repo
2. Set **Root Directory**: `frontend`
3. Add environment variables (optional, hardcoded in HTML):
   - `NEXT_PUBLIC_ORACLE_URL`: Your Railway URL
4. Deploy

## 📋 Deployed Contracts (Arbitrum Sepolia)

| Contract | Address |
|----------|---------|
| MoleSwap Hook | `0xF2BE644D71936bD8544f3599edd8083De6831500` |
| MOLE-A Token | `0xCc777c07d5ecCfFEB8C02E62805bd120CE4C7c6E` |
| MOLE-B Token | `0xFbd51f6D6005f767AF48Bd6D52eFD53Fa419aFB1` |
| iExec TEE App | `0x0EB32Cd94495c47102c95c08dEEA13F80DB20B4f` |

## 🔧 Configuration

### Oracle Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PRIVATE_KEY` | Oracle wallet private key | Yes |
| `RPC_URL` | Arbitrum Sepolia RPC (use Alchemy) | Yes |
| `HTTP_PORT` | Server port (default: 3001) | No |
| `BATCH_INTERVAL_MS` | Polling interval (default: 30000) | No |

### Frontend Configuration

Update `CONFIG` object in `index.html`:

```javascript
const CONFIG = {
  chainId: 421614,
  chainName: 'Arbitrum Sepolia',
  rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
  contracts: {
    moleSwapHook: '0xF2BE644D71936bD8544f3599edd8083De6831500',
    moleA: '0xCc777c07d5ecCfFEB8C02E62805bd120CE4C7c6E',
    moleB: '0xFbd51f6D6005f767AF48Bd6D52eFD53Fa419aFB1',
    oracleUrl: 'https://your-railway-url.up.railway.app',
  },
  iexecApp: '0x0EB32Cd94495c47102c95c08dEEA13F80DB20B4f',
};
```

## 📖 Usage Guide

### Getting Test Tokens

1. Connect wallet to the dApp
2. Click "Faucet" button
3. Receive 1000 MOLE-A and 1000 MOLE-B

### Making a Private Swap

1. Enable "Privacy Mode" toggle
2. Enter swap amount
3. Click "Swap"
4. Approve token spending (first time only)
5. Submit intent transaction
6. Wait for TEE processing (30-120s)
7. Wait for privacy delay (60-180s)
8. Tokens automatically sent to your stealth address
9. Check "Stealth Wallets" tab to view and claim

### Claiming from Stealth Wallet

1. Go to "Stealth Wallets" tab
2. Find your stealth wallet with balance
3. Click "Withdraw" to send tokens to your main wallet

## 🔐 Security Model

### What the TEE Protects

- **Stealth address generation**: Private keys created inside SGX enclave
- **Key encryption**: Only viewable by recipient's viewing key
- **No front-running**: Intent details hidden until settlement

### Trust Assumptions

- iExec TEE enclaves are secure (Intel SGX)
- Oracle is honest (can be decentralized in production)
- Uniswap v4 pool has sufficient liquidity

## 🛠️ Technical Details

### Intent Structure

```solidity
struct Intent {
    address sender;
    address tokenIn;
    address tokenOut;
    uint256 amountIn;
    bytes viewingPubKey;    // For encrypting stealth key
    uint256 deadline;
    uint256 submittedAt;
    bool settled;
}
```

### Settlement Batch

```solidity
struct SettlementBatch {
    InternalMatch[] internalMatches;  // P2P matches
    Settlement[] ammSettlements;       // Uniswap swaps
    Release[] releases;                // Time-delayed outputs
    bytes32 batchId;
    uint256 timestamp;
    bytes teeSignature;               // TEE attestation
}
```

### Release Structure

```solidity
struct Release {
    address token;
    address stealthAddress;
    uint256 amount;
    uint256 releaseTime;              // Unix timestamp
    bytes encryptedStealthKey;        // Encrypted with viewing key
    bytes32 intentId;
    bool executed;
}
```

## 🧪 Testing

### Run Contract Tests

```bash
cd contracts
forge test -vvv
```

### Test Oracle Locally

```bash
cd oracle
node src/index.js

# In another terminal:
curl http://localhost:3001/health
curl -X POST http://localhost:3001/faucet -H "Content-Type: application/json" -d '{"address":"0xYourAddress"}'
```

## 🌐 Live Demo

- **Frontend**: [https://moleswap-tee.vercel.app](https://moleswap-tee.vercel.app)
- **Oracle**: [https://moleswaptee-production.up.railway.app](https://moleswaptee-production.up.railway.app)
- **Health Check**: [https://moleswaptee-production.up.railway.app/health](https://moleswaptee-production.up.railway.app/health)

## 📚 API Reference

### Oracle Endpoints

#### `GET /health`
Returns oracle status.

```json
{
  "status": "ok",
  "oracle": "0xffD9E66c997391b01E5ca3f36E13ab3e786a8c42",
  "hook": "0xF2BE644D71936bD8544f3599edd8083De6831500"
}
```

#### `POST /faucet`
Request test tokens.

```bash
curl -X POST https://your-oracle.railway.app/faucet \
  -H "Content-Type: application/json" \
  -d '{"address": "0xYourWalletAddress"}'
```

#### `POST /submit`
Trigger intent processing.

```bash
curl -X POST https://your-oracle.railway.app/submit \
  -H "Content-Type: application/json" \
  -d '{"intentId": "0x..."}'
```

#### `GET /status/:intentId`
Check intent processing status.

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing`)
5. Open Pull Request

## 📄 License

MIT License - see [LICENSE](LICENSE) file.

## 🙏 Acknowledgments

- [iExec](https://iex.ec/) - TEE infrastructure
- [Uniswap](https://uniswap.org/) - v4 hooks framework
- [Arbitrum](https://arbitrum.io/) - L2 scaling

---

Built with 🦔 for the iExec Hackathon 2025
