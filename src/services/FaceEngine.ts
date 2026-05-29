/**
 * JS wrapper for the `FaceEngine` native module (SPEC §6.1).
 *
 * Exposes a thin, strongly-typed facade over `NativeModules.FaceEngine`
 * (implemented in Kotlin / Swift). Performs no inference itself — every method
 * marshals to native and resolves the native promise. If the native module is
 * not linked, the wrapper throws a clear error on first access so the failure
 * is diagnosable rather than a cryptic `undefined is not a function`.
 *
 * @module services/FaceEngine
 */

import { NativeModules } from 'react-native';

import { logger } from '../utils/logger';

const TAG = 'FaceEngine';

/** Axis-aligned face bounding box, in source-frame pixels. */
export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Result of {@link FaceEngine.detectFace} (SCRFD-500M). SPEC §6.1. */
export interface DetectionResult {
  /** Whether a face was found. */
  found: boolean;
  /** Bounding box in source-frame pixels (present iff `found`). */
  bbox?: BoundingBox;
  /** Five facial keypoints `[[x,y], ...]` for ArcFace alignment. */
  landmarks?: [number, number][];
  /** Detector confidence in [0,1]. */
  confidence?: number;
}

/** Result of {@link FaceEngine.checkLiveness} (FASNet). SPEC §6.1. */
export interface LivenessResult {
  /** Whether the crop is judged a live face. */
  isLive: boolean;
  /** Real-face probability in [0,1]. */
  score: number;
}

/** Result of {@link FaceEngine.getEmbedding} (MobileFaceNet). SPEC §6.1. */
export interface EmbeddingResult {
  /** 512-dim L2-normalised embedding. */
  embedding: number[];
  /** Native inference time, milliseconds. */
  inferenceMs: number;
}

/**
 * Native module contract (Kotlin + Swift). SPEC §6.1.
 *
 * `bbox` is passed as a `[x, y, w, h]` tuple and `landmarks` as a `[[x,y], ...]`
 * array to keep the bridge payload primitive.
 */
export interface IFaceEngineNative {
  detectFace(base64Frame: string): Promise<DetectionResult>;
  checkLiveness(
    base64Frame: string,
    bbox: [number, number, number, number],
  ): Promise<LivenessResult>;
  getEmbedding(
    base64Frame: string,
    landmarks: [number, number][],
  ): Promise<EmbeddingResult>;
  /** Load all ONNX models. Call once at app start. */
  initModels(): Promise<void>;
  /** Free model memory. Call on cleanup / background. */
  releaseModels(): Promise<void>;
}

const nativeModule: IFaceEngineNative | undefined = (
  NativeModules as { FaceEngine?: IFaceEngineNative }
).FaceEngine;

/**
 * Resolve the native module or throw a diagnosable error.
 *
 * @throws If `NativeModules.FaceEngine` is missing (module not linked / not
 *   rebuilt after install).
 */
function requireNative(): IFaceEngineNative {
  if (!nativeModule) {
    const msg =
      'Native module "FaceEngine" is not available. Ensure FaceEnginePackage ' +
      'is registered (Android) / the pod is installed (iOS) and rebuild the app.';
    logger.error(TAG, msg);
    throw new Error(msg);
  }
  return nativeModule;
}

/**
 * Typed wrapper over the `FaceEngine` native module.
 *
 * All methods are async and reject with the native error on failure.
 */
export const FaceEngine: IFaceEngineNative = {
  detectFace(base64Frame: string): Promise<DetectionResult> {
    return requireNative().detectFace(base64Frame);
  },

  checkLiveness(
    base64Frame: string,
    bbox: [number, number, number, number],
  ): Promise<LivenessResult> {
    return requireNative().checkLiveness(base64Frame, bbox);
  },

  getEmbedding(
    base64Frame: string,
    landmarks: [number, number][],
  ): Promise<EmbeddingResult> {
    return requireNative().getEmbedding(base64Frame, landmarks);
  },

  async initModels(): Promise<void> {
    logger.info(TAG, 'initModels()');
    await requireNative().initModels();
  },

  async releaseModels(): Promise<void> {
    logger.info(TAG, 'releaseModels()');
    await requireNative().releaseModels();
  },
};

/** Whether the native module is linked (no throw). */
export function isFaceEngineAvailable(): boolean {
  return nativeModule != null;
}

export default FaceEngine;
