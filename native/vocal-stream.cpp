// Low-latency microphone driver with a speech gate. This intentionally lives
// outside vendor/: it links the public whisper.cpp API but does not fork it.
#include "audio-capture.h"
#include "ggml-backend.h"
#include "vad-gate.h"
#include "whisper.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string>
#include <thread>
#include <vector>

namespace {
constexpr int sample_rate = WHISPER_SAMPLE_RATE;
// Silero v6.x at 16 kHz advances its recurrent state in 512-sample frames.
constexpr int vad_window_samples = 512;
constexpr int capture_backlog_ms = 30000;

struct params {
    int audio_ctx = 0;
    int beam_size = 1;
    int capture_id = -1;
    int keep_ms = 150;
    int length_ms = 1200;
    int max_decode_silence_ms = 150;
    int max_tokens = 16;
    int min_speech_ms = 300;
    int silence_hangover_ms = 450;
    int step_ms = 150;
    int threads = 4;
    float logprob_threshold = -1.0f;
    float no_speech_threshold = 0.6f;
    float freq_threshold = 0.0f;
    float vad_threshold = 0.6f;
    bool carry_initial_prompt = false;
    bool diagnostics = false;
    bool keep_context = false;
    bool no_fallback = false;
    bool print_special = false;
    bool translate = false;
    bool tinydiarize = false;
    bool use_gpu = true;
    std::string language = "en";
    std::string model;
    std::string prompt;
    std::string vad_model;
};

[[noreturn]] void usage(const char * program, const char * error = nullptr) {
    if (error) std::fprintf(stderr, "error: %s\n", error);
    std::fprintf(stderr,
        "usage: %s -m <model> --vad-model <silero-model> [options]\n"
        "  --step N --length N --keep N --capture N --threads N --beam-size N\n"
        "  --vad-thold N --freq-thold N --no-speech-thold N --logprob-thold N\n"
        "  --min-speech-ms N --silence-hangover-ms N --max-decode-silence-ms N\n"
        "  --language LANG --max-tokens N --audio-ctx N --diagnostics\n"
        "  --prompt TEXT --carry-initial-prompt --keep-context --no-fallback\n"
        "  --translate --print-special --no-gpu\n", program);
    std::exit(error ? 1 : 0);
}

const char * value(int & index, int argc, char ** argv, const char * flag) {
    if (++index >= argc) usage(argv[0], flag);
    return argv[index];
}

params parse(int argc, char ** argv) {
    params result;
    for (int index = 1; index < argc; ++index) {
        const std::string arg = argv[index];
        if (arg == "-h" || arg == "--help") usage(argv[0]);
        else if (arg == "-m" || arg == "--model") result.model = value(index, argc, argv, "--model requires a value");
        else if (arg == "--vad-model") result.vad_model = value(index, argc, argv, "--vad-model requires a value");
        else if (arg == "--step") result.step_ms = std::stoi(value(index, argc, argv, "--step requires a value"));
        else if (arg == "--length") result.length_ms = std::stoi(value(index, argc, argv, "--length requires a value"));
        else if (arg == "--keep") result.keep_ms = std::stoi(value(index, argc, argv, "--keep requires a value"));
        else if (arg == "-c" || arg == "--capture") result.capture_id = std::stoi(value(index, argc, argv, "--capture requires a value"));
        else if (arg == "-t" || arg == "--threads") result.threads = std::stoi(value(index, argc, argv, "--threads requires a value"));
        else if (arg == "-bs" || arg == "--beam-size") result.beam_size = std::stoi(value(index, argc, argv, "--beam-size requires a value"));
        else if (arg == "-mt" || arg == "--max-tokens") result.max_tokens = std::stoi(value(index, argc, argv, "--max-tokens requires a value"));
        else if (arg == "-ac" || arg == "--audio-ctx") result.audio_ctx = std::stoi(value(index, argc, argv, "--audio-ctx requires a value"));
        else if (arg == "-vth" || arg == "--vad-thold") result.vad_threshold = std::stof(value(index, argc, argv, "--vad-thold requires a value"));
        else if (arg == "-fth" || arg == "--freq-thold") result.freq_threshold = std::stof(value(index, argc, argv, "--freq-thold requires a value"));
        else if (arg == "--no-speech-thold") result.no_speech_threshold = std::stof(value(index, argc, argv, "--no-speech-thold requires a value"));
        else if (arg == "--logprob-thold") result.logprob_threshold = std::stof(value(index, argc, argv, "--logprob-thold requires a value"));
        else if (arg == "--min-speech-ms") result.min_speech_ms = std::stoi(value(index, argc, argv, "--min-speech-ms requires a value"));
        else if (arg == "--silence-hangover-ms") result.silence_hangover_ms = std::stoi(value(index, argc, argv, "--silence-hangover-ms requires a value"));
        else if (arg == "--max-decode-silence-ms") result.max_decode_silence_ms = std::stoi(value(index, argc, argv, "--max-decode-silence-ms requires a value"));
        else if (arg == "-l" || arg == "--language") result.language = value(index, argc, argv, "--language requires a value");
        else if (arg == "--prompt") result.prompt = value(index, argc, argv, "--prompt requires a value");
        else if (arg == "--carry-initial-prompt") result.carry_initial_prompt = true;
        else if (arg == "--diagnostics") result.diagnostics = true;
        else if (arg == "--keep-context") result.keep_context = true;
        else if (arg == "--no-fallback") result.no_fallback = true;
        else if (arg == "--print-special") result.print_special = true;
        else if (arg == "--translate") result.translate = true;
        else if (arg == "--tinydiarize") result.tinydiarize = true;
        else if (arg == "--save-audio") { /* capture remains in-memory in this driver */ }
        else if (arg == "-ng" || arg == "--no-gpu") result.use_gpu = false;
        else usage(argv[0], ("unknown argument: " + arg).c_str());
    }
    if (result.model.empty()) usage(argv[0], "--model is required");
    if (result.vad_model.empty()) usage(argv[0], "--vad-model is required");
    if (result.step_ms <= 0 || result.length_ms < result.step_ms) usage(argv[0], "--step must be positive and no larger than --length");
    if (result.min_speech_ms <= 0 || result.silence_hangover_ms <= 0 || result.max_decode_silence_ms < 0) {
        usage(argv[0], "speech and silence durations must be non-negative, with positive speech and hangover durations");
    }
    return result;
}

bool wait_for_audio(
    audio_capture & audio,
    int step_ms,
    std::vector<float> & pending,
    std::vector<float> & output
) {
    const int required_samples = (sample_rate * step_ms) / 1000;
    std::vector<float> captured;
    while (poll_capture_events()) {
        // Inference can take longer than step_ms. Atomically drain everything
        // recorded since the previous iteration, then accumulate short device
        // callbacks until a decode step is available.
        audio.drain(captured);
        pending.insert(pending.end(), captured.begin(), captured.end());
        if (static_cast<int>(pending.size()) >= required_samples) {
            output.swap(pending);
            pending.clear();
            return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    return false;
}

std::string json_string(const std::string & value) {
    std::string output;
    output.reserve(value.size() + 2);
    output.push_back('"');
    for (const unsigned char character : value) {
        switch (character) {
            case '"': output += "\\\""; break;
            case '\\': output += "\\\\"; break;
            case '\b': output += "\\b"; break;
            case '\f': output += "\\f"; break;
            case '\n': output += "\\n"; break;
            case '\r': output += "\\r"; break;
            case '\t': output += "\\t"; break;
            default:
                if (character < 0x20) {
                    char escaped[7];
                    std::snprintf(escaped, sizeof(escaped), "\\u%04x", character);
                    output += escaped;
                } else {
                    output.push_back(static_cast<char>(character));
                }
        }
    }
    output.push_back('"');
    return output;
}

std::vector<float> audio_tail(const std::vector<float> & audio, int length_ms) {
    const size_t wanted = static_cast<size_t>(sample_rate) * static_cast<size_t>(length_ms) / 1000;
    if (audio.size() <= wanted) return audio;
    return std::vector<float>(audio.end() - wanted, audio.end());
}

struct decode_result {
    std::string text;
    float avg_logprob = -std::numeric_limits<float>::infinity();
    float no_speech_probability = 1.0f;
    int text_tokens = 0;
};

decode_result read_result(whisper_context * context) {
    decode_result result;
    double logprob_sum = 0.0;
    bool has_segment = false;

    for (int index = 0; index < whisper_full_n_segments(context); ++index) {
        const float no_speech = whisper_full_get_segment_no_speech_prob(context, index);
        result.no_speech_probability = has_segment
            ? std::max(result.no_speech_probability, no_speech)
            : no_speech;
        has_segment = true;
        result.text += whisper_full_get_segment_text(context, index);

        for (int token = 0; token < whisper_full_n_tokens(context, index); ++token) {
            const auto data = whisper_full_get_token_data(context, index, token);
            if (data.id >= whisper_token_eot(context) || !std::isfinite(data.plog)) continue;
            logprob_sum += data.plog;
            result.text_tokens += 1;
        }
    }

    if (result.text_tokens > 0) {
        result.avg_logprob = static_cast<float>(logprob_sum / result.text_tokens);
    }

    return result;
}

bool accept_result(const decode_result & result, const params & options) {
    if (result.text.empty() || result.text_tokens == 0) return false;

    // Match Whisper's own silence decision: a high no-speech probability is
    // not sufficient to discard confident speech (including a genuinely spoken
    // short phrase such as "Thank you."). Both signals must indicate silence.
    return !(result.no_speech_probability > options.no_speech_threshold &&
             result.avg_logprob < options.logprob_threshold);
}

void print_hypothesis(const std::string & text, bool current_chunk_has_speech) {
    // RS marks a speech-positive hypothesis; GS marks the one right-context
    // decode allowed after VAD turns negative. Both are non-printing provisional
    // record boundaries for the TypeScript agreement parser.
    std::printf("\33[2K\r%s%c", text.c_str(), current_chunk_has_speech ? '\x1e' : '\x1d');
    std::fflush(stdout);
}

void print_utterance_final(const std::string & text) {
    // FS marks an authoritative decode over the complete VAD utterance. The
    // TypeScript parser treats RS/GS redraws as previews and only this record as
    // final, so rolling-window corrections cannot delete already-spoken words.
    std::printf("\33[2K\r%s%c\n", text.c_str(), '\x1c');
    std::fflush(stdout);
}

} // namespace

int main(int argc, char ** argv) {
    const auto options = parse(argc, argv);
    ggml_backend_load_all();

    whisper_context_params context_params = whisper_context_default_params();
    context_params.use_gpu = options.use_gpu;
    whisper_context * context = whisper_init_from_file_with_params(options.model.c_str(), context_params);
    if (!context) {
        std::fprintf(stderr, "vocal-stream: unable to load Whisper model: %s\n", options.model.c_str());
        return 2;
    }

    const auto vad_params = whisper_vad_default_context_params();
    whisper_vad_context * vad = whisper_vad_init_from_file_with_params(options.vad_model.c_str(), vad_params);
    if (!vad) {
        std::fprintf(stderr, "vocal-stream: unable to load VAD model: %s\n", options.vad_model.c_str());
        whisper_free(context);
        return 2;
    }

    // The capture ring is a backlog, not the decoder window. Keeping these
    // separate prevents audio recorded during a slow decode from disappearing.
    audio_capture audio(std::max(capture_backlog_ms, options.length_ms));
    if (!audio.init(options.capture_id, sample_rate) || !audio.resume()) {
        whisper_vad_free(vad);
        whisper_free(context);
        return 3;
    }

    bool initial_prompt_pending = true;
    std::vector<float> chunk;
    std::vector<float> capture_pending;
    std::vector<float> vad_pending;
    std::vector<float> window;
    std::vector<whisper_token> prompt_tokens;
    std::string last_preview_text;
    utterance_audio retained(vocal_pre_roll_samples(
        sample_rate, options.keep_ms, options.min_speech_ms));
    vad_gate speech_gate(
        options.vad_threshold,
        (vad_window_samples * 1000) / sample_rate,
        options.min_speech_ms,
        options.silence_hangover_ms);

    const auto decode_audio = [&](const std::vector<float> & samples, bool final_decode) {
        whisper_full_params decode = whisper_full_default_params(
            options.beam_size > 1 ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY);
        decode.print_progress = false;
        decode.print_realtime = false;
        decode.print_special = options.print_special;
        decode.print_timestamps = false;
        decode.single_segment = !final_decode;
        // max_tokens limits a rolling preview, not the final utterance. Applying
        // the 16-token low-latency default to a complete sentence truncates it.
        decode.max_tokens = final_decode ? 0 : options.max_tokens;
        decode.n_threads = options.threads;
        decode.audio_ctx = options.audio_ctx;
        decode.language = options.language.c_str();
        decode.translate = options.translate;
        decode.tdrz_enable = options.tinydiarize;
        decode.initial_prompt = (final_decode || initial_prompt_pending)
            ? (options.prompt.empty() ? nullptr : options.prompt.c_str())
            : nullptr;
        decode.carry_initial_prompt = false;
        // Rolling context can improve the next preview, but feeding tail tokens
        // into a full-utterance decode can duplicate or bias its beginning.
        decode.prompt_tokens = !final_decode && options.keep_context && !prompt_tokens.empty()
            ? prompt_tokens.data()
            : nullptr;
        decode.prompt_n_tokens = !final_decode && options.keep_context
            ? static_cast<int>(prompt_tokens.size())
            : 0;
        decode.beam_search.beam_size = options.beam_size;
        decode.temperature_inc = options.no_fallback ? 0.0f : decode.temperature_inc;
        decode.logprob_thold = options.logprob_threshold;
        decode.no_speech_thold = options.no_speech_threshold;

        decode_result failed;
        if (whisper_full(context, decode, samples.data(), static_cast<int>(samples.size())) != 0) {
            std::fprintf(stderr, "vocal-stream: Whisper decode failed\n");
            return failed;
        }

        if (!final_decode) initial_prompt_pending = false;
        return read_result(context);
    };

    const auto finalize_utterance = [&]() {
        const auto & utterance = retained.utterance();
        const auto decode_started = std::chrono::steady_clock::now();
        const auto result = decode_audio(utterance, true);
        const bool accepted = accept_result(result, options);
        print_utterance_final(accepted ? result.text : "");

        if (options.diagnostics) {
            const auto latency_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - decode_started).count();
            const auto final_text = accepted ? result.text : "";
            std::fprintf(stderr,
                "vocal-stream: diagnostic {\"event\":\"decode\",\"scope\":\"utterance\","
                "\"no_speech_probability\":%.4f,\"avg_logprob\":%.4f,\"tokens\":%d,"
                "\"action\":\"%s\",\"latency_ms\":%lld,\"audio_ms\":%lld,"
                "\"preview_text\":%s,\"authoritative_text\":%s}\n",
                result.no_speech_probability,
                result.avg_logprob,
                result.text_tokens,
                accepted ? "final" : "discarded",
                static_cast<long long>(latency_ms),
                static_cast<long long>(utterance.size() * 1000 / sample_rate),
                json_string(last_preview_text).c_str(),
                json_string(final_text).c_str());
        }

        speech_gate.reset_utterance();
        retained.reset();
        prompt_tokens.clear();
        last_preview_text.clear();
        initial_prompt_pending = true;
    };

    while (wait_for_audio(audio, options.step_ms, capture_pending, chunk)) {
        const auto captured_chunk_ms = static_cast<long long>(chunk.size() * 1000 / sample_rate);
        vad_pending.insert(vad_pending.end(), chunk.begin(), chunk.end());
        const int vad_sample_count = static_cast<int>(vad_pending.size() / vad_window_samples) * vad_window_samples;
        if (vad_sample_count == 0) continue;

        bool current_frame_has_speech = false;
        float latest_vad_probability = 0.0f;
        int processed_samples = 0;
        bool vad_failed = false;

        // Process retention and boundaries one VAD frame at a time. A drained
        // capture chunk can contain seconds of audio accumulated during Whisper
        // inference, including an utterance boundary and the next quiet onset.
        // Capping the whole chunk before examining its frame probabilities would
        // discard that onset.
        while (processed_samples < vad_sample_count) {
            const int remaining_samples = vad_sample_count - processed_samples;
            if (!whisper_vad_detect_speech_no_reset(
                vad, vad_pending.data() + processed_samples, remaining_samples)) {
                std::fprintf(stderr, "vocal-stream: VAD compute failed\n");
                vad_failed = true;
                break;
            }

            const int probability_count = whisper_vad_n_probs(vad);
            const float * probabilities = whisper_vad_probs(vad);
            const int expected_frames = remaining_samples / vad_window_samples;
            if (!probabilities || probability_count != expected_frames) {
                std::fprintf(stderr,
                    "vocal-stream: VAD returned %d probabilities for %d frames\n",
                    probability_count, expected_frames);
                vad_failed = true;
                break;
            }
            const std::vector<float> frame_probabilities(
                probabilities, probabilities + probability_count);
            bool reached_boundary = false;

            for (int index = 0; index < probability_count; ++index) {
                const size_t frame_start = static_cast<size_t>(processed_samples)
                    + static_cast<size_t>(index) * vad_window_samples;
                retained.append(vad_pending.data() + frame_start, vad_window_samples);
                latest_vad_probability = frame_probabilities[index];
                const auto decision = speech_gate.feed(latest_vad_probability);
                current_frame_has_speech = decision.speech;

                if (decision.became_active) {
                    retained.activate();
                    if (options.diagnostics) {
                        const auto retained_ms = static_cast<long long>(
                            retained.utterance().size() * 1000 / sample_rate);
                        std::fprintf(stderr,
                            "vocal-stream: diagnostic {\"event\":\"vad_activation\","
                            "\"activation_offset_ms\":%lld,\"pre_roll_ms\":%lld,"
                            "\"retained_utterance_ms\":%lld,\"speech_ms\":%d}\n",
                            retained_ms,
                            retained_ms,
                            retained_ms,
                            speech_gate.speech_ms());
                    }
                }

                if (decision.boundary) {
                    processed_samples += (index + 1) * vad_window_samples;
                    finalize_utterance();
                    // whisper.cpp documents resetting recurrent VAD state
                    // between utterances. Any remaining backlog is re-evaluated
                    // from that clean state on the next outer iteration.
                    whisper_vad_reset_state(vad);
                    current_frame_has_speech = false;
                    reached_boundary = true;
                    break;
                }
            }

            if (!reached_boundary) {
                processed_samples += remaining_samples;
            }
        }

        if (vad_failed) {
            whisper_vad_reset_state(vad);
            speech_gate.reset_utterance();
            retained.reset();
            vad_pending.clear();
            continue;
        }
        vad_pending.erase(vad_pending.begin(),
            vad_pending.begin() + processed_samples);

        if (options.diagnostics) {
            std::fprintf(stderr,
                "vocal-stream: diagnostic {\"event\":\"capture\",\"chunk_ms\":%lld,"
                "\"pre_roll_ms\":%lld,\"retained_utterance_ms\":%lld,"
                "\"vad_probability\":%.4f,\"speech\":%s,\"active\":%s,"
                "\"speech_ms\":%d,\"silence_ms\":%d}\n",
                captured_chunk_ms,
                static_cast<long long>(retained.pre_roll_size() * 1000 / sample_rate),
                static_cast<long long>(retained.utterance().size() * 1000 / sample_rate),
                latest_vad_probability,
                current_frame_has_speech ? "true" : "false",
                speech_gate.active() ? "true" : "false",
                speech_gate.speech_ms(),
                speech_gate.silence_ms());
        }

        if (!speech_gate.active()) {
            // Never invoke Whisper for a silence-only window. This is the
            // critical distinction that prevents silence hallucinations.
            continue;
        }

        // Decode one silence window for right context, then let the VAD
        // hangover finish without repeatedly asking Whisper to transcribe an
        // increasingly silent tail.
        if (!current_frame_has_speech &&
            speech_gate.silence_ms() > options.max_decode_silence_ms) continue;

        window = audio_tail(retained.utterance(), options.length_ms);
        if (window.empty()) continue;

        const auto decode_started = std::chrono::steady_clock::now();
        const auto result = decode_audio(window, false);
        const bool accepted = accept_result(result, options);
        print_hypothesis(accepted ? result.text : "", current_frame_has_speech);
        if (accepted) last_preview_text = result.text;

        if (options.diagnostics) {
            const auto latency_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - decode_started).count();
            std::fprintf(stderr,
                "vocal-stream: diagnostic {\"event\":\"decode\",\"scope\":\"rolling\","
                "\"vad_probability\":%.4f,\"no_speech_probability\":%.4f,"
                "\"avg_logprob\":%.4f,\"tokens\":%d,\"action\":\"%s\","
                "\"latency_ms\":%lld,\"audio_ms\":%lld,\"retained_utterance_ms\":%lld,"
                "\"text\":%s}\n",
                latest_vad_probability,
                result.no_speech_probability,
                result.avg_logprob,
                result.text_tokens,
                accepted ? "hypothesis" : "discarded",
                static_cast<long long>(latency_ms),
                static_cast<long long>(window.size() * 1000 / sample_rate),
                static_cast<long long>(retained.utterance().size() * 1000 / sample_rate),
                json_string(accepted ? result.text : "").c_str());
        }

        if (options.keep_context) {
            prompt_tokens.clear();
            for (int segment = 0; segment < whisper_full_n_segments(context); ++segment) {
                for (int token = 0; token < whisper_full_n_tokens(context, segment); ++token) {
                    prompt_tokens.push_back(whisper_full_get_token_id(context, segment, token));
                }
            }
        }
    }

    if (speech_gate.active() && !retained.utterance().empty()) {
        finalize_utterance();
    } else {
        std::printf("\n");
    }
    whisper_vad_free(vad);
    whisper_free(context);
    return 0;
}
