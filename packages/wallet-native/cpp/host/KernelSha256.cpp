#include "KernelSha256.hpp"

#include <array>
#include <cstdint>
#include <cstdio>

namespace qntx {
namespace {

struct Sha256Ctx {
  uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  uint64_t bits = 0;
  std::array<uint8_t, 64> block{};
  size_t used = 0;
};

constexpr uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

inline uint32_t rotr(uint32_t v, int n) {
  return (v >> n) | (v << (32 - n));
}

void compress(Sha256Ctx& c, const uint8_t* p) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++) {
    w[i] = (uint32_t(p[4 * i]) << 24) | (uint32_t(p[4 * i + 1]) << 16) |
           (uint32_t(p[4 * i + 2]) << 8) | uint32_t(p[4 * i + 3]);
  }
  for (int i = 16; i < 64; i++) {
    const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
    const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = c.h[0], b = c.h[1], d = c.h[3], e = c.h[4], f = c.h[5], g = c.h[6],
           hh = c.h[7], cc = c.h[2];
  for (int i = 0; i < 64; i++) {
    const uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const uint32_t ch = (e & f) ^ (~e & g);
    const uint32_t t1 = hh + s1 + ch + K[i] + w[i];
    const uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const uint32_t maj = (a & b) ^ (a & cc) ^ (b & cc);
    const uint32_t t2 = s0 + maj;
    hh = g; g = f; f = e; e = d + t1; d = cc; cc = b; b = a; a = t1 + t2;
  }
  c.h[0] += a; c.h[1] += b; c.h[2] += cc; c.h[3] += d;
  c.h[4] += e; c.h[5] += f; c.h[6] += g; c.h[7] += hh;
}

void update(Sha256Ctx& c, const uint8_t* data, size_t size) {
  c.bits += uint64_t(size) * 8;
  while (size > 0) {
    const size_t take = c.block.size() - c.used < size ? c.block.size() - c.used : size;
    std::memcpy(c.block.data() + c.used, data, take);
    c.used += take;
    data += take;
    size -= take;
    if (c.used == c.block.size()) {
      compress(c, c.block.data());
      c.used = 0;
    }
  }
}

} // namespace

std::vector<uint8_t> kernelSha256(const uint8_t* data, size_t size) {
  Sha256Ctx c;
  update(c, data, size);
  const uint64_t bits = c.bits;
  const uint8_t pad80 = 0x80;
  update(c, &pad80, 1);
  uint8_t pad = 0;
  while (c.used != 56) {
    update(c, &pad, 1);
  }
  uint8_t len[8];
  for (int i = 0; i < 8; i++) {
    len[i] = uint8_t(bits >> (56 - 8 * i));
  }
  update(c, len, 8);
  std::vector<uint8_t> out(32);
  for (int i = 0; i < 8; i++) {
    out[4 * i] = uint8_t(c.h[i] >> 24);
    out[4 * i + 1] = uint8_t(c.h[i] >> 16);
    out[4 * i + 2] = uint8_t(c.h[i] >> 8);
    out[4 * i + 3] = uint8_t(c.h[i]);
  }
  return out;
}

std::string kernelSha256Hex(const uint8_t* data, size_t size) {
  const auto digest = kernelSha256(data, size);
  char hex[65];
  for (int i = 0; i < 32; i++) {
    std::snprintf(hex + 2 * i, 3, "%02x", digest[i]);
  }
  return {hex, 64};
}

} // namespace qntx
