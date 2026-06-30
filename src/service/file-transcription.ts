import {
  resolveConfiguredWhisperBinary,
  validateInputPath,
  spawnWhisper,
} from "../engine/whisper-process.js";
import { TranscriptPolisher } from "../engine/transcript-polisher.js";
import type { ResolvedVocalConfig } from "./config.js";
import { whisperPathConfig } from "./config.js";
import type { FileTranscriptionOptions, FileTranscriptionResult } from "./events.js";
import { resolveModelPath } from "./models.js";

export async function transcribeFile(
  config: ResolvedVocalConfig,
  options: FileTranscriptionOptions,
): Promise<FileTranscriptionResult> {
  if (config.mock) {
    const text = `Mock transcription for ${options.filePath}`;
    return polishResult(config, options, { text, raw: text, stderr: "", exitCode: 0, signal: null });
  }

  const inputPath = await validateInputPath(options.filePath);
  const modelPath = await resolveModelPath(config, options.modelPath);
  const binary = await resolveConfiguredWhisperBinary("cli", whisperPathConfig(config));
  if (!binary.found) {
    throw new Error(
      [
        "whisper.cpp file transcription binary not found.",
        `Set ${binary.envVar}, configure whisperCliPath, or place whisper-cli in ${config.paths.binDir}.`,
        "Checked:",
        ...binary.checked.map((candidate) => `  - ${candidate.path}`),
      ].join("\n"),
    );
  }

  let stdout = "";
  let stderr = "";
  const result = await spawnWhisper({
    backend: options.backend ?? config.defaultBackend,
    binaryPath: binary.found.path,
    carryInitialPrompt: options.carryInitialPrompt,
    initialPrompt: options.initialPrompt ?? options.prompt,
    inputPath,
    mode: "cli",
    modelPath,
    onStderr: (chunk) => {
      stderr += chunk;
    },
    onStdout: (chunk) => {
      stdout += chunk;
    },
  });

  return polishResult(config, options, {
    text: normalizeTranscript(stdout),
    raw: stdout,
    stderr,
    exitCode: result.exitCode,
    signal: result.signal,
  });
}

async function polishResult(
  config: ResolvedVocalConfig,
  options: FileTranscriptionOptions,
  result: FileTranscriptionResult,
): Promise<FileTranscriptionResult> {
  if (!options.polish?.enabled || !result.text) {
    return result;
  }

  const warnings: string[] = [];
  let polished: NonNullable<FileTranscriptionResult["polished"]> | undefined;
  const polisher = new TranscriptPolisher({
    config: {
      ...config.openRouter,
      ...(options.polish.model ? { model: options.polish.model } : {}),
    },
    onPolished: (event) => {
      polished = event;
    },
    onWarning: (message) => warnings.push(message),
  });

  try {
    await polisher.polish(result.text);
  } finally {
    polisher.dispose();
  }

  return {
    ...result,
    ...(polished ? { polished } : {}),
    stderr: joinStderr(result.stderr, warnings.join("\n")),
  };
}

function normalizeTranscript(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\[\d{2}:\d{2}:\d{2}(?:[.,]\d{3})?\s+-->\s+\d{2}:\d{2}:\d{2}(?:[.,]\d{3})?\]\s*/, "")
        .trim(),
    )
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function joinStderr(...parts: string[]): string {
  return parts.filter((part) => part.trim().length > 0).join("\n");
}
