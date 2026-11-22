#include "KernelCardReader.hpp"

#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "../host/CardReader.hpp"
#include "KernelBuffer.hpp"
#include "KernelGlobals.hpp"
#include "KernelJs.hpp"

namespace qntx {

namespace jsi = facebook::jsi;

namespace {

constexpr size_t kPromptMax = 1024;
constexpr size_t kTextMax = 1024;
constexpr size_t kApduMin = 4;
constexpr size_t kApduMax = 261;
constexpr size_t kResponseMin = 2;
constexpr size_t kResponseMax = 258;

const char* errorCode(CardReaderStatus status) {
  switch (status) {
    case CardReaderStatus::cancelled:
      return "cancelled";
    case CardReaderStatus::timeout:
      return "timeout";
    case CardReaderStatus::tagLost:
      return "tag-lost";
    case CardReaderStatus::interrupted:
      return "interrupted";
    case CardReaderStatus::ok:
    case CardReaderStatus::unavailable:
      break;
  }
  return "unavailable";
}

// Process-wide ownership: at most one runtime holds a reader session. The
// owner is the KernelGlobalsState* — opaque identity only, never dereferenced.
std::mutex& ownerMutex() {
  static auto* m = new std::mutex();
  return *m;
}

const void*& ownerSlot() {
  static const void* owner = nullptr;
  return owner;
}

bool ownsReader(const void* owner) {
  std::lock_guard<std::mutex> lock(ownerMutex());
  return ownerSlot() == owner;
}

void releaseReader(const void* owner) {
  std::lock_guard<std::mutex> lock(ownerMutex());
  if (ownerSlot() == owner) {
    ownerSlot() = nullptr;
  }
}

enum class Phase { idle, opening, connected, ended, closed };

// One runtime's reader session; touched on the kernel thread only.
struct ReaderSession {
  Phase phase = Phase::idle;
  const char* endedCode = nullptr;
  std::shared_ptr<KernelPendingCall> open;
  std::shared_ptr<KernelPendingCall> transmit;
};

std::string textArg(
    jsi::Runtime& rt,
    const jsi::Value& value,
    const char* name,
    size_t max) {
  if (!value.isString()) {
    throw jsi::JSError(rt, std::string(name) + " must be a string");
  }
  auto text = value.asString(rt).utf8(rt);
  if (text.size() > max) {
    throw jsi::JSError(rt, std::string(name) + " length is out of range");
  }
  return text;
}

jsi::Function callbackFrom(jsi::Runtime& rt, const jsi::Value& value, const char* name) {
  if (!value.isObject() || !value.asObject(rt).isFunction(rt)) {
    throw jsi::JSError(rt, std::string(name) + " expects a completion function");
  }
  return value.asObject(rt).asFunction(rt);
}

jsi::Value ascii(jsi::Runtime& rt, const char* s) {
  return jsi::Value(rt, jsi::String::createFromAscii(rt, s));
}

std::shared_ptr<KernelPendingCall> park(
    const std::shared_ptr<KernelGlobalsState>& state,
    jsi::Function done) {
  auto call = std::make_shared<KernelPendingCall>();
  call->done = std::move(done);
  state->pending.insert(call);
  return call;
}

// Settles a parked call on the kernel thread; returns false when it was
// already settled (an early close moved the done out).
bool settle(
    jsi::Runtime& rt,
    const std::shared_ptr<KernelGlobalsState>& state,
    const std::shared_ptr<KernelPendingCall>& call,
    std::initializer_list<jsi::Value> args) {
  // A moved-from optional stays engaged with a dead jsi::Function, so a
  // second settle would call a null pointer — reset() disengages it.
  auto done = std::move(call->done);
  call->done.reset();
  state->pending.erase(call);
  if (!done.has_value()) {
    return false;
  }
  done->call(rt, args);
  return true;
}

// A failed platform result always ends the session: mark it, drop the
// platform session silently, and hand process ownership back.
void failSession(
    const std::shared_ptr<KernelGlobalsState>& state,
    const std::shared_ptr<ReaderSession>& session,
    const char* code) {
  session->phase = Phase::ended;
  session->endedCode = code;
  if (state->cardReader != nullptr) {
    state->cardReader->close(false, "");
  }
  releaseReader(state.get());
}

} // namespace

void installKernelCardReader(
    jsi::Runtime& rt,
    jsi::Object& qntx,
    const std::shared_ptr<KernelGlobalsState>& state) {
  auto session = std::make_shared<ReaderSession>();

  // Kernel thread, runtime teardown: a live session belongs to nobody now —
  // close it silently and hand ownership back. Late completions die on the
  // weak state/active flag like every other ceremony. Capturing `state` here
  // would cycle state → cancelCeremonies → state, so the ceremony keeps the
  // raw owner identity and a reader reference instead.
  const void* owner = state.get();
  const std::shared_ptr<CardReader> reader = state->cardReader;
  state->cancelCeremonies.emplace_back([owner, reader, session] {
    session->phase = Phase::closed;
    if (ownsReader(owner) && reader != nullptr) {
      reader->close(false, "");
    }
    releaseReader(owner);
  });

  auto cardReader = jsi::Object(rt);
  cardReader.setProperty(
      rt,
      "open",
      hostFn(rt, "cardReader.open", 2, [state, session](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 2) {
          throw jsi::JSError(rt, "__qntx.cardReader.open expects (prompt, done)");
        }
        auto prompt = textArg(rt, args[0], "__qntx.cardReader.open prompt", kPromptMax);
        if (prompt.empty()) {
          throw jsi::JSError(rt, "__qntx.cardReader.open prompt length is out of range");
        }
        auto done = callbackFrom(rt, args[1], "__qntx.cardReader.open");
        if (session->phase == Phase::opening || session->phase == Phase::connected) {
          throw jsi::JSError(rt, "__qntx.cardReader.open while a session is open");
        }
        auto call = park(state, std::move(done));
        {
          std::lock_guard<std::mutex> lock(ownerMutex());
          if (ownerSlot() != nullptr && ownerSlot() != state.get()) {
            // Another runtime owns the reader: complete asynchronously and
            // never touch the platform.
            state->enqueueTask([state, call](jsi::Runtime& rt) {
              settle(
                  rt, state, call,
                  {ascii(rt, "unavailable"), ascii(rt, "qntx:busy")});
            });
            return jsi::Value::undefined();
          }
          ownerSlot() = state.get();
        }
        session->phase = Phase::opening;
        session->endedCode = nullptr;
        session->open = call;
        auto reader = state->cardReader;
        if (reader == nullptr) {
          state->enqueueTask([state, session, call](jsi::Runtime& rt) {
            if (session->open == call) {
              session->open.reset();
            }
            failSession(state, session, "unavailable");
            settle(rt, state, call, {ascii(rt, "unavailable"), jsi::Value::undefined()});
          });
          return jsi::Value::undefined();
        }
        std::weak_ptr<KernelGlobalsState> weak = state;
        reader->open(std::move(prompt), [weak, session, call](CardReaderResult result) {
          auto state = weak.lock();
          if (state == nullptr || !state->active->load(std::memory_order_acquire)) {
            return;
          }
          auto shared = std::make_shared<CardReaderResult>(std::move(result));
          state->enqueueTask([state, session, call, shared](jsi::Runtime& rt) {
            if (session->open == call) {
              session->open.reset();
            }
            if (session->phase == Phase::closed) {
              // The kernel already closed this session: settle the call and
              // ignore the platform's late answer.
              settle(rt, state, call, {ascii(rt, "cancelled"), jsi::Value::undefined()});
              return;
            }
            if (shared->status == CardReaderStatus::ok) {
              session->phase = Phase::connected;
              settle(rt, state, call, {jsi::Value::undefined(), jsi::Value::undefined()});
              return;
            }
            const char* code = errorCode(shared->status);
            failSession(state, session, code);
            settle(
                rt, state, call,
                {ascii(rt, code), detailValue(rt, shared->detail)});
          });
        });
        return jsi::Value::undefined();
      }));

