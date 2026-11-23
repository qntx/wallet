#include "FakeCardReader.hpp"

#include "host/CardReader.hpp"

#include <chrono>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if defined(__APPLE__)
#include <os/log.h>
#elif defined(__ANDROID__)
#include <android/log.h>
#endif

namespace qntx::harness {
namespace {

// What the leak check greps for: the sheet's text and outcome on the native
// probe log channel — os_log on iOS (simctl log stream), the V1Probe tag on
// Android — never on the JS side.
void logLine(const std::string& line) {
#if defined(__APPLE__)
  os_log(OS_LOG_DEFAULT, "%{public}s", line.c_str());
  std::fprintf(stderr, "%s\n", line.c_str());
  std::fflush(stderr);
#elif defined(__ANDROID__)
  __android_log_print(ANDROID_LOG_INFO, "V1Probe", "%s", line.c_str());
#else
  std::fprintf(stderr, "%s\n", line.c_str());
  std::fflush(stderr);
#endif
}

// SELECT of the qntx instance AID F0716E74780101.
const std::vector<uint8_t> kSelectAid{
    0x00, 0xa4, 0x04, 0x00, 0x07, 0xf0, 0x71, 0x6e, 0x74, 0x78, 0x01, 0x01, 0x00};

class FakeCardReader final : public qntx::CardReader {
 public:
  void open(std::string prompt, qntx::CardReaderDone done) override {
    logLine("CARD_SHEET_OPEN " + prompt);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      live_ = true;
    }
    // A card takes a moment to appear: complete on a background thread.
    std::thread([done = std::move(done)] {
      std::this_thread::sleep_for(std::chrono::milliseconds(300));
      done(qntx::CardReaderResult{qntx::CardReaderStatus::ok, {}, {}});
    }).detach();
  }

  void transmit(std::vector<uint8_t> apdu, qntx::CardReaderDone done) override {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!live_) {
        done(qntx::CardReaderResult{qntx::CardReaderStatus::tagLost, {}, "fake:dead"});
        return;
      }
    }
    if (apdu == kSelectAid) {
      done(qntx::CardReaderResult{qntx::CardReaderStatus::ok, {0x90, 0x00}, {}});
      return;
    }
    if (apdu.size() > 1 && apdu[1] == 0xee) {
      {
        std::lock_guard<std::mutex> lock(mutex_);
        live_ = false;
      }
      done(qntx::CardReaderResult{qntx::CardReaderStatus::tagLost, {}, "fake:tag-lost"});
      return;
    }
    // Everything else answers with the data part reversed ‖ 90 00.
    std::vector<uint8_t> response;
    for (size_t i = apdu.size(); i > 4; i--) {
      response.push_back(apdu[i - 1]);
    }
    response.push_back(0x90);
    response.push_back(0x00);
    done(qntx::CardReaderResult{qntx::CardReaderStatus::ok, std::move(response), {}});
  }

  void close(bool success, std::string text) override {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      live_ = false;
    }
    logLine(
        std::string("CARD_SHEET_CLOSE ") + (success ? "success" : "failure") + " " +
        text);
  }

 private:
  std::mutex mutex_;
  bool live_ = false;
};

} // namespace

std::shared_ptr<qntx::CardReader> fakeCardReader() {
  static const auto reader = std::make_shared<FakeCardReader>();
  return reader;
}

} // namespace qntx::harness
