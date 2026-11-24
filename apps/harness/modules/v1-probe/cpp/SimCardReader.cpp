#include "SimCardReader.hpp"

#include "host/CardReader.hpp"

#include <cerrno>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include <netdb.h>
#include <unistd.h>
#include <sys/socket.h>

#if defined(__APPLE__)
#include <os/log.h>
#elif defined(__ANDROID__)
#include <android/log.h>
#endif

namespace qntx::harness {
namespace {

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

std::string toHex(const std::vector<uint8_t>& bytes) {
  static const char* digits = "0123456789abcdef";
  std::string out;
  out.reserve(bytes.size() * 2);
  for (uint8_t b : bytes) {
    out.push_back(digits[b >> 4]);
    out.push_back(digits[b & 0x0f]);
  }
  return out;
}

std::vector<uint8_t> fromHex(const std::string& hex) {
  std::vector<uint8_t> out;
  for (size_t i = 0; i + 1 < hex.size(); i += 2) {
    auto nibble = [](char c) -> int {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      if (c >= 'A' && c <= 'F') return c - 'A' + 10;
      return -1;
    };
    const int hi = nibble(hex[i]);
    const int lo = nibble(hex[i + 1]);
    if (hi < 0 || lo < 0) {
      return {};
    }
    out.push_back(static_cast<uint8_t>((hi << 4) | lo));
  }
  return out;
}

std::mutex identityMutex;
std::vector<uint8_t> identityBytes;

void setIdentity(const std::vector<uint8_t>& cert) {
  if (cert.size() < 33) {
    return;
  }
  std::lock_guard<std::mutex> lock(identityMutex);
  identityBytes.assign(cert.begin(), cert.begin() + 33);
}

// One TCP client of the card-sim bridge: the same line protocol the Node
// harness drives over stdio. The card is personalised at construction (`new`)
// — the probe's create flow asks for the printed short ID before its first
// tap — and every open() power-cycles it (`reset`).
class SimCardReader final : public qntx::CardReader {
 public:
  SimCardReader(std::string host, int port) : host_(std::move(host)), port_(port) {
    if (!connectTo()) {
      logLine("SIM_CONNECT_FAILED " + host_ + ":" + std::to_string(port_));
      return;
    }
    const std::string answer = roundTrip("new");
    if (!answer.starts_with("CARD ")) {
      logLine("SIM_NEW_FAILED " + answer);
      drop();
      return;
    }
    cardIndex_ = std::stoi(answer.substr(5, answer.find(' ', 5) - 5));
    setIdentity(fromHex(answer.substr(answer.find(' ', 5) + 1)));
    live_ = true;
    logLine("SIM_CARD " + std::to_string(cardIndex_));
  }

  ~SimCardReader() override { drop(); }

  void open(std::string prompt, qntx::CardReaderDone done) override {
    logLine("SIM_SHEET_OPEN " + prompt);
    std::lock_guard<std::mutex> lock(mutex_);
    if (fd_ < 0 || cardIndex_ < 0) {
      done(qntx::CardReaderResult{
          qntx::CardReaderStatus::unavailable, {}, "sim:connect " + host_});
      return;
    }
    const std::string answer = roundTrip("reset " + std::to_string(cardIndex_));
    if (answer != "OK") {
      done(fail("sim:reset", answer));
      return;
    }
    live_ = true;
    done(qntx::CardReaderResult{qntx::CardReaderStatus::ok, {}, {}});
  }

  void transmit(std::vector<uint8_t> apdu, qntx::CardReaderDone done) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!live_ || fd_ < 0) {
      done(qntx::CardReaderResult{
          qntx::CardReaderStatus::tagLost, {}, "sim:dead"});
      return;
    }
    const std::string answer =
        roundTrip("apdu " + std::to_string(cardIndex_) + " " + toHex(apdu));
    if (answer.starts_with("R ")) {
      std::vector<uint8_t> response = fromHex(answer.substr(2));
      if (!response.empty()) {
        done(qntx::CardReaderResult{
            qntx::CardReaderStatus::ok, std::move(response), {}});
        return;
      }
      done(fail("sim:bad-response", answer));
      return;
    }
    if (answer == "TORN") {
      live_ = false;
      done(qntx::CardReaderResult{
          qntx::CardReaderStatus::tagLost, {}, "sim:torn"});
      return;
    }
    done(fail("sim:transmit", answer));
  }

  void close(bool success, std::string text) override {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      live_ = false;
    }
    logLine(
        std::string("SIM_SHEET_CLOSE ") + (success ? "success" : "failure") +
        " " + text);
  }

 private:
  qntx::CardReaderResult fail(const char* code, const std::string& answer) {
    drop();
    live_ = false;
    return qntx::CardReaderResult{
        qntx::CardReaderStatus::tagLost, {}, std::string(code) + " " + answer};
  }

  bool connectTo() {
    addrinfo hints{};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* info = nullptr;
    if (getaddrinfo(host_.c_str(), std::to_string(port_).c_str(), &hints, &info) !=
            0 ||
        info == nullptr) {
      return false;
    }
    fd_ = ::socket(info->ai_family, info->ai_socktype, info->ai_protocol);
    const bool ok =
        fd_ >= 0 && ::connect(fd_, info->ai_addr, info->ai_addrlen) == 0;
    freeaddrinfo(info);
    if (!ok) {
      drop();
      return false;
    }
    // The bridge banners READY on accept.
    return readLine() == "READY";
  }

  std::string readLine() {
    std::string line;
    char c = 0;
    while (fd_ >= 0) {
      const ssize_t n = ::recv(fd_, &c, 1, 0);
      if (n <= 0) {
        drop();
        return {};
      }
      if (c == '\n') {
        return line;
      }
      if (c != '\r') {
        line.push_back(c);
      }
    }
    return {};
  }

  std::string roundTrip(const std::string& request) {
    if (fd_ < 0) {
      return {};
    }
    const std::string wire = request + "\n";
    if (::send(fd_, wire.data(), wire.size(), 0) != static_cast<ssize_t>(wire.size())) {
      drop();
      return {};
    }
    return readLine();
  }

  void drop() {
    if (fd_ >= 0) {
      ::close(fd_);
      fd_ = -1;
    }
  }

  const std::string host_;
  const int port_;
  int fd_ = -1;
  int cardIndex_ = -1;
  bool live_ = false;
  std::mutex mutex_;
};

} // namespace

std::shared_ptr<qntx::CardReader> simCardReader(std::string host, int port) {
  return std::make_shared<SimCardReader>(std::move(host), port);
}

std::vector<uint8_t> simIdentity() {
  std::lock_guard<std::mutex> lock(identityMutex);
  return identityBytes;
}

} // namespace qntx::harness
