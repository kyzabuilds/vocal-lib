cmake_minimum_required(VERSION 3.16)
project(vocal_stream LANGUAGES CXX)

# This is a project-owned microphone driver. whisper.cpp remains an unmodified
# dependency; we only link its public library. Capture and buffering remain
# project-owned so draining microphone samples is atomic.
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
option(VOCAL_STREAM_VULKAN "Build the driver with whisper.cpp's Vulkan backend" ON)
if (VOCAL_STREAM_VULKAN)
  set(GGML_VULKAN ON CACHE BOOL "" FORCE)
endif()
add_subdirectory(${CMAKE_CURRENT_LIST_DIR}/../vendor/whisper.cpp whisper.cpp-build)

find_package(SDL2 REQUIRED)
find_package(Threads REQUIRED)

add_executable(vocal-stream vocal-stream.cpp audio-capture.cpp)
target_compile_features(vocal-stream PRIVATE cxx_std_17)
target_include_directories(vocal-stream PRIVATE
  ${CMAKE_CURRENT_LIST_DIR}/../vendor/whisper.cpp/include
  ${CMAKE_CURRENT_LIST_DIR}/../vendor/whisper.cpp/ggml/include
)
target_link_libraries(vocal-stream PRIVATE whisper SDL2::SDL2 Threads::Threads)

add_executable(vocal-stream-vad-test vad-gate-test.cpp)
target_compile_features(vocal-stream-vad-test PRIVATE cxx_std_17)

enable_testing()
add_test(NAME vocal-stream-vad-test COMMAND vocal-stream-vad-test)
