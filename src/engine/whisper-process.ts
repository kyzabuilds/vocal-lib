import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { appPaths } from "../config/paths.js";
import { TranscriptStreamFilter } from "./transcript-parser.js";
import type {
  Backend,
  BinaryCandidate,
  BinaryResolution,
  SpawnWhisperOptions,
  SpawnWhisperResult,
  WhisperBinaryKind,
} from "./types.js";

const modelExtensions = new Set([".bin", ".gguf"]);

const binaryNames: Record<WhisperBinaryKind, string[]> = {
  cli: ["whisper-cli", "main"],
  stream: ["whisper-stream", "stream"],
};

const envVars: Record<WhisperBinaryKind, string> = {
  cli: "VOCAL_WHISPER_CLI",
  stream: "VOCAL_WHISPER_STREAM",
};

const backendArgs: Record<Backend, string[]> = {
  auto: [],
  cpu: ["-ng"],
  vulkan: [],
  hip: [],
};

const streamFlushDelayMs = 1200;
const clearCurrentLine = "\x1b[2K\r";

export function parseBackend(value: string): Backend {
  if (value === "auto" || value === "cpu" || value === "vulkan" || value === "hip") {
    return value;
  }

  throw new Error(`Invalid backend "${value}". Expected one of: auto, cpu, vulkan, hip.`);
}

export function supportedModelExtensions(): string[] {
  return [...modelExtensions].sort();
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const file = await stat(path);
    if (!file.isFile()) {
      return false;
    }

    if (process.platform === "win32") {
      return true;
    }

    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isReadableFile(path: string): Promise<boolean> {
  try {
    const file = await stat(path);
    return file.isFile();
  } catch {
    return false;
  }
}

export function resolveUserPath(path: string): string {
  if (path.startsWith("~/")) {
    return resolve(process.env.HOME ?? process.cwd(), path.slice(2));
  }

  return resolve(process.cwd(), path);
}

export function candidateLabel(candidate: BinaryCandidate): string {
  return `${candidate.path} (${candidate.source})`;
}

export function getBinaryCandidates(kind: WhisperBinaryKind): BinaryCandidate[] {
  const envVar = envVars[kind];
  const envValue = process.env[envVar];
  const names = binaryNames[kind];
  const candidates: BinaryCandidate[] = [];

  if (envValue && envValue.trim().length > 0) {
    candidates.push({
      path: resolveUserPath(envValue.trim()),
      source: "environment",
    });
  }

  for (const name of names) {
    candidates.push({
      path: join(appPaths.binDir, withPlatformExtension(name)),
      source: "local-bin",
    });
  }

  const vendorBinDirs = [
    join(appPaths.whisperCppDir, "build", "bin"),
    join(appPaths.whisperCppDir, "build", "src"),
    join(appPaths.whisperCppDir, "build", "examples", kind === "cli" ? "cli" : "stream"),
    join(appPaths.whisperCppDir, "build", "examples", kind === "cli" ? "main" : "stream"),
    join(appPaths.whisperCppDir, "build", "bin", "Release"),
    join(appPaths.whisperCppDir, "build", "Release"),
  ];

  for (const binDir of vendorBinDirs) {
    for (const name of names) {
      candidates.push({
        path: join(binDir, withPlatformExtension(name)),
        source: "vendor",
      });
    }
  }

  return dedupeCandidates(candidates);
}

export async function resolveWhisperBinary(kind: WhisperBinaryKind): Promise<BinaryResolution> {
  const checked = getBinaryCandidates(kind);
  for (const candidate of checked) {
    if (await isExecutableFile(candidate.path)) {
      return {
        kind,
        found: candidate,
        checked,
        envVar: envVars[kind],
      };
    }
  }

  return {
    kind,
    found: null,
    checked,
    envVar: envVars[kind],
  };
}

export async function validateInputPath(inputPath: string): Promise<string> {
  const resolved = resolveUserPath(inputPath);
  if (!(await isReadableFile(resolved))) {
    throw new Error(`Input file not found or not readable: ${resolved}`);
  }

  return resolved;
}

export async function validateModelPath(modelPath: string): Promise<string> {
  const resolved = resolveUserPath(modelPath);
  if (!(await isReadableFile(resolved))) {
    throw new Error(`Model file not found or not readable: ${resolved}`);
  }

  const extension = extname(resolved).toLowerCase();
  if (!modelExtensions.has(extension)) {
    throw new Error(
      `Model file extension "${extension || basename(resolved)}" is not recognized. Expected one of: ${supportedModelExtensions().join(", ")}.`,
    );
  }

  return resolved;
}

export async function spawnWhisper(options: SpawnWhisperOptions): Promise<SpawnWhisperResult> {
  const args = buildWhisperArgs(options);

  return await new Promise<SpawnWhisperResult>((resolvePromise, reject) => {
    const child = spawn(options.binaryPath, args, {
      stdio: options.mode === "stream" ? ["inherit", "pipe", "inherit"] : "inherit",
      cwd: dirname(options.binaryPath),
    });
    const stopChild = (): void => {
      if (!child.killed) {
        child.kill("SIGINT");
      }
    };

    if (options.signal?.aborted) {
      stopChild();
    } else {
      options.signal?.addEventListener("abort", stopChild, { once: true });
    }

    if (options.mode === "stream") {
      const stdout = child.stdout;
      const transcriptFilter = new TranscriptStreamFilter();
      let previewText = "";
      let flushTimer: NodeJS.Timeout | undefined;
      const writeFinal = options.onTranscriptFinal ?? ((event: { text: string }): void => {
        process.stdout.write(`${previewText ? clearCurrentLine : ""}${event.text}\n`);
        previewText = "";
      });
      const writePreview = options.onTranscriptPreview ?? ((event: { text: string }): void => {
        if (event.text === previewText) {
          return;
        }

        previewText = event.text;
        process.stdout.write(`${clearCurrentLine}${event.text}`);
      });
      const flushPending = (): void => {
        flushTimer = undefined;
        const event = transcriptFilter.flush();
        if (event) {
          writeFinal(event);
        }
      };
      const scheduleFlush = (): void => {
        if (flushTimer) {
          clearTimeout(flushTimer);
        }

        if (transcriptFilter.hasPending()) {
          flushTimer = setTimeout(flushPending, streamFlushDelayMs);
        }
      };

      stdout?.setEncoding("utf8");
      stdout?.on("data", (chunk: string) => {
        const update = transcriptFilter.write(chunk);
        for (const final of update.finals) {
          writeFinal(final);
        }

        if (update.preview) {
          writePreview(update.preview);
        }

        scheduleFlush();
      });

      child.on("close", () => {
        if (flushTimer) {
          clearTimeout(flushTimer);
        }

        flushPending();
      });
    }

    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      options.signal?.removeEventListener("abort", stopChild);
      resolvePromise({ exitCode, signal });
    });
  });
}

