#pragma once

#include <SDL.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <vector>

// Project-owned SDL capture buffer. drain() copies and consumes samples under
// one lock, so a callback cannot write samples between a get() and clear().
class audio_capture {
public:
    explicit audio_capture(int length_ms);
    ~audio_capture();

    bool init(int capture_id, int sample_rate);
    bool resume();
    void drain(std::vector<float> & output);
    // Independently drains recent capture samples for best-effort UI metering.
    // This never consumes or delays the decoder backlog.
    void drain_meter(std::vector<float> & output);

private:
    void callback(uint8_t * stream, int length);

    SDL_AudioDeviceID device_id_ = 0;
    int length_ms_ = 0;
    int sample_rate_ = 0;
    std::atomic_bool running_ = false;
    std::mutex mutex_;
    std::vector<float> audio_;
    size_t audio_position_ = 0;
    size_t audio_length_ = 0;
    std::vector<float> meter_audio_;
    size_t meter_position_ = 0;
    size_t meter_length_ = 0;
};

bool poll_capture_events();
