/**
 * MoleSwap Oracle v3 - iExec TEE Integration
 * 
 * This oracle:
 * 1. Watches IntentSubmitted events on Arbitrum Sepolia
 * 2. Batches intents and sends to iExec TEE (real SGX enclave)
 * 3. Submits TEE-signed settlements on-chain
 * 4. Executes releases when their time comes
 * 
 * TRUST MODEL:
 * - Oracle is UNTRUSTED relay only
 * - TEE generates stealth keys, oracle never sees them
 * - TEE signs settlements, contract verifies signature
 */

import { ethers } from 'ethers';
import { IExec } from 'iexec';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ══════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════

const CONFIG = {
  // Arbitrum Sepolia (where contracts live)
  ARB_RPC_URL: process.env.RPC_URL || 'https://arb-sepolia.g.alchemy.com/v2/demo',
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  HOOK_ADDRESS: process.env.HOOK_ADDRESS,
  
  // iExec configuration
  IEXEC_APP_ADDRESS: process.env.IEXEC_APP_ADDRESS || '0xF8A3bB4BBCcFC0f810196117Fc779a8587a9899F',
  IEXEC_WORKERPOOL: process.env.IEXEC_WORKERPOOL || 'prod-v8-learn.main.pools.iexec.eth',
  IEXEC_TEE_TAG: '0x0000000000000000000000000000000000000000000000000000000000000003',
  
  // Timing
  BATCH_INTERVAL_MS: parseInt(process.env.BATCH_INTERVAL_MS) || 30000,
  RELEASE_CHECK_INTERVAL_MS: parseInt(process.env.RELEASE_CHECK_INTERVAL_MS) || 10000,
  
  // Mode: default is iExec (real TEE)
  USE_LOCAL_TEE: process.env.USE_LOCAL_TEE === 'true',
  HTTP_PORT: parseInt(process.env.HTTP_PORT) || 3001,
  TEE_SIGNER_KEY: process.env.TEE_SIGNER_KEY,
};

// ══════════════════════════════════════════════════════════════
// ABI
// ══════════════════════════════════════════════════════════════

const HOOK_ABI = [
  'event IntentSubmitted(bytes32 indexed intentId, address indexed sender, address tokenIn, address tokenOut, uint256 amountIn, uint256 deadline)',
  'event ReleaseQueued(bytes32 indexed releaseId, bytes32 indexed intentId, address stealthAddress, uint256 amount, uint256 releaseTime)',
  'event ReleaseExecuted(bytes32 indexed releaseId, address indexed stealthAddress, address token, uint256 amount, bytes encryptedStealthKey)',
  'event BatchSettled(bytes32 indexed batchId, uint256 internalMatches, uint256 ammSwaps, uint256 releasesQueued)',
  
  'function getPendingIntents() view returns (bytes32[])',
  'function getPendingReleases() view returns (bytes32[])',
  'function getReleasesReadyToExecute() view returns (bytes32[])',
  'function getIntent(bytes32) view returns (tuple(address sender, address tokenIn, address tokenOut, uint256 amountIn, bytes viewingPubKey, uint256 deadline, uint256 submittedAt, bool settled))',
  'function getRelease(bytes32) view returns (tuple(address token, address stealthAddress, uint256 amount, uint256 releaseTime, bytes encryptedStealthKey, bytes32 intentId, bool executed))',
  'function oracle() view returns (address)',
  'function teeSigner() view returns (address)',
  
  'function settleAndQueue(tuple(tuple(bytes32 buyIntentId, bytes32 sellIntentId, uint256 matchedAmount)[] internalMatches, tuple(bytes32 intentId, address stealthAddress, uint256 amountOut, bool zeroForOne)[] ammSettlements, tuple(address token, address stealthAddress, uint256 amount, uint256 releaseTime, bytes encryptedStealthKey, bytes32 intentId, bool executed)[] releases, bytes32 batchId, uint256 timestamp, bytes teeSignature))',
  'function executeRelease(bytes32 releaseId)',
];

// ══════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════

let arbProvider;
let arbWallet;
let hook;
let iexec;
let isProcessing = false;
let lastBatchTime = 0;

// ══════════════════════════════════════════════════════════════
// INITIALIZATION
// ══════════════════════════════════════════════════════════════

