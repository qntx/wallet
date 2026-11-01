#pragma once

#include <jsi/jsi.h>

#include <memory>

namespace qntx {

struct KernelGlobalsState;

// Installs the frozen `passkey` object on `__qntx` before the caller freezes
// it:
//   create(requestJson, done)   done(responseJson | undefined, code | undefined)
//   get(requestJson, done)      done(responseJson | undefined, code | undefined)
// The request is a non-empty string of at most 16 KiB. Completions return to
// the kernel thread through the pending-call machinery; `code` is the kernel
// error code for a failure. Teardown cancels an in-flight ceremony.
void installKernelPasskey(
    facebook::jsi::Runtime& rt,
    facebook::jsi::Object& qntx,
    const std::shared_ptr<KernelGlobalsState>& state);

} // namespace qntx
