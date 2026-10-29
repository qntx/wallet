// Test-only qntx_spark implementation: the host build has no real
// libqntx_spark, so this file supplies the qs_* symbols with deterministic
// echo outputs, sentinel-driven error codes, and an allocation tracker that
// proves every emitted buffer comes back through qs_free exactly once with
// its original length. Mirrors how HostLifecycle.cpp satisfies the platform
// symbols — production code keeps a single link path.

#include "HostQntxSpark.hpp"

#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <vector>

namespace {

struct AllocTracker {
  std::mutex m;
  std::map<void*, size_t> outstanding;
  int badFrees = 0;
  int goodFrees = 0;
};

AllocTracker& tracker() {
  static auto* t = new AllocTracker();
  return *t;
}

void trackedFree(uint8_t* ptr, size_t len) {
  if (ptr == nullptr) {
    return;
  }
  auto& t = tracker();
  {
    std::lock_guard<std::mutex> lock(t.m);
    auto it = t.outstanding.find(ptr);
    if (it == t.outstanding.end() || it->second != len) {
      t.badFrees += 1;
      return;
    }
    t.outstanding.erase(it);
    t.goodFrees += 1;
  }
  std::memset(ptr, 0, len);
  std::free(ptr);
}

// Allocates a tracked buffer holding `bytes` and hands it to the out-params —
// the same ownership shape as the real library: caller frees via qs_free.
int emit(const uint8_t* bytes, size_t size, uint8_t** out, size_t* outLen) {
  uint8_t* buffer = static_cast<uint8_t*>(std::malloc(size == 0 ? 1 : size));
  if (buffer == nullptr) {
    return 8;
  }
  std::memcpy(buffer, bytes, size);
  {
    std::lock_guard<std::mutex> lock(tracker().m);
    tracker().outstanding[buffer] = size;
  }
  *out = buffer;
  *outLen = size;
  return 0;
}

} // namespace

extern "C" {

uint32_t qs_abi_version() {
  return 1;
}

uint8_t* qs_alloc(size_t len) {
  if (len == 0) {
    return nullptr;
  }
  uint8_t* buffer = static_cast<uint8_t*>(std::calloc(len, 1));
  if (buffer == nullptr) {
    return nullptr;
  }
  std::lock_guard<std::mutex> lock(tracker().m);
  tracker().outstanding[buffer] = len;
  return buffer;
}

void qs_free(uint8_t* ptr, size_t len) {
  trackedFree(ptr, len);
}

// Echo hedge ‖ random. hedge[0] == 0xEE forces code 5 while still emitting an
// output — the caller must free it on the error path too.
int32_t qs_frost_commit(
    const uint8_t* hedge,
    size_t hedgeLen,
    const uint8_t* random,
    size_t randomLen,
    uint8_t** out,
    size_t* outLen) {
  if (hedge == nullptr || random == nullptr || out == nullptr || outLen == nullptr) {
    return 1;
  }
  if (hedgeLen > 0 && hedge[0] == 0xEE) {
    const uint8_t err[4] = {0xDE, 0xAD, 0xBE, 0xEF};
    emit(err, sizeof(err), out, outLen);
    return 5;
  }
  std::vector<uint8_t> joined;
  joined.insert(joined.end(), hedge, hedge + hedgeLen);
  joined.insert(joined.end(), random, random + randomLen);
  return emit(joined.data(), joined.size(), out, outLen);
}

// Echo the request. req[0] == 0xFF forces a decode error with no output.
int32_t qs_frost_sign(
    const uint8_t* req,
    size_t reqLen,
    uint8_t** out,
    size_t* outLen) {
  if (req == nullptr || out == nullptr || outLen == nullptr) {
    return 1;
  }
  if (reqLen > 0 && req[0] == 0xFF) {
    return 4;
  }
  return emit(req, reqLen, out, outLen);
}

int32_t qs_frost_aggregate(
    const uint8_t* req,
    size_t reqLen,
    uint8_t** out,
    size_t* outLen) {
  if (req == nullptr || out == nullptr || outLen == nullptr) {
    return 1;
  }
  return emit(req, reqLen, out, outLen);
}

// Echo the plaintext.
int32_t qs_ecies_encrypt(
    const uint8_t* pk,
    size_t /*pkLen*/,
    const uint8_t* msg,
    size_t msgLen,
    const uint8_t* random,
    size_t /*randomLen*/,
    uint8_t** out,
    size_t* outLen) {
  if (pk == nullptr || msg == nullptr || random == nullptr || out == nullptr ||
      outLen == nullptr) {
    return 1;
  }
  return emit(msg, msgLen, out, outLen);
}

// Echo the ciphertext.
int32_t qs_ecies_decrypt(
    const uint8_t* sk,
    size_t /*skLen*/,
    const uint8_t* ct,
    size_t ctLen,
    uint8_t** out,
    size_t* outLen) {
  if (sk == nullptr || ct == nullptr || out == nullptr || outLen == nullptr) {
    return 1;
  }
  return emit(ct, ctLen, out, outLen);
}

// Echo the secret.
int32_t qs_split_secret_with_proofs(
    const uint8_t* secret,
    size_t secretLen,
    uint32_t /*threshold*/,
    uint32_t /*shares*/,
    const uint8_t* random,
    size_t /*randomLen*/,
    uint8_t** out,
    size_t* outLen) {
  if (secret == nullptr || random == nullptr || out == nullptr || outLen == nullptr) {
    return 1;
  }
  return emit(secret, secretLen, out, outLen);
}

} // extern "C"

namespace qntxTestSpark {

int outstandingAllocs() {
  std::lock_guard<std::mutex> lock(tracker().m);
  return static_cast<int>(tracker().outstanding.size());
}

int badFrees() {
  std::lock_guard<std::mutex> lock(tracker().m);
  return tracker().badFrees;
}

int goodFrees() {
  std::lock_guard<std::mutex> lock(tracker().m);
  return tracker().goodFrees;
}

} // namespace qntxTestSpark
