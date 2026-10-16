/**
 * MurmurHash3 (x86, 32-bit) — the same family of hash Optimizely and other
 * experimentation SDKs use for bucketing. It is fast, well distributed, and
 * deterministic, so a user lands in the same bucket on every server, every
 * SDK, and every re-evaluation without storing anything.
 */

const encoder = new TextEncoder();

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

function rotl32(x: number, r: number): number {
  return (x << r) | (x >>> (32 - r));
}

export function murmur3(input: string, seed = 0): number {
  const data = encoder.encode(input);
  const length = data.length;
  const blockCount = length >>> 2;
  let h = seed >>> 0;

  for (let i = 0; i < blockCount; i++) {
    const o = i * 4;
    let k = data[o]! | (data[o + 1]! << 8) | (data[o + 2]! << 16) | (data[o + 3]! << 24);
    k = Math.imul(k, C1);
    k = rotl32(k, 15);
    k = Math.imul(k, C2);
    h ^= k;
    h = rotl32(h, 13);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  const tail = blockCount * 4;
  let k = 0;
  const remainder = length & 3;
  if (remainder >= 3) k ^= data[tail + 2]! << 16;
  if (remainder >= 2) k ^= data[tail + 1]! << 8;
  if (remainder >= 1) {
    k ^= data[tail]!;
    k = Math.imul(k, C1);
    k = rotl32(k, 15);
    k = Math.imul(k, C2);
    h ^= k;
  }

  // Finalization mix: forces all bits of the hash to avalanche.
  h ^= length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 10,000 buckets gives 0.01% traffic granularity. */
export const BUCKET_COUNT = 10_000;

export function bucketFor(key: string): number {
  return murmur3(key) % BUCKET_COUNT;
}
