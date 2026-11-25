#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <stdbool.h>

// Tao handles window close, but Cocoa sends Quit (menu, Dock, logout) directly
// to the application delegate. Keep Cocoa's termination request pending until
// the editor confirms its changes are durable, or cancels on a save failure.
static bool (*requestEditorClose)(void);
static bool awaitingReply;

static NSApplicationTerminateReply shouldTerminate(id delegate, SEL action, NSApplication *app) {
    if (awaitingReply) return NSTerminateLater;
    if (!requestEditorClose()) return NSTerminateNow;
    awaitingReply = true;
    return NSTerminateLater;
}

bool blok_install_quit_guard(bool (*request)(void)) {
    id<NSApplicationDelegate> delegate = NSApp.delegate;
    if (!delegate) return false;
    SEL selector = @selector(applicationShouldTerminate:);
    struct objc_method_description method = protocol_getMethodDescription(@protocol(NSApplicationDelegate), selector, NO, YES);
    if (!method.types || !class_addMethod(object_getClass(delegate), selector, (IMP)shouldTerminate, method.types)) return false;
    requestEditorClose = request;
    // AppKit caches optional delegate selectors when the delegate is assigned.
    NSApp.delegate = nil;
    NSApp.delegate = delegate;
    return true;
}

bool blok_reply_to_quit(bool saved) {
    if (!awaitingReply) return false;
    awaitingReply = false;
    [NSApp replyToApplicationShouldTerminate:saved];
    return true;
}
