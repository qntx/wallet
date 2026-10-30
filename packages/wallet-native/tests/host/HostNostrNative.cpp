// Test-only nostr_native_* implementation: deterministic outputs so the kernel
// bridge cases assert exact bytes without the real secp256k1. A secret key of
// all 0xEE makes the sign/publicKey/ecdhX calls return 0 — the reject path —
// and verifySerialized answers 1 only when the serialized input's first byte
// is 0x01. Inputs are recorded so offset-view cases can check them.

extern "C" {
#include "nostr_native.h"
}

#include <cstdint>
#include <cstring>

namespace {

uint8_t g_lastSerialized[64];
size_t g_lastSerializedLen = 0;
uint8_t g_lastSignId[32];
uint8_t g_lastEcdhPub[32];

bool isBadSecret(const unsigned char* key) {
  for (int i = 0; i < 32; i++) {
    if (key[i] != 0xEE) {
      return false;
    }
  }
  return true;
}

} // namespace

extern "C" {

int nostr_native_abi_version(void) {
  return NOSTR_NATIVE_ABI_VERSION;
}

int nostr_native_verify_serialized(const unsigned char* serialized, size_t len,
                                   const unsigned char* id,
                                   const unsigned char* pubkey,
                                   const unsigned char* sig) {
  (void)id;
  (void)pubkey;
  (void)sig;
  if (serialized == nullptr) {
    return 0;
  }
  const size_t kept = len < sizeof g_lastSerialized ? len : sizeof g_lastSerialized;
  std::memcpy(g_lastSerialized, serialized, kept);
  g_lastSerializedLen = len;
  return len > 0 && serialized[0] == 0x01 ? 1 : 0;
}

int nostr_native_public_key(const unsigned char* seckey, unsigned char* out_xonly) {
  if (seckey == nullptr || out_xonly == nullptr || isBadSecret(seckey)) {
    return 0;
  }
  for (int i = 0; i < 32; i++) {
    out_xonly[i] = static_cast<unsigned char>(seckey[31 - i] ^ 0xAA);
  }
  return 1;
}

int nostr_native_sign(const unsigned char* id, const unsigned char* seckey,
                      const unsigned char* aux_rand, unsigned char* out_sig) {
  if (id == nullptr || seckey == nullptr || aux_rand == nullptr ||
      out_sig == nullptr || isBadSecret(seckey)) {
    return 0;
  }
  std::memcpy(g_lastSignId, id, 32);
  for (int i = 0; i < 64; i++) {
    out_sig[i] = static_cast<unsigned char>(id[i & 31] ^ aux_rand[i & 31]);
  }
  return 1;
}

int nostr_native_ecdh_x(const unsigned char* seckey, const unsigned char* pubkey_x,
                        unsigned char* out32) {
  if (seckey == nullptr || pubkey_x == nullptr || out32 == nullptr ||
      isBadSecret(seckey)) {
    return 0;
  }
  std::memcpy(g_lastEcdhPub, pubkey_x, 32);
  for (int i = 0; i < 32; i++) {
    out32[i] = static_cast<unsigned char>(seckey[i] ^ pubkey_x[i]);
  }
  return 1;
}

} // extern "C"

void hostNostrRecordedSerialized(uint8_t* out, size_t* len) {
  std::memcpy(out, g_lastSerialized, g_lastSerializedLen < 64 ? g_lastSerializedLen : 64);
  *len = g_lastSerializedLen;
}

void hostNostrRecordedSignId(uint8_t* out) {
  std::memcpy(out, g_lastSignId, 32);
}

void hostNostrRecordedEcdhPub(uint8_t* out) {
  std::memcpy(out, g_lastEcdhPub, 32);
}
