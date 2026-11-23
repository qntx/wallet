// Android vault anchor: the record lives in Android Keystore entry aliases
// (`qntx-wallet.anchor.<seq>.<record hex>`) — see VaultAnchor.kt for why the
// alias itself is the byte store. This file only forwards the two platform
// primitives through fbjni; the CAS mutex and compare live in host/VaultAnchor.
#include "../host/VaultAnchor.hpp"

#ifdef __ANDROID__

#include <fbjni/fbjni.h>
#include <jni.h>

#include <stdexcept>
#include <vector>

namespace qntx {
namespace {

namespace jni = facebook::jni;

jni::global_ref<jclass> g_anchorClass;

jni::alias_ref<jclass> anchorClass() {
  if (!g_anchorClass) {
    throw std::runtime_error("vault anchor: JNI_OnLoad init did not run");
  }
  return g_anchorClass;
}

} // namespace

void kernelAnchorInit(jni::alias_ref<jclass> clazz) {
  g_anchorClass = jni::make_global(clazz);
}

std::optional<std::vector<uint8_t>> platformAnchorLoad() {
  try {
    jni::ThreadScope threadScope;
    auto method =
        anchorClass()->getStaticMethod<jni::JArrayByte::javaobject()>("load");
    auto bytes = method(anchorClass());
    if (!bytes) {
      return std::nullopt;
    }
    const auto size = static_cast<size_t>(bytes->size());
    std::vector<uint8_t> out(size);
    if (size > 0) {
      bytes->getRegion(0, static_cast<jsize>(size),
                       reinterpret_cast<jbyte*>(out.data()));
    }
    return out;
  } catch (const jni::JniException& error) {
    throw std::runtime_error(
        std::string("vault anchor: ") + error.what());
  }
}

void platformAnchorStore(const std::vector<uint8_t>& bytes) {
  try {
    jni::ThreadScope threadScope;
    auto method = anchorClass()->getStaticMethod<void(
        jni::alias_ref<jni::JArrayByte>)>("store");
    auto array = jni::JArrayByte::newArray(bytes.size());
    if (!bytes.empty()) {
      array->setRegion(0, static_cast<jsize>(bytes.size()),
                       reinterpret_cast<const jbyte*>(bytes.data()));
    }
    method(anchorClass(), array);
  } catch (const jni::JniException& error) {
    throw std::runtime_error(
        std::string("vault anchor: ") + error.what());
  }
}

} // namespace qntx

#endif // __ANDROID__
