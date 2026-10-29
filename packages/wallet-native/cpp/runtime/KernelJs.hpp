#pragma once

#include <jsi/jsi.h>

#include <cstdint>
#include <memory>
#include <string>

namespace qntx {

namespace jsi = facebook::jsi;

// Captured JS intrinsics, taken on the pristine runtime before any script can
// tamper with the builtins they come from. Every member is a jsi value owned
// by the kernel thread; teardown resets the holding shared_ptr while the
// runtime is still alive.
struct KernelIntrinsics {
  jsi::Function defineProperty;
  jsi::Function freeze;
  jsi::Function uint8Array;
  // The real %TypedArray%.prototype accessors. Calling them reads internal
  // slots, so forged objects throw and redefined prototype getters cannot lie.
  jsi::Function taBufferGet;
  jsi::Function taByteOffsetGet;
  jsi::Function taByteLengthGet;
  jsi::Function taTagGet;
};

std::shared_ptr<KernelIntrinsics> captureIntrinsics(jsi::Runtime& rt);

jsi::Function hostFn(
    jsi::Runtime& rt,
    const char* name,
    unsigned int paramCount,
    jsi::HostFunctionType fn);

void defineHiddenGlobal(
    jsi::Runtime& rt,
    const KernelIntrinsics& intrinsics,
    const char* name,
    jsi::Value value);

double finiteNumber(jsi::Runtime& rt, const jsi::Value& value, const char* name);

uint64_t integerInRange(
    jsi::Runtime& rt,
    const jsi::Value& value,
    const char* name,
    double min,
    double max);

// A view into a live ArrayBuffer: `buffer` keeps the storage referenced while
// `data`/`size` are borrowed from it.
struct ByteView {
  jsi::ArrayBuffer buffer;
  uint8_t* data;
  size_t size;
};

// The shared extractor for every byte input. Accepts a real ArrayBuffer or a
// genuine TypedArray — identified by calling the captured
// %TypedArray%.prototype getters, which read internal slots: forged plain
// objects throw TypeError and a redefined Uint8Array.prototype getter cannot
// lie.
ByteView byteViewFromValue(
    jsi::Runtime& rt,
    const jsi::Value& value,
    const char* name,
    const KernelIntrinsics& intrinsics);

jsi::ArrayBuffer arrayBufferFromBytes(
    jsi::Runtime& rt,
    const uint8_t* bytes,
    size_t size);

jsi::Object makeUint8Array(
    jsi::Runtime& rt,
    const KernelIntrinsics& intrinsics,
    jsi::ArrayBuffer buffer);

} // namespace qntx
