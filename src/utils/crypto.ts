// src/utils/crypto.ts
import EncryptedStorage from 'react-native-encrypted-storage';

const KEY_ALIAS = 'offlineid_embedding_key';

/** Length of the AES-GCM IV (nonce) prepended to every ciphertext, in bytes. */
const IV_LENGTH = 12;

/**
 * Load the AES-256-GCM key from secure storage, creating one on first use.
 * The raw 32-byte key is persisted base64-encoded via the platform keystore.
 *
 * @returns A non-extractable {@link CryptoKey} usable for encrypt/decrypt.
 */
export async function getOrCreateKey(): Promise<CryptoKey> {
  let keyBase64 = await EncryptedStorage.getItem(KEY_ALIAS);
  if (!keyBase64) {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    keyBase64 = Buffer.from(keyBytes).toString('base64');
    await EncryptedStorage.setItem(KEY_ALIAS, keyBase64);
  }
  return crypto.subtle.importKey('raw', Buffer.from(keyBase64, 'base64'), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt a face embedding with AES-256-GCM.
 * Output layout: [12-byte IV][ciphertext+GCM tag].
 *
 * @param embedding - The Float32Array embedding to encrypt.
 * @returns IV-prefixed ciphertext bytes.
 */
export async function encryptEmbedding(embedding: Float32Array): Promise<Uint8Array> {
  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  // Pass an explicit byte view (BufferSource); avoids ArrayBufferLike/SharedArrayBuffer typing.
  const plaintext = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  // Prepend IV to ciphertext
  const result = new Uint8Array(IV_LENGTH + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), IV_LENGTH);
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
export async function decryptEmbedding(payload: Uint8Array): Promise<Float32Array> {
  const key = await getOrCreateKey();
  const iv = payload.subarray(0, IV_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  // Copy into a fresh, correctly-aligned buffer before the Float32Array view.
  const aligned = new Uint8Array(decrypted.byteLength);
  aligned.set(new Uint8Array(decrypted));
  return new Float32Array(aligned.buffer);
}
