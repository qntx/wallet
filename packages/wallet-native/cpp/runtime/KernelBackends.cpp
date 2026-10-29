#include "KernelBackends.hpp"

#include "KernelJs.hpp"

// qntx_spark.h is generated with cbindgen language = "C" — no extern "C"
// guard of its own — so C++ consumers must wrap the include or they'd emit
// references under the wrong (mangled) names. iOS takes the vendored
// QntxSpark.framework's public header; Android and the host test put the
// package's include/ directory on -I instead.
extern "C" {
#if __has_include(<QntxSpark/qntx_spark.h>)
#include <QntxSpark/qntx_spark.h>
#else
#include "qntx_spark.h"
#endif
}

#include <string>

namespace qntx {

namespace {

constexpr double kUint32Max = 4294967295.0;

// Every qs_* call shares this shape: byte inputs go in as borrowed (data,
// size) views; the library-owned output is copied into a fresh Uint8Array
// before qs_free wipes and releases it. A nonzero code throws
// `qntx_spark:<code>` — the kernel-side wrapper maps it to SparkCryptoError.
template <typename Invoke>
jsi::Value callOut(
    jsi::Runtime& rt,
    const KernelIntrinsics& intrinsics,
    Invoke&& invoke) {
  uint8_t* out = nullptr;
  size_t outLen = 0;
  const int32_t code = invoke(&out, &outLen);
  jsi::Value result;
  if (code == 0) {
    auto buffer = arrayBufferFromBytes(rt, out, outLen);
    result = jsi::Value(
        rt, makeUint8Array(rt, intrinsics, std::move(buffer)));
  }
  if (out != nullptr) {
    qs_free(out, outLen);
  }
  if (code != 0) {
    throw jsi::JSError(rt, "qntx_spark:" + std::to_string(code));
  }
  return result;
}

uint32_t uint32Arg(
    jsi::Runtime& rt,
    const jsi::Value& value,
    const char* name) {
  return static_cast<uint32_t>(integerInRange(rt, value, name, 0, kUint32Max));
}

} // namespace

void installKernelBackends(
    jsi::Runtime& rt,
    jsi::Object& qntx,
    const KernelIntrinsics& intrinsics) {
  auto spark = jsi::Object(rt);

  spark.setProperty(
      rt, "abiVersion", jsi::Value(static_cast<double>(qs_abi_version())));

  spark.setProperty(
      rt,
      "frostCommit",
      hostFn(rt, "spark.frostCommit", 2, [&intrinsics](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 2) {
          throw jsi::JSError(
              rt, "__qntx.backends.spark.frostCommit expects (hedge, random)");
        }
        auto hedge = byteViewFromValue(rt, args[0], "__qntx.backends.spark.frostCommit hedge", intrinsics);
        auto random = byteViewFromValue(rt, args[1], "__qntx.backends.spark.frostCommit random", intrinsics);
        return callOut(rt, intrinsics, [&](uint8_t** out, size_t* outLen) {
          return qs_frost_commit(
              hedge.data, hedge.size, random.data, random.size, out, outLen);
        });
      }));

  spark.setProperty(
      rt,
      "frostSign",
      hostFn(rt, "spark.frostSign", 1, [&intrinsics](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 1) {
          throw jsi::JSError(
              rt, "__qntx.backends.spark.frostSign expects (request)");
        }
        auto request = byteViewFromValue(rt, args[0], "__qntx.backends.spark.frostSign request", intrinsics);
        return callOut(rt, intrinsics, [&](uint8_t** out, size_t* outLen) {
          return qs_frost_sign(request.data, request.size, out, outLen);
        });
      }));

  spark.setProperty(
      rt,
      "frostAggregate",
      hostFn(rt, "spark.frostAggregate", 1, [&intrinsics](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 1) {
          throw jsi::JSError(
              rt, "__qntx.backends.spark.frostAggregate expects (request)");
        }
        auto request = byteViewFromValue(rt, args[0], "__qntx.backends.spark.frostAggregate request", intrinsics);
        return callOut(rt, intrinsics, [&](uint8_t** out, size_t* outLen) {
          return qs_frost_aggregate(request.data, request.size, out, outLen);
        });
      }));

  spark.setProperty(
      rt,
      "eciesEncrypt",
      hostFn(rt, "spark.eciesEncrypt", 3, [&intrinsics](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 3) {
          throw jsi::JSError(
              rt, "__qntx.backends.spark.eciesEncrypt expects (publicKey, plaintext, random)");
        }
        auto publicKey = byteViewFromValue(rt, args[0], "__qntx.backends.spark.eciesEncrypt publicKey", intrinsics);
        auto plaintext = byteViewFromValue(rt, args[1], "__qntx.backends.spark.eciesEncrypt plaintext", intrinsics);
        auto random = byteViewFromValue(rt, args[2], "__qntx.backends.spark.eciesEncrypt random", intrinsics);
        return callOut(rt, intrinsics, [&](uint8_t** out, size_t* outLen) {
          return qs_ecies_encrypt(
              publicKey.data,
              publicKey.size,
              plaintext.data,
              plaintext.size,
              random.data,
              random.size,
              out,
              outLen);
        });
      }));

  spark.setProperty(
      rt,
      "eciesDecrypt",
      hostFn(rt, "spark.eciesDecrypt", 2, [&intrinsics](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 2) {
          throw jsi::JSError(
              rt, "__qntx.backends.spark.eciesDecrypt expects (privateKey, ciphertext)");
        }
        auto privateKey = byteViewFromValue(rt, args[0], "__qntx.backends.spark.eciesDecrypt privateKey", intrinsics);
        auto ciphertext = byteViewFromValue(rt, args[1], "__qntx.backends.spark.eciesDecrypt ciphertext", intrinsics);
        return callOut(rt, intrinsics, [&](uint8_t** out, size_t* outLen) {
          return qs_ecies_decrypt(
              privateKey.data, privateKey.size, ciphertext.data, ciphertext.size, out, outLen);
        });
      }));

  spark.setProperty(
      rt,
      "splitSecretWithProofs",
      hostFn(rt, "spark.splitSecretWithProofs", 4, [&intrinsics](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 4) {
          throw jsi::JSError(
              rt, "__qntx.backends.spark.splitSecretWithProofs expects (secret, threshold, shares, random)");
        }
        auto secret = byteViewFromValue(rt, args[0], "__qntx.backends.spark.splitSecretWithProofs secret", intrinsics);
        const auto threshold =
            uint32Arg(rt, args[1], "__qntx.backends.spark.splitSecretWithProofs threshold");
        const auto shares =
            uint32Arg(rt, args[2], "__qntx.backends.spark.splitSecretWithProofs shares");
        auto random = byteViewFromValue(rt, args[3], "__qntx.backends.spark.splitSecretWithProofs random", intrinsics);
        return callOut(rt, intrinsics, [&](uint8_t** out, size_t* outLen) {
          return qs_split_secret_with_proofs(
              secret.data,
              secret.size,
              threshold,
              shares,
              random.data,
              random.size,
              out,
              outLen);
        });
      }));

  intrinsics.freeze.call(rt, jsi::Value(rt, spark));

  auto backends = jsi::Object(rt);
  backends.setProperty(rt, "spark", jsi::Value(std::move(spark)));
  intrinsics.freeze.call(rt, jsi::Value(rt, backends));
  qntx.setProperty(rt, "backends", jsi::Value(std::move(backends)));
}

} // namespace qntx
