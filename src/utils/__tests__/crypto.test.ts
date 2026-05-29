// In-memory stub for react-native-encrypted-storage.
jest.mock('react-native-encrypted-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
      setItem: jest.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
      removeItem: jest.fn(async (k: string) => {
        store.delete(k);
      }),
    },
  };
});

import { webcrypto } from 'crypto';
import { encryptEmbedding, decryptEmbedding } from '../crypto';

// Provide global crypto.subtle + getRandomValues (Node webcrypto) and Buffer.
beforeAll(() => {
  if (typeof (globalThis as { crypto?: unknown }).crypto === 'undefined') {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

describe('crypto roundtrip', () => {
  it('encrypt -> decrypt preserves the Float32Array', async () => {
    const original = new Float32Array([0.1, -0.5, 0.99, -1.0, 0.0, 0.333333]);
    const ciphertext = await encryptEmbedding(original);

    // IV (12) is prepended; ciphertext+tag follows.
    expect(ciphertext.length).toBeGreaterThan(12 + original.byteLength);

    const recovered = await decryptEmbedding(ciphertext);
    expect(recovered.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(recovered[i]).toBeCloseTo(original[i], 6);
    }
  });

  it('uses a fresh IV per call (distinct ciphertexts)', async () => {
    const emb = new Float32Array([1, 2, 3, 4]);
    const c1 = await encryptEmbedding(emb);
    const c2 = await encryptEmbedding(emb);
    expect(Buffer.from(c1).toString('base64')).not.toBe(Buffer.from(c2).toString('base64'));
  });
});
