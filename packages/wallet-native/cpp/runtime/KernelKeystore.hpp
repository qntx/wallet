#pragma once

#include <jsi/jsi.h>

#include <memory>

namespace qntx {

struct KernelGlobalsState;

// Installs the frozen `keystore` object on `__qntx` before the caller freezes
// it:
//   locale                                        platform language (BCP 47)
//   seal(id, secret, title, description, done)    done(sealed | undefined, code | undefined)
//   open(id, sealed, title, description, done)    done(kek | undefined, code | undefined)
//   authenticate(title, description, done)        done(undefined, code | undefined)
//   clear(done)                                   done(undefined, code | undefined)
// Arguments are validated before the platform sees them (id: 32 lowercase hex;
// title ≤ 128 and description ≤ 1024 UTF-8 bytes, both non-empty; secret
// exactly 32 bytes; sealed 1–512 bytes). Completions return to the kernel
// thread through the pending-call machinery pbkdf2 uses; `code` is the
// kernel error code for a failure. Teardown cancels an in-flight prompt.
void installKernelKeystore(
    facebook::jsi::Runtime& rt,
    facebook::jsi::Object& qntx,
    const std::shared_ptr<KernelGlobalsState>& state);

} // namespace qntx
