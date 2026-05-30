// src/utils/crypto.ts
//
// AES-256-GCM encryption for face embeddings at rest (SPEC §7).
//
// Uses @noble/ciphers (pure-JS AES-GCM) rather than WebCrypto `crypto.subtle`,
// which does not exist on Hermes/React Native. Randomness comes from
// `crypto.getRandomValues`, polyfilled by `react-native-get-random-values`
// (imported once in `index.js`) on device and provided by Node in tests.
import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, hexToBytes } from '@noble/ciphers/utils.js';
import EncryptedStorage from 'react-native-encrypted-storage';

const KEY_ALIAS = 'offlineid_embedding_key';

/** Length of the AES-GCM IV (nonce) prepended to every ciphertext, in bytes. */
const IV_LENGTH = 12;

/** AES-256 key length, in bytes. */
const KEY_LENGTH = 32;

/**
 * Load the raw 32-byte AES-256 key from secure storage, creating one on first
 * use. Persisted hex-encoded via the platform keystore.
 *
 * @returns The raw 32-byte key.
 */
async function getOrCreateKey(): Promise<Uint8Array> {
  let keyHex = await EncryptedStorage.getItem(KEY_ALIAS);
  if (!keyHex) {
    const keyBytes = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
    keyHex = bytesToHex(keyBytes);
    await EncryptedStorage.setItem(KEY_ALIAS, keyHex);
  }
  return hexToBytes(keyHex);
}

/**
 * Encrypt a face embedding with AES-256-GCM.
 * Output layout: [12-byte IV][ciphertext+GCM tag].
 *
 * @param embedding - The Float32Array embedding to encrypt.
 * @returns IV-prefixed ciphertext bytes.
 */
export async function encryptEmbedding(
  embedding: Float32Array,
): Promise<Uint8Array> {
  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new Uint8Array(
    embedding.buffer,
    embedding.byteOffset,
    embedding.byteLength,
  );
  const ciphertext = gcm(key, iv).encrypt(plaintext);

  // Prepend IV to ciphertext (+ GCM tag already appended by noble).
  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(ciphertext, IV_LENGTH);
  return result;
}

/**
 * Decrypt an embedding produced by {@link encryptEmbedding}.
 * Strips the leading 12-byte IV, AES-GCM decrypts the remainder, and
 * reinterprets the plaintext bytes as a Float32Array.
 *
 * @param payload - IV-prefixed ciphertext from {@link encryptEmbedding}.
 * @returns The recovered embedding.
 */
export async function decryptEmbedding(
  payload: Uint8Array,
): Promise<Float32Array> {
  const key = await getOrCreateKey();
  const iv = payload.subarray(0, IV_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH);
  const decrypted = gcm(key, iv).decrypt(ciphertext);

  // Copy into a fresh, correctly-aligned buffer before the Float32Array view.
  const aligned = new Uint8Array(decrypted.byteLength);
  aligned.set(decrypted);
  return new Float32Array(aligned.buffer);
}
