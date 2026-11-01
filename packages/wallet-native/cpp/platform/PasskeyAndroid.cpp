// Android passkey authenticator: the Kotlin Passkey object runs Credential
// Manager; this file forwards each request JSON through fbjni with a
// completion token and resolves the parked completion when Kotlin calls back
// through nativeComplete (on the main thread).
#include "../host/Passkey.hpp"

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

jni::global_ref<jclass> g_passkeyClass;

std::mutex g_mutex;
int64_t g_nextToken = 1;
std::unordered_map<int64_t, PasskeyDone> g_pending;

int64_t park(PasskeyDone done) {
  std::lock_guard<std::mutex> lock(g_mutex);
  const int64_t token = g_nextToken++;
  g_pending.emplace(token, std::move(done));
  return token;
}

PasskeyDone take(int64_t token) {
  std::lock_guard<std::mutex> lock(g_mutex);
  auto found = g_pending.find(token);
  if (found == g_pending.end()) {
    return nullptr;
  }
  auto done = std::move(found->second);
  g_pending.erase(found);
  return done;
}

jni::alias_ref<jclass> passkeyClass() {
  if (!g_passkeyClass) {
    throw std::runtime_error("passkey: JNI_OnLoad init did not run");
  }
  return g_passkeyClass;
}

// Runs one Kotlin entry point; a JNI failure completes the call as `failed`
// instead of leaving it parked forever.
void dispatch(const char* method, const std::string& requestJson, PasskeyDone done) {
  const int64_t token = park(std::move(done));
  try {
    jni::ThreadScope threadScope;
    auto entry = passkeyClass()->getStaticMethod<void(jlong, jni::alias_ref<jstring>)>(method);
    entry(passkeyClass(), static_cast<jlong>(token), jni::make_jstring(requestJson));
  } catch (...) {
    if (auto parked = take(token)) {
      parked(PasskeyResult{PasskeyStatus::failed, {}});
    }
  }
}

} // namespace

void kernelPasskeyInit(jni::alias_ref<jclass> clazz) {
  g_passkeyClass = jni::make_global(clazz);
}

void passkeyCreate(std::string requestJson, PasskeyDone done) {
  dispatch("create", requestJson, std::move(done));
}

void passkeyGet(std::string requestJson, PasskeyDone done) {
  dispatch("get", requestJson, std::move(done));
}

void passkeyCancel() {
  jni::ThreadScope threadScope;
  auto method = passkeyClass()->getStaticMethod<void()>("cancel");
  method(passkeyClass());
}

} // namespace qntx

extern "C" JNIEXPORT void JNICALL
Java_com_margelo_nitro_qntxwallet_Passkey_nativeComplete(
    JNIEnv* env, jclass, jlong token, jint status, jstring responseJson) {
  auto done = qntx::take(static_cast<int64_t>(token));
  if (!done) {
    return;
  }
  qntx::PasskeyResult result;
  switch (status) {
    case static_cast<jint>(qntx::PasskeyStatus::ok):
    case static_cast<jint>(qntx::PasskeyStatus::cancelled):
    case static_cast<jint>(qntx::PasskeyStatus::unavailable):
      result.status = static_cast<qntx::PasskeyStatus>(status);
      break;
    default:
      result.status = qntx::PasskeyStatus::failed;
  }
  if (responseJson != nullptr && result.status == qntx::PasskeyStatus::ok) {
    const char* utf = env->GetStringUTFChars(responseJson, nullptr);
    if (utf != nullptr) {
      result.responseJson = utf;
      env->ReleaseStringUTFChars(responseJson, utf);
    }
  }
  done(std::move(result));
}

#endif // __ANDROID__
