#include "KernelFile.hpp"

#include <cerrno>
#include <cstring>
#include <stdexcept>

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

} // namespace

std::optional<std::vector<uint8_t>> kernelFileRead(const std::string& directory) {
  const std::string path = pathFor(directory, "vault.cbor");
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

void kernelFileWrite(const std::string& directory, const std::vector<uint8_t>& bytes) {
  const std::string tmp = pathFor(directory, "vault.cbor.tmp");
  const std::string final = pathFor(directory, "vault.cbor");
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
  try {
    fsyncOrFail(dirFd, "fsync vault directory");
  } catch (...) {
    ::close(dirFd);
    throw;
  }
  ::close(dirFd);
}

} // namespace qntx
