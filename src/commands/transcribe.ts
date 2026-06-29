import { resolveWhisperBinary, parseBackend, validateInputPath, spawnWhisper } from "../engine/whisper-process.js";
import type { Backend } from "../engine/types.js";
import { formatBackendHint, validateSelectedModelPath } from "./utils.js";

export interface TranscribeOptions {
  model?: string;
  backend: string;
}

export async function transcribeCommand(input: string, options: TranscribeOptions): Promise<void> {
  const backend = parseBackend(options.backend);
  const inputPath = await validateInputPath(input);
  const modelPath = await validateModelOption(options.model);
  const binary = await resolveWhisperBinary("cli");

  if (!binary.found) {
    throw new Error(
      [
        "whisper.cpp file transcription binary not found.",
        `Set ${binary.envVar}, place whisper-cli in ./bin, or build vendor/whisper.cpp.`,
        "Checked:",
        ...binary.checked.map((candidate) => `  - ${candidate.path}`),
      ].join("\n"),
    );
  }

  printBackendHint(backend);

  const result = await spawnWhisper({
    binaryPath: binary.found.path,
    inputPath,
    modelPath,
    backend,
    mode: "cli",
  });

  if (result.signal) {
    process.exitCode = 1;
    console.error(`whisper.cpp exited from signal ${result.signal}`);
    return;
  }

  process.exitCode = result.exitCode ?? 1;
}

async function validateModelOption(model: string | undefined): Promise<string> {
  return validateSelectedModelPath(model);
}

function printBackendHint(backend: Backend): void {
  const hint = formatBackendHint(backend, "the selected whisper.cpp binary");
  if (hint) {
    console.error(hint);
  }
}
