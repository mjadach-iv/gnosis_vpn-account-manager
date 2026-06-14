// Keccak-256 (the Ethereum variant, NOT NIST SHA3-256) — pure JS, no deps.
// Node's crypto only ships sha3-256, which uses different padding and would
// produce wrong Ethereum addresses, so we implement the permutation directly.
// Operates on and returns Buffers.

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const R = [
  [0n, 36n, 3n, 41n, 18n],
  [1n, 44n, 10n, 45n, 2n],
  [62n, 6n, 43n, 15n, 61n],
  [28n, 55n, 25n, 21n, 56n],
  [27n, 20n, 39n, 8n, 14n],
];
const M = (1n << 64n) - 1n;
const rot = (x, n) => (n === 0n ? x : (((x << n) | (x >> (64n - n))) & M));

export function keccak256(input) {
  const src = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const rate = 136; // 1088-bit rate for 256-bit output

  // Multi-rate padding (Keccak pad10*1 with the 0x01 domain byte).
  const pad = rate - (src.length % rate);
  let data;
  if (pad === 1) {
    data = Buffer.concat([src, Buffer.from([0x81])]);
  } else {
    data = Buffer.concat([src, Buffer.from([0x01]), Buffer.alloc(pad - 2), Buffer.from([0x80])]);
  }

  // State lanes s[x][y].
  const s = Array.from({ length: 5 }, () => new Array(5).fill(0n));

  for (let off = 0; off < data.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      s[i % 5][Math.floor(i / 5)] ^= data.readBigUInt64LE(off + i * 8);
    }
    for (const rc of RC) {
      // θ
      const C = new Array(5);
      for (let x = 0; x < 5; x++) C[x] = s[x][0] ^ s[x][1] ^ s[x][2] ^ s[x][3] ^ s[x][4];
      const D = new Array(5);
      for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rot(C[(x + 1) % 5], 1n);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x][y] ^= D[x];
      // ρ + π
      const B = Array.from({ length: 5 }, () => new Array(5).fill(0n));
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) B[y][(2 * x + 3 * y) % 5] = rot(s[x][y], R[x][y]);
      }
      // χ
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          s[x][y] = B[x][y] ^ ((~B[(x + 1) % 5][y] & M) & B[(x + 2) % 5][y]);
        }
      }
      // ι
      s[0][0] ^= rc;
    }
  }

  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i % 5][Math.floor(i / 5)] & M, i * 8);
  return out;
}
