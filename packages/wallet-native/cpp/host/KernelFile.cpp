#include "KernelFile.hpp"

#include <cerrno>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <system_error>

#if defined(_WIN32)
#error "KernelFile has no Windows implementation"
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#endif

namespace qntx {
namespace {

std::mutex g_dirMutex;
std::string g_dirOverride;

[[noreturn]] void fail(const char* what) {
  throw std::system_error(errno, std::system_category(), what);
}

void fsyncOrFail(int fd, const char* what) {
#if defined(__APPLE__)
  // Apple documents fcntl(F_FULLFSYNC) as the durable barrier (works on
  // directories too); plain fsync is not guaranteed to flush on iOS.
  if (::fcntl(fd, F_FULLFSYNC) != 0) {
    fail(what);
  }
#else
  if (::fsync(fd) != 0) {
    fail(what);
  }
#endif
}

std::string pathFor(const std::string& leaf) {
  const std::string dir = kernelFileDirectory();
  return dir + "/" + leaf;
}

} // namespace

void setKernelFileDirectory(std::string directory) {
  std::lock_guard<std::mutex> lock(g_dirMutex);
  g_dirOverride = std::move(directory);
}

std::string kernelFileDirectoryOverride() {
  std::lock_guard<std::mutex> lock(g_dirMutex);
  return g_dirOverride;
}

// Default directory hook for hosts without a platform translation unit:
// the override, then QNTX_VAULT_DIR. iOS and Android provide their own
// kernelFileDirectory() instead (which still honours the override).
__attribute__((weak)) std::string kernelFileDirectory() {
  {
    const std::string override = kernelFileDirectoryOverride();
    if (!override.empty()) {
      return override;
    }
  }
  const char* env = ::getenv("QNTX_VAULT_DIR");
  if (env != nullptr && env[0] != '\0') {
    return env;
  }
  throw std::runtime_error("kernel file directory not configured");
}

std::optional<std::vector<uint8_t>> kernelFileRead() {
  const std::string path = pathFor("vault.cbor");
  const int fd = ::open(path.c_str(), O_RDONLY);
  if (fd < 0) {
    if (errno == ENOENT) {
      return std::nullopt;
    }
    fail("open vault file");
  }
  std::vector<uint8_t> bytes;
  uint8_t chunk[65536];
  for (;;) {
    const ssize_t n = ::read(fd, chunk, sizeof(chunk));
    if (n < 0) {
      const int saved = errno;
      ::close(fd);
      errno = saved;
      fail("read vault file");
    }
    if (n == 0) {
      break;
    }
    bytes.insert(bytes.end(), chunk, chunk + n);
  }
  ::close(fd);
  return bytes;
}

void kernelFileWrite(const std::vector<uint8_t>& bytes) {
  const std::string tmp = pathFor("vault.cbor.tmp");
  const std::string final = pathFor("vault.cbor");
  const int fd = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) {
    fail("open temp vault file");
  }
  size_t off = 0;
  while (off < bytes.size()) {
    const ssize_t n = ::write(fd, bytes.data() + off, bytes.size() - off);
    if (n <= 0) {
      const int saved = errno;
      ::close(fd);
      ::unlink(tmp.c_str());
      errno = saved;
      fail("write temp vault file");
    }
    off += static_cast<size_t>(n);
  }
  if (::fsync(fd) != 0) {
    const int saved = errno;
    ::close(fd);
    ::unlink(tmp.c_str());
    errno = saved;
    fail("fsync temp vault file");
  }
  if (::close(fd) != 0) {
    ::unlink(tmp.c_str());
    fail("close temp vault file");
  }
  if (::rename(tmp.c_str(), final.c_str()) != 0) {
    ::unlink(tmp.c_str());
    fail("rename vault file");
  }
  const int dirFd = ::open(kernelFileDirectory().c_str(), O_RDONLY);
  if (dirFd >= 0) {
    fsyncOrFail(dirFd, "fsync vault directory");
    ::close(dirFd);
  }
}

} // namespace qntx
