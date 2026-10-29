# Called from native code over JNI or bound to JNI by method-name mangling;
# R8 would otherwise strip or rename them (the classes have no direct Java
# call sites inside the app).
-keep class com.margelo.nitro.qntxwallet.** { *; }
