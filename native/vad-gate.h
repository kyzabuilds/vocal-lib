#pragma once

#include <algorithm>
#include <cstddef>
#include <vector>

constexpr int vocal_vad_onset_lookback_ms = 1200;

inline size_t vocal_pre_roll_samples(int sample_rate, int keep_ms, int min_speech_ms) {
    const int retained_ms = std::max(keep_ms, min_speech_ms) + vocal_vad_onset_lookback_ms;
    return static_cast<size_t>(sample_rate) * static_cast<size_t>(retained_ms) / 1000;
}

class utterance_audio {
public:
    explicit utterance_audio(size_t pre_roll_capacity)
        : pre_roll_capacity_(pre_roll_capacity) {}

    void append(const float * samples, size_t count) {
        auto & destination = active_ ? utterance_ : pre_roll_;
        destination.insert(destination.end(), samples, samples + count);
        if (!active_ && destination.size() > pre_roll_capacity_) {
            destination.erase(destination.begin(),
                destination.begin() + (destination.size() - pre_roll_capacity_));
        }
    }

    void activate() {
        if (active_) return;
        active_ = true;
        utterance_.swap(pre_roll_);
        pre_roll_.clear();
    }

    void reset() {
        active_ = false;
        pre_roll_.clear();
        utterance_.clear();
    }

    bool active() const { return active_; }
    const std::vector<float> & utterance() const { return utterance_; }
    size_t pre_roll_size() const { return pre_roll_.size(); }

private:
    size_t pre_roll_capacity_;
    bool active_ = false;
    std::vector<float> pre_roll_;
    std::vector<float> utterance_;
};

struct vad_gate_decision {
    bool speech = false;
    bool became_active = false;
    bool boundary = false;
};

class vad_gate {
public:
    vad_gate(float threshold, int frame_ms, int min_speech_ms, int silence_hangover_ms)
        : threshold_(threshold),
          frame_ms_(frame_ms),
          min_speech_ms_(min_speech_ms),
          silence_hangover_ms_(silence_hangover_ms) {}

    vad_gate_decision feed(float probability) {
        vad_gate_decision decision;
        decision.speech = probability >= threshold_;
        if (decision.speech) {
            consecutive_speech_ms_ += frame_ms_;
            utterance_speech_ms_ += frame_ms_;
            silent_ms_ = 0;
            if (!active_ && consecutive_speech_ms_ >= min_speech_ms_) {
                active_ = true;
                decision.became_active = true;
            }
        } else if (active_) {
            silent_ms_ += frame_ms_;
            decision.boundary = silent_ms_ >= silence_hangover_ms_;
        } else {
            consecutive_speech_ms_ = 0;
            utterance_speech_ms_ = 0;
        }
        return decision;
    }

    void reset_utterance() {
        active_ = false;
        consecutive_speech_ms_ = 0;
        utterance_speech_ms_ = 0;
        silent_ms_ = 0;
    }

    bool active() const { return active_; }
    int speech_ms() const { return utterance_speech_ms_; }
    int silence_ms() const { return silent_ms_; }

private:
    float threshold_;
    int frame_ms_;
    int min_speech_ms_;
    int silence_hangover_ms_;
    bool active_ = false;
    int consecutive_speech_ms_ = 0;
    int utterance_speech_ms_ = 0;
    int silent_ms_ = 0;
};
