/**
 * MoleSwap TEE Matching Engine v3
 * 
 * Runs inside iExec SGX enclave for trustless privacy:
 * 1. Receives batched intents from oracle
 * 2. Matches buy/sell pairs (internal matching)
 * 3. Routes unmatched to AMM
 * 4. Generates stealth keypairs
 * 5. Encrypts stealth private keys with user's viewing key (ECIES)
 * 6. Assigns random release times (60-180s delay)
 * 7. Signs entire batch for on-chain verification
 * 
 * TRUST: All secrets (stealth keys, timing) generated inside TEE
 * VERIFY: Contract verifies TEE signature before processing
 */

import { ethers } from 'ethers';
import crypto from 'crypto';
import fs from 'fs';

// ══════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════

const MIN_DELAY = 60;   // seconds
const MAX_DELAY = 180;  // seconds

// TEE signer key - in production, this is the enclave's attestation key
const TEE_SIGNER_KEY = process.env.TEE_SIGNER_KEY || ethers.Wallet.createRandom().privateKey;

// ══════════════════════════════════════════════════════════════
// ECIES ENCRYPTION
// ══════════════════════════════════════════════════════════════

/**
 * Encrypt data using ECIES with recipient's public key
 * Format: ephemeralPubKey (65 bytes) + iv (12 bytes) + authTag (16 bytes) + ciphertext
 */
function eciesEncrypt(plaintext, recipientPubKeyHex) {
  // Generate ephemeral keypair
  const ephemeralWallet = ethers.Wallet.createRandom();
  const ephemeralPrivKey = ephemeralWallet.signingKey.privateKey;
  const ephemeralPubKey = ephemeralWallet.signingKey.publicKey;

  // Compute shared secret using ECDH
  const ephemeralSigningKey = new ethers.SigningKey(ephemeralPrivKey);
  const sharedSecret = ephemeralSigningKey.computeSharedSecret(recipientPubKeyHex);

  // Derive encryption key from shared secret
  const encryptionKey = crypto.createHash('sha256').update(Buffer.from(sharedSecret.slice(2), 'hex')).digest();

  // Encrypt with AES-256-GCM
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  
  const plainBuffer = Buffer.from(plaintext, 'utf8');
  const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: ephemeralPubKey (65) + iv (12) + authTag (16) + ciphertext
  const ephPubBytes = Buffer.from(ephemeralPubKey.slice(2), 'hex'); // Remove 0x prefix
  const result = Buffer.concat([ephPubBytes, iv, authTag, encrypted]);

  return '0x' + result.toString('hex');
}

// ══════════════════════════════════════════════════════════════
// INTENT MATCHING
// ══════════════════════════════════════════════════════════════

function matchIntents(intents) {
  const internalMatches = [];
  const ammSettlements = [];
  const matched = new Set();

  // Group by token pair
  const pairs = {};
  for (const intent of intents) {
    const pairKey = [intent.tokenIn, intent.tokenOut].sort().join('-');
    if (!pairs[pairKey]) pairs[pairKey] = { buys: [], sells: [] };

    // Determine if buy or sell based on token order
    const isBuy = intent.tokenIn < intent.tokenOut;
    if (isBuy) {
      pairs[pairKey].buys.push(intent);
    } else {
      pairs[pairKey].sells.push(intent);
    }
  }

  // Match buys with sells (FIFO)
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

      // Match at minimum of both amounts
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

  // Unmatched intents go to AMM
  for (const intent of intents) {
    if (!matched.has(intent.intentId)) {
      const zeroForOne = intent.tokenIn.toLowerCase() < intent.tokenOut.toLowerCase();
      ammSettlements.push({
        intentId: intent.intentId,
        stealthAddress: '', // Will be filled with generated stealth address
        amountOut: intent.amountIn, // Simplified: 1:1 for hackathon
        zeroForOne,
      });
    }
  }

  return { internalMatches, ammSettlements, matched };
}

// ══════════════════════════════════════════════════════════════
// STEALTH ADDRESS GENERATION
// ══════════════════════════════════════════════════════════════

function generateStealthAddress() {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
}

// ══════════════════════════════════════════════════════════════
// RELEASE GENERATION
// ══════════════════════════════════════════════════════════════

