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
  WhisperBinaryCapabilities,
  WhisperDecoderPrompt,
  WhisperDecoderPromptInput,
  WhisperPathConfig,
  WhisperBinaryKind,
} from "./types.js";

const modelExtensions = new Set([".bin", ".gguf"]);

const binaryNames: Record<WhisperBinaryKind, string[]> = {
  cli: ["whisper-cli", "main"],
  stream: ["vocal-stream", "whisper-stream", "stream"],
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
const binaryCapabilityCache = new Map<string, Promise<WhisperBinaryCapabilities>>();

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

export function getBinaryCandidates(kind: WhisperBinaryKind, paths: WhisperPathConfig = {}): BinaryCandidate[] {
  const envVar = envVars[kind];
  const envValue = process.env[envVar];
  const names = binaryNames[kind];
  const candidates: BinaryCandidate[] = [];
  const explicitPath = kind === "cli" ? paths.whisperCliPath : paths.whisperStreamPath;

  if (explicitPath && explicitPath.trim().length > 0) {
    candidates.push({
      path: resolveUserPath(explicitPath.trim()),
      source: "configuration",
    });
  }

  if (envValue && envValue.trim().length > 0) {
    candidates.push({
      path: resolveUserPath(envValue.trim()),
      source: "environment",
    });
  }

  for (const name of names) {
    candidates.push({
      path: join(paths.binDir ?? appPaths.binDir, withPlatformExtension(name)),
      source: "local-bin",
    });
  }

  const whisperCppDir = paths.whisperCppDir ?? appPaths.whisperCppDir;
  const vendorBinDirs = [
    join(whisperCppDir, "build", "bin"),
    join(whisperCppDir, "build", "src"),
    join(whisperCppDir, "build", "examples", kind === "cli" ? "cli" : "stream"),
    join(whisperCppDir, "build", "examples", kind === "cli" ? "main" : "stream"),
    join(whisperCppDir, "build", "bin", "Release"),
    join(whisperCppDir, "build", "Release"),
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
  return resolveWhisperBinaryFromCandidates(kind, checked);
}

export async function resolveConfiguredWhisperBinary(
  kind: WhisperBinaryKind,
  paths: WhisperPathConfig = {},
): Promise<BinaryResolution> {
  const checked = getBinaryCandidates(kind, paths);
  return resolveWhisperBinaryFromCandidates(kind, checked);
}

async function resolveWhisperBinaryFromCandidates(
  kind: WhisperBinaryKind,
  checked: BinaryCandidate[],
): Promise<BinaryResolution> {
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

export async function detectWhisperBinaryCapabilities(binaryPath: string): Promise<WhisperBinaryCapabilities> {
  const cached = binaryCapabilityCache.get(binaryPath);
  if (cached) {
    return cached;
  }

  const probe = readWhisperHelp(binaryPath).then((help) => ({
    carryInitialPrompt: hasHelpFlag(help, "--carry-initial-prompt"),
    prompt: hasHelpFlag(help, "--prompt"),
    vadModel: hasHelpFlag(help, "--vad-model"),
  }));

  binaryCapabilityCache.set(binaryPath, probe);
  return probe;
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

async function readWhisperHelp(binaryPath: string): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(binaryPath, ["--help"], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: dirname(binaryPath),
    });
    let output = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      output += chunk;
    });

    child.on("error", reject);
    child.on("close", () => resolvePromise(output));
  });
}

function hasHelpFlag(help: string, flag: string): boolean {
  return new RegExp(`(^|\\s)${escapeRegExp(flag)}(\\s|,|$)`).test(help);
}

export async function spawnWhisper(options: SpawnWhisperOptions): Promise<SpawnWhisperResult> {
  const args = buildWhisperArgs(options);

  return await new Promise<SpawnWhisperResult>((resolvePromise, reject) => {
    const child = spawn(options.binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
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
      const transcriptFilter = new TranscriptStreamFilter({
        onDecision: options.stream?.diagnostics
          ? (decision) => options.onStderr?.(`vocal-stream: agreement ${JSON.stringify(decision)}\n`)
          : undefined,
        trailingSilencePhrases: options.stream?.hallucinationGuardPhrases,
      });
      let flushTimer: NodeJS.Timeout | undefined;
      const writeFinal = options.onTranscriptFinal ?? (() => undefined);
      const writePreview = options.onTranscriptPreview ?? (() => undefined);
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
        options.onStdout?.(chunk);
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
    } else {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        options.onStdout?.(chunk);
      });
    }

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      options.onStderr?.(chunk);
    });

    child.on("error", (error) => {
      options.onError?.(error);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      options.signal?.removeEventListener("abort", stopChild);
      const result = { exitCode, signal };
      options.onProcessExit?.(result);
      resolvePromise(result);
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
    appendDecoderArgs(args, options);
    pushInitialPromptArgs(args, options.initialPrompt, options.carryInitialPrompt);
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
  pushNumberArg(args, "--no-speech-thold", stream.noSpeechThreshold);
  pushNumberArg(args, "--logprob-thold", stream.logprobThreshold);
  pushNumberArg(args, "--min-speech-ms", stream.minSpeechMs);
  pushNumberArg(args, "--silence-hangover-ms", stream.silenceHangoverMs);
  pushNumberArg(args, "--max-decode-silence-ms", stream.maxDecodeSilenceMs);
  pushStringArg(args, "--vad-model", stream.vadModelPath);
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

  if (stream.diagnostics) {
    args.push("--diagnostics");
  }

  pushInitialPromptArgs(args, stream.initialPrompt, stream.carryInitialPrompt);
}

function appendDecoderArgs(args: string[], options: SpawnWhisperOptions): void {
  pushNumberArg(args, "--entropy-thold", options.entropyThreshold);
  pushNumberArg(args, "--logprob-thold", options.logprobThreshold);
  pushNumberArg(args, "--no-speech-thold", options.noSpeechThreshold);

  if (options.noFallback) {
    args.push("--no-fallback");
  }

  if (options.suppressNonSpeechTokens) {
    args.push("--suppress-nst");
  }
}

function pushInitialPromptArgs(
  args: string[],
  initialPrompt: WhisperDecoderPromptInput | undefined,
  carryInitialPrompt: boolean | undefined,
): void {
  const prompt = formatDecoderPrompt(initialPrompt);
  if (prompt) {
    args.push("--prompt", prompt);
  }

  if (carryInitialPrompt) {
    args.push("--carry-initial-prompt");
  }
}

export function formatDecoderPrompt(prompt: WhisperDecoderPromptInput | undefined): string | undefined {
  if (typeof prompt === "string") {
    return cleanPromptPart(prompt);
  }

  if (!prompt) {
    return undefined;
  }

  const parts = [
    cleanPromptPart(prompt.text),
    listPromptPart("Common vocabulary", prompt.vocabulary),
    listPromptPart("Common phrases", prompt.phrases),
    listPromptPart("Expected punctuation", prompt.punctuation),
    listPromptPart("Formatting", prompt.formatting),
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join("\n") : undefined;
}

function listPromptPart(label: string, values: WhisperDecoderPrompt[keyof WhisperDecoderPrompt]): string | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }

  const cleaned = values.map(cleanPromptPart).filter((value): value is string => Boolean(value));
  return cleaned.length > 0 ? `${label}: ${cleaned.join(", ")}` : undefined;
}

function cleanPromptPart(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}

function pushNumberArg(args: string[], flag: string, value: number | undefined): void {
  if (value !== undefined) {
    args.push(flag, String(value));
  }
}

function pushStringArg(args: string[], flag: string, value: string | undefined): void {
  if (value) {
    args.push(flag, value);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
