//
//  ScreenBrightness.m
//  OfflineID — Objective-C bridge exposing the Swift ScreenBrightness module to RN.
//
//  Mirrors the Android ScreenBrightnessModule registration. The method signatures
//  match IScreenBrightnessNative in src/services/ScreenBrightness.ts exactly, so
//  NativeModules.ScreenBrightness resolves identically on iOS and Android.
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ScreenBrightness, NSObject)

RCT_EXTERN_METHOD(setBrightness:(nonnull NSNumber *)value
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(restore:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getLux:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(acquireWakeLock:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(releaseWakeLock:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
