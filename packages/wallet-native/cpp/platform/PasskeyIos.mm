// iOS passkey authenticator: not available yet. Native passkeys need the
// app's associated domain (webcredentials), which the current free signing
// team cannot provision; W6c implements ASAuthorization with PRF once a paid
// team exists. Until then every ceremony reports `unavailable`, which the
// kernel surfaces as factor-unavailable (no passkey wallet on this platform).
#include "../host/Passkey.hpp"

namespace qntx {

void passkeyCreate(std::string, PasskeyDone done) {
  done(PasskeyResult{PasskeyStatus::unavailable, {}});
}

void passkeyGet(std::string, PasskeyDone done) {
  done(PasskeyResult{PasskeyStatus::unavailable, {}});
}

void passkeyCancel() {}

} // namespace qntx
