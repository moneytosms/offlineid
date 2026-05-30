//
//  FaceEngine.m
//  OfflineID — Objective-C bridge exposing the Swift FaceEngine to React Native.
//
//  Mirrors the Android FaceEnginePackage registration. The method signatures match
//  IFaceEngineNative in src/services/FaceEngine.ts exactly, so NativeModules.FaceEngine
//  resolves identically on iOS and Android.
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(FaceEngine, NSObject)

RCT_EXTERN_METHOD(initModels:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(releaseModels:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(detectFace:(NSString *)base64Frame
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(checkLiveness:(NSString *)base64Frame
                  bbox:(NSArray *)bbox
                  scale:(nonnull NSNumber *)scale
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getEmbedding:(NSString *)base64Frame
                  landmarksJson:(NSString *)landmarksJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup { return NO; }

@end
