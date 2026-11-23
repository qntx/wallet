// iOS vault anchor: one generic-password keychain item (service
// "qntx-wallet.anchor", account "vault") holding the kernel's anchor record.
// The accessibility class matches the NSFileProtectionComplete vault file —
// when one is unreadable so is the other — and the item never syncs, so a host
// that restores an older vault image cannot restore the revision floor or the
// failure counters with it. Keychain items survive app reinstall, which is
// exactly why the kernel establishes at anchor.revision + 1.
#include "../host/VaultAnchor.hpp"

#import <Foundation/Foundation.h>
#import <Security/Security.h>

#include <stdexcept>
#include <vector>

namespace qntx {
namespace {

// The OSStatus is reduced to its number: failure messages propagate through
// the kernel's error path and must never carry item detail.
[[noreturn]] void failStep(const char* step, OSStatus status) {
  throw std::runtime_error(
      std::string(step) + " (OSStatus " + std::to_string(status) + ")");
}

NSDictionary* anchorQuery() {
  return @{
    (id)kSecClass : (id)kSecClassGenericPassword,
    (id)kSecAttrService : @"qntx-wallet.anchor",
    (id)kSecAttrAccount : @"vault",
    (id)kSecAttrSynchronizable : @NO,
  };
}

} // namespace

std::optional<std::vector<uint8_t>> platformAnchorLoad() {
  NSMutableDictionary* query = [anchorQuery() mutableCopy];
  query[(id)kSecReturnData] = @YES;
  CFTypeRef found = nullptr;
  const OSStatus status =
      SecItemCopyMatching((__bridge CFDictionaryRef)query, &found);
  if (status == errSecItemNotFound) {
    return std::nullopt;
  }
  if (status != errSecSuccess || found == nullptr) {
    failStep("read vault anchor", status);
  }
  NSData* data = (__bridge_transfer NSData*)found;
  const auto* bytes = static_cast<const uint8_t*>(data.bytes);
  return std::vector<uint8_t>(bytes, bytes + data.length);
}

void platformAnchorStore(const std::vector<uint8_t>& bytes) {
  NSData* data = [NSData dataWithBytes:bytes.data() length:bytes.size()];
  const OSStatus updated = SecItemUpdate(
      (__bridge CFDictionaryRef)anchorQuery(),
      (__bridge CFDictionaryRef) @{(id)kSecValueData : data});
  if (updated == errSecSuccess) {
    return;
  }
  if (updated != errSecItemNotFound) {
    failStep("update vault anchor", updated);
  }
  NSMutableDictionary* item = [anchorQuery() mutableCopy];
  item[(id)kSecAttrAccessible] =
      (id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly;
  item[(id)kSecValueData] = data;
  const OSStatus added =
      SecItemAdd((__bridge CFDictionaryRef)item, nullptr);
  if (added != errSecSuccess) {
    failStep("store vault anchor", added);
  }
}

} // namespace qntx
