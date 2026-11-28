#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>

@interface BlokNotificationPresenter : NSObject<UNUserNotificationCenterDelegate>
@end
@implementation BlokNotificationPresenter
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
    completion(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList);
}
@end

// Called on a Tauri blocking worker. UserNotifications invokes its completions on
// a private queue, allowing AppKit to handle the permission prompt on the main thread.
int blok_notification_permission(bool request) {
    @autoreleasepool {
        UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        __block int result = -1;
        if (request) {
            [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionBadge)
                                 completionHandler:^(BOOL granted, NSError *error) {
                result = error ? -1 : (granted ? 1 : 2);
                dispatch_semaphore_signal(done);
            }];
        } else {
            [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
                switch (settings.authorizationStatus) {
                    case UNAuthorizationStatusAuthorized:
                    case UNAuthorizationStatusProvisional: result = 1; break;
                    case UNAuthorizationStatusDenied: result = 2; break;
                    default: result = 0; break;
                }
                dispatch_semaphore_signal(done);
            }];
        }
        dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
        return result;
    }
}

bool blok_send_notification(const char *identifier, const char *body) {
    @autoreleasepool {
        UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
        static BlokNotificationPresenter *presenter;
        static dispatch_once_t once;
        dispatch_once(&once, ^{
            presenter = [[BlokNotificationPresenter alloc] init];
            if (!center.delegate) center.delegate = presenter;
        });
        UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
        content.title = @"Blok";
        content.body = [NSString stringWithUTF8String:body];
        UNNotificationRequest *notice = [UNNotificationRequest requestWithIdentifier:[NSString stringWithUTF8String:identifier] content:content trigger:nil];
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        __block bool sent = false;
        [center addNotificationRequest:notice withCompletionHandler:^(NSError *error) {
            sent = !error;
            dispatch_semaphore_signal(done);
        }];
        dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
        return sent;
    }
}
