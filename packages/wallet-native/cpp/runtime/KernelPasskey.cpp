#include "KernelPasskey.hpp"

#include <string>
#include <utility>

#include "../host/Passkey.hpp"
#include "KernelGlobals.hpp"
#include "KernelJs.hpp"

namespace qntx {

namespace jsi = facebook::jsi;

namespace {

constexpr size_t kRequestMax = 16 * 1024;

const char* errorCode(PasskeyStatus status) {
  switch (status) {
    case PasskeyStatus::cancelled:
      return "cancelled";
    case PasskeyStatus::unavailable:
      return "factor-unavailable";
    case PasskeyStatus::ok:
    case PasskeyStatus::failed:
      break;
  }
  return "unavailable";
}

struct PasskeyCalls {
  int inFlight = 0; // kernel thread only
};

std::string requestFrom(jsi::Runtime& rt, const jsi::Value& value, const char* name) {
  if (!value.isString()) {
    throw jsi::JSError(rt, std::string(name) + " expects a request JSON string");
  }
  auto request = value.asString(rt).utf8(rt);
  if (request.empty() || request.size() > kRequestMax) {
    throw jsi::JSError(rt, std::string(name) + " request length is out of range");
  }
  return request;
}

// Parks `done` as a pending call; the returned completion hands the outcome
// back on the kernel thread. Like the keystore, the platform may hold the
// completion past teardown, so it keeps the globals state only weakly.
PasskeyDone park(
    const std::shared_ptr<KernelGlobalsState>& state,
    const std::shared_ptr<PasskeyCalls>& calls,
    jsi::Function done) {
  auto call = std::make_shared<KernelPendingCall>();
  call->done = std::move(done);
  state->pending.insert(call);
  calls->inFlight += 1;
  std::weak_ptr<KernelGlobalsState> weak = state;
  return [weak, calls, call](PasskeyResult result) {
    auto state = weak.lock();
    if (state == nullptr || !state->active->load(std::memory_order_acquire)) {
      return;
    }
    auto shared = std::make_shared<PasskeyResult>(std::move(result));
    state->enqueueTask([state, calls, call, shared](jsi::Runtime& rt) {
      calls->inFlight -= 1;
      auto done = std::move(call->done);
      state->pending.erase(call);
      if (!done.has_value()) {
        return;
      }
      if (shared->status != PasskeyStatus::ok || shared->responseJson.empty()) {
        const auto status =
            shared->status == PasskeyStatus::ok ? PasskeyStatus::failed : shared->status;
        done->call(
            rt,
            jsi::Value::undefined(),
            jsi::Value(rt, jsi::String::createFromAscii(rt, errorCode(status))));
        return;
      }
      done->call(
          rt,
          jsi::Value(rt, jsi::String::createFromUtf8(rt, shared->responseJson)),
          jsi::Value::undefined());
    });
  };
}

jsi::Function callbackFrom(jsi::Runtime& rt, const jsi::Value& value, const char* name) {
  if (!value.isObject() || !value.asObject(rt).isFunction(rt)) {
    throw jsi::JSError(rt, std::string(name) + " expects a completion function");
  }
  return value.asObject(rt).asFunction(rt);
}

} // namespace

void installKernelPasskey(
    jsi::Runtime& rt,
    jsi::Object& qntx,
    const std::shared_ptr<KernelGlobalsState>& state) {
  auto calls = std::make_shared<PasskeyCalls>();
  state->cancelCeremonies.emplace_back([calls] {
    if (calls->inFlight > 0) {
      passkeyCancel();
    }
  });

  auto passkey = jsi::Object(rt);
  passkey.setProperty(
      rt,
      "create",
      hostFn(rt, "passkey.create", 2, [state, calls](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 2) {
          throw jsi::JSError(rt, "__qntx.passkey.create expects (requestJson, done)");
        }
        auto request = requestFrom(rt, args[0], "__qntx.passkey.create");
        auto done = park(state, calls, callbackFrom(rt, args[1], "__qntx.passkey.create"));
        passkeyCreate(std::move(request), std::move(done));
        return jsi::Value::undefined();
      }));
  passkey.setProperty(
      rt,
      "get",
      hostFn(rt, "passkey.get", 2, [state, calls](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 2) {
          throw jsi::JSError(rt, "__qntx.passkey.get expects (requestJson, done)");
        }
        auto request = requestFrom(rt, args[0], "__qntx.passkey.get");
        auto done = park(state, calls, callbackFrom(rt, args[1], "__qntx.passkey.get"));
        passkeyGet(std::move(request), std::move(done));
        return jsi::Value::undefined();
      }));
  state->intrinsics->freeze.call(rt, jsi::Value(rt, passkey));
  qntx.setProperty(rt, "passkey", jsi::Value(std::move(passkey)));
}

} // namespace qntx
