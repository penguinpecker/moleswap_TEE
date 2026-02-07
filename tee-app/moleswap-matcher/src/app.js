/**
 * MoleSwap TEE Matching Engine v3
 * iExec SCONE-compatible - Base64 encoded input
 */

import { ethers } from 'ethers';
import crypto from 'crypto';
import fs from 'fs';
const MIN_DELAY = 60;
const MAX_DELAY = 180;
const TEE_SIGNER_KEY = '0x33cdac836c7be7cc81918ffee22d21c349934db2a96313e04637560f18d44502';

function readIntents() {
  const inputDir = process.env.IEXEC_IN || '/iexec_in';
  
  console.log('[TEE] Checking input sources...');
  console.log('[TEE] argv length:', process.argv.length);
  
  // Method 1: Single base64-encoded argument
  if (process.argv[2]) {
    const arg = process.argv[2];
    console.log('[TEE] argv[2] length:', arg.length);
    console.log('[TEE] argv[2] (first 100 chars):', arg.substring(0, 100));
    
    // Try base64 decode first
    try {
      const decoded = Buffer.from(arg, 'base64').toString('utf8');
      console.log('[TEE] Base64 decoded (first 200 chars):', decoded.substring(0, 200));
      const parsed = JSON.parse(decoded);
      console.log('[TEE] Successfully parsed base64 decoded JSON');
      if (Array.isArray(parsed)) return parsed;
      if (parsed.intents) return parsed.intents;
      return [parsed];
    } catch (e) {
      console.log('[TEE] Base64 decode failed:', e.message);
    }
    
    // Try direct JSON parse
    try {
      const parsed = JSON.parse(arg);
      console.log('[TEE] Successfully parsed direct JSON');
      if (Array.isArray(parsed)) return parsed;
      if (parsed.intents) return parsed.intents;
      return [parsed];
    } catch (e) {
      console.log('[TEE] Direct parse failed:', e.message);
    }
  }

  // Method 2: Check for files in input directory
  try {
    const files = fs.readdirSync(inputDir);
    console.log('[TEE] Input dir files:', files);
    
    for (const file of files) {
      if (file.endsWith('.json') || file === 'args.txt') {
        console.log(`[TEE] Trying file: ${file}`);
        const content = fs.readFileSync(`${inputDir}/${file}`, 'utf8');
        try {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) return parsed;
          if (parsed.intents) return parsed.intents;
        } catch (e) {
          console.log(`[TEE] Failed to parse ${file}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.log('[TEE] Could not read input dir:', e.message);
  }

  console.log('[TEE] No intents found');
  return [];
}

function eciesEncrypt(plaintext, recipientPubKeyHex) {
  try {
    if (!recipientPubKeyHex || recipientPubKeyHex.length < 66) return '0x';
    const ephemeralWallet = ethers.Wallet.createRandom();
    const sharedSecret = new ethers.SigningKey(ephemeralWallet.privateKey).computeSharedSecret(recipientPubKeyHex);
    const encryptionKey = crypto.createHash('sha256').update(Buffer.from(sharedSecret.slice(2), 'hex')).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    const result = Buffer.concat([Buffer.from(ephemeralWallet.signingKey.publicKey.slice(2), 'hex'), iv, cipher.getAuthTag(), encrypted]);
    return '0x' + result.toString('hex');
  } catch (e) {
    console.log('[TEE] ECIES error:', e.message);
    return '0x';
  }
}

function matchIntents(intents) {
  const internalMatches = [];
  const ammSettlements = [];
  const matched = new Set();

  const pairs = {};
  for (const intent of intents) {
    const pairKey = [intent.tokenIn, intent.tokenOut].sort().join('-');
    if (!pairs[pairKey]) pairs[pairKey] = { buys: [], sells: [] };
    const isBuy = intent.tokenIn.toLowerCase() < intent.tokenOut.toLowerCase();
    if (isBuy) pairs[pairKey].buys.push(intent);
    else pairs[pairKey].sells.push(intent);
  }

  for (const pairKey of Object.keys(pairs)) {
    const { buys, sells } = pairs[pairKey];
    let buyIdx = 0, sellIdx = 0;
    while (buyIdx < buys.length && sellIdx < sells.length) {
      const buy = buys[buyIdx], sell = sells[sellIdx];
      if (matched.has(buy.intentId) || matched.has(sell.intentId)) {
        if (matched.has(buy.intentId)) buyIdx++;
        if (matched.has(sell.intentId)) sellIdx++;
        continue;
      }
      const matchedAmount = BigInt(buy.amountIn) < BigInt(sell.amountIn) ? buy.amountIn : sell.amountIn;
      internalMatches.push({ buyIntentId: buy.intentId, sellIntentId: sell.intentId, matchedAmount: matchedAmount.toString() });
      matched.add(buy.intentId);
      matched.add(sell.intentId);
      buyIdx++;
      sellIdx++;
    }
  }

  for (const intent of intents) {
    if (!matched.has(intent.intentId)) {
      const zeroForOne = intent.tokenIn.toLowerCase() < intent.tokenOut.toLowerCase();
      ammSettlements.push({ intentId: intent.intentId, stealthAddress: '', amountOut: intent.amountIn, zeroForOne });
    }
  }

  return { internalMatches, ammSettlements, matched };
}

function generateStealthAddress() {
  const wallet = ethers.Wallet.createRandom();
  return { address: wallet.address, privateKey: wallet.privateKey };
}

function generateReleases(intents, internalMatches, ammSettlements) {
  const releases = [];
  const currentTime = Math.floor(Date.now() / 1000);
  const intentMap = {};
  for (const intent of intents) intentMap[intent.intentId] = intent;

  for (const match of internalMatches) {
    const buyIntent = intentMap[match.buyIntentId];
    const sellIntent = intentMap[match.sellIntentId];
    if (buyIntent) {
      const stealth = generateStealthAddress();
      const delay = MIN_DELAY + crypto.randomInt(MAX_DELAY - MIN_DELAY + 1);
      releases.push({
        token: buyIntent.tokenOut, stealthAddress: stealth.address, amount: match.matchedAmount,
        releaseTime: currentTime + delay, encryptedStealthKey: eciesEncrypt(stealth.privateKey, buyIntent.viewingPubKey),
        intentId: match.buyIntentId, executed: false,
      });
    }
    if (sellIntent) {
      const stealth = generateStealthAddress();
      const delay = MIN_DELAY + crypto.randomInt(MAX_DELAY - MIN_DELAY + 1);
      releases.push({
        token: sellIntent.tokenOut, stealthAddress: stealth.address, amount: match.matchedAmount,
        releaseTime: currentTime + delay, encryptedStealthKey: eciesEncrypt(stealth.privateKey, sellIntent.viewingPubKey),
        intentId: match.sellIntentId, executed: false,
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
      token: intent.tokenOut, stealthAddress: stealth.address, amount: settlement.amountOut,
      releaseTime: currentTime + delay, encryptedStealthKey: eciesEncrypt(stealth.privateKey, intent.viewingPubKey),
      intentId: settlement.intentId, executed: false,
    });
  }

  return releases;
}

async function signBatch(internalMatches, ammSettlements, releases, batchId, timestamp) {
  const teeWallet = new ethers.Wallet(TEE_SIGNER_KEY);
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  
  const encodedMatches = internalMatches.map(m => [m.buyIntentId, m.sellIntentId, m.matchedAmount]);
  const encodedSettlements = ammSettlements.map(s => [s.intentId, s.stealthAddress, s.amountOut, s.zeroForOne]);
  const encodedReleases = releases.map(r => [r.token, r.stealthAddress, r.amount, r.releaseTime, r.encryptedStealthKey, r.intentId, r.executed]);

  const batchHash = ethers.keccak256(abiCoder.encode(
    ['tuple(bytes32,bytes32,uint256)[]', 'tuple(bytes32,address,uint256,bool)[]', 'tuple(address,address,uint256,uint256,bytes,bytes32,bool)[]', 'bytes32', 'uint256'],
    [encodedMatches, encodedSettlements, encodedReleases, batchId, timestamp]
  ));

  const signature = await teeWallet.signMessage(ethers.getBytes(batchHash));
  return { signature, signerAddress: teeWallet.address };
}

async function processIntents(intents) {
  console.log(`[TEE] Processing ${intents.length} intents...`);

  if (!intents || intents.length === 0) {
    const teeWallet = new ethers.Wallet(TEE_SIGNER_KEY);
    return {
      settlementBatch: { internalMatches: [], ammSettlements: [], releases: [], batchId: ethers.ZeroHash, timestamp: Math.floor(Date.now() / 1000), teeSignature: '0x' },
      teeSigner: teeWallet.address,
      summary: { totalIntents: 0, internalMatches: 0, ammSwaps: 0, releasesQueued: 0 },
    };
  }

  const { internalMatches, ammSettlements } = matchIntents(intents);
  console.log(`[TEE] Internal matches: ${internalMatches.length}`);
  console.log(`[TEE] AMM settlements: ${ammSettlements.length}`);

  const releases = generateReleases(intents, internalMatches, ammSettlements);
  console.log(`[TEE] Releases: ${releases.length}`);

  const timestamp = Math.floor(Date.now() / 1000);
  const batchId = ethers.keccak256(ethers.toUtf8Bytes(`batch-${timestamp}-${crypto.randomUUID()}`));

  const { signature, signerAddress } = await signBatch(internalMatches, ammSettlements, releases, batchId, timestamp);
  console.log(`[TEE] Signed by: ${signerAddress}`);

  return {
    settlementBatch: { internalMatches, ammSettlements, releases, batchId, timestamp, teeSignature: signature },
    teeSigner: signerAddress,
    summary: { totalIntents: intents.length, internalMatches: internalMatches.length, ammSwaps: ammSettlements.length, releasesQueued: releases.length, batchId },
  };
}

async function main() {
  console.log('[TEE] MoleSwap Matching Engine v3');
  const outputDir = process.env.IEXEC_OUT || '/iexec_out';

  try {
    const intents = readIntents();
    console.log(`[TEE] Loaded ${intents.length} intents`);
    
    const result = await processIntents(intents);

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(`${outputDir}/result.json`, JSON.stringify(result, null, 2));
    fs.writeFileSync(`${outputDir}/computed.json`, JSON.stringify({ 'deterministic-output-path': '/iexec_out/result.json' }));

    console.log('[TEE] Complete!');
  } catch (error) {
    console.error('[TEE] Error:', error.message);
    console.error('[TEE] Stack:', error.stack);
    
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(`${outputDir}/result.json`, JSON.stringify({ error: error.message, settlementBatch: { internalMatches: [], ammSettlements: [], releases: [], batchId: ethers.ZeroHash, timestamp: Math.floor(Date.now() / 1000), teeSignature: '0x' } }));
    fs.writeFileSync(`${outputDir}/computed.json`, JSON.stringify({ 'deterministic-output-path': '/iexec_out/result.json' }));
    
    process.exit(1);
  }
}

main();
