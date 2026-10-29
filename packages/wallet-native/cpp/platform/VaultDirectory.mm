// iOS vault directory: Application Support/qntx-wallet/ created with
// NSFileProtectionComplete and excluded from backup — the vault image must
// never ride into iCloud or unencrypted backups.
#include "../host/VaultDirectory.hpp"

#import <Foundation/Foundation.h>

#include <stdexcept>

namespace qntx {
namespace {

// NSError detail is reduced to its numeric code: failure messages propagate
// through the kernel's error path and must never carry user-data paths.
[[noreturn]] void failStep(const char* step, NSError* error) {
  if (error == nil) {
    throw std::runtime_error(step);
  }
  throw std::runtime_error(
      std::string(step) + " (Cocoa error " + std::to_string(error.code) + ")");
}

} // namespace

std::string platformVaultDirectory() {
  NSFileManager* fileManager = [NSFileManager defaultManager];
  NSError* error = nil;
  NSURL* appSupport = [fileManager URLForDirectory:NSApplicationSupportDirectory
                                          inDomain:NSUserDomainMask
                                 appropriateForURL:nil
                                            create:YES
                                             error:&error];
  if (appSupport == nil) {
    failStep("resolve Application Support directory", error);
  }
  NSURL* dir = [appSupport URLByAppendingPathComponent:@"qntx-wallet" isDirectory:YES];
  if (dir == nil) {
    throw std::runtime_error("resolve vault directory");
  }
  error = nil;
  if (![fileManager createDirectoryAtURL:dir
             withIntermediateDirectories:YES
                              attributes:@{NSFileProtectionKey : NSFileProtectionComplete}
                                   error:&error]) {
    failStep("create vault directory", error);
  }
  error = nil;
  if (![dir setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&error]) {
    failStep("exclude vault directory from backup", error);
  }
  const char* path = dir.fileSystemRepresentation;
  if (path == nullptr) {
    throw std::runtime_error("resolve vault directory path");
  }
  return path;
}

} // namespace qntx
