// Pack/unpack the configuration embedded into a built binary.
//
// SECURITY NOTE: this is OBFUSCATION, not encryption-at-rest. The binary is
// self-contained — both the encrypted MySQL creds AND the (XOR-obfuscated)
// ENCRYPTION_KEY ship inside it. Anyone with the binary and some effort can
// recover the key and therefore the DB credentials and every saved account
// identity. The only thing this defeats is a casual `strings binary | grep`.

import { encrypt, decrypt } from './crypto.js';

// Fixed, source-visible secret used to lightly obfuscate the embedded key.
const OBFUSCATION_SECRET = 'gvpn-accounts::embedded::v1';

function xorBytes(buf, secret) {
  const s = Buffer.from(secret, 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ s[i % s.length];
  return out;
}

export function obfuscateKey(key) {
  return xorBytes(Buffer.from(key, 'utf8'), OBFUSCATION_SECRET).toString('base64');
}

export function deobfuscateKey(obf) {
  return xorBytes(Buffer.from(obf, 'base64'), OBFUSCATION_SECRET).toString('utf8');
}

// Build the embedded payload (a single base64 string) at build time.
// `mysql` = { host, user, password, database }, `encryptionKey` = string.
export function packEmbedded({ mysql, encryptionKey }) {
  const c = encrypt(JSON.stringify(mysql), encryptionKey); // creds, encrypted under the key
  const k = obfuscateKey(encryptionKey); // key, obfuscated (so it isn't greppable verbatim)
  return Buffer.from(JSON.stringify({ c, k }), 'utf8').toString('base64');
}

// Reverse of packEmbedded, run at startup inside the binary.
// Returns { mysql, encryptionKey }.
export function unpackEmbedded(payload) {
  const { c, k } = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  const encryptionKey = deobfuscateKey(k);
  const mysql = JSON.parse(decrypt(c, encryptionKey).toString('utf8'));
  return { mysql, encryptionKey };
}
