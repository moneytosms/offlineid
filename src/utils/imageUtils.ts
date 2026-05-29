// src/utils/imageUtils.ts

/**
 * Preprocess a single grayscale-intensity frame for model inference.
 *
 * Pipeline (per SPEC §15.1):
 *   1. Histogram equalisation (harsh sunlight / low light).
 *   2. Auto-gamma correction (compensates for shadows).
 *   3. Bilinear resize to `targetSize` (640 for detector, 112 for recogniser).
 *   4. Normalise to [-1, 1].
 *
 * `frame` is treated as a square buffer of 8-bit intensity values
 * (length must be a perfect square).
 *
 * @param frame - Source intensity bytes (square, row-major).
 * @param targetSize - Output side length in pixels.
 * @returns Float32Array of length targetSize*targetSize in [-1, 1].
 */
export function preprocessFrame(frame: Uint8Array, targetSize: number): Float32Array {
  // Step 1: Histogram equalisation (handles harsh sunlight / low light)
  const equalised = histogramEqualise(frame);

  // Step 2: Gamma correction (compensates for shadows)
  const gamma = estimateGamma(equalised); // auto-gamma based on mean luminance
  const corrected = applyGamma(equalised, gamma);

  // Step 3: Resize to target (640×640 for detector, 112×112 for recogniser)
  const resized = bilinearResize(corrected, targetSize);

  // Step 4: Normalise to [-1, 1]
  return new Float32Array(resized).map((v) => (v / 255.0 - 0.5) / 0.5);
}

/**
 * Apply global histogram equalisation to an 8-bit intensity buffer.
 * Redistributes intensities using the normalised cumulative histogram,
 * stretching contrast across the full [0, 255] range.
 *
 * @param frame - Source intensity bytes.
 * @returns New equalised buffer (same length).
 */
export function histogramEqualise(frame: Uint8Array): Uint8Array {
  const n = frame.length;
  const out = new Uint8Array(n);
  if (n === 0) return out;

  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[frame[i]]++;

  // Cumulative distribution function.
  const cdf = new Uint32Array(256);
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    cdf[v] = acc;
  }

  // First non-zero CDF value (cdf_min) for normalisation.
  let cdfMin = 0;
  for (let v = 0; v < 256; v++) {
    if (cdf[v] !== 0) {
      cdfMin = cdf[v];
      break;
    }
  }

  const denom = n - cdfMin;
  if (denom <= 0) {
    // Degenerate (single intensity) — leave unchanged.
    out.set(frame);
    return out;
  }

  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.round(((cdf[v] - cdfMin) / denom) * 255);
  }
  for (let i = 0; i < n; i++) out[i] = lut[frame[i]];
  return out;
}

/**
 * Estimate a gamma value from mean luminance.
 * Dark frames (low mean) get gamma < 1 to brighten; bright frames get
 * gamma > 1 to darken. Derived so that mean maps toward mid-grey (0.5).
 *
 * @param frame - Source intensity bytes.
 * @returns Gamma exponent (clamped to a sane [0.4, 2.5] range).
 */
export function estimateGamma(frame: Uint8Array): number {
  const n = frame.length;
  if (n === 0) return 1.0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += frame[i];
  const mean = sum / n / 255.0; // normalised mean luminance in (0, 1)
  if (mean <= 0 || mean >= 1) return 1.0;
  // Solve mean^gamma = 0.5  ->  gamma = log(0.5)/log(mean).
  const gamma = Math.log(0.5) / Math.log(mean);
  return Math.min(2.5, Math.max(0.4, gamma));
}

/**
 * Apply gamma correction via a precomputed lookup table.
 *
 * @param frame - Source intensity bytes.
 * @param gamma - Gamma exponent (output = 255 * (in/255)^gamma).
 * @returns New gamma-corrected buffer (same length).
 */
export function applyGamma(frame: Uint8Array, gamma: number): Uint8Array {
  const n = frame.length;
  const out = new Uint8Array(n);
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.min(255, Math.round(255 * Math.pow(v / 255, gamma)));
  }
  for (let i = 0; i < n; i++) out[i] = lut[frame[i]];
  return out;
}

/**
 * Bilinearly resize a square intensity buffer to `targetSize`×`targetSize`.
 * Source side length is inferred as sqrt(frame.length).
 *
 * @param frame - Source intensity bytes (square, row-major).
 * @param targetSize - Output side length in pixels.
 * @returns Resized buffer of length targetSize*targetSize.
 * @throws If the source buffer is not square.
 */
export function bilinearResize(frame: Uint8Array, targetSize: number): Uint8Array {
  const srcSize = Math.round(Math.sqrt(frame.length));
  if (srcSize * srcSize !== frame.length) {
    throw new Error('bilinearResize expects a square source buffer');
  }
  const out = new Uint8Array(targetSize * targetSize);
  if (targetSize === 0) return out;
  if (srcSize === 1) {
    out.fill(frame[0]);
    return out;
  }

  // Map output pixel centres back into source coordinates.
  const scale = (srcSize - 1) / (targetSize - 1 || 1);
  for (let y = 0; y < targetSize; y++) {
    const sy = y * scale;
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, srcSize - 1);
    const wy = sy - y0;
    for (let x = 0; x < targetSize; x++) {
      const sx = x * scale;
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, srcSize - 1);
      const wx = sx - x0;

      const p00 = frame[y0 * srcSize + x0];
      const p01 = frame[y0 * srcSize + x1];
      const p10 = frame[y1 * srcSize + x0];
      const p11 = frame[y1 * srcSize + x1];

      const top = p00 + (p01 - p00) * wx;
      const bottom = p10 + (p11 - p10) * wx;
      out[y * targetSize + x] = Math.round(top + (bottom - top) * wy);
    }
  }
  return out;
}

/**
 * Convert a YUV (NV21-style, full-range BT.601) buffer to packed RGB.
 *
 * STUB: native camera frames arrive as YUV; the production path will convert
 * on the native side for performance. This TS reference is intentionally
 * minimal and currently unimplemented.
 *
 * @param _yuv - Interleaved/planar YUV bytes.
 * @param _width - Frame width in pixels.
 * @param _height - Frame height in pixels.
 * @returns Packed RGB bytes (length width*height*3).
 */
export function yuvToRgb(_yuv: Uint8Array, _width: number, _height: number): Uint8Array {
  throw new Error('yuvToRgb not implemented: conversion handled natively');
}
