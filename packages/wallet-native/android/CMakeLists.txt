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
target_include_directories(${PACKAGE_NAME} PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/../cpp")

# Adds the nitrogen-generated sources, the BUILDING_..._GENERATED_CMAKE_PROJECT
# define they require, and the fbjni/ReactAndroid/NitroModules prefab links.
include(${CMAKE_CURRENT_SOURCE_DIR}/../nitrogen/generated/android/WalletNative+autolinking.cmake)

# Same Hermes link pattern as react-native-worklets 0.10.1: the hermes-engine
# prefab target is hermesvm on RN >= 0.82 and libhermes before that. The version
# minor comes from the ReactAndroid prefab config.
find_package(hermes-engine REQUIRED CONFIG)

# The runtime compiled inside the probe target carried ReactAndroid's Folly flag
# set (see ReactAndroid/cmake-utils/folly-flags.cmake); replicate it so the
# fbjni/folly headers compile identically.
include("${CMAKE_SOURCE_DIR}/../../../node_modules/react-native/ReactAndroid/cmake-utils/folly-flags.cmake")
target_compile_definitions(${PACKAGE_NAME} PRIVATE ${folly_FLAGS} -DRN_SERIALIZABLE_STATE)

find_library(LOG_LIB log)

target_link_libraries(
        ${PACKAGE_NAME}
        fbjni::fbjni
        ReactAndroid::jsi
        ${LOG_LIB}
        android
)

if(ReactAndroid_VERSION_MINOR GREATER_EQUAL 82)
  target_link_libraries(${PACKAGE_NAME} hermes-engine::hermesvm)
else()
  target_link_libraries(${PACKAGE_NAME} hermes-engine::libhermes)
endif()
