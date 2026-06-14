// AES-256-GCM encryption for account file blobs.
//
// The key is derived as sha256(ENCRYPTION_KEY), giving a fixed 32-byte key for
// any key string. Each encryption uses a fresh random 12-byte IV. The stored
// value is base64( iv | authTag | ciphertext ).

import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16; // GCM auth tag length

function deriveKey(encryptionKey) {
  if (!encryptionKey) throw new Error('ENCRYPTION_KEY is required for crypto operations');
  return crypto.createHash('sha256').update(String(encryptionKey)).digest();
}

// encrypt(Buffer|string) -> base64 string
export function encrypt(plaintext, encryptionKey) {
  const key = deriveKey(encryptionKey);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

// decrypt(base64 string) -> Buffer
export function decrypt(payload, encryptionKey) {
  const key = deriveKey(encryptionKey);
  const data = Buffer.from(payload, 'base64');
  if (data.length < IV_LEN + TAG_LEN) throw new Error('Encrypted payload is too short / corrupt');
  const iv = data.subarray(0, IV_LEN);
  const authTag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = data.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
