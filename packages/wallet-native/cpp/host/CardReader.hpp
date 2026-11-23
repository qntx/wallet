#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace qntx {

// The platform NFC reader behind `__qntx.cardReader`: an object the host
// packages provide so APDU bytes and the session's visible text flow only
// between the kernel and native code — never through the main runtime. The
// kernel builds the trusted summary and hands it to open() verbatim; the
// platform displays it while it polls for an ISO-DEP tag and must never
// truncate or replace it. iOS: NFCTagReaderSession; Android: reader mode with
// the module's own dialog. platformCardReader() has exactly one strong
// definition per platform; host tests link a fake.

// How a reader call ended. The binding maps each status to the kernel's
// failure code: cancelled → "cancelled", timeout → "timeout",
// tagLost → "tag-lost", interrupted → "interrupted",
// unavailable → "unavailable". The values are part of the Android JNI
// contract.
enum class CardReaderStatus {
  ok = 0,
  cancelled = 1,
  timeout = 2,
  tagLost = 3,
  interrupted = 4,
  unavailable = 5,
};

struct CardReaderResult {
  CardReaderStatus status = CardReaderStatus::unavailable;
  // transmit: the card's response data with SW1SW2 appended, 2..258 bytes.
  std::vector<uint8_t> response;
  // A "<domain>:<code>" diagnostic (e.g. "NFCError:202"), empty when none.
  std::string detail;
};

// Completion callbacks run exactly once, on any thread.
using CardReaderDone = std::function<void(CardReaderResult)>;

// Platform contract:
// - open() shows `prompt` and completes ok once an ISO-DEP card is connected;
//   until then a non-ISO-DEP tag or multiple tags are re-polled without
//   changing the text.
// - After a successful open, a session-ending event (user cancel, system
//   timeout, loss of focus) fails the in-flight transmit — or the next one
//   when none is in flight — with that event's status. After any failure the
//   session is over: it is never polled again.
// - close() ends the session and is idempotent; failure with an empty text is
//   a silent close, otherwise `text` is the result message shown to the user.
class CardReader {
 public:
  virtual ~CardReader() = default;

  virtual void open(std::string prompt, CardReaderDone done) = 0;

  // Only after a successful open; an ok result carries data ‖ SW1 ‖ SW2.
  virtual void transmit(std::vector<uint8_t> apdu, CardReaderDone done) = 0;

  virtual void close(bool success, std::string text) = 0;
};

// The platform's reader; every KernelRuntime shares it.
std::shared_ptr<CardReader> platformCardReader();

} // namespace qntx
