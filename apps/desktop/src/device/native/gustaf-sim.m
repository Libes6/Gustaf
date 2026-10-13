// gustaf-sim: a small native helper for ONE iOS Simulator, started by the Gustaf desktop app (apps/desktop/src/device).
// It talks to CoreSimulator / SimulatorKit (private frameworks that ship with Xcode, the same ones the Simulator app and
// idb use): touch / button / key events through the simulator's own HID client and frames from the display's
// framebuffer IOSurface. Protocol: JSON lines on stdin (requests) and stdout (events); it exits when stdin closes.
//   argv: <udid>
//   -> {"op":"touch","phase":"down|move|up","x":201,"y":400,"sw":402,"sh":874}   (points; sw/sh = screen size in points)
//      {"op":"button","name":"home|lock|siri|side","down":true|false}
//      {"op":"key","usage":40,"down":true}   (USB HID usage page 7; layout independent keys like Enter only: letters
//                                              would come out in the simulator's keyboard layout)
//      {"op":"tap","x":..,"y":..,"sw":..,"sh":..,"holdMs":40}   {"op":"swipe","x1":..,"y1":..,"x2":..,"y2":..,"ms":120,"holdEndMs":0,"sw":..,"sh":..}
//      {"op":"ack","seq":N}   frames the app has consumed: at most two are ever in flight
//      {"op":"frames","on":true,"fps":30,"scale":0.5,"quality":0.55}      start/stop pushing frames when the screen changes
//      {"op":"frame","scale":0.5,"quality":0.55}                          one frame now
//      {"op":"quit"}
//   <- {"event":"ready", ...}  {"event":"frame","seq":N,"pw":1206,"ph":2622,"w":603,"h":1311,"data":"<base64 jpeg>"}
//      {"event":"error","message":"..."}  every request with an "id" is answered {"id":N,"ok":true|false,"error":"..."}
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <IOSurface/IOSurface.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>

typedef void *(*MouseFn)(CGPoint *, CGPoint *, int, int, int, double, double);
typedef void *(*ButtonFn)(int, int, int);
typedef void *(*KeyFn)(int, int);

static const int kVersion = 1;
static id gClient;
static MouseFn gMouse;
static ButtonFn gButton;
static KeyFn gKey;
static id gDisplay;
static IOSurfaceRef gSurface;
static dispatch_queue_t gOut, gFrames;
static volatile int gOutPending = 0;
static volatile int gSent = 0, gAcked = 0;

static void emit(NSDictionary *d) {
  NSData *j = [NSJSONSerialization dataWithJSONObject:d options:0 error:nil];
  if (!j) return;
  dispatch_async(gOut, ^{
    fwrite(j.bytes, 1, j.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
  });
}
static void fail(NSString *m) { emit(@{@"event": @"error", @"message": m}); }

static void sendHID(void *msg) {
  if (!msg) return;
  ((void (*)(id, SEL, void *, BOOL, id, id))objc_msgSend)(
      gClient, NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:"), msg, YES, nil, nil);
}

// ---------- frames ----------
static BOOL gFramesOn = NO;
static double gScale = 0.5, gQuality = 0.55, gFps = 30;
static int gSeq = 0;
static uint8_t *gPrev = NULL;
static size_t gPrevSize = 0;
static dispatch_source_t gTimer;

static NSData *encodeFrame(double scale, double quality, size_t *pw, size_t *ph, size_t *ow, size_t *oh) {
  IOSurfaceRef s = gSurface;
  if (!s) return nil;
  size_t w = IOSurfaceGetWidth(s), h = IOSurfaceGetHeight(s);
  *pw = w; *ph = h;
  IOSurfaceLock(s, kIOSurfaceLockReadOnly, NULL);
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGContextRef full = CGBitmapContextCreate(IOSurfaceGetBaseAddress(s), w, h, 8, IOSurfaceGetBytesPerRow(s), cs,
                                            kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst);
  CGImageRef img = CGBitmapContextCreateImage(full);
  size_t sw = MAX(1, (size_t)(w * scale)), sh = MAX(1, (size_t)(h * scale));
  CGImageRef out = img;
  CGContextRef sm = NULL;
  if (scale < 0.999) {
    sm = CGBitmapContextCreate(NULL, sw, sh, 8, 0, cs, kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst);
    CGContextSetInterpolationQuality(sm, kCGInterpolationLow);
    CGContextDrawImage(sm, CGRectMake(0, 0, sw, sh), img);
    out = CGBitmapContextCreateImage(sm);
  } else { sw = w; sh = h; }
  NSMutableData *data = [NSMutableData data];
  CGImageDestinationRef dst = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)data, CFSTR("public.jpeg"), 1, NULL);
  CGImageDestinationAddImage(dst, out, (__bridge CFDictionaryRef) @{(__bridge id)kCGImageDestinationLossyCompressionQuality: @(quality)});
  CGImageDestinationFinalize(dst);
  CFRelease(dst);
  IOSurfaceUnlock(s, kIOSurfaceLockReadOnly, NULL);
  if (out != img) CGImageRelease(out);
  CGImageRelease(img);
  CGContextRelease(full);
  if (sm) CGContextRelease(sm);
  CGColorSpaceRelease(cs);
  *ow = sw; *oh = sh;
  return data;
}

