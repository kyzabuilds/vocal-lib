import { parseBackend, resolveWhisperBinary, spawnWhisper } from "../engine/whisper-process.js";
import type { Backend, WhisperStreamOptions } from "../engine/types.js";
import { formatBackendHint, validateSelectedModelPath } from "./utils.js";

export interface ListenOptions {
  audioCtx?: string;
  beamSize?: string;
  capture?: string;
  fallback?: boolean;
  freqThreshold?: string;
  keep?: string;
  keepContext?: boolean;
  language?: string;
  length?: string;
  maxTokens?: string;
  model?: string;
  backend: string;
  printSpecial?: boolean;
  saveAudio?: boolean;
  step?: string;
  threads?: string;
  tinydiarize?: boolean;
  translate?: boolean;
  vadThreshold?: string;
}

export async function listenCommand(options: ListenOptions): Promise<void> {
  const backend = parseBackend(options.backend);
  const modelPath = await validateModelOption(options.model);
  const stream = parseStreamOptions(options);
  const binary = await resolveWhisperBinary("stream");

  if (!binary.found) {
    throw new Error(
      [
        "Live transcription requires the whisper-stream binary, but it was not found.",
        `Set ${binary.envVar}, place whisper-stream in ./bin, or build the whisper.cpp stream example under vendor/whisper.cpp.`,
        "Checked:",
        ...binary.checked.map((candidate) => `  - ${candidate.path}`),
      ].join("\n"),
    );
  }

  printBackendHint(backend);
  console.error("Listening to microphone input. Press Ctrl+C to stop.");

  const result = await spawnWhisper({
    binaryPath: binary.found.path,
    modelPath,
    backend,
    mode: "stream",
    stream,
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
  const hint = formatBackendHint(backend, "whisper-stream");
  if (hint) {
    console.error(hint);
  }
}

function parseStreamOptions(options: ListenOptions): WhisperStreamOptions {
  return {
    audioContext: parseOptionalInteger(options.audioCtx, "audio context", { min: 0 }),
    beamSize: parseOptionalInteger(options.beamSize, "beam size", { min: 1 }),
    capture: parseOptionalInteger(options.capture, "capture device", { min: -1 }),
    freqThreshold: parseOptionalNumber(options.freqThreshold, "frequency threshold"),
    keep: parseOptionalInteger(options.keep, "keep", { min: 0 }),
    keepContext: options.keepContext,
    language: options.language,
    length: parseOptionalInteger(options.length, "length", { min: 1 }),
    maxTokens: parseOptionalInteger(options.maxTokens, "max tokens", { min: 1 }),
    noFallback: options.fallback === false,
    printSpecial: options.printSpecial,
    saveAudio: options.saveAudio,
    step: parseOptionalInteger(options.step, "step", { min: 0 }),
    threads: parseOptionalInteger(options.threads, "threads", { min: 1 }),
    tinydiarize: options.tinydiarize,
    translate: options.translate,
    vadThreshold: parseOptionalNumber(options.vadThreshold, "VAD threshold"),
  };
}

function parseOptionalInteger(
  value: string | undefined,
  label: string,
  range: { min?: number; max?: number } = {},
): number | undefined {
  const parsed = parseOptionalNumber(value, label);
  if (parsed === undefined) {
    return undefined;
  }

  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${label} "${value}". Expected an integer.`);
  }

  assertInRange(parsed, label, value, range);
  return parsed;
}

function parseOptionalNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid ${label} "${value}". Expected a number.`);
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${label} "${value}". Expected a number.`);
  }

  return parsed;
}

function assertInRange(value: number, label: string, raw: string | undefined, range: { min?: number; max?: number }): void {
  if (range.min !== undefined && value < range.min) {
    throw new Error(`Invalid ${label} "${raw}". Expected a value greater than or equal to ${range.min}.`);
  }

  if (range.max !== undefined && value > range.max) {
    throw new Error(`Invalid ${label} "${raw}". Expected a value less than or equal to ${range.max}.`);
  }
}
