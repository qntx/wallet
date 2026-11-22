#pragma once

#include <jsi/jsi.h>

#include <memory>

namespace qntx {

struct KernelGlobalsState;

// Installs the frozen `secureInput` object on `__qntx` before the caller
// freezes it:
//   request(kind, label, done)   done(value | undefined, code | undefined)
//   cancel()
// `kind` is "access-code" or "short-id"; `label` is 1..512 UTF-8 bytes shown
// inside the secure view. Requests go to the process-wide SecureInputHub, so
// at most one request exists at a time: a second request of this runtime is
// a kernel bug (throws), another runtime's completes "unavailable". Teardown
// releases this runtime's pending request without calling its done.
void installKernelSecureInput(
    facebook::jsi::Runtime& rt,
    facebook::jsi::Object& qntx,
    const std::shared_ptr<KernelGlobalsState>& state);

} // namespace qntx
