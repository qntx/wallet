// Android keystore: the Kotlin Keystore object owns the AndroidKeyStore key
// and the BiometricPrompt; this file forwards each call through fbjni with a
// completion token and resolves the parked completion when Kotlin calls back
// through nativeComplete (on the main thread).
#include "../host/Keystore.hpp"

#ifdef __ANDROID__

#include <fbjni/fbjni.h>
#include <jni.h>

#include <cstdint>
#include <mutex>
#include <stdexcept>
#include <unordered_map>
#include <utility>

namespace qntx {
namespace {

namespace jni = facebook::jni;

jni::global_ref<jclass> g_keystoreClass;

std::mutex g_mutex;
int64_t g_nextToken = 1;
std::unordered_map<int64_t, KeystoreDone> g_pending;

int64_t park(KeystoreDone done) {
  std::lock_guard<std::mutex> lock(g_mutex);
  const int64_t token = g_nextToken++;
  g_pending.emplace(token, std::move(done));
  return token;
}

KeystoreDone take(int64_t token) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto found = g_pending.find(token);
  if (found == g_pending.end()) {
    return nullptr;
  }
  auto done = std::move(found->second);
  g_pending.erase(found);
  return done;
}

jni::alias_ref<jclass> keystoreClass() {
  if (!g_keystoreClass) {
    throw std::runtime_error("keystore: JNI_OnLoad init did not run");
  }
  return g_keystoreClass;
}

jni::local_ref<jni::JArrayByte> byteArray(const uint8_t* data, size_t size) {
  auto array = jni::JArrayByte::newArray(size);
  array->setRegion(0, static_cast<jsize>(size), reinterpret_cast<const jbyte*>(data));
  return array;
}

// Runs one Kotlin entry point; a JNI failure completes the call as `failed`
// instead of leaving it parked forever.
template <typename Call>
void dispatch(KeystoreDone done, Call&& call) {
  const int64_t token = park(std::move(done));
  try {
    jni::ThreadScope threadScope;
    call(static_cast<jlong>(token));
  } catch (...) {
    if (auto parked = take(token)) {
      parked(KeystoreResult{KeystoreStatus::failed, {}});
    }
  }
}

} // namespace

void kernelKeystoreInit(jni::alias_ref<jclass> clazz) {
  g_keystoreClass = jni::make_global(clazz);
}

void keystoreSeal(
    const std::string& id,
    SecretBytes secret,
    KeystorePrompt prompt,
    KeystoreDone done) {
  dispatch(std::move(done), [&](jlong token) {
    auto method = keystoreClass()->getStaticMethod<void(
        jlong, jni::alias_ref<jstring>, jni::alias_ref<jni::JArrayByte>, jni::alias_ref<jstring>,
        jni::alias_ref<jstring>)>("seal");
    method(
        keystoreClass(),
        token,
        jni::make_jstring(id),
        byteArray(secret.data(), secret.size()),
        jni::make_jstring(prompt.title),
        jni::make_jstring(prompt.description));
  });
}

void keystoreOpen(
    const std::string& id,
    std::vector<uint8_t> sealed,
    KeystorePrompt prompt,
    KeystoreDone done) {
  dispatch(std::move(done), [&](jlong token) {
    auto method = keystoreClass()->getStaticMethod<void(
        jlong, jni::alias_ref<jstring>, jni::alias_ref<jni::JArrayByte>, jni::alias_ref<jstring>,
        jni::alias_ref<jstring>)>("open");
    method(
        keystoreClass(),
        token,
        jni::make_jstring(id),
        byteArray(sealed.data(), sealed.size()),
        jni::make_jstring(prompt.title),
        jni::make_jstring(prompt.description));
  });
}

void keystoreAuthenticate(KeystorePrompt prompt, KeystoreDone done) {
  dispatch(std::move(done), [&](jlong token) {
    auto method = keystoreClass()->getStaticMethod<void(
        jlong, jni::alias_ref<jstring>, jni::alias_ref<jstring>)>("authenticate");
    method(
        keystoreClass(),
        token,
        jni::make_jstring(prompt.title),
        jni::make_jstring(prompt.description));
  });
}

void keystoreClear(KeystoreDone done) {
  dispatch(std::move(done), [&](jlong token) {
    auto method = keystoreClass()->getStaticMethod<void(jlong)>("clear");
    method(keystoreClass(), token);
  });
}

void keystoreCancel() {
  jni::ThreadScope threadScope;
  auto method = keystoreClass()->getStaticMethod<void()>("cancel");
  method(keystoreClass());
}

std::string keystoreLocale() {
  jni::ThreadScope threadScope;
  auto method = keystoreClass()->getStaticMethod<jni::JString::javaobject()>("locale");
  return method(keystoreClass())->toStdString();
}

} // namespace qntx

// Kotlin's Keystore.nativeComplete: resolves the parked call. The byte array
// is copied into wiping storage; Kotlin wipes its own copy afterwards.
extern "C" JNIEXPORT void JNICALL
Java_com_margelo_nitro_qntxwallet_Keystore_nativeComplete(
    JNIEnv* env, jclass, jlong token, jint status, jbyteArray bytes) {
  auto done = qntx::take(static_cast<int64_t>(token));
  if (!done) {
    return;
  }
  qntx::KeystoreResult result;
  result.status = static_cast<qntx::KeystoreStatus>(status);
  if (status < 0 || status > static_cast<jint>(qntx::KeystoreStatus::failed)) {
    result.status = qntx::KeystoreStatus::failed;
  }
  if (bytes != nullptr && result.status == qntx::KeystoreStatus::ok) {
    const jsize size = env->GetArrayLength(bytes);
    qntx::SecretBytes copy(static_cast<size_t>(size));
    env->GetByteArrayRegion(bytes, 0, size, reinterpret_cast<jbyte*>(copy.data()));
    result.bytes = std::move(copy);
  }
  done(std::move(result));
}

#endif // __ANDROID__