function generateReleases(intents, internalMatches, ammSettlements) {
  const releases = [];
  const currentTime = Math.floor(Date.now() / 1000);

  // Create intent lookup
  const intentMap = {};
  for (const intent of intents) {
    intentMap[intent.intentId] = intent;
  }

  // Generate releases for internal matches (both sides get output)
  for (const match of internalMatches) {
    const buyIntent = intentMap[match.buyIntentId];
    const sellIntent = intentMap[match.sellIntentId];

    // Buyer gets tokenOut (what they wanted)
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

    // Seller gets tokenOut (what they wanted)
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

  // Generate releases for AMM settlements
  for (const settlement of ammSettlements) {
    const intent = intentMap[settlement.intentId];
    const stealth = generateStealthAddress();
    const delay = MIN_DELAY + crypto.randomInt(MAX_DELAY - MIN_DELAY + 1);

    // Update settlement with stealth address
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

  // Encode batch data for hashing
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  
  // Encode internal matches
  const encodedMatches = internalMatches.map(m => [m.buyIntentId, m.sellIntentId, m.matchedAmount]);
  
  // Encode settlements
  const encodedSettlements = ammSettlements.map(s => [s.intentId, s.stealthAddress, s.amountOut, s.zeroForOne]);
  
  // Encode releases
  const encodedReleases = releases.map(r => [
    r.token,
    r.stealthAddress,
    r.amount,
    r.releaseTime,
    r.encryptedStealthKey,
    r.intentId,
    r.executed
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
  
  return {
    signature,
    signerAddress: teeWallet.address,
  };
}

// ══════════════════════════════════════════════════════════════
// MAIN PROCESSING
// ══════════════════════════════════════════════════════════════

async function processIntents(intents) {
  console.log(`[TEE] Processing ${intents.length} intents...`);

  if (intents.length === 0) {
    return { error: 'No intents to process' };
  }

  // Step 1: Match intents
  const { internalMatches, ammSettlements } = matchIntents(intents);
  console.log(`[TEE] Internal matches: ${internalMatches.length}`);
  console.log(`[TEE] AMM settlements: ${ammSettlements.length}`);

  // Step 2: Generate stealth addresses and releases
  const releases = generateReleases(intents, internalMatches, ammSettlements);
  console.log(`[TEE] Releases generated: ${releases.length}`);

  // Step 3: Generate batch ID and timestamp
  const timestamp = Math.floor(Date.now() / 1000);
  const batchId = ethers.keccak256(ethers.toUtf8Bytes(`batch-${timestamp}-${crypto.randomUUID()}`));

  // Step 4: Sign the batch
  const { signature, signerAddress } = await signBatch(
    internalMatches,
    ammSettlements,
    releases,
    batchId,
    timestamp
  );
  console.log(`[TEE] Batch signed by: ${signerAddress}`);

  // Step 5: Construct output
  const result = {
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

  return result;
}

// ══════════════════════════════════════════════════════════════
// iEXEC ENTRY POINT
// ══════════════════════════════════════════════════════════════

async function main() {
  console.log('[TEE] MoleSwap Matching Engine v3 starting...');
  console.log('[TEE] Running inside SGX enclave');

  try {
    // Read input from iExec environment
    const inputDir = process.env.IEXEC_IN || '/iexec_in';
    const outputDir = process.env.IEXEC_OUT || '/iexec_out';

    let intents;

    // Try to read from IEXEC_APP_ARGS first (passed from oracle)
    if (process.env.IEXEC_APP_ARGS) {
      intents = JSON.parse(process.env.IEXEC_APP_ARGS);
      console.log(`[TEE] Read ${intents.length} intents from IEXEC_APP_ARGS`);
    } else {
      // Fall back to reading from input file
      const inputPath = `${inputDir}/intents.json`;
      if (fs.existsSync(inputPath)) {
        intents = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
        console.log(`[TEE] Read ${intents.length} intents from file`);
      } else {
        throw new Error('No intents provided');
      }
    }

    // Process intents
    const result = await processIntents(intents);

    // Write output
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(`${outputDir}/result.json`, JSON.stringify(result, null, 2));
    fs.writeFileSync(`${outputDir}/computed.json`, JSON.stringify({ 
      'result-path': '/result.json' 
    }));

    console.log('[TEE] Processing complete!');
    console.log(`[TEE] Output written to ${outputDir}/result.json`);

  } catch (error) {
    console.error('[TEE] Error:', error.message);
    
    const outputDir = process.env.IEXEC_OUT || '/iexec_out';
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(`${outputDir}/result.json`, JSON.stringify({ error: error.message }));
    fs.writeFileSync(`${outputDir}/computed.json`, JSON.stringify({ 
      'result-path': '/result.json' 
    }));
    
    process.exit(1);
  }
}

main();
