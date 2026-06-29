import { parseBackend, resolveWhisperBinary, spawnWhisper } from "../engine/whisper-process.js";
import { TranscriptPolisher } from "../engine/transcript-polisher.js";
import type { Backend, WhisperStreamOptions } from "../engine/types.js";
import { readOpenRouterConfig } from "../llm/openrouter.js";
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
  lowLatency?: boolean;
  maxTokens?: string;
  model?: string;
  polish?: boolean;
  polishModel?: string;
  backend: string;
  printSpecial?: boolean;
  saveAudio?: boolean;
  step?: string;
  threads?: string;
  tinydiarize?: boolean;
  translate?: boolean;
  vadThreshold?: string;
}

interface StreamPreset {
  beamSize: number;
  keep: number;
  language: string;
  length: number;
  maxTokens?: number;
  step: number;
}

const defaultStreamPreset: StreamPreset = {
  beamSize: 6,
  keep: 300,
  language: "en",
  length: 5000,
  step: 1000,
};

const lowLatencyStreamPreset: StreamPreset = {
  beamSize: 1,
  keep: 150,
  language: "en",
  length: 1200,
  maxTokens: 16,
  step: 150,
};

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

  const binaryPath = binary.found.path;
  printBackendHint(backend);
  if (options.lowLatency) {
    console.error("Low-latency live words enabled. Explicit stream timing flags override the preset.");
  }
  if (options.polish) {
    console.error("Transcript polishing enabled. Raw local transcript will print immediately; press Esc to polish the current transcript.");
  }
  console.error("Listening to microphone input. Press Ctrl+C to stop.");

  const stopController = new AbortController();
  const output = options.polish ? createPolishedStreamOutput(options.polishModel, () => stopController.abort()) : undefined;
  const result = await (async () => {
    try {
      return await spawnWhisper({
        binaryPath,
        modelPath,
        backend,
        mode: "stream",
        stream,
        onTranscriptFinal: output?.writeFinal,
        onTranscriptPreview: output?.writePreview,
        signal: stopController.signal,
      });
    } finally {
      await output?.waitForPendingPolish();
      output?.dispose();
    }
  })();

  if (result.signal) {
    process.exitCode = stopController.signal.aborted ? 0 : 1;
    if (!stopController.signal.aborted) {
      console.error(`whisper.cpp exited from signal ${result.signal}`);
    }
    return;
  }

  process.exitCode = result.exitCode ?? 1;
}

function createPolishedStreamOutput(model: string | undefined, requestStop: () => void): {
  dispose: () => void;
  waitForPendingPolish: () => Promise<void>;
  writeFinal: (event: { text: string }) => void;
  writePreview: (event: { text: string }) => void;
} {
  const clearCurrentLine = "\x1b[2K\r";
  let previewText = "";
  let lastPolishedInput = "";
  let pendingPolish: Promise<void> = Promise.resolve();
  let stopped = false;
  const transcriptChunks: string[] = [];
  const modelOverride = model?.trim();
  const config = { ...readOpenRouterConfig(), ...(modelOverride ? { model: modelOverride } : {}) };
  const polisher = new TranscriptPolisher({
    config,
    onPolished: (event) => {
      const activePreview = previewText;
      process.stdout.write(`${activePreview ? clearCurrentLine : ""}polished: ${event.text}\n`);
      if (activePreview && !stopped) {
        process.stdout.write(activePreview);
      }
    },
    onWarning: (message) => console.error(message),
  });
  const detachEscapeHandler = attachEscapeHandler(() => {
    if (stopped) {
      return;
    }

    stopped = true;
    const input = buildPolishInput(transcriptChunks, previewText);
    if (!input || input === lastPolishedInput) {
      requestStop();
      return;
    }

    lastPolishedInput = input;
    if (previewText) {
      process.stdout.write("\n");
    }
    previewText = "";
    console.error("Polishing transcript with OpenRouter...");
    pendingPolish = polisher.polish(input);
    requestStop();
  });

  return {
    dispose: () => {
      detachEscapeHandler();
      polisher.dispose();
    },
    waitForPendingPolish: () => pendingPolish,
    writeFinal: (event) => {
      if (stopped) {
        transcriptChunks.push(event.text);
        return;
      }

      process.stdout.write(`${previewText ? clearCurrentLine : ""}${event.text}\n`);
      previewText = "";
      transcriptChunks.push(event.text);
    },
    writePreview: (event) => {
      if (stopped) {
        return;
      }

      if (event.text === previewText) {
        return;
      }

      previewText = event.text;
      process.stdout.write(`${clearCurrentLine}${event.text}`);
    },
  };
}

function attachEscapeHandler(onEscape: () => void): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    console.error("Esc-to-polish is only available from an interactive terminal.");
    return () => undefined;
  }

  const wasRaw = stdin.isRaw;
  const wasPaused = stdin.isPaused();
  const onData = (chunk: Buffer): void => {
    const value = chunk.toString("utf8");
    if (value === "\x1b") {
      onEscape();
      return;
    }

    if (value === "\x03") {
      process.kill(process.pid, "SIGINT");
    }
  };

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onData);

  return () => {
    stdin.off("data", onData);
    stdin.setRawMode(wasRaw);
    if (wasPaused) {
      stdin.pause();
    }
  };
}

function buildPolishInput(chunks: string[], previewText: string): string {
  const text = chunks.filter((chunk) => chunk.trim().length > 0).join(" ").replace(/\s+/g, " ").trim();
  const preview = previewText.trim();
  if (!preview) {
    return text;
  }

  if (!text) {
    return preview;
  }

  if (text.endsWith(preview)) {
    return text;
  }

  return `${text} ${preview}`.replace(/\s+/g, " ").trim();
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
  const preset = options.lowLatency ? lowLatencyStreamPreset : defaultStreamPreset;

  return {
    audioContext: parseOptionalInteger(options.audioCtx, "audio context", { min: 0 }),
    beamSize: parseOptionalInteger(options.beamSize, "beam size", { min: 1 }) ?? preset.beamSize,
    capture: parseOptionalInteger(options.capture, "capture device", { min: -1 }),
    freqThreshold: parseOptionalNumber(options.freqThreshold, "frequency threshold"),
    keep: parseOptionalInteger(options.keep, "keep", { min: 0 }) ?? preset.keep,
    keepContext: options.keepContext,
    language: options.language ?? preset.language,
    length: parseOptionalInteger(options.length, "length", { min: 1 }) ?? preset.length,
    maxTokens: parseOptionalInteger(options.maxTokens, "max tokens", { min: 1 }) ?? preset.maxTokens,
    noFallback: options.fallback === false,
    printSpecial: options.printSpecial,
    saveAudio: options.saveAudio,
    step: parseOptionalInteger(options.step, "step", { min: 0 }) ?? preset.step,
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