/** True when the surface differs from the last frame sent (exact compare, ~1 ms for a phone screen). */
static BOOL surfaceChanged(void) {
  IOSurfaceRef s = gSurface;
  if (!s) return NO;
  size_t h = IOSurfaceGetHeight(s), bpr = IOSurfaceGetBytesPerRow(s), rowBytes = IOSurfaceGetWidth(s) * 4;
  size_t need = bpr * h;
  IOSurfaceLock(s, kIOSurfaceLockReadOnly, NULL);
  const uint8_t *base = IOSurfaceGetBaseAddress(s);
  BOOL changed = NO;
  if (gPrevSize != need) { free(gPrev); gPrev = malloc(need); gPrevSize = need; changed = YES; }
  for (size_t y = 0; y < h && !changed; y++)
    if (memcmp(base + y * bpr, gPrev + y * bpr, rowBytes) != 0) changed = YES;
  if (changed) memcpy(gPrev, base, need);
  IOSurfaceUnlock(s, kIOSurfaceLockReadOnly, NULL);
  return changed;
}

static void sendFrame(double scale, double quality) {
  size_t pw, ph, w, h;
  NSData *jpg = encodeFrame(scale, quality, &pw, &ph, &w, &h);
  if (!jpg) { fail(@"no framebuffer"); return; }
  gSent++;
  emit(@{@"event": @"frame", @"seq": @(++gSeq), @"pw": @(pw), @"ph": @(ph), @"w": @(w), @"h": @(h),
         @"data": [jpg base64EncodedStringWithOptions:0]});
}

static void startFrames(void) {
  if (gTimer) dispatch_source_cancel(gTimer);
  gTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gFrames);
  uint64_t ns = (uint64_t)(NSEC_PER_SEC / MAX(1.0, gFps));
  dispatch_source_set_timer(gTimer, dispatch_time(DISPATCH_TIME_NOW, 0), ns, ns / 10);
  dispatch_source_set_event_handler(gTimer, ^{
    if (!gFramesOn) return;
    // A frame still waiting to be written means the reader is slow: skip this one, the next carries the latest screen.
    if (gOutPending > 0) return;
    // At most two frames the app has not acknowledged yet (the reader is the app's UI thread: never run ahead of it).
    if (gSent - gAcked >= 2) return;
    if (!surfaceChanged()) return;
    gOutPending++;
    sendFrame(gScale, gQuality);
    dispatch_async(gOut, ^{ gOutPending--; });
  });
  dispatch_resume(gTimer);
}

