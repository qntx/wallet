#include "KernelFile.hpp"

#include <cerrno>
#include <cstring>
#include <stdexcept>

#if defined(_WIN32)
#error "KernelFile has no Windows implementation"
#else
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#endif

namespace qntx {
namespace {

[[noreturn]] void fail(const char* what) {
  const int saved = errno;
  throw std::runtime_error(
      std::string(what) + ": " + std::strerror(saved) + " (errno " + std::to_string(saved) + ")");
}

void fsyncOrFail(int fd, const char* what, bool full = false) {
  // Files: on Apple the documented durable barrier is fcntl(F_FULLFSYNC).
  // Directories: plain fsync everywhere (F_FULLFSYNC is for files only).
  const int rc =
#if defined(__APPLE__)
      full ? ::fcntl(fd, F_FULLFSYNC) : ::fsync(fd);
#else
      (::fsync(fd));
#endif
  if (rc != 0) {
    fail(what);
  }
}

std::string pathFor(const std::string& directory, const char* leaf) {
  return directory + "/" + leaf;
}

// Closes fd on every path, including exceptions mid-write.
struct ScopedFd {
  explicit ScopedFd(int fd) : fd(fd) {}
  ~ScopedFd() {
    if (fd >= 0) {
      ::close(fd);
    }
  }
  ScopedFd(const ScopedFd&) = delete;
  ScopedFd& operator=(const ScopedFd&) = delete;
  int fd;
};

// Reads an already-open lock file's sibling: the whole vault.cbor, or nullopt
// when it does not exist. Called with the lock held.
std::optional<std::vector<uint8_t>> readImage(const std::string& directory) {
  const std::string path = pathFor(directory, "vault.cbor");
  const int fd = ::open(path.c_str(), O_RDONLY);
  if (fd < 0) {
    if (errno == ENOENT) {
      return std::nullopt;
    }
    fail("open vault file");
  }
  const ScopedFd guard(fd);
  std::vector<uint8_t> bytes;
  uint8_t chunk[65536];
  for (;;) {
    const ssize_t n = ::read(fd, chunk, sizeof(chunk));
    if (n < 0) {
      fail("read vault file");
    }
    if (n == 0) {
      break;
    }
    bytes.insert(bytes.end(), chunk, chunk + n);
  }
  return bytes;
}

// Temp + fsync + rename + directory fsync. Called with the lock held, so the
// shared temp name belongs to one writer at a time.
void writeImage(const std::string& directory, const uint8_t* bytes, size_t size) {
  const std::string tmp = pathFor(directory, "vault.cbor.tmp");
  const std::string final = pathFor(directory, "vault.cbor");
  const int fd = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) {
    fail("open temp vault file");
  }
  size_t off = 0;
  while (off < size) {
    const ssize_t n = ::write(fd, bytes + off, size - off);
    if (n <= 0) {
      const int saved = errno;
      ::close(fd);
      ::unlink(tmp.c_str());
      errno = saved;
      fail("write temp vault file");
    }
    off += static_cast<size_t>(n);
  }
  try {
    fsyncOrFail(fd, "fsync temp vault file", /*full=*/true);
  } catch (...) {
    ::close(fd);
    ::unlink(tmp.c_str());
    throw;
  }
  if (::close(fd) != 0) {
    ::unlink(tmp.c_str());
    fail("close temp vault file");
  }
  if (::rename(tmp.c_str(), final.c_str()) != 0) {
    ::unlink(tmp.c_str());
    fail("rename vault file");
  }
  const int dirFd = ::open(directory.c_str(), O_RDONLY);
  if (dirFd < 0) {
    fail("open vault directory");
  }
  const ScopedFd dirGuard(dirFd);
  fsyncOrFail(dirFd, "fsync vault directory");
}

// Exclusive flock on the vault lock file for the whole read-modify-write.
// flock (not a std::mutex) because it excludes separate open file descriptions
// — a second KernelRuntime in this process holds a different fd — and other
// processes sharing the vault directory alike.
struct VaultLock {
  explicit VaultLock(const std::string& directory) {
    const std::string lockPath = pathFor(directory, "vault.cbor.lock");
    fd = ::open(lockPath.c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0600);
    if (fd < 0) {
      fail("open vault lock file");
    }
    if (::flock(fd, LOCK_EX) != 0) {
      const int saved = errno;
      ::close(fd);
      fd = -1;
      errno = saved;
      fail("lock vault file");
    }
  }
  ~VaultLock() {
    if (fd >= 0) {
      ::flock(fd, LOCK_UN);
      ::close(fd);
    }
  }
  VaultLock(const VaultLock&) = delete;
  VaultLock& operator=(const VaultLock&) = delete;
  int fd = -1;
};

} // namespace

std::optional<std::vector<uint8_t>> kernelFileRead(const std::string& directory) {
  // Read outside the lock: the image is a whole-file atomic rename, so readers
  // always see one complete generation or the other. Writers serialize through
  // kernelFileReplace.
  return readImage(directory);
}

bool kernelFileReplace(
    const std::string& directory,
    const uint8_t* next,
    size_t size,
    const std::optional<std::vector<uint8_t>>& expected) {
  const VaultLock lock(directory);
  const auto current = readImage(directory);
  const bool matches = expected.has_value()
      ? (current.has_value() && *current == *expected)
      : !current.has_value();
  if (!matches) {
    return false;
  }
  writeImage(directory, next, size);
  return true;
}

} // namespace qntx
