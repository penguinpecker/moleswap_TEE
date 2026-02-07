# MoleSwap v3 - iExec TEE Integration

Privacy-preserving DEX using Uniswap V4 hooks + iExec TEE (Intel SGX).

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│   Frontend  │────▶│   Contract   │────▶│   Oracle      │
│  (Browser)  │     │ (Arb Sepolia)│     │  (Node.js)    │
└─────────────┘     └──────────────┘     └───────┬───────┘
                                                 │
                                                 ▼
                                    ┌───────────────────────┐
                                    │     iExec TEE         │
                                    │   (SGX Enclave)       │
                                    │                       │
                                    │ • Match intents       │
                                    │ • Generate stealth    │
                                    │ • Encrypt keys        │
                                    │ • Sign batch          │
                                    └───────────────────────┘
```

## Deployed Addresses

| Component | Address |
|-----------|---------|
| Hook Contract | `0x5212f997E33dF21a517eC276Dd1855607C063E97` |
| iExec iApp | `0xF8A3bB4BBCcFC0f810196117Fc779a8587a9899F` |
| MOLE-A Token | `0xCc777c07d5ecCfFEB8C02E62805bd120CE4C7c6E` |
| MOLE-B Token | `0xFbd51f6D6005f767AF48Bd6D52eFD53Fa419aFB1` |
| Oracle | `0xffD9E66c997391b01E5ca3f36E13ab3e786a8c42` |

## Quick Start

### 1. Install dependencies

```bash
cd oracle
npm install

cd ../tee-app
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your values
```

### 3. Get iExec RLC tokens

The oracle needs RLC tokens to pay for TEE execution:
- Go to https://faucet.iex.ec/bellecour
- Enter your oracle wallet address
- Get testnet RLC

### 4. Start the Oracle

**Real iExec TEE mode (production):**
```bash
cd oracle
npm run start:iexec
```

**Local TEE simulation (testing):**
```bash
cd oracle
npm run start:local
```

### 5. Start the Frontend

```bash
cd frontend
python3 -m http.server 8080
# Open http://localhost:8080/moleswap.html
```

## How It Works

1. **User submits swap intent** → Frontend encrypts with viewing key, submits to contract
2. **Oracle batches intents** → Every 30s, collects pending intents
3. **iExec TEE processes** → Intents sent to SGX enclave via iExec
4. **TEE matching** → Inside enclave:
   - Match buy/sell pairs internally
   - Route unmatched to AMM
   - Generate stealth keypairs
   - ECIES encrypt private keys with user's viewing key
   - Assign random delays (60-180s)
   - Sign entire batch
5. **Settlement** → Oracle submits TEE-signed batch to contract
6. **Delay pool** → Contract holds tokens, releases after delay
7. **User claims** → Decrypts stealth key with viewing key, imports wallet

## Privacy Guarantees

- **Input privacy**: Only hash stored on-chain, details in TEE
- **Output privacy**: Stealth addresses break transaction graph
- **Timing privacy**: Random delays (60-180s) prevent correlation
- **Key privacy**: Stealth keys generated in TEE, ECIES encrypted

## iExec Integration Points

| Component | iExec Feature |
|-----------|---------------|
| Oracle | `iexec.order.matchOrders()` - triggers TEE task |
| TEE App | `IEXEC_IN/OUT` - standard iExec app interface |
| Workerpool | `prod-v8-learn.main.pools.iexec.eth` - TEE workers |
| Tag | `0x...03` - requires TEE execution |

## Contract Functions

```solidity
// User submits intent
submitIntent(tokenIn, tokenOut, amountIn, viewingPubKey, deadline)

// Oracle submits TEE-signed batch
settleAndQueue(SettlementBatch)

// Anyone can execute ready releases
executeRelease(releaseId)
```

## Files

```
moleswap-v3-iexec/
├── oracle/
│   ├── src/index.js     # Oracle with iExec integration
│   └── package.json
├── tee-app/
│   ├── src/app.js       # TEE matching engine
│   ├── Dockerfile       # iExec-compatible container
│   └── package.json
├── contracts/
│   ├── src/MoleSwapHook.sol
│   └── script/Deploy.s.sol
├── frontend/
│   └── moleswap.html
└── .env
```

## License

MIT
