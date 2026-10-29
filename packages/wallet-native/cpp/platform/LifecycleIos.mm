#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

#include <mutex>
#include <time.h>

#include "../host/Lifecycle.hpp"

namespace qntx {

int64_t sleepInclusiveMonotonicMs() {
  // CLOCK_MONOTONIC counts sleep (steady_clock/mach_absolute_time does not).
  const uint64_t ns = clock_gettime_nsec_np(CLOCK_MONOTONIC);
  return static_cast<int64_t>(ns / 1000000);
}

void installLifecycleObserver() {
  static std::once_flag once;
  std::call_once(once, [] {
    auto* center = NSNotificationCenter.defaultCenter;
    [center addObserverForName:UIApplicationDidEnterBackgroundNotification
                        object:nil
                         queue:nil
                    usingBlock:^(NSNotification*) {
                      KernelLifecycleDispatcher::shared().onBackground();
                    }];
    [center addObserverForName:UIApplicationWillEnterForegroundNotification
                        object:nil
                         queue:nil
                    usingBlock:^(NSNotification*) {
                      KernelLifecycleDispatcher::shared().onForeground();
                    }];
  });
}

} // namespace qntx
