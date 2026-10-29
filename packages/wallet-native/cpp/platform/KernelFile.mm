// iOS vault directory: Application Support/qntx-wallet/ created with
// NSFileProtectionComplete and excluded from backup — the vault image must
// never ride into iCloud or unencrypted backups.
#include "../host/KernelFile.hpp"

#import <Foundation/Foundation.h>

#include <stdexcept>
#include <system_error>

namespace qntx {

std::string kernelFileDirectory() {
  // Test/override path wins when set (the weak default in KernelFile.cpp is
  // replaced by this definition, so the override must be honoured here too).
  const std::string override = kernelFileDirectoryOverride();
  if (!override.empty()) {
    return override;
  }

  NSURL* appSupport = [[NSFileManager defaultManager]
      URLForDirectory:NSApplicationSupportDirectory
             inDomain:NSUserDomainMask
    appropriateForURL:nil
               create:NO
                error:nil];
  NSURL* dir = [appSupport URLByAppendingPathComponent:@"qntx-wallet" isDirectory:YES];
  NSError* error = nil;
  [[NSFileManager defaultManager] createDirectoryAtURL:dir
                       withIntermediateDirectories:YES
                                        attributes:@{NSFileProtectionKey: NSFileProtectionComplete}
                                             error:&error];
  if (error != nil) {
    throw std::system_error(
        static_cast<int>(error.code), std::system_category(), "create vault directory");
  }
  NSURL* exclude = dir;
  if (![exclude setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&error] ||
      error != nil) {
    throw std::system_error(
        static_cast<int>(error.code), std::system_category(), "exclude vault directory");
  }
  return dir.fileSystemRepresentation;
}

} // namespace qntx
