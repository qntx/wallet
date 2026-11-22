// Android NFC reader: the Kotlin CardReader object runs reader mode and the
// card sheet; this file forwards calls through fbjni with completion tokens
// and resolves the parked completion when Kotlin calls nativeComplete.
#include "../host/CardReader.hpp"

#ifdef __ANDROID__

#include <fbjni/fbjni.h>
#include <jni.h>

#include <cstdint>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace qntx {
namespace {

namespace jni = facebook::jni;

jni::global_ref<jclass> g_readerClass;

std::mutex g_mutex;
int64_t g_nextToken = 1;
std::unordered_map<int64_t, CardReaderDone> g_pending;

int64_t park(CardReaderDone done) {
  std::lock_guard<std::mutex> lock(g_mutex);
  const int64_t token = g_nextToken++;
  g_pending.emplace(token, std::move(done));
  return token;
}

CardReaderDone take(int64_t token) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto found = g_pending.find(token);
  if (found == g_pending.end()) {
    return nullptr;
  }
  auto done = std::move(found->second);
  g_pending.erase(found);
  return done;
}

jni::alias_ref<jclass> readerClass() {
  if (!g_readerClass) {
    throw std::runtime_error("card reader: JNI_OnLoad init did not run");
  }
  return g_readerClass;
}

// Runs one Kotlin entry point; a JNI failure completes the call as
// `unavailable` instead of leaving it parked forever.
template <typename Call>
void dispatch(CardReaderDone done, Call&& call) {
  const int64_t token = park(std::move(done));
  try {
    jni::ThreadScope threadScope;
    call(static_cast<jlong>(token));
  } catch (...) {
    if (auto parked = take(token)) {
      parked(CardReaderResult{CardReaderStatus::unavailable, {}, "android:jni"});
    }
  }
}

class AndroidCardReader final : public CardReader {
 public:
  void open(std::string prompt, CardReaderDone done) override {
    dispatch(std::move(done), [&prompt](jlong token) {
      auto entry =
          readerClass()->getStaticMethod<void(jlong, jni::alias_ref<jstring>)>("open");
      entry(readerClass(), token, jni::make_jstring(prompt));
    });
  }

  void transmit(std::vector<uint8_t> apdu, CardReaderDone done) override {
    dispatch(std::move(done), [&apdu](jlong token) {
      auto bytes = jni::JArrayByte::newArray(apdu.size());
      bytes->setRegion(
          0,
          static_cast<jsize>(apdu.size()),
          reinterpret_cast<const jbyte*>(apdu.data()));
      auto entry = readerClass()
                       ->getStaticMethod<void(jlong, jni::alias_ref<jni::JArrayByte>)>(
                           "transmit");
      entry(readerClass(), token, bytes);
    });
  }

  void close(bool success, std::string text) override {
    jni::ThreadScope threadScope;
    auto method =
        readerClass()->getStaticMethod<void(jboolean, jni::alias_ref<jstring>)>("close");
    method(readerClass(), success ? JNI_TRUE : JNI_FALSE, jni::make_jstring(text));
  }
};

} // namespace

void kernelCardReaderInit(jni::alias_ref<jclass> clazz) {
  g_readerClass = jni::make_global(clazz);
}

std::shared_ptr<CardReader> platformCardReader() {
  static const auto reader = std::make_shared<AndroidCardReader>();
  return reader;
}

} // namespace qntx

// Kotlin's CardReader.nativeComplete resolves the parked call. Status ints
// are the CardReaderStatus JNI contract; an out-of-range value degrades to
// unavailable rather than inventing a status.
extern "C" JNIEXPORT void JNICALL
Java_com_margelo_nitro_qntxwallet_CardReader_nativeComplete(
    JNIEnv* env, jclass, jlong token, jint status, jbyteArray response, jstring detail) {
  auto done = qntx::take(static_cast<int64_t>(token));
  if (!done) {
    return;
  }
  qntx::CardReaderResult result;
  result.status = static_cast<qntx::CardReaderStatus>(status);
  if (status < 0 || status > static_cast<jint>(qntx::CardReaderStatus::unavailable)) {
    result.status = qntx::CardReaderStatus::unavailable;
  }
  if (response != nullptr && result.status == qntx::CardReaderStatus::ok) {
    const jsize size = env->GetArrayLength(response);
    result.response.resize(static_cast<size_t>(size));
    env->GetByteArrayRegion(
        response, 0, size, reinterpret_cast<jbyte*>(result.response.data()));
  }
  if (detail != nullptr) {
    const char* utf = env->GetStringUTFChars(detail, nullptr);
    if (utf != nullptr) {
      result.detail = utf;
      env->ReleaseStringUTFChars(detail, utf);
    }
  }
  done(std::move(result));
}

#endif // __ANDROID__
