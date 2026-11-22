#pragma once

#include <memory>

namespace qntx {
class CardReader;
}

namespace qntx::harness {

// The scripted card behind the card-surfaces probe: open logs the prompt and
// completes ok after a short delay, transmit answers the fixture contract,
// close logs the outcome. Only the probe kernel ever sees it — the real
// platform reader is untouched.
std::shared_ptr<qntx::CardReader> fakeCardReader();

} // namespace qntx::harness
