// src/utils/cosineDistance.ts

/** An enrolled identity with its L2-normalised embedding. */
export interface EnrolledEmbedding {
  employeeId: string;
  embedding: Float32Array;
}

/** Result of a successful match. */
export interface MatchResult {
  employeeId: string;
  score: number;
}

/**
 * Compute cosine similarity between two L2-normalised embeddings.
 * Both vectors must already be L2-normalised (norm = 1.0).
 * Returns value in [-1, 1]; threshold: > 0.40 = match (on-device calibrated).
 *
 * @param a - First L2-normalised embedding.
 * @param b - Second L2-normalised embedding.
 * @returns Cosine similarity (the dot product, since both are unit vectors).
 * @throws If the embedding dimensions do not match.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('Embedding dimension mismatch');
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // already normalised, so ||a||=||b||=1
}

/**
 * Find best match from a list of enrolled embeddings.
 * Returns employeeId + score, or null if no match above threshold.
 *
 * @param queryEmbedding - The probe embedding to match.
 * @param enrolled - Candidate enrolled embeddings.
 * @param threshold - Minimum cosine similarity to accept (default 0.40).
 * @returns Best match above threshold, or null.
 */
export function findBestMatch(
  queryEmbedding: Float32Array,
  enrolled: EnrolledEmbedding[],
  threshold = 0.4,
): MatchResult | null {
  let bestScore = -Infinity;
  let bestId: string | null = null;
  for (const { employeeId, embedding } of enrolled) {
    const score = cosineSimilarity(queryEmbedding, embedding);
    if (score > bestScore) {
      bestScore = score;
      bestId = employeeId;
    }
  }
  if (bestId && bestScore >= threshold) return { employeeId: bestId, score: bestScore };
  return null;
}
