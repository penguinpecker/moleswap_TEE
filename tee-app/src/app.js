/**
 * MoleSwap TEE Matching Engine v3
 * 
 * SCONE-compatible iExec TEE Application
 * 
 * Input methods (checked in order):
 * 1. IEXEC_APP_ARGS env var (non-TEE)
 * 2. /iexec_in/args.txt file (SCONE TEE)
 * 3. /iexec_in/intents.json file (fallback)
 * 4. Command line argument process.argv[2]
 */

import { ethers } from 'ethers';
import crypto from 'crypto';
import fs from 'fs';

const MIN_DELAY = 60;
const MAX_DELAY = 180;
const TEE_SIGNER_KEY = process.env.TEE_SIGNER_KEY || ethers.Wallet.createRandom().privateKey;

// ══════════════════════════════════════════════════════════════
// INPUT READING - SCONE COMPATIBLE
// ══════════════════════════════════════════════════════════════

function readIntents() {
  const inputDir = process.env.IEXEC_IN || '/iexec_in';
  
  console.log('[TEE] Checking input sources...');
  console.log('[TEE] IEXEC_IN:', inputDir);
  console.log('[TEE] IEXEC_APP_ARGS exists:', !!process.env.IEXEC_APP_ARGS);
  console.log('[TEE] argv:', process.argv);
  
  // List input directory
  try {
    if (fs.existsSync(inputDir)) {
      console.log('[TEE] Input dir contents:', fs.readdirSync(inputDir));
    }
  } catch (e) {
    console.log('[TEE] Cannot list input dir:', e.message);
  }

  // Method 1: IEXEC_APP_ARGS environment variable
  if (process.env.IEXEC_APP_ARGS) {
    console.log('[TEE] Reading from IEXEC_APP_ARGS env var');
    try {
      const data = process.env.IEXEC_APP_ARGS;
      // Could be JSON array directly or base64 encoded
      if (data.startsWith('[')) {
        return JSON.parse(data);
      } else if (data.startsWith('{')) {
        const parsed = JSON.parse(data);
        return parsed.intents || parsed;
      } else {
        // Try base64 decode
        const decoded = Buffer.from(data, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        return Array.isArray(parsed) ? parsed : (parsed.intents || []);
      }
    } catch (e) {
      console.log('[TEE] Failed to parse IEXEC_APP_ARGS:', e.message);
    }
  }

  // Method 2: args.txt file (SCONE writes iexec_args here)
  const argsFile = `${inputDir}/args.txt`;
  if (fs.existsSync(argsFile)) {
    console.log('[TEE] Reading from args.txt');
    try {
      const data = fs.readFileSync(argsFile, 'utf8').trim();
      if (data.startsWith('[')) {
        return JSON.parse(data);
      } else if (data.startsWith('{')) {
        const parsed = JSON.parse(data);
        return parsed.intents || parsed;
      } else {
        const decoded = Buffer.from(data, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        return Array.isArray(parsed) ? parsed : (parsed.intents || []);
      }
    } catch (e) {
      console.log('[TEE] Failed to parse args.txt:', e.message);
    }
  }

  // Method 3: intents.json file
  const intentsFile = `${inputDir}/intents.json`;
  if (fs.existsSync(intentsFile)) {
    console.log('[TEE] Reading from intents.json');
    try {
      return JSON.parse(fs.readFileSync(intentsFile, 'utf8'));
    } catch (e) {
      console.log('[TEE] Failed to parse intents.json:', e.message);
    }
  }

  // Method 4: Command line argument
  if (process.argv[2]) {
    console.log('[TEE] Reading from argv[2]');
    try {
      const data = process.argv[2];
      if (data.startsWith('[')) {
        return JSON.parse(data);
      } else if (data.startsWith('{')) {
        const parsed = JSON.parse(data);
        return parsed.intents || parsed;
      } else {
        const decoded = Buffer.from(data, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        return Array.isArray(parsed) ? parsed : (parsed.intents || []);
      }
    } catch (e) {
      console.log('[TEE] Failed to parse argv[2]:', e.message);
    }
  }

  // Method 5: Check for any JSON file in input dir
  try {
    const files = fs.readdirSync(inputDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        console.log(`[TEE] Trying ${file}`);
        try {
          const content = JSON.parse(fs.readFileSync(`${inputDir}/${file}`, 'utf8'));
          if (Array.isArray(content)) return content;
          if (content.intents) return content.intents;
        } catch {}
      }
    }
  } catch {}

  console.log('[TEE] No intents found from any source');
  return [];
}

// ══════════════════════════════════════════════════════════════
// ECIES ENCRYPTION
// ══════════════════════════════════════════════════════════════

function eciesEncrypt(plaintext, recipientPubKeyHex) {
  try {
    const ephemeralWallet = ethers.Wallet.createRandom();
    const ephemeralPrivKey = ephemeralWallet.signingKey.privateKey;
    const ephemeralPubKey = ephemeralWallet.signingKey.publicKey;

    const ephemeralSigningKey = new ethers.SigningKey(ephemeralPrivKey);
    const sharedSecret = ephemeralSigningKey.computeSharedSecret(recipientPubKeyHex);

    const encryptionKey = crypto.createHash('sha256').update(Buffer.from(sharedSecret.slice(2), 'hex')).digest();

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    
    const plainBuffer = Buffer.from(plaintext, 'utf8');
    const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const ephPubBytes = Buffer.from(ephemeralPubKey.slice(2), 'hex');
    const result = Buffer.concat([ephPubBytes, iv, authTag, encrypted]);

    return '0x' + result.toString('hex');
  } catch (e) {
    console.log('[TEE] ECIES encrypt error:', e.message);
    return '0x';
  }
}

// ══════════════════════════════════════════════════════════════
// INTENT MATCHING
// ══════════════════════════════════════════════════════════════

function matchIntents(intents) {
  const internalMatches = [];
  const ammSettlements = [];
  const matched = new Set();

  const pairs = {};
  for (const intent of intents) {
    const pairKey = [intent.tokenIn, intent.tokenOut].sort().join('-');
    if (!pairs[pairKey]) pairs[pairKey] = { buys: [], sells: [] };

    const isBuy = intent.tokenIn.toLowerCase() < intent.tokenOut.toLowerCase();
    if (isBuy) {
      pairs[pairKey].buys.push(intent);
    } else {
      pairs[pairKey].sells.push(intent);
    }
  }

  for (const pairKey of Object.keys(pairs)) {
    const { buys, sells } = pairs[pairKey];
    let buyIdx = 0, sellIdx = 0;
    
    while (buyIdx < buys.length && sellIdx < sells.length) {
      const buy = buys[buyIdx];
      const sell = sells[sellIdx];
      
      if (matched.has(buy.intentId) || matched.has(sell.intentId)) {
        if (matched.has(buy.intentId)) buyIdx++;
        if (matched.has(sell.intentId)) sellIdx++;
        continue;
      }

      const matchedAmount = BigInt(buy.amountIn) < BigInt(sell.amountIn) 
        ? buy.amountIn 
        : sell.amountIn;

      internalMatches.push({
        buyIntentId: buy.intentId,
        sellIntentId: sell.intentId,
        matchedAmount: matchedAmount.toString(),
      });

      matched.add(buy.intentId);
      matched.add(sell.intentId);
      buyIdx++;
      sellIdx++;
    }
  }

  for (const intent of intents) {
    if (!matched.has(intent.intentId)) {
      const zeroForOne = intent.tokenIn.toLowerCase() < intent.tokenOut.toLowerCase();
      ammSettlements.push({
        intentId: intent.intentId,
        stealthAddress: '',
        amountOut: intent.amountIn,
        zeroForOne,
      });
    }
  }

  return { internalMatches, ammSettlements, matched };
}

// ══════════════════════════════════════════════════════════════
// STEALTH ADDRESS & RELEASE GENERATION
// ══════════════════════════════════════════════════════════════

function generateStealthAddress() {
  const wallet = ethers.Wallet.createRandom();
  return { address: wallet.address, privateKey: wallet.privateKey };
}

function generateReleases(intents, internalMatches, ammSettlements) {
  const releases = [];
  const currentTime = Math.floor(Date.now() / 1000);

  const intentMap = {};
  for (const intent of intents) {
    intentMap[intent.intentId] = intent;
  }

  for (const match of internalMatches) {
    const buyIntent = intentMap[match.buyIntentId];
    const sellIntent = intentMap[match.sellIntentId];

    if (buyIntent) {
      const buyerStealth = generateStealthAddress();
      const buyerDelay = MIN_DELAY + crypto.randomInt(MAX_DELAY - MIN_DELAY + 1);
      releases.push({
        token: buyIntent.tokenOut,
        stealthAddress: buyerStealth.address,
        amount: match.matchedAmount,
        releaseTime: currentTime + buyerDelay,
        encryptedStealthKey: eciesEncrypt(buyerStealth.privateKey, buyIntent.viewingPubKey),
        intentId: match.buyIntentId,
        executed: false,
      });
    }

    if (sellIntent) {
      const sellerStealth = generateStealthAddress();
      const sellerDelay = MIN_DELAY + crypto.randomInt(MAX_DELAY - MIN_DELAY + 1);
      releases.push({
        token: sellIntent.tokenOut,
        stealthAddress: sellerStealth.address,
        amount: match.matchedAmount,
        releaseTime: currentTime + sellerDelay,
        encryptedStealthKey: eciesEncrypt(sellerStealth.privateKey, sellIntent.viewingPubKey),
        intentId: match.sellIntentId,
        executed: false,
      });
    }
  }

  for (const settlement of ammSettlements) {
    const intent = intentMap[settlement.intentId];
    if (!intent) continue;
    
    const stealth = generateStealthAddress();
    const delay = MIN_DELAY + crypto.randomInt(MAX_DELAY - MIN_DELAY + 1);

    settlement.stealthAddress = stealth.address;

    releases.push({
      token: intent.tokenOut,
      stealthAddress: stealth.address,
      amount: settlement.amountOut,
      releaseTime: currentTime + delay,
      encryptedStealthKey: eciesEncrypt(stealth.privateKey, intent.viewingPubKey),
      intentId: settlement.intentId,
      executed: false,
    });
  }

  return releases;
}

// ══════════════════════════════════════════════════════════════
// BATCH SIGNING
// ══════════════════════════════════════════════════════════════

async function signBatch(internalMatches, ammSettlements, releases, batchId, timestamp) {
  const teeWallet = new ethers.Wallet(TEE_SIGNER_KEY);

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  
  const encodedMatches = internalMatches.map(m => [m.buyIntentId, m.sellIntentId, m.matchedAmount]);
  const encodedSettlements = ammSettlements.map(s => [s.intentId, s.stealthAddress, s.amountOut, s.zeroForOne]);
  const encodedReleases = releases.map(r => [
    r.token, r.stealthAddress, r.amount, r.releaseTime, r.encryptedStealthKey, r.intentId, r.executed
  ]);

  const batchHash = ethers.keccak256(abiCoder.encode(
    [
      'tuple(bytes32,bytes32,uint256)[]',
      'tuple(bytes32,address,uint256,bool)[]',
      'tuple(address,address,uint256,uint256,bytes,bytes32,bool)[]',
      'bytes32',
      'uint256'
    ],
    [encodedMatches, encodedSettlements, encodedReleases, batchId, timestamp]
  ));

  const signature = await teeWallet.signMessage(ethers.getBytes(batchHash));
  
  return { signature, signerAddress: teeWallet.address };
}

// ══════════════════════════════════════════════════════════════
// MAIN PROCESSING
// ══════════════════════════════════════════════════════════════

async function processIntents(intents) {
  console.log(`[TEE] Processing ${intents.length} intents...`);

  if (!intents || intents.length === 0) {
    console.log('[TEE] No intents to process');
    return {
      settlementBatch: {
        internalMatches: [],
        ammSettlements: [],
        releases: [],
        batchId: ethers.keccak256(ethers.toUtf8Bytes(`empty-${Date.now()}`)),
        timestamp: Math.floor(Date.now() / 1000),
        teeSignature: '0x',
      },
      teeSigner: new ethers.Wallet(TEE_SIGNER_KEY).address,
      summary: { totalIntents: 0, internalMatches: 0, ammSwaps: 0, releasesQueued: 0 },
    };
  }

  const { internalMatches, ammSettlements } = matchIntents(intents);
  console.log(`[TEE] Internal matches: ${internalMatches.length}`);
  console.log(`[TEE] AMM settlements: ${ammSettlements.length}`);

  const releases = generateReleases(intents, internalMatches, ammSettlements);
  console.log(`[TEE] Releases generated: ${releases.length}`);

  const timestamp = Math.floor(Date.now() / 1000);
  const batchId = ethers.keccak256(ethers.toUtf8Bytes(`batch-${timestamp}-${crypto.randomUUID()}`));

  const { signature, signerAddress } = await signBatch(
    internalMatches, ammSettlements, releases, batchId, timestamp
  );
  console.log(`[TEE] Batch signed by: ${signerAddress}`);

  return {
    settlementBatch: {
      internalMatches,
      ammSettlements,
      releases,
      batchId,
      timestamp,
      teeSignature: signature,
    },
    teeSigner: signerAddress,
    summary: {
      totalIntents: intents.length,
      internalMatches: internalMatches.length,
      ammSwaps: ammSettlements.length,
      releasesQueued: releases.length,
      batchId,
    },
  };
}

// ══════════════════════════════════════════════════════════════
// ENTRY POINT
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log('[TEE] MoleSwap Matching Engine v3');
  console.log('[TEE] Starting...');

  const outputDir = process.env.IEXEC_OUT || '/iexec_out';

  try {
    const intents = readIntents();
    console.log(`[TEE] Loaded ${intents.length} intents`);
    
    if (intents.length > 0) {
      console.log('[TEE] First intent:', JSON.stringify(intents[0]).slice(0, 200));
    }

    const result = await processIntents(intents);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(`${outputDir}/result.json`, JSON.stringify(result, null, 2));
    fs.writeFileSync(`${outputDir}/computed.json`, JSON.stringify({ 'result-path': '/result.json' }));

    console.log('[TEE] Complete!');
    console.log(`[TEE] Output: ${outputDir}/result.json`);

  } catch (error) {
    console.error('[TEE] Error:', error.message);
    console.error('[TEE] Stack:', error.stack);
    
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(`${outputDir}/result.json`, JSON.stringify({ 
      error: error.message,
      settlementBatch: {
        internalMatches: [],
        ammSettlements: [],
        releases: [],
        batchId: '0x0000000000000000000000000000000000000000000000000000000000000000',
        timestamp: Math.floor(Date.now() / 1000),
        teeSignature: '0x',
      }
    }));
    fs.writeFileSync(`${outputDir}/computed.json`, JSON.stringify({ 'result-path': '/result.json' }));
    
    process.exit(1);
  }
}

main();
