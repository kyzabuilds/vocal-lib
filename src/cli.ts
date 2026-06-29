#!/usr/bin/env node
import { Command } from "commander";
import { doctorCommand } from "./commands/doctor.js";
import { listenCommand, type ListenOptions } from "./commands/listen.js";
import { modelsCommand } from "./commands/models.js";
import { transcribeCommand } from "./commands/transcribe.js";

const program = new Command();

program
  .name("vocal")
  .description("Local-first live microphone transcription powered by whisper.cpp.")
  .version("0.1.0")
  .showHelpAfterError();

program
  .command("doctor")
  .description("Inspect local Vocal, whisper.cpp, model, audio, and GPU prerequisites.")
  .action(run(doctorCommand));

program
  .command("models")
  .description("List local whisper.cpp models and recommended starter models.")
  .action(run(modelsCommand));

program
  .command("transcribe")
  .description("Transcribe an audio file with a local whisper.cpp binary.")
  .argument("<file>", "Audio file to transcribe.")
  .option("-m, --model <path>", "Path to a whisper.cpp .bin or .gguf model.")
  .option("-b, --backend <backend>", "Backend preference: auto, cpu, vulkan, or hip.", "auto")
  .action((file: string, options: Command | { model?: string; backend: string }) =>
    run(() => transcribeCommand(file, readOptions<{ model?: string; backend: string }>(options)))(),
  );

addListenOptions(
  program
    .command("listen")
    .description("Start live microphone transcription with whisper-stream."),
).action((options: Command | ListenOptions) => run(() => listenCommand(readOptions<ListenOptions>(options)))());

program.parseAsync(normalizeArgv(process.argv)).catch((error: unknown) => {
  process.exitCode = 1;
  console.error(formatError(error));
});

function run(action: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await action();
    } catch (error) {
      process.exitCode = 1;
      console.error(formatError(error));
    }
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function addListenOptions(command: Command): Command {
  return command
    .option("-m, --model <path>", "Path to a whisper.cpp .bin or .gguf model.")
    .option("-b, --backend <backend>", "Backend preference: auto, cpu, vulkan, or hip.", "auto")
    .option("-c, --capture <id>", "Capture device ID for whisper-stream. Use -1 for the default device.")
    .option("-l, --language <code>", "Spoken language code, or auto. Defaults to en.")
    .option("-t, --threads <count>", "Number of CPU threads used by whisper.cpp.")
    .option("--low-latency", "Use a fast live-words preset for small models: --step 150 --length 1200 --keep 150 --beam-size 1 --max-tokens 16.")
    .option("--step <ms>", "Audio step size in milliseconds. Use 0 for whisper-stream VAD mode. Defaults to 1000, or 150 with --low-latency.")
    .option("--length <ms>", "Audio window length in milliseconds. Ignored in VAD mode (--step 0). Defaults to 5000, or 1200 with --low-latency.")
    .option("--keep <ms>", "Audio from the previous step to keep in milliseconds. Defaults to 300, or 150 with --low-latency.")
    .option("--max-tokens <count>", "Maximum tokens per audio chunk.")
    .option("--audio-ctx <count>", "Audio context size, where 0 means all.")
    .option("--beam-size <count>", "Beam size for beam search. Defaults to 6, or 1 with --low-latency.")
    .option("--vad-threshold <value>", "Voice activity detection threshold for --step 0 mode.")
    .option("--freq-threshold <value>", "High-pass frequency cutoff.")
    .option("--translate", "Translate the source language to English.")
    .option("--no-fallback", "Disable temperature fallback while decoding.")
    .option("--print-special", "Print special tokens.")
    .option("--keep-context", "Keep prompt context between audio chunks.")
    .option("--tinydiarize", "Enable tinydiarize for compatible models.")
    .option("--save-audio", "Save recorded microphone audio beside whisper-stream.")
    .option("--polish", "Send committed transcript chunks to OpenRouter for optional text polishing.")
    .option("--polish-model <slug>", "OpenRouter model slug for --polish. Defaults to VOCAL_OPENROUTER_MODEL or google/gemini-2.5-flash-lite.");
}

function readOptions<T>(value: Command | T): T {
  if (value instanceof Command) {
    return value.opts() as T;
  }

  return value;
}

function normalizeArgv(argv: string[]): string[] {
  const args = argv.slice(2);
  const first = args[0];

  if (first === undefined) {
    return [...argv.slice(0, 2), "listen"];
  }

  if (first === "--help" || first === "-h" || first === "--version" || first === "-V") {
    return argv;
  }

  if (first.startsWith("-")) {
    return [...argv.slice(0, 2), "listen", ...args];
  }

  return argv;
}