  cardReader.setProperty(
      rt,
      "transmit",
      hostFn(rt, "cardReader.transmit", 2, [state, session](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 2) {
          throw jsi::JSError(rt, "__qntx.cardReader.transmit expects (apdu, done)");
        }
        auto view = byteViewFromValue(
            rt, args[0], "__qntx.cardReader.transmit apdu", *state->intrinsics);
        if (view.size < kApduMin || view.size > kApduMax) {
          throw jsi::JSError(rt, "__qntx.cardReader.transmit apdu length is out of range");
        }
        auto done = callbackFrom(rt, args[1], "__qntx.cardReader.transmit");
        if (session->phase == Phase::ended) {
          // The session ended on a platform event: the platform contract
          // fails the next transmit with the same code, so answer it here
          // without touching the platform.
          const char* code = session->endedCode;
          auto call = park(state, std::move(done));
          state->enqueueTask([state, call, code](jsi::Runtime& rt) {
            settle(rt, state, call, {jsi::Value::undefined(), ascii(rt, code), jsi::Value::undefined()});
          });
          return jsi::Value::undefined();
        }
        if (session->phase != Phase::connected) {
          throw jsi::JSError(rt, "__qntx.cardReader.transmit without a connected session");
        }
        if (session->transmit != nullptr) {
          throw jsi::JSError(rt, "__qntx.cardReader.transmit while a transmit is in flight");
        }
        auto call = park(state, std::move(done));
        session->transmit = call;
        std::vector<uint8_t> apdu(view.data, view.data + view.size);
        std::weak_ptr<KernelGlobalsState> weak = state;
        state->cardReader->transmit(std::move(apdu), [weak, session, call](CardReaderResult result) {
          auto state = weak.lock();
          if (state == nullptr || !state->active->load(std::memory_order_acquire)) {
            return;
          }
          auto shared = std::make_shared<CardReaderResult>(std::move(result));
          state->enqueueTask([state, session, call, shared](jsi::Runtime& rt) {
            if (session->transmit == call) {
              session->transmit.reset();
            }
            if (session->phase == Phase::closed) {
              settle(
                  rt, state, call,
                  {jsi::Value::undefined(), ascii(rt, "cancelled"), jsi::Value::undefined()});
              return;
            }
            if (shared->status == CardReaderStatus::ok &&
                shared->response.size() >= kResponseMin &&
                shared->response.size() <= kResponseMax) {
              auto response = arrayBufferFromBytes(
                  rt, shared->response.data(), shared->response.size());
              settle(
                  rt, state, call,
                  {jsi::Value(rt, makeUint8Array(rt, *state->intrinsics, std::move(response))),
                   jsi::Value::undefined(),
                   jsi::Value::undefined()});
              return;
            }
            if (shared->status == CardReaderStatus::ok) {
              failSession(state, session, "unavailable");
              settle(
                  rt, state, call,
                  {jsi::Value::undefined(),
                   ascii(rt, "unavailable"),
                   ascii(rt, "qntx:bad-response")});
              return;
            }
            const char* code = errorCode(shared->status);
            failSession(state, session, code);
            settle(
                rt, state, call,
                {jsi::Value::undefined(),
                 ascii(rt, code),
                 detailValue(rt, shared->detail)});
          });
        });
        return jsi::Value::undefined();
      }));

  cardReader.setProperty(
      rt,
      "close",
      hostFn(rt, "cardReader.close", 2, [state, session](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
        if (count < 2) {
          throw jsi::JSError(rt, "__qntx.cardReader.close expects (outcome, text)");
        }
        const auto outcome = textArg(rt, args[0], "__qntx.cardReader.close outcome", kTextMax);
        if (outcome != "success" && outcome != "failure") {
          throw jsi::JSError(rt, "__qntx.cardReader.close outcome must be success or failure");
        }
        const auto text = textArg(rt, args[1], "__qntx.cardReader.close text", kTextMax);
        // The kernel ended the session itself: the platform session ends and
        // ownership is released first, then any call still parked resolves
        // cancelled asynchronously, like every other completion — settling
        // here would re-enter JS while the phase still says open. The
        // platform's late answer is ignored.
        auto parkedOpen = std::move(session->open);
        auto parkedTransmit = std::move(session->transmit);
        switch (session->phase) {
          case Phase::idle:
          case Phase::closed:
            break;
          case Phase::ended:
            // The failure path already closed the platform session silently.
            session->phase = Phase::closed;
            break;
          case Phase::opening:
          case Phase::connected:
            if (state->cardReader != nullptr) {
              state->cardReader->close(outcome == "success", text);
            }
            session->phase = Phase::closed;
            releaseReader(state.get());
            break;
        }
        if (parkedOpen != nullptr) {
          state->enqueueTask([state, parkedOpen](jsi::Runtime& rt) {
            settle(
                rt, state, parkedOpen,
                {ascii(rt, "cancelled"), jsi::Value::undefined()});
          });
        }
        if (parkedTransmit != nullptr) {
          state->enqueueTask([state, parkedTransmit](jsi::Runtime& rt) {
            settle(
                rt, state, parkedTransmit,
                {jsi::Value::undefined(), ascii(rt, "cancelled"), jsi::Value::undefined()});
          });
        }
        return jsi::Value::undefined();
      }));

  state->intrinsics->freeze.call(rt, jsi::Value(rt, cardReader));
  qntx.setProperty(rt, "cardReader", jsi::Value(std::move(cardReader)));
}

} // namespace qntx
