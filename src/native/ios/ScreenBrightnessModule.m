#import <React/RCTBridgeModule.h>

// Bridges the Swift `ScreenBrightness` class to the React Native bridge.
@interface RCT_EXTERN_MODULE(ScreenBrightness, NSObject)

RCT_EXTERN_METHOD(setBrightness:(nonnull NSNumber *)value
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(restore:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
