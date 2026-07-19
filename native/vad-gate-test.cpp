#include "vad-gate.h"

#include <cassert>
#include <iostream>
#include <vector>

namespace {
constexpr int test_sample_rate = 1000;
constexpr int frame_ms = 32;

void feed_frame(utterance_audio & audio, vad_gate & gate, float value, float probability) {
    std::vector<float> frame(frame_ms, value);
    audio.append(frame.data(), frame.size());
    const auto decision = gate.feed(probability);
    if (decision.became_active) audio.activate();
}
}

int main() {
    // A 900 ms low-energy opening remains below the activation threshold. The
    // stronger continuation needs another 300 ms to activate, but the opening
    // must still be present in the retained utterance.
    utterance_audio delayed(vocal_pre_roll_samples(test_sample_rate, 150, 300));
    vad_gate delayed_gate(0.6f, frame_ms, 300, 460);
    for (int index = 0; index < 29; ++index) feed_frame(delayed, delayed_gate, 1.0f, 0.35f);
    for (int index = 0; index < 10; ++index) feed_frame(delayed, delayed_gate, 2.0f, 0.9f);
    assert(delayed.active());
    assert(delayed.utterance().size() == 1248);
    assert(delayed.utterance().front() == 1.0f);

    // A boundary and a following utterance can share one inference backlog.
    for (int index = 0; index < 15; ++index) {
        feed_frame(delayed, delayed_gate, 0.0f, 0.0f);
    }
    assert(delayed_gate.silence_ms() >= 460);
    delayed.reset();
    delayed_gate.reset_utterance();
    for (int index = 0; index < 10; ++index) feed_frame(delayed, delayed_gate, 3.0f, 0.4f);
    for (int index = 0; index < 10; ++index) feed_frame(delayed, delayed_gate, 4.0f, 0.9f);
    assert(delayed.active());
    assert(delayed.utterance().front() == 3.0f);

    std::cout << "vad-gate regression tests passed\n";
    return 0;
}
