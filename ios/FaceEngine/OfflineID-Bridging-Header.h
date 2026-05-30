//
//  OfflineID-Bridging-Header.h
//  Exposes React Native's Objective-C headers to Swift so the Swift FaceEngine module
//  can use RCTPromiseResolveBlock / RCTPromiseRejectBlock and the RCT bridge macros.
//
//  Set this file as the target's "Objective-C Bridging Header" build setting
//  (SWIFT_OBJC_BRIDGING_HEADER). If the project already has a bridging header, merge
//  these imports into it instead of adding a second one.
//

#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
