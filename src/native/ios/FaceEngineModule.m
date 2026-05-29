//
//  FaceEngineModule.m
//  OfflineID — Hackathon 7.0
//
//  Objective-C bridge that exposes the Swift `FaceEngine` module to the React
//  Native bridge. Method signatures MUST match the Swift @objc selectors and
//  the TypeScript IFaceEngineNative contract (SPEC.md §6.1).
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(FaceEngine, NSObject)

// initModels(): Promise<void>
RCT_EXTERN_METHOD(initModels:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// releaseModels(): Promise<void>
RCT_EXTERN_METHOD(releaseModels:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// detectFace(base64Frame): Promise<DetectionResult>
RCT_EXTERN_METHOD(detectFace:(NSString *)base64Frame
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// checkLiveness(base64Frame, bbox[x,y,w,h]): Promise<LivenessResult>
RCT_EXTERN_METHOD(checkLiveness:(NSString *)base64Frame
                  bbox:(NSArray *)bbox
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// getEmbedding(base64Frame, landmarks[[x,y]×5]): Promise<EmbeddingResult>
RCT_EXTERN_METHOD(getEmbedding:(NSString *)base64Frame
                  landmarks:(NSArray *)landmarks
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// Inference is dispatched off the main queue inside Swift.
+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

@end
