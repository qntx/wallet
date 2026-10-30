#include "KernelBackends.hpp"

#include "KernelJs.hpp"

// qntx_spark.h carries its own extern "C" guard since 0.5.1. Every build
// resolves the bare include through a search path: iOS via the SparkNative
// pod's headers (added by the WalletNative podspec), Android and the host
// test via the package's include/ directory.
#include "qntx_spark.h"
#include "nostr_native.h"

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

  // The nostr_native_* calls write fixed-size outputs on the stack and return
  // 0/1 rather than an allocator + error code, so they do not go through
  // callOut. Exact-length inputs are checked before the call; verifySerialized
  // answers with a boolean like nobleBackend instead of throwing.
  auto nostr = jsi::Object(rt);
  nostr.setProperty(
      rt, "abiVersion", jsi::Value(static_cast<double>(nostr_native_abi_version())));

  auto exact32 = [](jsi::Runtime& rt, const ByteView& view, const char* name) {
    if (view.size != 32) {
      throw jsi::JSError(rt, std::string(name) + " expects a 32-byte view");
    }
  };
  auto wipe = [](uint8_t* data, size_t size) {
    volatile uint8_t* p = data;
    while (size--) {
      *p++ = 0;
    }
  };

  nostr.setProperty(
      rt,
      "publicKey",
      hostFn(rt, "nostr.publicKey", 1, [&intrinsics, &exact32, &wipe](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 1) {
          throw jsi::JSError(rt, "__qntx.backends.nostr.publicKey expects (secretKey)");
        }
        auto sk = byteViewFromValue(rt, args[0], "__qntx.backends.nostr.publicKey secretKey", intrinsics);
        exact32(rt, sk, "__qntx.backends.nostr.publicKey secretKey");
        uint8_t out[32];
        const int ok = nostr_native_public_key(sk.data, out);
        jsi::Value result;
        if (ok == 1) {
          result = jsi::Value(rt, makeUint8Array(rt, intrinsics, arrayBufferFromBytes(rt, out, sizeof out)));
        }
        wipe(out, sizeof out);
        if (ok != 1) {
          throw jsi::JSError(rt, "nostr_native: publicKey rejected the input");
        }
        return result;
      }));

  nostr.setProperty(
      rt,
      "sign",
      hostFn(rt, "nostr.sign", 3, [&intrinsics, &exact32, &wipe](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 3) {
          throw jsi::JSError(rt, "__qntx.backends.nostr.sign expects (id, secretKey, auxRand)");
        }
        auto id = byteViewFromValue(rt, args[0], "__qntx.backends.nostr.sign id", intrinsics);
        auto sk = byteViewFromValue(rt, args[1], "__qntx.backends.nostr.sign secretKey", intrinsics);
        auto aux = byteViewFromValue(rt, args[2], "__qntx.backends.nostr.sign auxRand", intrinsics);
        exact32(rt, id, "__qntx.backends.nostr.sign id");
        exact32(rt, sk, "__qntx.backends.nostr.sign secretKey");
        exact32(rt, aux, "__qntx.backends.nostr.sign auxRand");
        uint8_t out[64];
        const int ok = nostr_native_sign(id.data, sk.data, aux.data, out);
        jsi::Value result;
        if (ok == 1) {
          result = jsi::Value(rt, makeUint8Array(rt, intrinsics, arrayBufferFromBytes(rt, out, sizeof out)));
        }
        wipe(out, sizeof out);
        if (ok != 1) {
          throw jsi::JSError(rt, "nostr_native: sign rejected the input");
        }
        return result;
      }));

  nostr.setProperty(
      rt,
      "verifySerialized",
      hostFn(rt, "nostr.verifySerialized", 4, [&intrinsics](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 4) {
          throw jsi::JSError(rt, "__qntx.backends.nostr.verifySerialized expects (serialized, id, pubkey, sig)");
        }
        auto serialized = byteViewFromValue(rt, args[0], "__qntx.backends.nostr.verifySerialized serialized", intrinsics);
        auto id = byteViewFromValue(rt, args[1], "__qntx.backends.nostr.verifySerialized id", intrinsics);
        auto pubkey = byteViewFromValue(rt, args[2], "__qntx.backends.nostr.verifySerialized pubkey", intrinsics);
        auto sig = byteViewFromValue(rt, args[3], "__qntx.backends.nostr.verifySerialized sig", intrinsics);
        if (id.size != 32 || pubkey.size != 32 || sig.size != 64) {
          return jsi::Value(false);
        }
        return jsi::Value(nostr_native_verify_serialized(
            serialized.data, serialized.size, id.data, pubkey.data, sig.data) == 1);
      }));

  nostr.setProperty(
      rt,
      "ecdhX",
      hostFn(rt, "nostr.ecdhX", 2, [&intrinsics, &exact32, &wipe](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 2) {
          throw jsi::JSError(rt, "__qntx.backends.nostr.ecdhX expects (secretKey, publicKeyX)");
        }
        auto sk = byteViewFromValue(rt, args[0], "__qntx.backends.nostr.ecdhX secretKey", intrinsics);
        auto pubX = byteViewFromValue(rt, args[1], "__qntx.backends.nostr.ecdhX publicKeyX", intrinsics);
        exact32(rt, sk, "__qntx.backends.nostr.ecdhX secretKey");
        exact32(rt, pubX, "__qntx.backends.nostr.ecdhX publicKeyX");
        uint8_t out[32];
        const int ok = nostr_native_ecdh_x(sk.data, pubX.data, out);
        jsi::Value result;
        if (ok == 1) {
          result = jsi::Value(rt, makeUint8Array(rt, intrinsics, arrayBufferFromBytes(rt, out, sizeof out)));
        }
        wipe(out, sizeof out);
        if (ok != 1) {
          throw jsi::JSError(rt, "nostr_native: ecdhX rejected the input");
        }
        return result;
      }));

  intrinsics.freeze.call(rt, jsi::Value(rt, nostr));

  auto backends = jsi::Object(rt);
  backends.setProperty(rt, "spark", jsi::Value(std::move(spark)));
  backends.setProperty(rt, "nostr", jsi::Value(std::move(nostr)));
  intrinsics.freeze.call(rt, jsi::Value(rt, backends));
  qntx.setProperty(rt, "backends", jsi::Value(std::move(backends)));
}

} // namespace qntx
