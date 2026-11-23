#pragma once

#include <jsi/jsi.h>

#include <memory>

namespace qntx {

struct KernelGlobalsState;

// Installs the frozen `cardReader` object on `__qntx` before the caller
// freezes it:
//   open(prompt, done)     done(code | undefined, detail | undefined)
//   transmit(apdu, done)   done(response | undefined, code | undefined, detail | undefined)
//   close(outcome, text)
// `prompt` is 1..1024 UTF-8 bytes shown verbatim by the platform session;
// `apdu` is a 4..261-byte view and an ok response is data ‖ SW1 ‖ SW2 of
// 2..258 bytes. One session per process: a second runtime's open completes
// "unavailable" with detail "qntx:busy". Every failure ends the session with
// a silent platform close; teardown closes a live session the same way and
// drops late completions.
void installKernelCardReader(
    facebook::jsi::Runtime& rt,
    facebook::jsi::Object& qntx,
    const std::shared_ptr<KernelGlobalsState>& state);

} // namespace qntx
