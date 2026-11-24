// Android secure input: Kotlin's SecureInputField attaches to the hub
// through these JNI entry points. The hub's sink holds a global ref to the
// field and calls its deliver() with a ThreadScope; the field reposts to the
// main Looper. Submitted bytes are copied into wiping SecretBytes and the
// Java array is zeroed before submit() returns.
#include "../host/SecureInput.hpp"

#ifdef __ANDROID__

#include "../runtime/KernelBuffer.hpp"

#include <fbjni/fbjni.h>
#include <jni.h>

#include <cstring>
#include <optional>

namespace qntx {
namespace {

namespace jni = facebook::jni;

// The SecureInputField class and its deliver(int kind, String label) method —
// both cached at JNI_OnLoad.
jni::global_ref<jclass> g_fieldClass;
jmethodID g_deliver = nullptr;

void deliver(
    const jni::global_ref<jobject>& field,
    const std::optional<SecureInputPrompt>& prompt) {
  jni::ThreadScope threadScope;
  JNIEnv* env = jni::Environment::current();
  if (env == nullptr || g_deliver == nullptr) {
    return;
  }
  jint kind = 0;
  // The SecureInputField.kt KIND_* ordinals, shared with the C++ enum.
  // make_jstring handles all of UTF-8; NewStringUTF's modified UTF-8
  // rejects astral characters and aborts under CheckJNI.
  jni::local_ref<jstring> label;
  if (prompt.has_value()) {
    kind = prompt->kind == SecureInputKind::accessCode
               ? 0
               : prompt->kind == SecureInputKind::shortId
                     ? 1
                     : prompt->kind == SecureInputKind::backupPassword ? 2 : 3;
    label = jni::make_jstring(prompt->label);
  }
  env->CallVoidMethod(field.get(), g_deliver, kind, label.get());
}

} // namespace

void kernelSecureInputInit(jni::alias_ref<jclass> clazz) {
  g_fieldClass = jni::make_global(clazz);
  jni::ThreadScope threadScope;
  JNIEnv* env = jni::Environment::current();
  g_deliver = env->GetMethodID(
      clazz.get(), "deliver", "(ILjava/lang/String;)V");
}

} // namespace qntx

extern "C" {

// SecureInputField.nativeAttach: register the hub sink; it keeps a global
// ref to the field until detach() drops the sink and releases it.
JNIEXPORT jlong JNICALL
Java_com_margelo_nitro_qntxwallet_SecureInputField_nativeAttach(
    JNIEnv*, jobject thiz) {
  auto field = facebook::jni::make_global(thiz);
  const uint64_t id = qntx::SecureInputHub::shared().attach(
      [field](const std::optional<qntx::SecureInputPrompt>& prompt) {
        qntx::deliver(field, prompt);
      });
  return static_cast<jlong>(id);
}

JNIEXPORT void JNICALL
Java_com_margelo_nitro_qntxwallet_SecureInputField_nativeDetach(
    JNIEnv*, jobject, jlong id) {
  qntx::SecureInputHub::shared().detach(static_cast<uint64_t>(id));
}

// SecureInputField.nativeSubmit: copy the bytes into wiping storage, zero
// the Java array in place, then hand the request to the hub.
JNIEXPORT jboolean JNICALL
Java_com_margelo_nitro_qntxwallet_SecureInputField_nativeSubmit(
    JNIEnv* env, jobject, jlong id, jbyteArray bytes) {
  if (bytes == nullptr) {
    return JNI_FALSE;
  }
  const jsize size = env->GetArrayLength(bytes);
  jbyte* elements = env->GetByteArrayElements(bytes, nullptr);
  if (elements == nullptr) {
    return JNI_FALSE;
  }
  qntx::SecretBytes value(
      reinterpret_cast<const uint8_t*>(elements), static_cast<size_t>(size));
  std::memset(elements, 0, static_cast<size_t>(size));
  env->ReleaseByteArrayElements(bytes, elements, 0);
  return qntx::SecureInputHub::shared().submit(
             static_cast<uint64_t>(id), std::move(value))
             ? JNI_TRUE
             : JNI_FALSE;
}

} // extern "C"

#endif // __ANDROID__
