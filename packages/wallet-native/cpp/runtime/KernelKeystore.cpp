#include "KernelKeystore.hpp"

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

#include "../host/Keystore.hpp"
#include "KernelBuffer.hpp"
#include "KernelGlobals.hpp"
#include "KernelJs.hpp"

namespace qntx {

namespace jsi = facebook::jsi;

namespace {

constexpr size_t kFactorIdLength = 32;
constexpr size_t kTitleMax = 128;
constexpr size_t kDescriptionMax = 1024;
constexpr size_t kSecretLength = 32;
constexpr size_t kSealedMax = 512;

std::string factorId(jsi::Runtime& rt, const jsi::Value& value, const char* name) {
  if (!value.isString()) {
    throw jsi::JSError(rt, std::string(name) + " expects a factor id");
  }
  auto id = value.asString(rt).utf8(rt);
  const bool hex = std::all_of(id.begin(), id.end(), [](char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
  });
  if (id.size() != kFactorIdLength || !hex) {
    throw jsi::JSError(rt, std::string(name) + " factor id must be 32 lowercase hex");
  }
  return id;
}

std::string boundedText(
    jsi::Runtime& rt,
    const jsi::Value& value,
    const char* name,
    size_t max) {
  if (!value.isString()) {
    throw jsi::JSError(rt, std::string(name) + " must be a string");
  }
  auto text = value.asString(rt).utf8(rt);
  if (text.empty() || text.size() > max) {
    throw jsi::JSError(rt, std::string(name) + " length is out of range");
  }
  return text;
}

KeystorePrompt promptFrom(jsi::Runtime& rt, const jsi::Value* args, const char* name) {
  return KeystorePrompt{
      boundedText(rt, args[0], name, kTitleMax),
      boundedText(rt, args[1], name, kDescriptionMax),
  };
}

jsi::Function callbackFrom(jsi::Runtime& rt, const jsi::Value& value, const char* name) {
  if (!value.isObject() || !value.asObject(rt).isFunction(rt)) {
    throw jsi::JSError(rt, std::string(name) + " expects a completion function");
  }
  return value.asObject(rt).asFunction(rt);
}

const char* errorCode(KeystoreStatus status) {
  switch (status) {
    case KeystoreStatus::cancelled:
      return "cancelled";
    case KeystoreStatus::invalidated:
      return "factor-invalidated";
    case KeystoreStatus::unavailable:
      return "factor-unavailable";
    case KeystoreStatus::ok:
    case KeystoreStatus::failed:
      break;
  }
  return "unavailable";
}

// Shared by every keystore call of one runtime: the number of platform calls
// whose completion has not yet returned (kernel thread only).
struct KeystoreCalls {
  int inFlight = 0;
};

// Parks `done` as a pending call and returns the platform completion that
// hands the result back on the kernel thread. `withBytes` says whether a
// success carries bytes (seal, open) or nothing (authenticate, clear).
KeystoreDone park(
    const std::shared_ptr<KernelGlobalsState>& state,
    const std::shared_ptr<KeystoreCalls>& calls,
    jsi::Function done,
    bool withBytes) {
  auto call = std::make_shared<KernelPendingCall>();
  call->done = std::move(done);
  state->pending.insert(call);
  calls->inFlight += 1;
  // The platform may hold this completion long after a lock tore the runtime
  // down (a prompt left on screen), so it keeps only a weak reference.
  std::weak_ptr<KernelGlobalsState> weak = state;
  return [weak, calls, call, withBytes](KeystoreResult result) {
    auto state = weak.lock();
    if (state == nullptr || !state->active->load(std::memory_order_acquire)) {
      return; // the runtime is gone; teardown already dropped `done`
    }
    auto shared = std::make_shared<KeystoreResult>(std::move(result));
    state->enqueueTask([state, calls, call, shared, withBytes](jsi::Runtime& rt) {
      calls->inFlight -= 1;
      auto done = std::move(call->done);
      state->pending.erase(call);
      if (!done.has_value()) {
        return;
      }
      if (shared->status != KeystoreStatus::ok) {
        done->call(
            rt,
            jsi::Value::undefined(),
            jsi::Value(rt, jsi::String::createFromAscii(rt, errorCode(shared->status))));
        return;
      }
      if (!withBytes) {
        done->call(rt, jsi::Value::undefined(), jsi::Value::undefined());
        return;
      }
      if (shared->bytes.size() == 0) {
        done->call(
            rt,
            jsi::Value::undefined(),
            jsi::Value(rt, jsi::String::createFromAscii(rt, errorCode(KeystoreStatus::failed))));
        return;
      }
      auto buffer = arrayBufferFromBytes(rt, shared->bytes.data(), shared->bytes.size());
      auto array = makeUint8Array(rt, *state->intrinsics, std::move(buffer));
      done->call(rt, jsi::Value(std::move(array)), jsi::Value::undefined());
    });
  };
}

} // namespace

void installKernelKeystore(
    jsi::Runtime& rt,
    jsi::Object& qntx,
    const std::shared_ptr<KernelGlobalsState>& state) {
  auto calls = std::make_shared<KeystoreCalls>();
  state->cancelCeremonies.emplace_back([calls] {
    if (calls->inFlight > 0) {
      keystoreCancel();
    }
  });

  auto keystore = jsi::Object(rt);
  keystore.setProperty(rt, "locale", jsi::String::createFromUtf8(rt, keystoreLocale()));
  keystore.setProperty(
      rt,
      "seal",
      hostFn(rt, "keystore.seal", 5, [state, calls](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 5) {
          throw jsi::JSError(
              rt, "__qntx.keystore.seal expects (id, secret, title, description, done)");
        }
        auto id = factorId(rt, args[0], "__qntx.keystore.seal");
        auto view = byteViewFromValue(rt, args[1], "__qntx.keystore.seal secret", *state->intrinsics);
        if (view.size != kSecretLength) {
          throw jsi::JSError(rt, "__qntx.keystore.seal secret must be 32 bytes");
        }
        SecretBytes secret(view.data, view.size);
        auto prompt = promptFrom(rt, args + 2, "__qntx.keystore.seal prompt");
        auto done = park(state, calls, callbackFrom(rt, args[4], "__qntx.keystore.seal"), true);
        keystoreSeal(id, std::move(secret), std::move(prompt), std::move(done));
        return jsi::Value::undefined();
      }));
  keystore.setProperty(
      rt,
      "open",
      hostFn(rt, "keystore.open", 5, [state, calls](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 5) {
          throw jsi::JSError(
              rt, "__qntx.keystore.open expects (id, sealed, title, description, done)");
        }
        auto id = factorId(rt, args[0], "__qntx.keystore.open");
        auto view = byteViewFromValue(rt, args[1], "__qntx.keystore.open sealed", *state->intrinsics);
        if (view.size == 0 || view.size > kSealedMax) {
          throw jsi::JSError(rt, "__qntx.keystore.open sealed length is out of range");
        }
        std::vector<uint8_t> sealed(view.data, view.data + view.size);
        auto prompt = promptFrom(rt, args + 2, "__qntx.keystore.open prompt");
        auto done = park(state, calls, callbackFrom(rt, args[4], "__qntx.keystore.open"), true);
        keystoreOpen(id, std::move(sealed), std::move(prompt), std::move(done));
        return jsi::Value::undefined();
      }));
  keystore.setProperty(
      rt,
      "authenticate",
      hostFn(rt, "keystore.authenticate", 3, [state, calls](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 3) {
          throw jsi::JSError(
              rt, "__qntx.keystore.authenticate expects (title, description, done)");
        }
        auto prompt = promptFrom(rt, args, "__qntx.keystore.authenticate prompt");
        auto done =
            park(state, calls, callbackFrom(rt, args[2], "__qntx.keystore.authenticate"), false);
        keystoreAuthenticate(std::move(prompt), std::move(done));
        return jsi::Value::undefined();
      }));
  keystore.setProperty(
      rt,
      "clear",
      hostFn(rt, "keystore.clear", 1, [state, calls](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 1) {
          throw jsi::JSError(rt, "__qntx.keystore.clear expects (done)");
        }
        auto done = park(state, calls, callbackFrom(rt, args[0], "__qntx.keystore.clear"), false);
        keystoreClear(std::move(done));
        return jsi::Value::undefined();
      }));
  state->intrinsics->freeze.call(rt, jsi::Value(rt, keystore));
  qntx.setProperty(rt, "keystore", jsi::Value(std::move(keystore)));
}

} // namespace qntx
