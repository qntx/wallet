project(WalletNative)
cmake_minimum_required(VERSION 3.16)

set(PACKAGE_NAME WalletNative)
set(CMAKE_VERBOSE_MAKEFILE ON)
set(CMAKE_CXX_STANDARD 20)

file(GLOB_RECURSE runtime_files CONFIGURE_DEPENDS
     "${CMAKE_CURRENT_SOURCE_DIR}/../cpp/runtime/*.cpp"
     "${CMAKE_CURRENT_SOURCE_DIR}/../cpp/host/*.cpp"
     "${CMAKE_CURRENT_SOURCE_DIR}/../cpp/platform/*.cpp"
     "${CMAKE_CURRENT_SOURCE_DIR}/src/main/cpp/*.cpp"
)

add_library(${PACKAGE_NAME} SHARED ${runtime_files})
target_include_directories(${PACKAGE_NAME} PUBLIC
     "${CMAKE_CURRENT_SOURCE_DIR}/../cpp"
     "${CMAKE_CURRENT_SOURCE_DIR}/../cpp/host"
     "${CMAKE_CURRENT_SOURCE_DIR}/../cpp/platform"
     "${CMAKE_CURRENT_BINARY_DIR}/qntx-kernel"
)

# Compile the shipped kernel bundle to bytecode with the app's own hermesc —
# Hermes only loads its own bytecode version, so precompiled hbc cannot ship.
# The app's react-native root is passed explicitly (-DQNTX_REACT_NATIVE_PATH)
# so the script resolves the app's own hermesc version.
find_program(NODE_EXECUTABLE node REQUIRED)
if(NOT QNTX_REACT_NATIVE_PATH)
  message(FATAL_ERROR "QNTX_REACT_NATIVE_PATH is not set — the consuming app must pass -DQNTX_REACT_NATIVE_PATH=<react-native dir>")
endif()
set(KERNEL_HEADER "${CMAKE_CURRENT_BINARY_DIR}/qntx-kernel/kernel.hpp")
add_custom_command(
     OUTPUT ${KERNEL_HEADER}
     COMMAND ${NODE_EXECUTABLE}
             "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/compile-kernel.mjs"
             "${CMAKE_CURRENT_BINARY_DIR}/qntx-kernel"
             "${QNTX_REACT_NATIVE_PATH}"
     DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/../kernel/generated/kernel-entry.js"
             "${CMAKE_CURRENT_SOURCE_DIR}/../kernel/generated/kernel.manifest.json"
             "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/compile-kernel.mjs"
     COMMENT "Compiling the kernel bytecode (hermesc)"
     VERBATIM
)
add_custom_target(qntx-kernel-bytecode DEPENDS ${KERNEL_HEADER})
add_dependencies(${PACKAGE_NAME} qntx-kernel-bytecode)

# The kernel's backends.spark binds the qs_* C ABI: the prebuilt
# libqntx_spark.so + header ship inside the app's @qntx/spark-native package
# (dir passed as -DQNTX_SPARK_NATIVE_PATH, resolved like the react-native dir).
if(NOT QNTX_SPARK_NATIVE_PATH)
  message(FATAL_ERROR "QNTX_SPARK_NATIVE_PATH is not set — the consuming app must pass -DQNTX_SPARK_NATIVE_PATH=<@qntx/spark-native dir>")
endif()
set(QNTX_SPARK_LIBDIR "${QNTX_SPARK_NATIVE_PATH}/android/src/main/jniLibs/${ANDROID_ABI}")
if(NOT EXISTS "${QNTX_SPARK_LIBDIR}/libqntx_spark.so")
  message(FATAL_ERROR "libqntx_spark.so for ${ANDROID_ABI} not found in ${QNTX_SPARK_LIBDIR}")
endif()
# The .so carries SONAME since 0.5.1, so the path link records the soname in
# DT_NEEDED — the loader resolves it from the packaged jniLibs. GLOBAL: this
# target's link libraries are transitive (plain signature), so
# add_subdirectory consumers (v1-probe) see and link the same imported target.
add_library(qntx_spark SHARED IMPORTED GLOBAL)
set_target_properties(qntx_spark PROPERTIES
     IMPORTED_LOCATION "${QNTX_SPARK_LIBDIR}/libqntx_spark.so")
target_include_directories(${PACKAGE_NAME} PRIVATE "${QNTX_SPARK_NATIVE_PATH}/include")

find_package(qntx_nostr-native REQUIRED CONFIG)

# Adds the nitrogen-generated sources, the BUILDING_..._GENERATED_CMAKE_PROJECT
# define they require, and the fbjni/ReactAndroid/NitroModules prefab links.
include(${CMAKE_CURRENT_SOURCE_DIR}/../nitrogen/generated/android/WalletNative+autolinking.cmake)

# Same Hermes link pattern as react-native-worklets 0.10.1: the hermes-engine
# prefab target is hermesvm on RN >= 0.82 and libhermes before that. The version
# minor comes from the ReactAndroid prefab config.
find_package(hermes-engine REQUIRED CONFIG)

# The generated autolinking.cmake already defines the FOLLY flags this module
# needs; the runtime only adds RN_SERIALIZABLE_STATE. (folly-flags.cmake itself
# is only reachable relative to the consuming app's node_modules, which this
# module cannot assume when it is built standalone.)
target_compile_definitions(${PACKAGE_NAME} PRIVATE -DRN_SERIALIZABLE_STATE)

find_library(LOG_LIB log)

target_link_libraries(
        ${PACKAGE_NAME}
        fbjni::fbjni
        ReactAndroid::jsi
        qntx_spark
        qntx_nostr-native::NostrNative
        ${LOG_LIB}
        android
)

if(ReactAndroid_VERSION_MINOR GREATER_EQUAL 82)
  target_link_libraries(${PACKAGE_NAME} hermes-engine::hermesvm)
else()
  target_link_libraries(${PACKAGE_NAME} hermes-engine::libhermes)
endif()
