#!/usr/bin/env node
// HOPR identity keystore -> Ethereum private key + address.
//
// Node.js port of hopr_decrypt.py. The keystore is a standard web3 secret-storage
// (scrypt KDF + AES-128-CTR + keccak256 MAC); Node's crypto handles the KDF and
// cipher, and viem handles keccak256 + address derivation.
//
//   node scripts/hopr-decrypt.mjs <keystore.json> <password>

import fs from 'node:fs';
import crypto from 'node:crypto';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const [, , ksPath, password] = process.argv;
if (!ksPath || password === undefined) {
  fail('usage: node scripts/hopr-decrypt.mjs <keystore.json> <password>');
}

const ks = JSON.parse(fs.readFileSync(ksPath, 'utf8'));
const c = ks.crypto;
const kdf = c.kdfparams;

if (c.kdf !== 'scrypt') fail(`unsupported KDF: ${c.kdf} (only scrypt)`);
if (c.cipher !== 'aes-128-ctr') fail(`unsupported cipher: ${c.cipher} (only aes-128-ctr)`);

// 1. Derive the key-encryption key with scrypt.
//    Node's default maxmem (32 MB) is too small for typical keystore N values;
//    size it to the cost parameters like the Python `maxmem` did.
const dk = crypto.scryptSync(
  Buffer.from(password),
  Buffer.from(kdf.salt, 'hex'),
  kdf.dklen,
  { N: kdf.n, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.n * kdf.r + 1024 * 1024 },
);

const ct = Buffer.from(c.ciphertext, 'hex');

// 2. Verify the MAC: keccak256(dk[16:32] || ciphertext) must equal stored mac.
const mac = keccak256(Buffer.concat([dk.subarray(16, 32), ct])).slice(2);
if (mac !== c.mac.toLowerCase()) {
  fail('MAC mismatch: wrong password or corrupted file');
}

// 3. Decrypt with AES-128-CTR using dk[0:16] and the stored IV.
const decipher = crypto.createDecipheriv(
  'aes-128-ctr',
  dk.subarray(0, 16),
  Buffer.from(c.cipherparams.iv, 'hex'),
);
const pt = Buffer.concat([decipher.update(ct), decipher.final()]);

// 4. The plaintext is either the 32-byte key directly, or JSON with a chain_key.
let chainKey;
if (pt.length === 32) {
  chainKey = pt;
} else {
  const inner = JSON.parse(pt.toString('utf8'));
  chainKey = Buffer.from(inner.chain_key, 'hex');
}

const privHex = toHex(chainKey); // 0x-prefixed
const account = privateKeyToAccount(privHex);

console.log(`chain_key: ${privHex}`);
console.log(`address:   ${account.address}`);