async function init() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  MoleSwap Oracle v3 - iExec TEE Integration          ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  if (!CONFIG.PRIVATE_KEY) throw new Error('PRIVATE_KEY required');
  if (!CONFIG.HOOK_ADDRESS) throw new Error('HOOK_ADDRESS required');

  // Setup Arbitrum Sepolia connection
  arbProvider = new ethers.JsonRpcProvider(CONFIG.ARB_RPC_URL);
  arbWallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, arbProvider);
  hook = new ethers.Contract(CONFIG.HOOK_ADDRESS, HOOK_ABI, arbWallet);

  console.log(`Oracle Address:  ${arbWallet.address}`);
  console.log(`Hook Address:    ${CONFIG.HOOK_ADDRESS}`);
  console.log(`Arbitrum RPC:    ${CONFIG.ARB_RPC_URL}`);
  console.log(`iExec App:       ${CONFIG.IEXEC_APP_ADDRESS}`);
  console.log(`Workerpool:      ${CONFIG.IEXEC_WORKERPOOL}`);
  console.log(`Mode:            ${CONFIG.USE_LOCAL_TEE ? 'LOCAL SIMULATION' : 'REAL iExec TEE'}`);

  // Setup iExec SDK (connects to Bellecour sidechain)
  if (!CONFIG.USE_LOCAL_TEE) {
    try {
      // iExec SDK needs an ethers signer
      const iexecProvider = new ethers.JsonRpcProvider('https://bellecour.iex.ec');
      const iexecWallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, iexecProvider);
      
      iexec = new IExec({ ethProvider: iexecWallet });
      
      // Check RLC balance
      const balance = await iexec.account.checkBalance(arbWallet.address);
      console.log(`\niExec RLC:       ${ethers.formatEther(balance.stake)} staked`);
      
      if (BigInt(balance.stake) === 0n) {
        console.warn('⚠️  No RLC staked! Get testnet RLC: https://faucet.iex.ec/bellecour');
      }
    } catch (e) {
      console.warn('⚠️  iExec SDK init failed:', e.message);
      console.warn('   Switching to local TEE simulation');
      CONFIG.USE_LOCAL_TEE = true;
    }
  }

  // Verify oracle is authorized on contract
  try {
    const authorized = await hook.oracle();
    if (authorized.toLowerCase() === arbWallet.address.toLowerCase()) {
      console.log(`\n✅ Oracle authorized on MoleSwap contract`);
    } else {
      console.warn(`\n⚠️  Not authorized. Contract expects: ${authorized}`);
    }
  } catch (e) {
    console.warn('Could not check authorization:', e.message);
  }

  console.log('\n───────────────────────────────────────────────────────\n');
}

// ══════════════════════════════════════════════════════════════
// EVENT WATCHING
// ══════════════════════════════════════════════════════════════

function watchEvents() {
  console.log('👀 Watching for events...\n');

  hook.on('IntentSubmitted', (intentId, sender, tokenIn, tokenOut, amountIn) => {
    console.log(`📥 New Intent: ${intentId.slice(0, 18)}...`);
    console.log(`   From: ${sender.slice(0, 12)}...`);
    console.log(`   Amount: ${ethers.formatEther(amountIn)}`);
    console.log('');
  });

  hook.on('ReleaseQueued', (releaseId, intentId, stealthAddress, amount, releaseTime) => {
    const delay = Number(releaseTime) - Math.floor(Date.now() / 1000);
    console.log(`⏳ Release Queued: ${releaseId.slice(0, 18)}...`);
    console.log(`   → ${stealthAddress.slice(0, 12)}...`);
    console.log(`   Unlocks in ${Math.max(0, delay)}s`);
    console.log('');
  });

  hook.on('ReleaseExecuted', (releaseId, stealthAddress) => {
    console.log(`✅ Release Executed: ${releaseId.slice(0, 18)}...`);
    console.log(`   Sent to ${stealthAddress.slice(0, 12)}...`);
    console.log('');
  });

  hook.on('BatchSettled', (batchId, internalMatches, ammSwaps, releases) => {
    console.log(`📦 Batch Settled: ${batchId.slice(0, 18)}...`);
    console.log(`   Internal: ${internalMatches}, AMM: ${ammSwaps}, Releases: ${releases}`);
    console.log('');
  });
}

// ══════════════════════════════════════════════════════════════
// BATCH PROCESSING
// ══════════════════════════════════════════════════════════════

