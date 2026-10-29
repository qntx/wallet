#include "KernelJs.hpp"

#include "KernelBuffer.hpp"

#include <cmath>
#include <stdexcept>

namespace qntx {

jsi::Function hostFn(
    jsi::Runtime& rt,
    const char* name,
    unsigned int paramCount,
    jsi::HostFunctionType fn) {
  return jsi::Function::createFromHostFunction(
      rt, jsi::PropNameID::forAscii(rt, name), paramCount, std::move(fn));
}

double finiteNumber(jsi::Runtime& rt, const jsi::Value& value, const char* name) {
  if (!value.isNumber() || !std::isfinite(value.getNumber())) {
    throw jsi::JSError(rt, std::string(name) + " expects a finite number");
  }
  return value.getNumber();
}

uint64_t integerInRange(
    jsi::Runtime& rt,
    const jsi::Value& value,
    const char* name,
    double min,
    double max) {
  const double n = finiteNumber(rt, value, name);
  if (n < min || n > max || std::floor(n) != n) {
    throw jsi::JSError(rt, std::string(name) + " is out of range");
  }
  return static_cast<uint64_t>(n);
}

ByteView byteViewFromValue(
    jsi::Runtime& rt,
    const jsi::Value& value,
    const char* name,
    const KernelIntrinsics& intrinsics) {
  if (!value.isObject()) {
    throw jsi::JSError(rt, std::string(name) + " expects an ArrayBuffer or TypedArray");
  }
  auto object = value.asObject(rt);
  if (object.isArrayBuffer(rt)) {
    auto buffer = object.getArrayBuffer(rt);
    uint8_t* data = buffer.data(rt);
    const size_t size = buffer.size(rt);
    return {std::move(buffer), data, size};
  }
  const jsi::Value bufferValue =
      intrinsics.taBufferGet.callWithThis(rt, object);
  const jsi::Value offsetValue =
      intrinsics.taByteOffsetGet.callWithThis(rt, object);
  const jsi::Value lengthValue =
      intrinsics.taByteLengthGet.callWithThis(rt, object);
  if (!bufferValue.isObject() || !bufferValue.asObject(rt).isArrayBuffer(rt)) {
    throw jsi::JSError(rt, std::string(name) + " view is not backed by an ArrayBuffer");
  }
  const double offset = finiteNumber(rt, offsetValue, "byteOffset");
  const double length = finiteNumber(rt, lengthValue, "byteLength");
  if (offset < 0 || std::floor(offset) != offset ||
      length < 0 || std::floor(length) != length) {
    throw jsi::JSError(rt, std::string(name) + " view bounds must be non-negative integers");
  }
  auto buffer = bufferValue.asObject(rt).getArrayBuffer(rt);
  uint8_t* data = buffer.data(rt);
  const size_t bufferSize = buffer.size(rt);
  if (offset + length > static_cast<double>(bufferSize)) {
    throw jsi::JSError(rt, std::string(name) + " view exceeds its ArrayBuffer");
  }
  return {std::move(buffer), data + static_cast<size_t>(offset), static_cast<size_t>(length)};
}

jsi::ArrayBuffer arrayBufferFromBytes(
    jsi::Runtime& rt,
    const uint8_t* bytes,
    size_t size) {
  auto buffer = std::make_shared<OwningBuffer>(size);
  if (bytes != nullptr && size > 0) {
    std::memcpy(buffer->data(), bytes, size);
  }
  return rt.createArrayBuffer(std::move(buffer));
}

jsi::Object makeUint8Array(
    jsi::Runtime& rt,
    const KernelIntrinsics& intrinsics,
    jsi::ArrayBuffer buffer) {
  return intrinsics.uint8Array
      .callAsConstructor(rt, jsi::Value(std::move(buffer)))
      .asObject(rt);
}

std::shared_ptr<KernelIntrinsics> captureIntrinsics(jsi::Runtime& rt) {
  auto global = rt.global();
  auto objectCtor = global.getPropertyAsObject(rt, "Object");
  auto getPrototypeOf = objectCtor.getPropertyAsFunction(rt, "getPrototypeOf");
  auto getDescriptor = objectCtor.getPropertyAsFunction(rt, "getOwnPropertyDescriptor");

  auto requireGetter = [&](const char* name,
                           const jsi::Value& container,
                           const jsi::Value& key) -> jsi::Function {
    const jsi::Value descriptor = getDescriptor.call(rt, container, key);
    const jsi::Value get = descriptor.isObject()
        ? descriptor.asObject(rt).getProperty(rt, "get")
        : jsi::Value::undefined();
    if (!get.isObject() || !get.asObject(rt).isFunction(rt)) {
      throw std::runtime_error(
          std::string("kernel globals: missing TypedArray intrinsic ") + name);
    }
    return get.asObject(rt).asFunction(rt);
  };

  auto uint8Array = global.getPropertyAsFunction(rt, "Uint8Array");
  const jsi::Value typedArrayProto =
      getPrototypeOf.call(rt, uint8Array.getProperty(rt, "prototype"));
  const jsi::Value toStringTag =
      global.getPropertyAsObject(rt, "Symbol").getProperty(rt, "toStringTag");
  const auto nameKey = [&](const char* name) {
    return jsi::Value(rt, jsi::String::createFromAscii(rt, name));
  };

  return std::shared_ptr<KernelIntrinsics>(new KernelIntrinsics{
      objectCtor.getPropertyAsFunction(rt, "defineProperty"),
      objectCtor.getPropertyAsFunction(rt, "freeze"),
      std::move(uint8Array),
      requireGetter("buffer", typedArrayProto, nameKey("buffer")),
      requireGetter("byteOffset", typedArrayProto, nameKey("byteOffset")),
      requireGetter("byteLength", typedArrayProto, nameKey("byteLength")),
      requireGetter("Symbol.toStringTag", typedArrayProto, toStringTag),
  });
}

void defineHiddenGlobal(
    jsi::Runtime& rt,
    const KernelIntrinsics& intrinsics,
    const char* name,
    jsi::Value value) {
  jsi::Object descriptor(rt);
  descriptor.setProperty(rt, "value", std::move(value));
  descriptor.setProperty(rt, "writable", jsi::Value(false));
  descriptor.setProperty(rt, "configurable", jsi::Value(false));
  descriptor.setProperty(rt, "enumerable", jsi::Value(false));
  intrinsics.defineProperty.call(
      rt,
      rt.global(),
      jsi::Value(rt, jsi::String::createFromAscii(rt, name)),
      jsi::Value(std::move(descriptor)));
}

} // namespace qntx
