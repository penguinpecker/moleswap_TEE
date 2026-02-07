# iExec Tools Feedback

**Project:** MoleSwap - Privacy-Preserving DEX with Stealth Addresses  
**Hackathon:** iExec TEE Hackathon 2025  
**Developer:** @penguinpecker

---

## Overview

This document provides feedback on our experience building MoleSwap using iExec's TEE infrastructure. We used iExec to generate stealth wallet private keys inside SGX enclaves, ensuring keys never exist in plaintext outside protected memory.

---

## 🌟 What Worked Well

### 1. Confidential Computing Model
The iExec confidential computing model is exactly what we needed for generating sensitive cryptographic material. The guarantee that our stealth private keys exist only inside SGX enclave memory is the foundation of MoleSwap's privacy model.

### 2. SDK & Documentation
- The `iexec` CLI was straightforward to install and use
- Documentation for deploying TEE apps was clear
- Examples in the docs helped us understand the request/result flow

### 3. Arbitrum Sepolia Support
Having iExec available on Arbitrum Sepolia made integration seamless since our smart contracts were already deployed there. No bridging or cross-chain complexity required.

### 4. Result Encryption
The built-in result encryption feature was useful. We could have our TEE app output encrypted data that only the requester can decrypt, which aligns well with our stealth key delivery model.

### 5. Workerpool Availability
The TEE workerpool on Arbitrum Sepolia (`0xB967057a21dc6A66A29721d96b8Aa7454B7c383F`) was generally available when we needed it.

---

## 🔧 Areas for Improvement

### 1. Task Execution Time
**Issue:** TEE task execution often took 60-120 seconds, with occasional timeouts.

**Impact:** Users waiting for swaps see "Waiting for TEE..." for extended periods, which hurts UX.

**Suggestion:** 
- Faster worker spin-up times would significantly improve real-time applications
- A "fast lane" for simple computation tasks (< 1 second of actual compute)
- Better visibility into queue depth and estimated wait times

### 2. Task Reliability / Timeouts
**Issue:** Approximately 10-15% of our TEE tasks timed out during testing, requiring retries.

**Impact:** We had to build retry logic into our oracle, and users occasionally see failed transactions.

**Suggestion:**
- More reliable task completion guarantees
- Automatic retry mechanism at the protocol level
- Better error messages when tasks fail (currently just "status: 1")

### 3. Debugging TEE Apps
**Issue:** When our TEE app had bugs, debugging was challenging. Logs from inside the enclave were limited.

**Impact:** Development iteration was slow - deploy, wait 60s, see cryptic error, repeat.

**Suggestion:**
- A local TEE simulator for faster development cycles
- More detailed error logs from failed enclave executions
- A "debug mode" that runs the app outside TEE for testing logic

### 4. Cost Estimation
**Issue:** It was unclear how to estimate RLC costs before submitting tasks.

**Impact:** We had to experiment to find the right RLC stake amount.

**Suggestion:**
- A cost calculator in the docs or CLI
- `iexec task estimate` command to preview costs
- Clearer documentation on workerpool pricing

### 5. SDK Deprecation Warnings
**Issue:** We received deprecation warnings when using the SDK:
```
passing app as first argument is deprecated, please pass the options object containing app or appOwner instead
```

**Impact:** Minor - warnings clutter logs but don't break functionality.

**Suggestion:**
- Update SDK examples in documentation to use new syntax
- Provide migration guide for deprecated patterns

### 6. Real-time Task Status
**Issue:** Polling `/task/{taskId}` for status updates felt inefficient.

**Suggestion:**
- WebSocket support for real-time task status updates
- Webhook callbacks when task completes
- GraphQL subscriptions for task events

---

## 📊 Usage Statistics

During MoleSwap development:
- **Total TEE tasks executed:** ~50+
- **Success rate:** ~85-90%
- **Average execution time:** 60-90 seconds
- **RLC consumed:** ~3 RLC

---

## 💡 Feature Requests

### 1. Batch Task Submission
Submit multiple tasks in a single transaction to reduce gas costs when processing multiple intents.

### 2. Scheduled/Recurring Tasks
Built-in support for tasks that run on a schedule (e.g., "process pending intents every 30 seconds").

### 3. Task Chaining
Output of one TEE task automatically feeds into another, useful for multi-step confidential workflows.

### 4. Enclave-to-Enclave Communication
Secure channels between TEE apps for more complex confidential computing scenarios.

### 5. Faster Testnets
A dedicated "fast" testnet workerpool optimized for hackathon/development use cases where speed matters more than decentralization.

---

## 🎯 Summary

| Aspect | Rating | Notes |
|--------|--------|-------|
| **Documentation** | ⭐⭐⭐⭐ | Clear, good examples |
| **SDK/CLI** | ⭐⭐⭐⭐ | Works well, minor deprecation warnings |
| **Reliability** | ⭐⭐⭐ | Occasional timeouts |
| **Speed** | ⭐⭐⭐ | 60-120s is slow for real-time apps |
| **Debugging** | ⭐⭐ | Challenging to debug enclave issues |
| **Cost Transparency** | ⭐⭐⭐ | Could be clearer |

**Overall:** iExec provided the core functionality we needed - genuine confidential computing with SGX attestation. The main friction points were execution speed and occasional reliability issues, which are understandable for a testnet environment. For production, we'd want faster execution times to deliver a smooth user experience.

---

## 🙏 Acknowledgments

Thanks to the iExec team for building accessible TEE infrastructure. The ability to run confidential computations without managing our own SGX hardware was essential for this hackathon project.

---

*Feedback submitted as part of MoleSwap hackathon entry*  
*GitHub: https://github.com/penguinpecker/moleswap_TEE*
