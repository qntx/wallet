project(WalletNative)
cmake_minimum_required(VERSION 3.16)

set(PACKAGE_NAME wallet-native)
set(CMAKE_VERBOSE_MAKEFILE ON)
set(CMAKE_CXX_STANDARD 20)

file(GLOB_RECURSE runtime_files CONFIGURE_DEPENDS
     "${CMAKE_CURRENT_SOURCE_DIR}/../cpp/runtime/*.cpp"
     "${CMAKE_CURRENT_SOURCE_DIR}/../cpp/host/*.cpp"
     "${CMAKE_CURRENT_SOURCE_DIR}/../nitrogen/generated/shared/c++/*.cpp"
     "${CMAKE_CURRENT_SOURCE_DIR}/../nitrogen/generated/android/*.cpp"
)

add_library(${PACKAGE_NAME} STATIC ${runtime_files})
target_include_directories(${PACKAGE_NAME} PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/../cpp")

# Same Hermes link pattern as react-native-worklets 0.10.1: the hermes-engine
# prefab target is hermesvm on RN >= 0.82 and libhermes before that. The version
# minor comes from the ReactAndroid prefab config.
find_package(fbjni REQUIRED)
find_package(ReactAndroid REQUIRED CONFIG)
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
