import { describe, expect, it } from 'vitest';
import { BUCKET_COUNT, bucketFor, murmur3 } from '../src/core/hash.js';

describe('murmur3', () => {
  it('matches the reference implementation test vectors', () => {
    expect(murmur3('', 0)).toBe(0);
    expect(murmur3('', 1)).toBe(0x514e28b7);
    expect(murmur3('test', 0)).toBe(0xba6bd213);
    expect(murmur3('hello', 0)).toBe(0x248bfa47);
    expect(murmur3('The quick brown fox jumps over the lazy dog', 0)).toBe(0x2e4ff723);
  });

  it('hashes multi-byte UTF-8 input without throwing', () => {
    expect(murmur3('ユーザー-42')).toBe(murmur3('ユーザー-42'));
  });
});

describe('bucketFor', () => {
  it('is deterministic', () => {
    expect(bucketFor('salt:variant:user-1')).toBe(bucketFor('salt:variant:user-1'));
  });

  it('spreads users uniformly across buckets', () => {
    const deciles = new Array(10).fill(0);
    const users = 100_000;
    for (let i = 0; i < users; i++) {
      deciles[Math.floor((bucketFor(`s:user-${i}`) / BUCKET_COUNT) * 10)]++;
    }
    for (const count of deciles) {
      expect(Math.abs(count - users / 10) / (users / 10)).toBeLessThan(0.03);
    }
  });
});
