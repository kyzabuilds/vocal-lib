# vocal-lib

`vocal-lib` is a local-first TypeScript service and IPC gateway for native
`whisper.cpp` transcription. It owns engine process management, session
lifecycle, structured events, and gateway/client protocol behavior; consumer UI
belongs in packages such as `vocal-cli` and `vocal.nvim`.

## Defaults

Live transcription defaults to short sliding windows so consumer UIs can show
words while the speaker is still talking:

```ts
{
  backend: "vulkan",
  language: "en",
  beamSize: 1,
  keep: 150,
  length: 1200,
  maxTokens: 16,
  noFallback: true,
  step: 150
}
```

This is a responsive, incremental mode: preview events update as each short
audio window is decoded. With the project-owned driver, each preview represents
the complete provisional utterance even after its beginning leaves the rolling
window. When VAD detects the utterance boundary, the retained full audio is
decoded again without the preview token cap and emitted as one `final` event.
Use `lowLatency: false` to select the stock VAD-gated preset instead.

For silence-resistant low latency, build the project-owned `vocal-stream`
driver. It uses the bundled Silero VAD model to ensure Whisper is never called
for silence-only audio windows:

```sh
cmake -S native -B native/build
cmake --build native/build --target vocal-stream
install -m 755 native/build/vocal-stream bin/vocal-stream
```

`vocal-lib` automatically prefers `bin/vocal-stream`. If it is unavailable,
the service falls back to stock `whisper-stream` in VAD-gated mode rather than
risking silence hallucinations. Set `VOCAL_VAD_MODEL` to replace the bundled
VAD model.

File transcription also defaults to safer decoding with `noFallback: true` and
`suppressNonSpeechTokens: true`.

## Environment

These variables configure the service and gateway without changing consumer
code:

| Variable | Purpose |
| --- | --- |
| `VOCAL_ROOT_DIR` | vocal-lib checkout/package root. |
| `VOCAL_RUNTIME_DIR` | Runtime directory for sockets and process state. |
| `VOCAL_IPC_ENDPOINT` | Explicit IPC endpoint path or URL. |
| `VOCAL_MODEL` | Default `.bin`/`.gguf` model path. |
| `VOCAL_BACKEND` | Default backend: `vulkan`, `cpu`, `auto`, or `hip`. |
| `VOCAL_BIN_DIR` | Directory containing built whisper binaries. |
| `VOCAL_MODELS_DIR` | Directory scanned for local models. |
| `VOCAL_WHISPER_CLI` | Explicit `whisper-cli` path for file transcription. |
| `VOCAL_WHISPER_STREAM` | Explicit `whisper-stream` path for live transcription. |
| `VOCAL_VAD_MODEL` | Silero VAD model for the `vocal-stream` speech gate. |
| `VOCAL_WHISPER_CPP_DIR` | `whisper.cpp` source/build root. |
| `VOCAL_OPENROUTER_API_KEY` | Enables optional transcript polishing. |
| `VOCAL_OPENROUTER_BASE_URL` | OpenRouter-compatible API base URL. |
| `VOCAL_OPENROUTER_MODEL` | Polishing model slug. |

## Live Tuning

Use the defaults first. Override these only when a consumer has a specific
interaction target:

| Option | Default | Use when |
| --- | --- | --- |
| `backend` | `vulkan` | Select AMD/Vulkan, CPU fallback, or auto detection. |
| `modelPath` / `model` | `ggml-large-v3-turbo` when installed | Choose a specific local model file. |
| `language` | `en` | Use another language code or `auto`. |
| `capture` | default device | Select a microphone by device ID. |
| `prompt` | none | Bias vocabulary, punctuation, names, and formatting. |
| `lowLatency` | `true` | Selects responsive sliding-window defaults; set `false` for VAD-gated output. |
| `step` | `150` | `0` is VAD-gated. Positive values enable sliding-window decoding. |
| `length` | `1200` | Audio lookback/window size in milliseconds. |
| `keep` | `150` | Audio retained between sliding windows. |
| `beamSize` | `1` | Increase accuracy or lower it for speed. |
| `maxTokens` | unset | Cap each decoded chunk for faster experiments. |
| `vadThreshold` | whisper default | Tune speech boundary sensitivity. |
| `freqThreshold` | whisper default | Apply high-pass cutoff for noisy inputs. |
| `threads` | whisper default | Tune CPU fallback performance. |
| `noFallback` | `true` | Leave enabled to reduce artifact-prone retries. |
| `polish` | disabled | Enable fail-open OpenRouter cleanup. |
| `visualization.enabled` | `false` | Opt in to normalized live microphone meter events. |
| `visualization.intervalMs` | `33` | Meter interval (33–1000 ms; about 30 Hz by default). |
| `visualization.bands` | `0` | Optional temporal waveform buckets (0–32); zero omits them. |

When enabled with the project-owned `vocal-stream`, live sessions emit typed
`audio` events and IPC `session.audio` envelopes. Payloads contain
`timestamp`, `sequence`, normalized `rms`, `peak`, smoothed `level`, and optional
VAD/speech/band fields. Values are relative full-scale microphone measurements,
not calibrated decibels. Events are best-effort and droppable under transport
backpressure. Stock `whisper-stream` binaries do not expose project capture
samples, so the service warns once and continues without visualization.

### Recommended Configurations

Clean live dictation:

```ts
client.listen({
  backend: "vulkan",
  model: "/home/me/Models/ggml-large-v3-turbo.bin",
  language: "en",
  prompt: "Common vocabulary: project names, people, and technical terms."
});
```

Lower-latency experiments:

```ts
client.listen({
  step: 150,
  length: 1200,
  keep: 150,
  beamSize: 1,
  maxTokens: 16
});
```

This restores the eager sliding-window interaction, but it can reintroduce
no-speech artifacts and repeated partial text.

CPU fallback:

```ts
client.listen({
  backend: "cpu",
  threads: 8,
  beamSize: 3
});
```

Manual polishing after raw insertion:

```ts
client.listen({
  polish: { enabled: true, mode: "manual" }
});
```

## Checks

```sh
pnpm typecheck
pnpm build
```