function buildWhisperArgs(options: SpawnWhisperOptions): string[] {
  const args = ["-m", options.modelPath, ...backendArgs[options.backend]];

  if (options.mode === "cli") {
    if (!options.inputPath) {
      throw new Error("Transcription requires an input file path.");
    }

    args.push("-f", options.inputPath);
  } else {
    appendStreamArgs(args, options.stream);
  }

  return args;
}

function appendStreamArgs(args: string[], stream = {} as NonNullable<SpawnWhisperOptions["stream"]>): void {
  pushNumberArg(args, "--step", stream.step);
  pushNumberArg(args, "--length", stream.length);
  pushNumberArg(args, "--keep", stream.keep);
  pushNumberArg(args, "--capture", stream.capture);
  pushNumberArg(args, "--threads", stream.threads);
  pushNumberArg(args, "--max-tokens", stream.maxTokens);
  pushNumberArg(args, "--audio-ctx", stream.audioContext);
  pushNumberArg(args, "--beam-size", stream.beamSize);
  pushNumberArg(args, "--vad-thold", stream.vadThreshold);
  pushNumberArg(args, "--freq-thold", stream.freqThreshold);

  if (stream.language) {
    args.push("--language", stream.language);
  }

  if (stream.translate) {
    args.push("--translate");
  }

  if (stream.noFallback) {
    args.push("--no-fallback");
  }

  if (stream.printSpecial) {
    args.push("--print-special");
  }

  if (stream.keepContext) {
    args.push("--keep-context");
  }

  if (stream.tinydiarize) {
    args.push("--tinydiarize");
  }

  if (stream.saveAudio) {
    args.push("--save-audio");
  }
}

function pushNumberArg(args: string[], flag: string, value: number | undefined): void {
  if (value !== undefined) {
    args.push(flag, String(value));
  }
}

function withPlatformExtension(name: string): string {
  if (process.platform === "win32" && !name.endsWith(".exe")) {
    return `${name}.exe`;
  }

  return name;
}

function dedupeCandidates(candidates: BinaryCandidate[]): BinaryCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) {
      return false;
    }

    seen.add(candidate.path);
    return true;
  });
}