async function processBatch() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const pendingIds = await hook.getPendingIntents();
    if (pendingIds.length === 0) return;

    console.log(`\n🔄 Processing batch of ${pendingIds.length} intents...`);

    // Fetch full intent data
    const intents = [];
    for (const intentId of pendingIds) {
      try {
        const intent = await hook.getIntent(intentId);
        if (!intent.settled && intent.sender !== ethers.ZeroAddress) {
          intents.push({
            intentId,
            sender: intent.sender,
            tokenIn: intent.tokenIn,
            tokenOut: intent.tokenOut,
            amountIn: intent.amountIn.toString(),
            viewingPubKey: intent.viewingPubKey,
            deadline: Number(intent.deadline),
          });
        }
      } catch (e) {
        console.warn(`Failed to fetch intent ${intentId}:`, e.message);
      }
    }

    if (intents.length === 0) {
      console.log('No valid intents');
      return;
    }

    // Process through TEE
    console.log('🔐 Sending to TEE...');
    
    let teeResult;
    if (CONFIG.USE_LOCAL_TEE) {
      teeResult = await processWithLocalTee(intents);
    } else {
      teeResult = await processWithIexec(intents);
    }

    if (!teeResult?.settlementBatch) {
      console.log('TEE returned empty result');
      return;
    }

    // Submit settlement on-chain
    await submitSettlement(teeResult.settlementBatch);

  } catch (error) {
    console.error('Batch error:', error.message);
  } finally {
    isProcessing = false;
    lastBatchTime = Date.now();
  }
}

// ══════════════════════════════════════════════════════════════
// iEXEC TEE PROCESSING
// ══════════════════════════════════════════════════════════════

async function processWithIexec(intents) {
  console.log('🔐 Processing with iExec TEE (SGX enclave)...');

  try {
    // Encode input as base64 JSON
    const inputData = {
      intents,
      hookAddress: CONFIG.HOOK_ADDRESS,
      chainId: 421614,
      timestamp: Date.now(),
    };
    const args = Buffer.from(JSON.stringify(inputData)).toString('base64');

    console.log(`   App: ${CONFIG.IEXEC_APP_ADDRESS}`);
    console.log(`   Workerpool: ${CONFIG.IEXEC_WORKERPOOL}`);
    console.log(`   Intents: ${intents.length}`);

    // Get app order
    const { orders: appOrders } = await iexec.orderbook.fetchAppOrderbook(
      CONFIG.IEXEC_APP_ADDRESS,
      { workerpool: CONFIG.IEXEC_WORKERPOOL }
    );
    if (appOrders.length === 0) throw new Error('No app orders available');
    const appOrder = appOrders[0].order;

    // Get workerpool order with TEE tag
    const { orders: wpOrders } = await iexec.orderbook.fetchWorkerpoolOrderbook({
      workerpool: CONFIG.IEXEC_WORKERPOOL,
      minTag: CONFIG.IEXEC_TEE_TAG,
    });
    if (wpOrders.length === 0) throw new Error('No workerpool orders with TEE tag');
    const workerpoolOrder = wpOrders[0].order;

    // Create and sign request order
    const requestOrder = await iexec.order.createRequestorder({
      app: CONFIG.IEXEC_APP_ADDRESS,
      category: 0,
      params: { iexec_args: args },
      tag: CONFIG.IEXEC_TEE_TAG,
    });
    const signedRequest = await iexec.order.signRequestorder(requestOrder);

    // Match orders → creates a deal
    console.log('   Creating deal...');
    const { dealid, txHash } = await iexec.order.matchOrders({
      apporder: appOrder,
      workerpoolorder: workerpoolOrder,
      requestorder: signedRequest,
    });
    console.log(`   Deal: ${dealid}`);
    console.log(`   Tx: ${txHash}`);

    // Wait for task completion
    console.log('   Waiting for TEE execution...');
    const taskId = await iexec.deal.computeTaskId(dealid, 0);
    
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Task timeout (5min)')), 300000);
      
      iexec.task.obsTask(taskId, { pollInterval: 5000 }).then(obs => {
        obs.subscribe({
          next: ({ message, task }) => {
            console.log(`   Status: ${message}`);
            if (task?.status === 3) { // COMPLETED
              clearTimeout(timeout);
              resolve(task);
            } else if (task?.status === 4) { // FAILED
              clearTimeout(timeout);
              reject(new Error('Task failed'));
            }
          },
          error: (e) => { clearTimeout(timeout); reject(e); },
        });
      });
    });

    // Fetch result
    console.log('   Fetching TEE output...');
    const resultBuffer = await iexec.task.fetchResults(taskId);
    const result = await parseIexecResult(resultBuffer);

    console.log('   ✅ TEE processing complete');
    return result;

  } catch (error) {
    console.error('   ❌ iExec error:', error.message);
    
    // Fallback to local simulation
    console.log('   Falling back to local TEE...');
    return processWithLocalTee(intents);
  }
}

async function parseIexecResult(buffer) {
  try {
    // Try direct JSON parse
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    // Extract from zip
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);
    
    // Look for result.json or computed.json
    for (const name of ['result.json', 'iexec_out/result.json', 'computed.json']) {
      const file = zip.file(name);
      if (file) {
        return JSON.parse(await file.async('string'));
      }
    }
    throw new Error('No result file in iExec output');
  }
}