// ---------- setup ----------
static BOOL setup(NSString *udid, NSString **why) {
  dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW);
  NSString *dev = [NSProcessInfo.processInfo.environment[@"DEVELOPER_DIR"] length] ? NSProcessInfo.processInfo.environment[@"DEVELOPER_DIR"] : nil;
  if (!dev) {
    NSTask *t = [NSTask new]; t.launchPath = @"/usr/bin/xcode-select"; t.arguments = @[@"-p"];
    NSPipe *p = [NSPipe pipe]; t.standardOutput = p; [t launch]; [t waitUntilExit];
    dev = [[[NSString alloc] initWithData:[p.fileHandleForReading readDataToEndOfFile] encoding:NSUTF8StringEncoding]
        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  }
  void *sk = dlopen([[dev stringByAppendingString:@"/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"] UTF8String], RTLD_NOW);
  if (!sk) { *why = @"SimulatorKit not found"; return NO; }
  gMouse = dlsym(sk, "IndigoHIDMessageForMouseNSEvent");
  gButton = dlsym(sk, "IndigoHIDMessageForButton");
  gKey = dlsym(sk, "IndigoHIDMessageForKeyboardArbitrary");
  if (!gMouse) { *why = @"IndigoHIDMessageForMouseNSEvent missing"; return NO; }
  Class ctx = NSClassFromString(@"SimServiceContext");
  if (!ctx) { *why = @"SimServiceContext missing"; return NO; }
  NSError *err = nil;
  id sc = ((id (*)(Class, SEL, id, NSError **))objc_msgSend)(ctx, NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:"), dev, &err);
  id set = sc ? ((id (*)(id, SEL, NSError **))objc_msgSend)(sc, NSSelectorFromString(@"defaultDeviceSetWithError:"), &err) : nil;
  NSDictionary *devs = [set valueForKey:@"devicesByUDID"];
  id device = nil;
  for (id k in devs) if ([[k description] caseInsensitiveCompare:udid] == NSOrderedSame) device = devs[k];
  if (!device) { *why = @"simulator not found"; return NO; }
  Class hc = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
  if (!hc) { *why = @"SimDeviceLegacyHIDClient missing"; return NO; }
  gClient = ((id (*)(id, SEL, id, NSError **))objc_msgSend)([hc alloc], NSSelectorFromString(@"initWithDevice:error:"), device, &err);
  if (!gClient) { *why = [NSString stringWithFormat:@"HID client: %@", err]; return NO; }
  id io = [device valueForKey:@"io"];
  ((void (*)(id, SEL))objc_msgSend)(io, NSSelectorFromString(@"updateIOPorts"));
  NSArray *ports = ((id (*)(id, SEL))objc_msgSend)(io, NSSelectorFromString(@"ioPorts"));
  for (id p in ports) {
    id d = ((id (*)(id, SEL))objc_msgSend)(p, NSSelectorFromString(@"descriptor"));
    SEL fb = NSSelectorFromString(@"framebufferSurface");
    if ([d respondsToSelector:fb] && ((void *(*)(id, SEL))objc_msgSend)(d, fb)) { gDisplay = d; break; }
  }
  if (!gDisplay) { *why = @"display framebuffer not found"; return NO; }
  gSurface = ((IOSurfaceRef (*)(id, SEL))objc_msgSend)(gDisplay, NSSelectorFromString(@"framebufferSurface"));
  if (gSurface) CFRetain(gSurface);
  // The surface is replaced when the simulator rotates or resizes: keep the pointer current.
  void (^surfCb)(id, id) = ^(id unmasked, id masked) {
    if (!unmasked) return;
    IOSurfaceRef n = (__bridge_retained IOSurfaceRef)unmasked;
    IOSurfaceRef old = gSurface;
    gSurface = n;
    if (old) CFRelease(old);
  };
  ((void (*)(id, SEL, id, id, id, id, id))objc_msgSend)(
      gDisplay, NSSelectorFromString(@"registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:"),
      [NSUUID UUID], gFrames, ^{}, surfCb, ^(id p){});
  return gSurface != NULL;
}

// ---------- input ----------
static void touch(NSString *phase, double x, double y, double sw, double sh) {
  int type = [phase isEqualToString:@"down"] ? 1 : [phase isEqualToString:@"up"] ? 2 : 6;
  CGPoint p = CGPointMake(x, y);
  sendHID(gMouse(&p, NULL, 0x32, type, 1, sw, sh));
}
static int buttonCode(NSString *n) {
  if ([n isEqualToString:@"home"]) return 0x0;
  if ([n isEqualToString:@"lock"]) return 0x1;
  if ([n isEqualToString:@"side"]) return 0xbb8;
  if ([n isEqualToString:@"siri"]) return 0x400002;
  return -1;
}
static void sleepMs(double ms) { if (ms > 0) usleep((useconds_t)(ms * 1000)); }
/** A tap: down, hold, up. Runs on the reader thread, so later requests wait behind it and order is kept. */
static void tapAt(double x, double y, double sw, double sh, double holdMs) {
  touch(@"down", x, y, sw, sh); sleepMs(holdMs); touch(@"up", x, y, sw, sh);
}
/** A drag from a to b over ms, a touch sample about every 8 ms (the screen follows it like a finger). */
static void swipeAt(double x1, double y1, double x2, double y2, double ms, double sw, double sh, double holdEndMs) {
  int steps = MAX(2, (int)(ms / 8.0));
  touch(@"down", x1, y1, sw, sh);
  for (int i = 1; i <= steps; i++) {
    double t = (double)i / steps;
    sleepMs(ms / steps);
    touch(@"move", x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, sw, sh);
  }
  sleepMs(holdEndMs);
  touch(@"up", x2, y2, sw, sh);
}
static void key(int usage, BOOL down) { if (gKey) sendHID(gKey(usage, down ? 1 : 2)); }

static void handle(NSDictionary *r) {
  NSString *op = r[@"op"];
  id rid = r[@"id"];
  NSString *err = nil;
  if ([op isEqualToString:@"touch"]) {
    touch(r[@"phase"], [r[@"x"] doubleValue], [r[@"y"] doubleValue], [r[@"sw"] doubleValue], [r[@"sh"] doubleValue]);
  } else if ([op isEqualToString:@"tap"]) {
    tapAt([r[@"x"] doubleValue], [r[@"y"] doubleValue], [r[@"sw"] doubleValue], [r[@"sh"] doubleValue], r[@"holdMs"] ? [r[@"holdMs"] doubleValue] : 40);
  } else if ([op isEqualToString:@"swipe"]) {
    swipeAt([r[@"x1"] doubleValue], [r[@"y1"] doubleValue], [r[@"x2"] doubleValue], [r[@"y2"] doubleValue],
            r[@"ms"] ? [r[@"ms"] doubleValue] : 120, [r[@"sw"] doubleValue], [r[@"sh"] doubleValue], [r[@"holdEndMs"] doubleValue]);
  } else if ([op isEqualToString:@"ack"]) {
    gAcked = [r[@"seq"] intValue];
  } else if ([op isEqualToString:@"button"]) {
    int code = buttonCode(r[@"name"]);
    if (code < 0 || !gButton) err = @"unknown button";
    else { BOOL down = [r[@"down"] boolValue]; sendHID(gButton(code, down ? 1 : 2, 0x33)); }
  } else if ([op isEqualToString:@"key"]) {
    key([r[@"usage"] intValue], [r[@"down"] boolValue]);
  } else if ([op isEqualToString:@"frames"]) {
    if (r[@"scale"]) gScale = MIN(1.0, MAX(0.1, [r[@"scale"] doubleValue]));
    if (r[@"quality"]) gQuality = MIN(1.0, MAX(0.1, [r[@"quality"] doubleValue]));
    if (r[@"fps"]) gFps = MIN(60.0, MAX(1.0, [r[@"fps"] doubleValue]));
    BOOL on = [r[@"on"] boolValue];
    dispatch_async(gFrames, ^{
      gFramesOn = on;
      if (on) { free(gPrev); gPrev = NULL; gPrevSize = 0; startFrames(); }
      else if (gTimer) { dispatch_source_cancel(gTimer); gTimer = nil; }
    });
  } else if ([op isEqualToString:@"frame"]) {
    double sc = r[@"scale"] ? [r[@"scale"] doubleValue] : gScale, q = r[@"quality"] ? [r[@"quality"] doubleValue] : gQuality;
    dispatch_async(gFrames, ^{ sendFrame(sc, q); });
  } else if ([op isEqualToString:@"quit"]) {
    dispatch_async(gOut, ^{ exit(0); });
  } else err = @"unknown op";
  if (rid) emit(err ? @{@"id": rid, @"ok": @NO, @"error": err} : @{@"id": rid, @"ok": @YES});
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc < 2) { fprintf(stderr, "usage: gustaf-sim <udid>\n"); return 2; }
    setvbuf(stdout, NULL, _IOFBF, 1 << 20);
    gOut = dispatch_queue_create("out", DISPATCH_QUEUE_SERIAL);
    gFrames = dispatch_queue_create("frames", DISPATCH_QUEUE_SERIAL);
    NSString *why = nil;
    if (!setup(@(argv[1]), &why)) {
      emit(@{@"event": @"ready", @"ok": @NO, @"reason": why ?: @"setup failed", @"version": @(kVersion)});
      dispatch_sync(gOut, ^{});
      return 1;
    }
    emit(@{@"event": @"ready", @"ok": @YES, @"version": @(kVersion), @"pw": @(IOSurfaceGetWidth(gSurface)),
           @"ph": @(IOSurfaceGetHeight(gSurface)), @"button": @(gButton != NULL), @"key": @(gKey != NULL)});
    NSThread *reader = [[NSThread alloc] initWithBlock:^{
      char *line = NULL; size_t cap = 0; ssize_t n;
      while ((n = getline(&line, &cap, stdin)) > 0) {
        @autoreleasepool {
          NSData *d = [NSData dataWithBytes:line length:n];
          NSDictionary *r = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
          if ([r isKindOfClass:NSDictionary.class]) handle(r);
        }
      }
      exit(0); // stdin closed: the app is gone or stopped us
    }];
    reader.stackSize = 1 << 20;
    [reader start];
    [[NSRunLoop mainRunLoop] run];
  }
  return 0;
}
