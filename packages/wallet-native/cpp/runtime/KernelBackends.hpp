#pragma once

#include <jsi/jsi.h>

namespace qntx {

namespace jsi = facebook::jsi;

struct KernelIntrinsics;

// Installs `backends` on the `__qntx` object before the caller freezes it:
// `backends.spark` is the qntx_spark C ABI bound as host functions. Byte
// inputs are borrowed views (no copy); every qs_* output is copied into a
// fresh Uint8Array and then freed with qs_free, which wipes the buffer first.
void installKernelBackends(
    jsi::Runtime& rt,
    jsi::Object& qntx,
    const KernelIntrinsics& intrinsics);

} // namespace qntx
