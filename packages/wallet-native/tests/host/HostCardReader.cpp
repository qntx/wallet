// Test-only platform card reader: the host build has no NFC, so this file
// supplies platformCardReader(). open completes ok, holds ("hold"), or fails
// with the status a "fail:<status>" prompt names — the prompt doubles as the
// detail so the JS side can assert it arrives. transmit answers an APDU by
// INS: 0xEE → tagLost, 0xEF → held until fireHeld, 0xB0 → a 1-byte response
// (below the kernel's minimum); anything else echoes the APDU's data part
// (bytes after the 4-byte header) reversed with SW 90 00 appended.
#include "HostCardReader.hpp"

#include <deque>
#include <mutex>
#include <optional>
#include <thread>
#include <utility>

#include "host/CardReader.hpp"

namespace qntxTestCardReader {
namespace {

struct Held {
  qntx::CardReaderDone done;
  qntx::CardReaderResult result;
};

struct State {
  std::mutex mutex;
  std::deque<Held> held;
  std::vector<Close> closes;
  std::string lastPrompt;
  int opens = 0;
  int transmits = 0;
};

State& state() {
  static auto* s = new State();
  return *s;
}

void completeLater(qntx::CardReaderDone done, qntx::CardReaderResult result) {
  std::thread([done = std::move(done), result = std::move(result)]() mutable {
    done(std::move(result));
  }).detach();
}

void hold(qntx::CardReaderDone done, qntx::CardReaderResult result) {
  std::lock_guard<std::mutex> lock(state().mutex);
  state().held.push_back(Held{std::move(done), std::move(result)});
}

} // namespace

void reset() {
  std::lock_guard<std::mutex> lock(state().mutex);
  state().held.clear();
  state().closes.clear();
  state().lastPrompt.clear();
  state().opens = 0;
  state().transmits = 0;
}

std::vector<Close> closes() {
  std::lock_guard<std::mutex> lock(state().mutex);
  return state().closes;
}

std::string lastPrompt() {
  std::lock_guard<std::mutex> lock(state().mutex);
  return state().lastPrompt;
}

int opens() {
  std::lock_guard<std::mutex> lock(state().mutex);
  return state().opens;
}

int transmits() {
  std::lock_guard<std::mutex> lock(state().mutex);
  return state().transmits;
}

bool fireHeld() {
  std::optional<Held> held;
  {
    std::lock_guard<std::mutex> lock(state().mutex);
    if (state().held.empty()) {
      return false;
    }
    held = std::move(state().held.front());
    state().held.pop_front();
  }
  completeLater(std::move(held->done), std::move(held->result));
  return true;
}

} // namespace qntxTestCardReader

namespace qntx {
namespace {

class HostCardReader final : public CardReader {
 public:
  void open(std::string prompt, CardReaderDone done) override {
    {
      auto& s = qntxTestCardReader::state();
      std::lock_guard<std::mutex> lock(s.mutex);
      s.lastPrompt = prompt;
      s.opens += 1;
    }
    if (prompt == "hold") {
      qntxTestCardReader::hold(std::move(done), CardReaderResult{CardReaderStatus::cancelled, {}});
      return;
    }
    for (const auto& [marker, status] : {
             std::pair{"fail:cancelled", CardReaderStatus::cancelled},
             std::pair{"fail:timeout", CardReaderStatus::timeout},
             std::pair{"fail:tag-lost", CardReaderStatus::tagLost},
             std::pair{"fail:interrupted", CardReaderStatus::interrupted},
             std::pair{"fail:unavailable", CardReaderStatus::unavailable},
         }) {
      if (prompt == marker) {
        // The marker doubles as the detail so the JS side can assert it arrives.
        qntxTestCardReader::completeLater(
            std::move(done), CardReaderResult{status, {}, marker});
        return;
      }
    }
    qntxTestCardReader::completeLater(std::move(done), CardReaderResult{CardReaderStatus::ok, {}});
  }

  void transmit(std::vector<uint8_t> apdu, CardReaderDone done) override {
    {
      auto& s = qntxTestCardReader::state();
      std::lock_guard<std::mutex> lock(s.mutex);
      s.transmits += 1;
    }
    const uint8_t ins = apdu.size() > 1 ? apdu[1] : 0;
    switch (ins) {
      case 0xEE:
        qntxTestCardReader::completeLater(
            std::move(done), CardReaderResult{CardReaderStatus::tagLost, {}});
        return;
      case 0xEF:
        qntxTestCardReader::hold(
            std::move(done), CardReaderResult{CardReaderStatus::tagLost, {}});
        return;
      case 0xB0:
        qntxTestCardReader::completeLater(
            std::move(done), CardReaderResult{CardReaderStatus::ok, {0x00}});
        return;
      default: {
        std::vector<uint8_t> response;
        for (size_t i = apdu.size(); i > 4; i--) {
          response.push_back(apdu[i - 1]);
        }
        response.push_back(0x90);
        response.push_back(0x00);
        qntxTestCardReader::completeLater(
            std::move(done), CardReaderResult{CardReaderStatus::ok, std::move(response)});
        return;
      }
    }
  }

  void close(bool success, std::string text) override {
    auto& s = qntxTestCardReader::state();
    std::lock_guard<std::mutex> lock(s.mutex);
    s.closes.push_back(qntxTestCardReader::Close{success, std::move(text)});
  }
};

} // namespace

std::shared_ptr<CardReader> platformCardReader() {
  static const std::shared_ptr<CardReader> reader = std::make_shared<HostCardReader>();
  return reader;
}

} // namespace qntx
