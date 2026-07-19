#include "audio-capture.h"

#include <algorithm>
#include <cstdio>
#include <cstring>

audio_capture::audio_capture(int length_ms) : length_ms_(length_ms) {}

audio_capture::~audio_capture() {
    if (device_id_) SDL_CloseAudioDevice(device_id_);
}

bool audio_capture::init(int capture_id, int sample_rate) {
    SDL_LogSetPriority(SDL_LOG_CATEGORY_APPLICATION, SDL_LOG_PRIORITY_INFO);
    if (SDL_Init(SDL_INIT_AUDIO) < 0) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "Couldn't initialize SDL: %s\n", SDL_GetError());
        return false;
    }

    SDL_SetHintWithPriority(SDL_HINT_AUDIO_RESAMPLING_MODE, "medium", SDL_HINT_OVERRIDE);
    const int device_count = SDL_GetNumAudioDevices(SDL_TRUE);
    std::fprintf(stderr, "%s: found %d capture devices:\n", __func__, device_count);
    for (int index = 0; index < device_count; ++index) {
        std::fprintf(stderr, "%s:    - Capture device #%d: '%s'\n",
            __func__, index, SDL_GetAudioDeviceName(index, SDL_TRUE));
    }

    SDL_AudioSpec requested;
    SDL_AudioSpec obtained;
    SDL_zero(requested);
    SDL_zero(obtained);
    requested.freq = sample_rate;
    requested.format = AUDIO_F32;
    requested.channels = 1;
    requested.samples = 1024;
    requested.callback = [](void * user_data, uint8_t * stream, int length) {
        static_cast<audio_capture *>(user_data)->callback(stream, length);
    };
    requested.userdata = this;

    const char * device_name = capture_id >= 0 ? SDL_GetAudioDeviceName(capture_id, SDL_TRUE) : nullptr;
    std::fprintf(stderr, "%s: attempt to open %s capture device%s%s%s ...\n",
        __func__,
        capture_id >= 0 ? "selected" : "default",
        device_name ? " '" : "",
        device_name ? device_name : "",
        device_name ? "'" : "");
    device_id_ = SDL_OpenAudioDevice(device_name, SDL_TRUE, &requested, &obtained, 0);
    if (!device_id_) {
        std::fprintf(stderr, "%s: couldn't open an audio device for capture: %s!\n",
            __func__, SDL_GetError());
        return false;
    }

    std::fprintf(stderr,
        "%s: obtained input spec: sample_rate=%d format=%d channels=%d samples=%d\n",
        __func__, obtained.freq, obtained.format, obtained.channels, obtained.samples);
    sample_rate_ = obtained.freq;
    audio_.resize((sample_rate_ * length_ms_) / 1000);
    return true;
}

bool audio_capture::resume() {
    if (!device_id_ || running_) return false;
    running_ = true;
    SDL_PauseAudioDevice(device_id_, 0);
    return true;
}

void audio_capture::callback(uint8_t * stream, int length) {
    if (!running_) return;

    size_t sample_count = static_cast<size_t>(length) / sizeof(float);
    if (sample_count > audio_.size()) {
        sample_count = audio_.size();
        stream += length - static_cast<int>(sample_count * sizeof(float));
    }

    std::lock_guard<std::mutex> lock(mutex_);
    if (audio_position_ + sample_count > audio_.size()) {
        const size_t first_count = audio_.size() - audio_position_;
        std::memcpy(&audio_[audio_position_], stream, first_count * sizeof(float));
        std::memcpy(&audio_[0], stream + first_count * sizeof(float),
            (sample_count - first_count) * sizeof(float));
    } else {
        std::memcpy(&audio_[audio_position_], stream, sample_count * sizeof(float));
    }
    audio_position_ = (audio_position_ + sample_count) % audio_.size();
    audio_length_ = std::min(audio_length_ + sample_count, audio_.size());
}

void audio_capture::drain(std::vector<float> & output) {
    output.clear();
    if (!device_id_ || !running_) return;

    std::lock_guard<std::mutex> lock(mutex_);
    output.resize(audio_length_);
    const size_t start = (audio_position_ + audio_.size() - audio_length_) % audio_.size();
    if (start + audio_length_ > audio_.size()) {
        const size_t first_count = audio_.size() - start;
        std::memcpy(output.data(), &audio_[start], first_count * sizeof(float));
        std::memcpy(output.data() + first_count, &audio_[0],
            (audio_length_ - first_count) * sizeof(float));
    } else if (audio_length_ > 0) {
        std::memcpy(output.data(), &audio_[start], audio_length_ * sizeof(float));
    }
    audio_length_ = 0;
}

bool poll_capture_events() {
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
        if (event.type == SDL_QUIT) return false;
    }
    return true;
}
