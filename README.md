# 🐀 MoleSwap v3 — Private DEX with Delay Pool

**Swap privately. Receive anonymously. No frontrunning. No trail.**

MoleSwap combines Uniswap V4 hooks, iExec TEE (Intel SGX), and stealth addresses with a time-delayed release pool to create a privacy-preserving DEX on Arbitrum Sepolia.

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           USER FLOW                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. Generate viewing keypair (browser)                                      │
│  2. Submit intent with viewingPubKey → Contract                             │
│  3. Oracle batches intents → sends to TEE                                   │
│  4. TEE matches, generates stealth addresses, signs batch                   │
│  5. Contract settles swaps, queues releases in delay pool (60-180s)         │
│  6. Oracle executes releases at TEE-specified times                         │
│  7. User decrypts stealth key locally, sweeps funds                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 🔐 Trust Model

| Component | Trust Level | Can See | Cannot See |
|-----------|-------------|---------|------------|
| **Contract** | Trustless | Amounts, tokens | Stealth keys, timing decisions |
| **Oracle** | Untrusted relay | Events, batches | Stealth private keys, matching logic |
| **TEE** | Trust anchor | Everything inside enclave | N/A (generates all secrets) |
| **User** | Self-sovereign | Own stealth keys | Other users' keys |

## 📁 Project Structure

```
moleswap-v3/
├── contracts/
│   ├── src/
│   │   └── MoleSwapHook.sol      # Main contract with delay pool
│   ├── script/
│   │   └── Deploy.s.sol          # Deployment scripts
│   ├── foundry.toml
│   └── remappings.txt
│
├── tee-app/
│   ├── src/
│   │   └── app.js                # TEE matching engine
│   ├── package.json
│   └── Dockerfile
│
├── oracle/
│   ├── src/
│   │   └── index.js              # Oracle service
│   └── package.json
│
├── frontend/
│   └── moleswap.html             # Web interface (existing UI)
│
└── .env.example
```

## 🚀 Quick Start

### 1. Install Dependencies

```bash
# Install Foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Install Node.js dependencies
cd tee-app && npm install && cd ..
cd oracle && npm install && cd ..
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your private key
```

### 3. Deploy Contracts

```bash
cd contracts

# Install Solidity dependencies
forge install uniswap/v4-core --no-commit
forge install uniswap/v4-periphery --no-commit
forge install OpenZeppelin/openzeppelin-contracts --no-commit
forge install foundry-rs/forge-std --no-commit

# Deploy hook
source ../.env
forge script script/Deploy.s.sol:DeployMoleSwap \
  --rpc-url $RPC_URL \
  --broadcast \
  --via-ir \
  -vvv

# Deploy test tokens (if needed)
forge script script/Deploy.s.sol:DeployTokens \
  --rpc-url $RPC_URL \
  --broadcast

# Initialize pool (update .env with HOOK_ADDRESS, TOKEN0, TOKEN1 first)
forge script script/Deploy.s.sol:InitializePool \
  --rpc-url $RPC_URL \
  --broadcast
```

### 4. Start Oracle

```bash
cd oracle
npm start
```

### 5. Open Frontend

```bash
cd frontend
python3 -m http.server 8080
# Open http://localhost:8080/moleswap.html
```

## 🔒 Privacy Features

### Stealth Addresses
Every swap output is sent to a freshly generated address that cannot be linked to your identity.

### ECIES Encryption
Stealth private keys are encrypted with your viewing public key. Only you can decrypt them.

### Delay Pool (60-180s)
Tokens are held in the contract for 60-180 seconds before release. The TEE randomizes the exact timing, breaking timing correlation.

### Batch Settlement
Multiple intents are settled together, obscuring individual amounts.

## 📊 v3 Changes from v2

| Feature | v2 | v3 |
|---------|----|----|
| Intent submission | Hash + deadline only | Full intent with viewingPubKey |
| Stealth key delivery | Event after swap | Delayed release (60-180s) |
| Timing privacy | None | TEE-randomized delays |
| Settlement | Individual | Batched |
| TEE verification | Optional | Required (signature) |

## 🧪 Testing

### Local TEE Simulation

The oracle supports local TEE mode for testing without iExec infrastructure:

```bash
cd oracle
USE_LOCAL_TEE=true npm start
```

## 📜 License

MIT
