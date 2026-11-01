// Test-only platform passkey authenticator: the host build has no Credential
// Manager, so this file supplies the passkey* functions. A request completes
// on a detached thread with `{"echo":<request>}`, or with the status a
// `"fail:<status>"` marker inside the request names; a `"hold"` marker parks
// the completion until passkeyCancel.
#include "HostPasskey.hpp"

#include <mutex>
#include <optional>
#include <thread>
#include <utility>

namespace qntxTestPasskey {
namespace {

struct State {
  std::mutex mutex;
  std::optional<qntx::PasskeyDone> held;
  int cancels = 0;
};

State& state() {
  static auto* s = new State();
  return *s;
}

void completeLater(qntx::PasskeyDone done, qntx::PasskeyResult result) {
  std::thread([done = std::move(done), result = std::move(result)]() mutable {
    done(std::move(result));
  }).detach();
}

void answer(const std::string& request, qntx::PasskeyDone done) {
  if (request.find("\"hold\"") != std::string::npos) {
    std::lock_guard<std::mutex> lock(state().mutex);
    state().held = std::move(done);
    return;
  }
  for (const auto& [marker, status] : {
           std::pair{"fail:cancelled", qntx::PasskeyStatus::cancelled},
           std::pair{"fail:unavailable", qntx::PasskeyStatus::unavailable},
           std::pair{"fail:failed", qntx::PasskeyStatus::failed},
       }) {
    if (request.find(marker) != std::string::npos) {
      completeLater(std::move(done), qntx::PasskeyResult{status, {}});
      return;
    }
  }
  completeLater(
      std::move(done), qntx::PasskeyResult{qntx::PasskeyStatus::ok, "{\"echo\":" + request + "}"});
}

} // namespace

void reset() {
  std::lock_guard<std::mutex> lock(state().mutex);
  state().held.reset();
  state().cancels = 0;
}

int cancels() {
  std::lock_guard<std::mutex> lock(state().mutex);
  return state().cancels;
}

} // namespace qntxTestPasskey

namespace qntx {

void passkeyCreate(std::string requestJson, PasskeyDone done) {
  qntxTestPasskey::answer(requestJson, std::move(done));
}

void passkeyGet(std::string requestJson, PasskeyDone done) {
  qntxTestPasskey::answer(requestJson, std::move(done));
}

void passkeyCancel() {
  std::optional<PasskeyDone> held;
  {
    auto& s = qntxTestPasskey::state();
    std::lock_guard<std::mutex> lock(s.mutex);
    s.cancels += 1;
    held.swap(s.held);
  }
  if (held.has_value()) {
    qntxTestPasskey::completeLater(std::move(*held), PasskeyResult{PasskeyStatus::cancelled, {}});
  }
}

} // namespace qntx
