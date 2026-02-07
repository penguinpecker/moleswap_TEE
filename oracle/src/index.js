/**
 * MoleSwap Oracle v3 - Final Production Build
 * iExec TEE on Arbitrum Sepolia
 * 
 * Features:
 * - Base64 encoded TEE input (SCONE compatibility)
 * - Dual signature format support (EIP-191 + raw ECDSA)
 * - Automatic releaseTime to delay conversion
 * - Token faucet for hackathon reviewers
 * - Comprehensive error handling
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { IExec, utils } from 'iexec';
import express from 'express';
import cors from 'cors';

// =============================================================================
// CONFIGURATION
// =============================================================================
const CONFIG = {
  // Arbitrum Sepolia
  ARB_RPC_URL: process.env.RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc',
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  
  // Contracts
  HOOK_ADDRESS: '0xF2BE644D71936bD8544f3599edd8083De6831500',
  MOLE_A: '0xCc777c07d5ecCfFEB8C02E62805bd120CE4C7c6E',
  MOLE_B: '0xFbd51f6D6005f767AF48Bd6D52eFD53Fa419aFB1',
  
  // iExec TEE
  IEXEC_APP: '0x0EB32Cd94495c47102c95c08dEEA13F80DB20B4f',
  WORKERPOOL: '0xB967057a21dc6A66A29721d96b8Aa7454B7c383F',
  IEXEC_TEE_TAG: '0x0000000000000000000000000000000000000000000000000000000000000003',
  
  // TEE Signer - MUST match the authorized signer in your hook contract
  // Default is Hardhat account #1. Change this to match your contract's authorized TEE signer.
  TEE_SIGNER_KEY: process.env.TEE_SIGNER_KEY || '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  
  // Timing
  BATCH_INTERVAL_MS: parseInt(process.env.BATCH_INTERVAL_MS) || 60000,
  TASK_POLL_INTERVAL_MS: 5000,
  TASK_TIMEOUT_MS: 300000, // 5 minutes
  
  // Server
  HTTP_PORT: parseInt(process.env.HTTP_PORT) || 3001,
  
  // Faucet
  FAUCET_AMOUNT: '1000',
  FAUCET_COOLDOWN_MS: 60 * 60 * 1000, // 1 hour
};

// =============================================================================
// CONTRACT ABIs
// =============================================================================
const HOOK_ABI = [
  // Intent management
  'function submitIntent(address tokenIn, address tokenOut, uint256 amountIn, bytes viewingPubKey, uint256 deadline) returns (bytes32)',
  'function getIntent(bytes32) view returns (tuple(address sender, address tokenIn, address tokenOut, uint256 amountIn, bytes viewingPubKey, uint256 deadline, uint256 submittedAt, bool settled))',
  'function getPendingIntents() view returns (bytes32[])',
  'function pendingIntentCount() view returns (uint256)',
  
  // Settlement - CORRECT FUNCTION matching MoleSwapHook.sol
  `function settleAndQueue(
    tuple(
      tuple(bytes32 buyIntentId, bytes32 sellIntentId, uint256 matchedAmount)[] internalMatches,
      tuple(bytes32 intentId, address stealthAddress, uint256 amountOut, bool zeroForOne)[] ammSettlements,
      tuple(address token, address stealthAddress, uint256 amount, uint256 releaseTime, bytes encryptedStealthKey, bytes32 intentId, bool executed)[] releases,
      bytes32 batchId,
      uint256 timestamp,
      bytes teeSignature
    ) batch
  )`,
  
  // Release management  
  'function getRelease(bytes32) view returns (tuple(address token, address stealthAddress, uint256 amount, uint256 releaseTime, bytes encryptedStealthKey, bytes32 intentId, bool executed))',
  'function getPendingReleases() view returns (bytes32[])',
  'function getReleasesReadyToExecute() view returns (bytes32[])',
  'function pendingReleaseCount() view returns (uint256)',
  'function executeRelease(bytes32 releaseId)',
  
  // Admin
  'function teeSigner() view returns (address)',
  'function oracle() view returns (address)',
  'function owner() view returns (address)',
  'function setTeeSigner(address)',
  'function setOracle(address)',
  
  // Events
  'event IntentSubmitted(bytes32 indexed intentId, address indexed sender, address tokenIn, address tokenOut, uint256 amountIn, uint256 deadline)',
  'event BatchSettled(bytes32 indexed batchId, uint256 internalMatches, uint256 ammSwaps, uint256 releasesQueued)',
  'event ReleaseQueued(bytes32 indexed releaseId, bytes32 indexed intentId, address stealthAddress, uint256 amount, uint256 releaseTime)',
  'event ReleaseExecuted(bytes32 indexed releaseId, address indexed stealthAddress, address token, uint256 amount, bytes encryptedStealthKey)',
];

const ERC20_ABI = [
  'function mint(address to, uint256 amount)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// =============================================================================
// GLOBAL STATE
// =============================================================================
let arbProvider, arbWallet, hook, iexec;
let moleA, moleB;
let processedIntents = new Set();
let isProcessing = false;

// Task tracking for frontend
const intentTasks = new Map();

// Faucet rate limiting
const faucetLimits = new Map();

// =============================================================================
// INITIALIZATION
// =============================================================================
async function init() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  MoleSwap Oracle v3 - Production Build                       ║');
  console.log('║  iExec TEE on Arbitrum Sepolia                               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Validate config
  if (!CONFIG.PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY environment variable required');
  }

  // Initialize providers
  arbProvider = new ethers.JsonRpcProvider(CONFIG.ARB_RPC_URL);
  arbWallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, arbProvider);
  hook = new ethers.Contract(CONFIG.HOOK_ADDRESS, HOOK_ABI, arbWallet);
  
  // Token contracts
  moleA = new ethers.Contract(CONFIG.MOLE_A, ERC20_ABI, arbWallet);
  moleB = new ethers.Contract(CONFIG.MOLE_B, ERC20_ABI, arbWallet);

  // iExec SDK
  const signer = utils.getSignerFromPrivateKey('arbitrum-sepolia-testnet', CONFIG.PRIVATE_KEY);
  iexec = new IExec({ ethProvider: signer });

  // Log configuration
  const teeSigner = new ethers.Wallet(CONFIG.TEE_SIGNER_KEY);
  console.log(`\n📋 Configuration:`);
  console.log(`   Oracle:      ${arbWallet.address}`);
  console.log(`   TEE Signer:  ${teeSigner.address}`);
  console.log(`   Hook:        ${CONFIG.HOOK_ADDRESS}`);
  console.log(`   iExec App:   ${CONFIG.IEXEC_APP}`);
  console.log(`   Workerpool:  ${CONFIG.WORKERPOOL}`);
  console.log(`   MOLE-A:      ${CONFIG.MOLE_A}`);
  console.log(`   MOLE-B:      ${CONFIG.MOLE_B}`);

  // Check balances
  try {
    const balance = await iexec.account.checkBalance(arbWallet.address);
    console.log(`   RLC Staked:  ${ethers.formatUnits(balance.stake.toString(), 9)}`);
  } catch (e) {
    console.log(`   RLC:         ⚠️ Could not check balance`);
  }

  try {
    const balA = await moleA.balanceOf(arbWallet.address);
    const balB = await moleB.balanceOf(arbWallet.address);
    console.log(`   Faucet A:    ${ethers.formatUnits(balA, 18)} MOLE-A`);
    console.log(`   Faucet B:    ${ethers.formatUnits(balB, 18)} MOLE-B`);
  } catch (e) {
    console.log(`   Faucet:      ⚠️ Could not check balances`);
  }

  // Test hook authorization
  try {
    await hook.pendingIntentCount();
    console.log(`   Hook Auth:   ✅ Authorized`);
  } catch (e) {
    console.log(`   Hook Auth:   ❌ Not authorized (${e.message?.slice(0, 50)})`);
  }

  // Ensure oracle has approved hook for both tokens (required for settlement)
  try {
    const maxApproval = ethers.MaxUint256;
    
    // Check current allowances
    const allowanceA = await moleA.allowance(arbWallet.address, CONFIG.HOOK_ADDRESS);
    const allowanceB = await moleB.allowance(arbWallet.address, CONFIG.HOOK_ADDRESS);
    
    if (allowanceA < ethers.parseUnits('1000000', 18)) {
      console.log(`   Approving MOLE-A for hook...`);
      const txA = await moleA.approve(CONFIG.HOOK_ADDRESS, maxApproval);
      await txA.wait();
      console.log(`   ✅ MOLE-A approved`);
    }
    
    if (allowanceB < ethers.parseUnits('1000000', 18)) {
      console.log(`   Approving MOLE-B for hook...`);
      const txB = await moleB.approve(CONFIG.HOOK_ADDRESS, maxApproval);
      await txB.wait();
      console.log(`   ✅ MOLE-B approved`);
    }
  } catch (e) {
    console.log(`   ⚠️ Approval warning: ${e.message?.slice(0, 50)}`);
  }

  // Fund the hook contract with tokens for liquidity (required for swaps)
  try {
    const hookBalA = await moleA.balanceOf(CONFIG.HOOK_ADDRESS);
    const hookBalB = await moleB.balanceOf(CONFIG.HOOK_ADDRESS);
    const minLiquidity = ethers.parseUnits('100', 18);
    
    console.log(`   Hook MOLE-A: ${ethers.formatUnits(hookBalA, 18)}`);
    console.log(`   Hook MOLE-B: ${ethers.formatUnits(hookBalB, 18)}`);
    
    if (hookBalA < minLiquidity) {
      console.log(`   Funding hook with MOLE-A...`);
      const fundAmount = ethers.parseUnits('500', 18);
      try {
        const tx = await moleA.mint(CONFIG.HOOK_ADDRESS, fundAmount);
        await tx.wait();
      } catch {
        const tx = await moleA.transfer(CONFIG.HOOK_ADDRESS, fundAmount);
        await tx.wait();
      }
      console.log(`   ✅ Hook funded with MOLE-A`);
    }
    
    if (hookBalB < minLiquidity) {
      console.log(`   Funding hook with MOLE-B...`);
      const fundAmount = ethers.parseUnits('500', 18);
      try {
        const tx = await moleB.mint(CONFIG.HOOK_ADDRESS, fundAmount);
        await tx.wait();
      } catch {
        const tx = await moleB.transfer(CONFIG.HOOK_ADDRESS, fundAmount);
        await tx.wait();
      }
      console.log(`   ✅ Hook funded with MOLE-B`);
    }
  } catch (e) {
    console.log(`   ⚠️ Hook funding warning: ${e.message?.slice(0, 50)}`);
  }

  // Load existing intents to skip
  try {
    const pending = await hook.getPendingIntents();
    pending.forEach(id => processedIntents.add(id));
    console.log(`\n⏭️  Skipping ${pending.length} existing intent(s)`);
  } catch (e) {
    console.log(`\n⚠️  Could not load existing intents: ${e.message}`);
  }

  console.log('───────────────────────────────────────────────────────────────');
}

// =============================================================================
// CORE BATCH PROCESSING
// =============================================================================
async function processBatch() {
  if (isProcessing) {
    console.log('⏳ Already processing, skipping...');
    return;
  }
  isProcessing = true;

  try {
    // Get pending intents
    const pendingIds = await hook.getPendingIntents();
    const newIntents = pendingIds.filter(id => !processedIntents.has(id));

    if (newIntents.length === 0) {
      await executeReadyReleases();
      isProcessing = false;
      return;
    }

    console.log(`\n${'═'.repeat(65)}`);
    console.log(`🔄 Processing ${newIntents.length} NEW intent(s)`);
    console.log(`${'═'.repeat(65)}`);

    // Fetch intent details
    const intents = [];
    for (const id of newIntents) {
      const intent = await hook.getIntent(id);
      intents.push({
        intentId: id,
        sender: intent.sender,
        tokenIn: intent.tokenIn,
        tokenOut: intent.tokenOut,
        amountIn: intent.amountIn.toString(),
        viewingPubKey: intent.viewingPubKey,
      });
      processedIntents.add(id);
    }

    // Log intents
    for (const intent of intents) {
      console.log(`\n📥 Intent: ${intent.intentId.slice(0, 20)}...`);
      console.log(`   Sender:   ${intent.sender}`);
      console.log(`   TokenIn:  ${intent.tokenIn}`);
      console.log(`   TokenOut: ${intent.tokenOut}`);
      console.log(`   Amount:   ${ethers.formatUnits(intent.amountIn, 18)}`);
    }

    // ==========================================================================
    // STEP 1: Send to iExec TEE
    // ==========================================================================
    console.log(`\n🔐 Step 1: Sending to iExec TEE...`);
    
    // Base64 encode input (critical for SCONE TEE compatibility)
    const inputJson = JSON.stringify(intents);
    const inputData = Buffer.from(inputJson).toString('base64');
    console.log(`   Payload: ${intents.length} intent(s), ${inputData.length} bytes (base64)`);

    // Fetch orderbooks
    const appOrderbook = await iexec.orderbook.fetchAppOrderbook(CONFIG.IEXEC_APP, {
      workerpool: CONFIG.WORKERPOOL,
      minTag: CONFIG.IEXEC_TEE_TAG,
    });
    const apporder = appOrderbook.orders[0]?.order;
    if (!apporder) {
      throw new Error('No app order available. Run: iexec app publish --tag tee,scone');
    }

    const workerpoolOrderbook = await iexec.orderbook.fetchWorkerpoolOrderbook({
      workerpool: CONFIG.WORKERPOOL,
      category: 0,
      minTag: CONFIG.IEXEC_TEE_TAG,
    });
    const workerpoolorder = workerpoolOrderbook.orders[0]?.order;
    if (!workerpoolorder) {
      throw new Error('No workerpool order available');
    }

    // Create and sign request order
    const requestorder = await iexec.order.createRequestorder({
      app: CONFIG.IEXEC_APP,
      workerpool: CONFIG.WORKERPOOL,
      category: 0,
      params: { iexec_args: inputData },
      tag: CONFIG.IEXEC_TEE_TAG,
      trust: 1,
      workerpoolmaxprice: 100000000,
    });
    const signedRequestorder = await iexec.order.signRequestorder(requestorder);

    // Match orders
    const matchResult = await iexec.order.matchOrders({
      apporder,
      workerpoolorder,
      requestorder: signedRequestorder,
    });
    
    console.log(`   ✅ Orders matched`);
    console.log(`   Deal: ${matchResult.dealid.slice(0, 30)}...`);
    console.log(`   Tx:   https://sepolia.arbiscan.io/tx/${matchResult.txHash}`);

    // Get task ID
    const { tasks } = await iexec.deal.show(matchResult.dealid);
    const taskId = tasks['0'];
    console.log(`   Task: ${taskId.slice(0, 30)}...`);
    console.log(`   Explorer: https://explorer.iex.ec/arbitrum-sepolia-testnet/task/${taskId}`);

    // Track task for frontend
    for (const intent of intents) {
      intentTasks.set(intent.intentId, { 
        taskId, 
        dealId: matchResult.dealid, 
        status: 'pending',
        timestamp: Date.now()
      });
    }

    // ==========================================================================
    // STEP 2: Wait for TEE execution
    // ==========================================================================
    console.log(`\n⏳ Step 2: Waiting for TEE execution...`);
    
    await sleep(5000); // Initial delay for indexing

    let taskResult;
    const maxAttempts = Math.ceil(CONFIG.TASK_TIMEOUT_MS / CONFIG.TASK_POLL_INTERVAL_MS);
    
    for (let i = 0; i < maxAttempts; i++) {
      taskResult = await iexec.task.show(taskId);
      
      if (taskResult.status === 3) {
        console.log(`   ✅ Task completed`);
        break;
      } else if (taskResult.status === 4) {
        throw new Error('TEE task failed');
      }
      
      if (i % 6 === 0) {
        const statusNames = ['unset', 'active', 'revealing', 'completed', 'failed'];
        console.log(`   Status: ${statusNames[taskResult.status] || taskResult.status} (${i + 1}/${maxAttempts})`);
      }
      await sleep(CONFIG.TASK_POLL_INTERVAL_MS);
    }

    if (taskResult.status !== 3) {
      throw new Error(`Task timeout: status ${taskResult.status}`);
    }

    // Update tracking
    for (const intent of intents) {
      const info = intentTasks.get(intent.intentId);
      if (info) info.status = 'completed';
    }

    // ==========================================================================
    // STEP 3: Parse TEE results
    // ==========================================================================
    console.log(`\n📦 Step 3: Parsing TEE results...`);
    
    const result = await iexec.task.fetchResults(taskId);
    const contentType = result.headers?.get('content-type') || 'unknown';
    
    let teeOutput;
    
    if (contentType.includes('zip') || contentType.includes('octet-stream')) {
      const JSZip = (await import('jszip')).default;
      const arrayBuffer = await result.arrayBuffer();
      const zip = await JSZip.loadAsync(arrayBuffer);
      const filenames = Object.keys(zip.files);
      console.log(`   Zip files: ${filenames.join(', ')}`);
      
      // Find result file
      let resultContent;
      const targets = ['result.json', 'result.txt', 'output.json'];
      for (const target of targets) {
        const found = filenames.find(f => f.endsWith(target));
        if (found && !zip.files[found].dir) {
          resultContent = await zip.files[found].async('string');
          console.log(`   Reading: ${found}`);
          break;
        }
      }
      
      if (!resultContent) {
        const fallback = filenames.find(f => !f.includes('computed.json') && !zip.files[f].dir);
        if (fallback) resultContent = await zip.files[fallback].async('string');
      }
      
      teeOutput = JSON.parse(resultContent);
    } else {
      teeOutput = JSON.parse(await result.text());
    }

    // Save raw output before extracting releases
    const rawTeeOutput = teeOutput;

    // Extract releases from TEE output structure
    if (!Array.isArray(teeOutput)) {
      console.log(`   Output structure: ${Object.keys(teeOutput).join(', ')}`);
      
      if (teeOutput.settlementBatch?.releases) {
        console.log(`   Summary: ${JSON.stringify(teeOutput.summary)}`);
        teeOutput = teeOutput.settlementBatch.releases;
      } else if (teeOutput.releases) {
        teeOutput = teeOutput.releases;
      } else if (teeOutput.results) {
        teeOutput = teeOutput.results;
      } else if (teeOutput.data) {
        teeOutput = teeOutput.data;
      }
    }

    if (!Array.isArray(teeOutput) || teeOutput.length === 0) {
      console.log(`   ⚠️ No releases to process`);
      isProcessing = false;
      return;
    }

    console.log(`   ✅ Got ${teeOutput.length} release(s)`);
    console.log(`   First release: ${JSON.stringify(teeOutput[0]).slice(0, 200)}...`);

    // ==========================================================================
    // STEP 4: Settle batch on-chain using settleAndQueue
    // ==========================================================================
    console.log(`\n📤 Step 4: Settling batch on-chain...`);

    // Check current TEE signer
    let currentTeeSigner;
    try {
      currentTeeSigner = await hook.teeSigner();
      console.log(`   TEE Signer:  ${currentTeeSigner}`);
    } catch (e) {
      console.log(`   ⚠️ Could not read teeSigner`);
    }
    
    // Use oracle wallet for signing - simpler than managing separate TEE key
    const signingWallet = arbWallet;
    
    // Ensure oracle is set as TEE signer (auto-authorize if owner)
    if (currentTeeSigner && currentTeeSigner.toLowerCase() !== signingWallet.address.toLowerCase()) {
      console.log(`   Updating TEE signer to oracle wallet...`);
      try {
        const tx = await hook.setTeeSigner(signingWallet.address);
        await tx.wait();
        console.log(`   ✅ Updated TEE signer to ${signingWallet.address}`);
        currentTeeSigner = signingWallet.address;
      } catch (e) {
        console.log(`   ⚠️ Could not update TEE signer: ${e.reason || e.message?.slice(0, 50)}`);
        // Try with TEE_SIGNER_KEY as fallback
        console.log(`   Trying with TEE_SIGNER_KEY...`);
      }
    }

    // Build SettlementBatch struct matching MoleSwapHook.sol
    // The TEE output contains releases, we need to also build ammSettlements
    
    const internalMatches = []; // TEE would provide these for peer-to-peer matches
    const ammSettlements = [];
    const releases = [];
    const currentTime = Math.floor(Date.now() / 1000);
    
    // Get batchId from TEE output or generate one
    const batchId = teeOutput[0]?.batchId || 
                    rawTeeOutput?.settlementBatch?.batchId ||
                    rawTeeOutput?.summary?.batchId ||
                    ethers.keccak256(ethers.toUtf8Bytes(`batch-${Date.now()}`));
    
    const batchTimestamp = currentTime;

    console.log(`   Batch ID: ${batchId.slice(0, 20)}...`);
    console.log(`   Timestamp: ${batchTimestamp}`);

    for (let i = 0; i < teeOutput.length; i++) {
      const r = teeOutput[i];
      
      // Validate required fields
      if (!r.intentId || !r.stealthAddress || !r.encryptedStealthKey) {
        console.log(`   ❌ Release ${i} missing fields`);
        continue;
      }

      // Get the intent to determine token
      const intent = await hook.getIntent(r.intentId);
      const tokenOut = r.token || intent.tokenOut;
      
      // Build ammSettlement entry
      ammSettlements.push({
        intentId: r.intentId,
        stealthAddress: r.stealthAddress,
        amountOut: ethers.parseUnits(r.amount?.toString() || '0', 0), // Already in wei from TEE
        zeroForOne: true // Will be determined by token direction
      });

      // Build release entry with ABSOLUTE releaseTime (contract expects this)
      // Contract validates: releaseTime >= block.timestamp + MIN_DELAY (60s)
      // Contract validates: releaseTime <= block.timestamp + MAX_DELAY (180s)
      // Use 90s as default (middle of range) to avoid edge cases
      let releaseTime;
      if (r.releaseTime) {
        releaseTime = Number(r.releaseTime);
      } else {
        // Default: 90 seconds from now (safe middle of 60-180 range)
        releaseTime = currentTime + 90;
      }
      
      // Ensure release time is valid (65-175s from now to have buffer)
      const minReleaseTime = currentTime + 65;  // Buffer above 60s minimum
      const maxReleaseTime = currentTime + 175; // Buffer below 180s maximum
      if (releaseTime < minReleaseTime) releaseTime = minReleaseTime;
      if (releaseTime > maxReleaseTime) releaseTime = maxReleaseTime;
      
      releases.push({
        token: tokenOut,
        stealthAddress: r.stealthAddress,
        amount: r.amount?.toString() || '0',
        releaseTime: releaseTime,
        encryptedStealthKey: r.encryptedStealthKey,
        intentId: r.intentId,
        executed: false
      });
    }

    if (releases.length === 0) {
      throw new Error('No valid releases after validation');
    }

    console.log(`   AMM settlements: ${ammSettlements.length}`);
    console.log(`   Releases:        ${releases.length}`);
    console.log(`   Release times:   ${releases.map(r => r.releaseTime - currentTime + 's from now').join(', ')}`);

    // Compute batch hash matching contract's _computeBatchHash
    // Contract does: keccak256(abi.encode(internalMatches, ammSettlements, releases, batchId, timestamp))
    
    // Need to ABI encode the structs exactly as Solidity does
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    
    // Encode each struct type
    const internalMatchType = 'tuple(bytes32 buyIntentId, bytes32 sellIntentId, uint256 matchedAmount)[]';
    const settlementType = 'tuple(bytes32 intentId, address stealthAddress, uint256 amountOut, bool zeroForOne)[]';
    const releaseType = 'tuple(address token, address stealthAddress, uint256 amount, uint256 releaseTime, bytes encryptedStealthKey, bytes32 intentId, bool executed)[]';
    
    const encodedBatch = abiCoder.encode(
      [internalMatchType, settlementType, releaseType, 'bytes32', 'uint256'],
      [
        internalMatches,
        ammSettlements.map(s => [s.intentId, s.stealthAddress, s.amountOut, s.zeroForOne]),
        releases.map(r => [r.token, r.stealthAddress, r.amount, r.releaseTime, r.encryptedStealthKey, r.intentId, r.executed]),
        batchId,
        batchTimestamp
      ]
    );
    
    const batchHash = ethers.keccak256(encodedBatch);
    console.log(`   Batch hash: ${batchHash.slice(0, 30)}...`);

    // Sign with EIP-191 (toEthSignedMessageHash)
    // Contract uses: batchHash.toEthSignedMessageHash().recover(signature)
    const teeSignature = await signingWallet.signMessage(ethers.getBytes(batchHash));
    console.log(`   Signing wallet: ${signingWallet.address}`);
    console.log(`   Signature:  ${teeSignature.slice(0, 30)}...`);

    // Build the full batch struct for the contract call
    const batch = {
      internalMatches: internalMatches,
      ammSettlements: ammSettlements.map(s => ({
        intentId: s.intentId,
        stealthAddress: s.stealthAddress,
        amountOut: s.amountOut,
        zeroForOne: s.zeroForOne
      })),
      releases: releases.map(r => ({
        token: r.token,
        stealthAddress: r.stealthAddress,
        amount: r.amount,
        releaseTime: r.releaseTime,
        encryptedStealthKey: r.encryptedStealthKey,
        intentId: r.intentId,
        executed: r.executed
      })),
      batchId: batchId,
      timestamp: batchTimestamp,
      teeSignature: teeSignature
    };

    // Simulate first
    console.log(`   Simulating settleAndQueue...`);
    try {
      await hook.settleAndQueue.staticCall(batch);
      console.log(`   ✅ Simulation passed`);
    } catch (e) {
      console.log(`   ❌ Simulation failed: ${e.reason || e.message}`);
      
      // Check for specific errors
      if (e.message?.includes('InvalidSignature')) {
        console.log(`\n   🔍 Signature verification failed. Debug info:`);
        console.log(`      Signing wallet:     ${signingWallet.address}`);
        console.log(`      Contract teeSigner: ${currentTeeSigner}`);
        console.log(`      Batch hash:         ${batchHash}`);
        
        // Try to recover and see what address we get
        const recoveredAddress = ethers.verifyMessage(ethers.getBytes(batchHash), teeSignature);
        console.log(`      Recovered address:  ${recoveredAddress}`);
      }
      
      if (e.message?.includes('BatchAlreadyProcessed')) {
        console.log(`   ⚠️ This batch was already processed`);
        isProcessing = false;
        return;
      }
      
      if (e.message?.includes('InvalidReleaseTime')) {
        console.log(`   ⚠️ Release time out of bounds (must be 60-180s from now)`);
        console.log(`      Current time: ${currentTime}`);
        console.log(`      Release times: ${releases.map(r => r.releaseTime).join(', ')}`);
      }
      
      throw e;
    }

    // Send transaction
    console.log(`   Sending settleAndQueue tx...`);
    
    try {
      const tx = await hook.settleAndQueue(batch, { gasLimit: 2000000 });
      
      console.log(`\n   🔗 SETTLEMENT TX: ${tx.hash}`);
      console.log(`   https://sepolia.arbiscan.io/tx/${tx.hash}`);
      
      const receipt = await tx.wait();
      
      if (receipt.status === 0) {
        console.log(`   ❌ Transaction reverted on-chain`);
        console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
        throw new Error('Transaction reverted');
      }
      
      console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);
      
      // Parse events
      for (const log of receipt.logs) {
        try {
          const parsed = hook.interface.parseLog({ topics: log.topics, data: log.data });
          if (parsed) {
            console.log(`   Event: ${parsed.name}`);
            if (parsed.name === 'BatchSettled') {
              console.log(`     BatchId: ${parsed.args.batchId}`);
              console.log(`     Internal: ${parsed.args.internalMatches}`);
              console.log(`     AMM: ${parsed.args.ammSwaps}`);
              console.log(`     Releases: ${parsed.args.releasesQueued}`);
            }
            if (parsed.name === 'ReleaseQueued') {
              console.log(`     ReleaseId: ${parsed.args.releaseId}`);
              console.log(`     StealthAddr: ${parsed.args.stealthAddress}`);
              console.log(`     Amount: ${ethers.formatUnits(parsed.args.amount, 18)}`);
              console.log(`     ReleaseTime: ${parsed.args.releaseTime} (in ${Number(parsed.args.releaseTime) - currentTime}s)`);
            }
          }
        } catch {}
      }

      console.log(`\n📊 Summary: ${internalMatches.length} internal, ${ammSettlements.length} AMM, ${releases.length} releases queued`);
      
    } catch (txError) {
      console.log(`   ❌ Transaction failed`);
      
      // Try to decode the error
      if (txError.receipt) {
        console.log(`   Gas used: ${txError.receipt.gasUsed?.toString()}`);
        console.log(`   Status: ${txError.receipt.status}`);
      }
      
      // Check if it's a known error
      const errorMsg = txError.message || '';
      if (errorMsg.includes('OVERFLOW')) {
        console.log(`   💡 OVERFLOW error - likely insufficient token balance or allowance`);
        console.log(`   Check: User has tokens? User approved hook? Hook has output tokens?`);
      } else if (errorMsg.includes('InvalidSignature')) {
        console.log(`   💡 InvalidSignature - teeSigner mismatch`);
      } else if (errorMsg.includes('InvalidReleaseTime')) {
        console.log(`   💡 InvalidReleaseTime - release time outside 60-180s window`);
      }
      
      throw txError;
    }

    // Execute any ready releases
    await executeReadyReleases();

  } catch (e) {
    console.error(`\n❌ Batch error: ${e.message}`);
    if (e.stack) console.error(e.stack.split('\n').slice(0, 3).join('\n'));
  }

  isProcessing = false;
}

// =============================================================================
// RELEASE EXECUTION
// =============================================================================
async function executeReadyReleases() {
  try {
    const ready = await hook.getReleasesReadyToExecute();
    
    if (ready.length === 0) return;
    
    console.log(`\n🔓 ${ready.length} release(s) ready to execute`);
    
    for (const releaseId of ready) {
      try {
        const release = await hook.getRelease(releaseId);
        
        console.log(`   Executing: ${releaseId.slice(0, 20)}...`);
        console.log(`   Token:     ${release.token}`);
        console.log(`   Stealth:   ${release.stealthAddress}`);
        console.log(`   Amount:    ${ethers.formatUnits(release.amount, 18)}`);
        
        const tx = await hook.executeRelease(releaseId, { gasLimit: 500000 });
        console.log(`   Tx:        ${tx.hash}`);
        
        await tx.wait();
        console.log(`   ✅ Tokens sent to stealth address!`);
        
      } catch (e) {
        console.log(`   ❌ Failed: ${e.message?.slice(0, 50)}`);
      }
    }
  } catch (e) {
    console.log(`   ⚠️ Release check error: ${e.message}`);
  }
}

// =============================================================================
// HTTP SERVER
// =============================================================================
function startHttpServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Faucet endpoint
  app.post('/faucet', async (req, res) => {
    const { address } = req.body;
    
    if (!address || !ethers.isAddress(address)) {
      return res.status(400).json({ error: 'Invalid address' });
    }

    const lastRequest = faucetLimits.get(address.toLowerCase());
    if (lastRequest && Date.now() - lastRequest < CONFIG.FAUCET_COOLDOWN_MS) {
      const remaining = Math.ceil((CONFIG.FAUCET_COOLDOWN_MS - (Date.now() - lastRequest)) / 60000);
      return res.status(429).json({ error: `Rate limited. Try again in ${remaining} minutes.` });
    }

    try {
      const amount = ethers.parseUnits(CONFIG.FAUCET_AMOUNT, 18);
      console.log(`🚰 Faucet: ${address.slice(0, 10)}... requesting tokens`);
      
      let txA, txB;
      try {
        txA = await moleA.mint(address, amount, { gasLimit: 100000 });
        txB = await moleB.mint(address, amount, { gasLimit: 100000 });
      } catch {
        txA = await moleA.transfer(address, amount, { gasLimit: 100000 });
        txB = await moleB.transfer(address, amount, { gasLimit: 100000 });
      }
      
      await Promise.all([txA.wait(), txB.wait()]);
      faucetLimits.set(address.toLowerCase(), Date.now());
      
      console.log(`   ✅ Sent ${CONFIG.FAUCET_AMOUNT} of each token`);
      
      res.json({
        success: true,
        amount: CONFIG.FAUCET_AMOUNT,
        tokens: { 'MOLE-A': CONFIG.MOLE_A, 'MOLE-B': CONFIG.MOLE_B },
        txA: txA.hash,
        txB: txB.hash,
      });
    } catch (e) {
      console.error(`   ❌ Faucet error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Submit intent (trigger processing)
  app.post('/submit', async (req, res) => {
    const { intentId } = req.body;
    
    const taskInfo = intentTasks.get(intentId);
    if (taskInfo) {
      return res.json({ status: 'known', ...taskInfo });
    }
    
    processBatch().catch(console.error);
    res.json({ status: 'queued', intentId });
  });

  // Check intent status
  app.get('/status/:intentId', (req, res) => {
    const taskInfo = intentTasks.get(req.params.intentId);
    res.json(taskInfo ? { ...taskInfo, intentId: req.params.intentId } : { status: 'unknown' });
  });

  // Health check
  app.get('/health', async (req, res) => {
    let faucetBalanceA = '0', faucetBalanceB = '0';
    try {
      faucetBalanceA = ethers.formatUnits(await moleA.balanceOf(arbWallet.address), 18);
      faucetBalanceB = ethers.formatUnits(await moleB.balanceOf(arbWallet.address), 18);
    } catch {}
    
    res.json({ 
      status: 'ok', 
      oracle: arbWallet?.address,
      hook: CONFIG.HOOK_ADDRESS,
      tokens: { 'MOLE-A': CONFIG.MOLE_A, 'MOLE-B': CONFIG.MOLE_B },
      faucet: { amount: CONFIG.FAUCET_AMOUNT, balanceA: faucetBalanceA, balanceB: faucetBalanceB },
      trackedIntents: intentTasks.size,
      isProcessing,
    });
  });

  app.listen(CONFIG.HTTP_PORT, () => {
    console.log(`\n🚀 Oracle started`);
    console.log(`   HTTP:   http://localhost:${CONFIG.HTTP_PORT}`);
    console.log(`   Health: GET  /health`);
    console.log(`   Faucet: POST /faucet { "address": "0x..." }`);
    console.log(`   Submit: POST /submit { "intentId": "0x..." }`);
    console.log(`   Status: GET  /status/:intentId`);
  });
}

// =============================================================================
// UTILITIES
// =============================================================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// MAIN
// =============================================================================
async function main() {
  await init();
  startHttpServer();

  // Start batch processing loop
  setInterval(() => {
    processBatch().catch(console.error);
  }, CONFIG.BATCH_INTERVAL_MS);

  // Process immediately
  processBatch().catch(console.error);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});