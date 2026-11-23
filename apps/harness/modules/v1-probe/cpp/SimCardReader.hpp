#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace qntx {
class CardReader;
}

namespace qntx::harness {

// The simulator card behind the card-sim probe: a TCP client of the
// scripts/card-sim bridge (the real qntx applet in jcardsim). open()
// power-cycles the one card the bridge created for this reader; transmit()
// sends raw APDUs and returns R-payloads, mapping TORN to tagLost.
std::shared_ptr<qntx::CardReader> simCardReader(std::string host, int port);

// The identity key (33 B) of the card the sim reader personalised, empty until
// the bridge answers `new`. Exposed to the probe runtime so the scripted
// secure input can type the card's printed short ID.
std::vector<uint8_t> simIdentity();

} // namespace qntx::harness
