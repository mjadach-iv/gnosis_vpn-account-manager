// Recover the EOA (chain key) from an on-disk HOPR identity keystore + password.
//
// The .id file is a web3 secret-storage keystore (scrypt KDF + AES-128-CTR +
// keccak256 MAC). Node's crypto handles the KDF, cipher and secp256k1 priv->pub;
// our own keccak256 handles the MAC, address hash and EIP-55 checksum — so this
// works fully offline, without the service or any external dependency.

import crypto from 'node:crypto';
import { keccak256 } from './keccak.js';

// Decrypt the keystore buffer with `password`, returning the 32-byte chain key.
function decryptKeystore(idBuf, password) {
  const ks = JSON.parse(idBuf.toString('utf8'));
  const c = ks.crypto || ks.Crypto;
  if (!c) throw new Error('not a keystore JSON (no crypto section)');
  if (c.kdf !== 'scrypt') throw new Error(`unsupported KDF: ${c.kdf}`);
  if (c.cipher !== 'aes-128-ctr') throw new Error(`unsupported cipher: ${c.cipher}`);

  const kdf = c.kdfparams;
  const dk = crypto.scryptSync(Buffer.from(password), Buffer.from(kdf.salt, 'hex'), kdf.dklen, {
    N: kdf.n,
    r: kdf.r,
    p: kdf.p,
    maxmem: 256 * kdf.n * kdf.r + 1024 * 1024,
  });

  const ct = Buffer.from(c.ciphertext, 'hex');
  const mac = keccak256(Buffer.concat([dk.subarray(16, 32), ct])).toString('hex');
  if (mac !== c.mac.toLowerCase()) throw new Error('MAC mismatch (wrong password or corrupt file)');

  const decipher = crypto.createDecipheriv(
    'aes-128-ctr',
    dk.subarray(0, 16),
    Buffer.from(c.cipherparams.iv, 'hex'),
  );
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.length === 32 ? pt : Buffer.from(JSON.parse(pt.toString('utf8')).chain_key, 'hex');
}

// EIP-55 checksummed 0x-address from a 20-byte buffer.
function toChecksumAddress(addrBuf) {
  const hex = addrBuf.toString('hex');
  const hash = keccak256(Buffer.from(hex)).toString('hex');
  let out = '0x';
  for (let i = 0; i < hex.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  }
  return out;
}

// 32-byte private key -> EIP-55 EOA address.
function privateKeyToAddress(priv) {
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(priv);
  const pub = ecdh.getPublicKey(); // 65 bytes: 0x04 || X(32) || Y(32)
  const hash = keccak256(pub.subarray(1)); // keccak256(X || Y)
  return toChecksumAddress(hash.subarray(12)); // last 20 bytes
}

// Derive { privateKey, address } from the identity + password buffers.
// The .pass file often carries a trailing newline; if the raw password fails
// the MAC check, retry once with trailing whitespace stripped.
export function deriveEoa(idBuf, passBuf) {
  const raw = passBuf.toString('utf8');
  let chainKey;
  try {
    chainKey = decryptKeystore(idBuf, raw);
  } catch (err) {
    const trimmed = raw.replace(/[\r\n]+$/, '');
    if (trimmed === raw) throw err;
    chainKey = decryptKeystore(idBuf, trimmed);
  }
  return { privateKey: `0x${chainKey.toString('hex')}`, address: privateKeyToAddress(chainKey) };
}
