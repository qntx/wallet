// Test-only platform keystore: the host build has no Secure Enclave or
// Android Keystore, so this file supplies the keystore* functions. Sealing
// XORs the secret with 0x5a and keeps it per id; completions run on a
// detached thread like a real platform callback. Tests script failures by
// prompt title, hold a completion to exercise teardown, and read back every
// call.
#include "HostKeystore.hpp"

#include <map>
#include <mutex>
#include <optional>
#include <thread>
#include <utility>

namespace qntxTestKeystore {
namespace {

struct Held {
  qntx::KeystoreDone done;
  qntx::KeystoreResult result;
};

struct State {
  std::mutex mutex;
  std::vector<Call> calls;
  std::map<std::string, std::vector<uint8_t>> keys;
  bool holdNext = false;
  std::optional<Held> held;
  int cancels = 0;
};

State& state() {
  static auto* s = new State();
  return *s;
}

void completeLater(qntx::KeystoreDone done, qntx::KeystoreResult result) {
  std::thread([done = std::move(done), result = std::move(result)]() mutable {
    done(std::move(result));
  }).detach();
}

std::optional<qntx::KeystoreStatus> scriptedFailure(const std::string& title) {
  static const std::map<std::string, qntx::KeystoreStatus> kScripts = {
      {"fail:cancelled", qntx::KeystoreStatus::cancelled},
      {"fail:invalidated", qntx::KeystoreStatus::invalidated},
      {"fail:unavailable", qntx::KeystoreStatus::unavailable},
      {"fail:failed", qntx::KeystoreStatus::failed},
  };
  auto found = kScripts.find(title);
  return found == kScripts.end() ? std::nullopt : std::optional(found->second);
}

// Records the call, then completes it: scripted failure, held, or `success`.
void finish(Call call, qntx::KeystoreDone done, qntx::KeystoreResult success) {
  auto failure = scriptedFailure(call.title);
  auto& s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  s.calls.push_back(std::move(call));
  qntx::KeystoreResult result =
      failure.has_value() ? qntx::KeystoreResult{*failure, {}} : std::move(success);
  if (s.holdNext) {
    s.holdNext = false;
    s.held = Held{std::move(done), std::move(result)};
    return;
  }
  completeLater(std::move(done), std::move(result));
}

qntx::SecretBytes xorBytes(const uint8_t* data, size_t size) {
  qntx::SecretBytes out(size);
  for (size_t i = 0; i < size; ++i) {
    out.data()[i] = data[i] ^ 0x5a;
  }
  return out;
}

} // namespace

std::vector<Call> calls() {
  std::lock_guard<std::mutex> lock(state().mutex);
  return state().calls;
}

void reset() {
  auto& s = state();
  std::lock_guard<std::mutex> lock(s.mutex);
  s.calls.clear();
  s.keys.clear();
  s.holdNext = false;
  s.held.reset();
  s.cancels = 0;
}

void holdNext() {
  std::lock_guard<std::mutex> lock(state().mutex);
  state().holdNext = true;
}

bool releaseHeld() {
  std::optional<Held> held;
  {
    std::lock_guard<std::mutex> lock(state().mutex);
    held.swap(state().held);
  }
  if (!held.has_value()) {
    return false;
  }
  completeLater(std::move(held->done), std::move(held->result));
  return true;
}

int cancels() {
  std::lock_guard<std::mutex> lock(state().mutex);
  return state().cancels;
}

} // namespace qntxTestKeystore

namespace qntx {

using qntxTestKeystore::Call;

void keystoreSeal(
    const std::string& id,
    SecretBytes secret,
    KeystorePrompt prompt,
    KeystoreDone done) {
  auto sealed = qntxTestKeystore::xorBytes(secret.data(), secret.size());
  {
    auto& s = qntxTestKeystore::state();
    std::lock_guard<std::mutex> lock(s.mutex);
    s.keys[id] = std::vector<uint8_t>(sealed.data(), sealed.data() + sealed.size());
  }
  qntxTestKeystore::finish(
      Call{"seal", id, prompt.title, prompt.description, secret.size()},
      std::move(done),
      KeystoreResult{KeystoreStatus::ok, std::move(sealed)});
}

void keystoreOpen(
    const std::string& id,
    std::vector<uint8_t> sealed,
    KeystorePrompt prompt,
    KeystoreDone done) {
  bool known = false;
  {
    auto& s = qntxTestKeystore::state();
    std::lock_guard<std::mutex> lock(s.mutex);
    auto key = s.keys.find(id);
    known = key != s.keys.end() && key->second == sealed;
  }
  KeystoreResult success = known
      ? KeystoreResult{KeystoreStatus::ok, qntxTestKeystore::xorBytes(sealed.data(), sealed.size())}
      : KeystoreResult{KeystoreStatus::invalidated, {}};
  qntxTestKeystore::finish(
      Call{"open", id, prompt.title, prompt.description, sealed.size()},
      std::move(done),
      std::move(success));
}

void keystoreAuthenticate(KeystorePrompt prompt, KeystoreDone done) {
  qntxTestKeystore::finish(
      Call{"authenticate", "", prompt.title, prompt.description, 0},
      std::move(done),
      KeystoreResult{KeystoreStatus::ok, {}});
}

void keystoreClear(KeystoreDone done) {
  {
    auto& s = qntxTestKeystore::state();
    std::lock_guard<std::mutex> lock(s.mutex);
    s.keys.clear();
  }
  qntxTestKeystore::finish(
      Call{"clear", "", "", "", 0}, std::move(done), KeystoreResult{KeystoreStatus::ok, {}});
}

void keystoreCancel() {
  std::optional<qntxTestKeystore::Held> held;
  {
    auto& s = qntxTestKeystore::state();
    std::lock_guard<std::mutex> lock(s.mutex);
    s.cancels += 1;
    held.swap(s.held);
  }
  if (held.has_value()) {
    qntxTestKeystore::completeLater(
        std::move(held->done), KeystoreResult{KeystoreStatus::cancelled, {}});
  }
}

std::string keystoreLocale() {
  return "zh-Hans-CN";
}

} // namespace qntx
