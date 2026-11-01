#pragma once

#include "host/Passkey.hpp"

namespace qntxTestPasskey {

// Forget any held completion and the cancel count.
void reset();
// passkeyCancel invocations.
int cancels();

} // namespace qntxTestPasskey