// ══════════════════════════════════════════════════════════════
// LOCAL TEE SIMULATION
// ══════════════════════════════════════════════════════════════

async function processWithLocalTee(intents) {
  console.log('🔐 Processing with local TEE simulation...');

  const tempDir = `/tmp/moleswap-${Date.now()}`;
  const inputDir = `${tempDir}/input`;
  const outputDir = `${tempDir}/output`;

  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(`${inputDir}/intents.json`, JSON.stringify(intents, null, 2));

  return new Promise((resolve, reject) => {
    const teeApp = path.join(__dirname, '../../tee-app/src/app.js');
    
    const proc = spawn('node', [teeApp], {
      env: {
        ...process.env,
        IEXEC_IN: inputDir,
        IEXEC_OUT: outputDir,
        TEE_SIGNER_KEY: CONFIG.TEE_SIGNER_KEY || CONFIG.PRIVATE_KEY,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stdout.on('data', d => {
      d.toString().split('\n').filter(Boolean).forEach(l => console.log(`[TEE] ${l}`));
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`TEE exited ${code}: ${stderr}`));
        return;
      }
      try {
        const result = JSON.parse(fs.readFileSync(`${outputDir}/result.json`, 'utf8'));
        resolve(result);
      } catch (e) {
        reject(e);
      }
    });
    proc.on('error', reject);
  });
}

// ══════════════════════════════════════════════════════════════
// SETTLEMENT SUBMISSION
// ══════════════════════════════════════════════════════════════

async function submitSettlement(batch) {
  console.log(`\n📤 Submitting batch ${batch.batchId.slice(0, 18)}...`);
  console.log(`   Internal: ${batch.internalMatches.length}`);
  console.log(`   AMM: ${batch.ammSettlements.length}`);
  console.log(`   Releases: ${batch.releases.length}`);

  try {
    const tx = await hook.settleAndQueue(batch, { gasLimit: 2000000 });
    console.log(`   Tx: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);
  } catch (e) {
    console.error(`   ❌ Failed: ${e.message}`);
    throw e;
  }
}

// ══════════════════════════════════════════════════════════════
// RELEASE EXECUTION
// ══════════════════════════════════════════════════════════════

async function executeReadyReleases() {
  try {
    const ready = await hook.getReleasesReadyToExecute();
    if (ready.length === 0) return;

    console.log(`\n⏰ ${ready.length} releases ready`);

    for (const releaseId of ready) {
      try {
        const rel = await hook.getRelease(releaseId);
        if (rel.executed) continue;

        console.log(`   Executing → ${rel.stealthAddress.slice(0, 12)}...`);
        const tx = await hook.executeRelease(releaseId, { gasLimit: 300000 });
        await tx.wait();
        console.log(`   ✅ Released`);
      } catch (e) {
        console.error(`   ❌ ${releaseId.slice(0, 12)}... failed: ${e.message}`);
      }
    }
  } catch (e) {
    if (!e.message?.includes('filter')) {
      console.error('Release check error:', e.message);
    }
  }
}

// ══════════════════════════════════════════════════════════════
// HTTP SERVER
// ══════════════════════════════════════════════════════════════

async function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        oracle: arbWallet.address,
        hook: CONFIG.HOOK_ADDRESS,
        iexecApp: CONFIG.IEXEC_APP_ADDRESS,
        mode: CONFIG.USE_LOCAL_TEE ? 'local' : 'iexec',
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/submit') {
      console.log('📥 Manual trigger');
      processBatch().catch(console.error);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(CONFIG.HTTP_PORT, () => {
    console.log(`🌐 HTTP API on port ${CONFIG.HTTP_PORT}`);
  });
}

// ══════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════

async function main() {
  await init();
  watchEvents();
  await startHttpServer();

  setInterval(async () => {
    if (Date.now() - lastBatchTime >= CONFIG.BATCH_INTERVAL_MS) {
      await processBatch();
    }
  }, 5000);

  setInterval(executeReadyReleases, CONFIG.RELEASE_CHECK_INTERVAL_MS);

  console.log(`\n🚀 Oracle running`);
  console.log(`   Mode: ${CONFIG.USE_LOCAL_TEE ? 'LOCAL' : 'iExec TEE'}`);
  console.log(`   Batch: ${CONFIG.BATCH_INTERVAL_MS / 1000}s`);
  console.log(`   Release check: ${CONFIG.RELEASE_CHECK_INTERVAL_MS / 1000}s`);
  console.log('\nCtrl+C to stop\n');

  await processBatch();
}

main().catch(console.error);
