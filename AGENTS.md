`vocal-lib` is a local-first TypeScript library and IPC gateway for native
`whisper.cpp` transcription. Keep it service-first: consumer UX and terminal
rendering belong in projects like `../vocal-cli`; `vocal-gateway` is only a thin
IPC server executable.

Boundaries: `engine/` owns native process/transcript parsing, `service/` owns
config/lifecycle/diagnostics/events, `ipc/` owns protocol/transport/client
behavior, `bin/` owns entry points, and `index.ts` is the public API.

Prioritize real-time local transcription, Vulkan-first AMD RX 6700 XT support
with CPU fallback, JSON-compatible IPC events, and optional fail-open OpenRouter
polishing. Do not add Python/cloud transcription paths or implement Whisper
inference in TypeScript.

Do not edit or add code under `vendor/`; treat it as third-party source and
limit work there to inspection only.

Keep detailed implementation guidance in `.prompts/`. Usual checks:
`pnpm typecheck` and `pnpm build`.
