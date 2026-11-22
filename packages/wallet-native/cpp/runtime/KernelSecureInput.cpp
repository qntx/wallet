#include "KernelSecureInput.hpp"

#include <string>
#include <utility>

#include "../host/SecureInput.hpp"
#include "KernelBuffer.hpp"
#include "KernelGlobals.hpp"
#include "KernelJs.hpp"

namespace qntx {

namespace jsi = facebook::jsi;

namespace {

constexpr size_t kLabelMax = 512;

const char* errorCode(SecureInputFailure failure) {
  switch (failure) {
    case SecureInputFailure::cancelled:
      return "cancelled";
    case SecureInputFailure::unavailable:
      break;
  }
  return "unavailable";
}

} // namespace

void installKernelSecureInput(
    jsi::Runtime& rt,
    jsi::Object& qntx,
    const std::shared_ptr<KernelGlobalsState>& state) {
  auto& hub = SecureInputHub::shared();

  // Teardown drops this runtime's pending request without completing it — the
  // parked jsi::Function is already dead by then — and clears the views.
  state->cancelCeremonies.emplace_back(
      [&hub, state] { hub.release(state.get()); });

  auto secureInput = jsi::Object(rt);
  secureInput.setProperty(
      rt,
      "request",
      hostFn(rt, "secureInput.request", 3, [state, &hub](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 3) {
          throw jsi::JSError(rt, "__qntx.secureInput.request expects (kind, label, done)");
        }
        if (!args[0].isString()) {
          throw jsi::JSError(rt, "__qntx.secureInput.request kind must be a string");
        }
        const auto kindText = args[0].asString(rt).utf8(rt);
        SecureInputKind kind;
        if (kindText == "access-code") {
          kind = SecureInputKind::accessCode;
        } else if (kindText == "short-id") {
          kind = SecureInputKind::shortId;
        } else {
          throw jsi::JSError(rt, "__qntx.secureInput.request kind is unknown");
        }
        if (!args[1].isString()) {
          throw jsi::JSError(rt, "__qntx.secureInput.request label must be a string");
        }
        auto label = args[1].asString(rt).utf8(rt);
        if (label.empty() || label.size() > kLabelMax) {
          throw jsi::JSError(rt, "__qntx.secureInput.request label length is out of range");
        }
        if (!args[2].isObject() || !args[2].asObject(rt).isFunction(rt)) {
          throw jsi::JSError(rt, "__qntx.secureInput.request expects a completion function");
        }
        auto call = std::make_shared<KernelPendingCall>();
        call->done = args[2].asObject(rt).asFunction(rt);
        state->pending.insert(call);
        std::weak_ptr<KernelGlobalsState> weak = state;
        const auto arm = hub.request(
            state.get(), kind, std::move(label), [weak, call](SecureInputResult result) {
              auto state = weak.lock();
              if (state == nullptr || !state->active->load(std::memory_order_acquire)) {
                return;
              }
              auto shared = std::make_shared<SecureInputResult>(std::move(result));
              state->enqueueTask([state, call, shared](jsi::Runtime& rt) {
                auto done = std::move(call->done);
                call->done.reset();
                state->pending.erase(call);
                if (!done.has_value()) {
                  return;
                }
                if (shared->failure.has_value()) {
                  done->call(
                      rt,
                      jsi::Value::undefined(),
                      jsi::Value(
                          rt,
                          jsi::String::createFromAscii(rt, errorCode(*shared->failure))));
                  return;
                }
                // A fresh Uint8Array holds the only copy that outlives this
                // call; the SecretBytes in `shared` wipes itself.
                auto bytes = arrayBufferFromBytes(
                    rt, shared->value.data(), shared->value.size());
                done->call(
                    rt,
                    jsi::Value(rt, makeUint8Array(rt, *state->intrinsics, std::move(bytes))),
                    jsi::Value::undefined());
              });
            });
        if (arm == SecureInputArm::busySelf) {
          // Kernel bug: a runtime may only have one pending request.
          call->done.reset();
          state->pending.erase(call);
          throw jsi::JSError(
              rt, "__qntx.secureInput.request while a request is pending");
        }
        if (arm == SecureInputArm::busyOther) {
          state->enqueueTask([state, call](jsi::Runtime& rt) {
            auto done = std::move(call->done);
            call->done.reset();
            state->pending.erase(call);
            if (!done.has_value()) {
              return;
            }
            done->call(
                rt,
                jsi::Value::undefined(),
                jsi::Value(rt, jsi::String::createFromAscii(rt, "unavailable")));
          });
        }
        return jsi::Value::undefined();
      }));
  secureInput.setProperty(
      rt,
      "cancel",
      hostFn(rt, "secureInput.cancel", 0, [state, &hub](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t) -> jsi::Value {
        hub.cancel(state.get());
        return jsi::Value::undefined();
      }));

  state->intrinsics->freeze.call(rt, jsi::Value(rt, secureInput));
  qntx.setProperty(rt, "secureInput", jsi::Value(std::move(secureInput)));
}

} // namespace qntx
