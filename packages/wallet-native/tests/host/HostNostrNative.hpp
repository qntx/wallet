#pragma once

#include <cstddef>
#include <cstdint>

// Read-back accessors for the last inputs the fake nostr_native_* functions
// recorded — lets cases prove offset views passed the right bytes.
void hostNostrRecordedSerialized(uint8_t* out, size_t* len);
void hostNostrRecordedSignId(uint8_t* out);
void hostNostrRecordedEcdhPub(uint8_t* out);
