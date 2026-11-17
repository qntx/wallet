#include "KernelArgon2.hpp"

#include <stdexcept>
#include <string>

extern "C" {
#include "../../vendor/argon2/include/argon2.h"
}

qntx::SecretBytes qntx::kernelArgon2id(
    const SecretBytes& password,
    const SecretBytes& salt,
    uint32_t memoryKiB,
    uint32_t passes,
    uint32_t lanes,
    size_t length) {
  SecretBytes out(length);
  // One thread per lane; the library wipes its working memory before freeing it
  // (FLAG_clear_internal_memory is on by default).
  const int status = argon2id_hash_raw(
      passes,
      memoryKiB,
      lanes,
      password.data(),
      password.size(),
      salt.data(),
      salt.size(),
      out.data(),
      out.size());
  if (status != ARGON2_OK) {
    throw std::runtime_error(std::string("argon2id failed: ") + argon2_error_message(status));
  }
  return out;
}
