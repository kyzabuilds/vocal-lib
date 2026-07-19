import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { TranscriptPolisher } from "../engine/transcript-polisher.js";
import {
  detectWhisperBinaryCapabilities,
  formatDecoderPrompt,
  resolveConfiguredWhisperBinary,
  spawnWhisper,
} from "../engine/whisper-process.js";
import type { SpawnWhisperResult, WhisperStreamOptions } from "../engine/types.js";
import type { ResolvedVocalConfig } from "./config.js";
import { whisperPathConfig } from "./config.js";
import type {
  LiveSessionStatus,
  LiveTranscriptionOptions,
  SessionErrorEvent,
  SessionStatusEvent,
  SessionStoppedEvent,
  SessionWarningEvent,
  TranscriptFinalEvent,
  TranscriptPolishedEvent,
  TranscriptPreviewEvent,
} from "./events.js";
import { resolveModelPath } from "./models.js";

export interface LiveSessionSnapshot {
  metadata?: LiveTranscriptionOptions["metadata"];
  options: LiveTranscriptionOptions;
  sessionId: string;
  status: LiveSessionStatus;
}

export interface LiveSessionEvents {
  error: [SessionErrorEvent];
  final: [TranscriptFinalEvent];
  polished: [TranscriptPolishedEvent];
  preview: [TranscriptPreviewEvent];
  status: [SessionStatusEvent];
  stopped: [SessionStoppedEvent];
  warning: [SessionWarningEvent];
}

interface StreamPreset {
  beamSize: number;
  keep: number;
  language: string;
  length: number;
  maxTokens?: number;
  noFallback: boolean;
  step: number;
}

// step 0 selects whisper-stream's VAD mode: decoding only triggers when speech
// energy drops (vad_simple), so silence/no-speech windows are never decoded and
// cannot hallucinate captions like "Thank you.". length doubles as the audio
// lookback buffer in this mode, so keep it generous.
const defaultStreamPreset: StreamPreset = {
  beamSize: 6,
  keep: 300,
  language: "en",
  length: 10000,
  noFallback: true,
  step: 0,
};

// Small sliding windows prioritize time-to-first-word. whisper-stream redraws
// its current hypothesis continuously; consumers receive that as preview events
// and can show it before a sentence is complete.
const lowLatencyStreamPreset: StreamPreset = {
  beamSize: 1,
  keep: 150,
  language: "en",
  length: 1200,
  maxTokens: 16,
  noFallback: true,
  step: 150,
};

export class LiveSession extends EventEmitter {
  readonly sessionId: string;
  private readonly abortController = new AbortController();
  private readonly transcriptChunks: string[] = [];
  private previewText = "";
  private result: SpawnWhisperResult | undefined;
  private pendingPolish: Promise<void> | undefined;
  private runPromise: Promise<void> | undefined;
  private statusValue: LiveSessionStatus = "starting";
  private polisher: TranscriptPolisher | undefined;

  constructor(
    private readonly config: ResolvedVocalConfig,
    private readonly options: LiveTranscriptionOptions,
  ) {
    super();
    this.sessionId = options.sessionId?.trim() || randomUUID();
  }

  override on<K extends keyof LiveSessionEvents>(eventName: K, listener: (...args: LiveSessionEvents[K]) => void): this {
    return super.on(eventName, listener);
  }

  override once<K extends keyof LiveSessionEvents>(eventName: K, listener: (...args: LiveSessionEvents[K]) => void): this {
    return super.once(eventName, listener);
  }

  override off<K extends keyof LiveSessionEvents>(eventName: K, listener: (...args: LiveSessionEvents[K]) => void): this {
    return super.off(eventName, listener);
  }

  get status(): LiveSessionStatus {
    return this.statusValue;
  }

  snapshot(): LiveSessionSnapshot {
    return {
      metadata: this.options.metadata,
      options: this.options,
      sessionId: this.sessionId,
      status: this.statusValue,
    };
  }

  async start(): Promise<void> {
    if (this.config.mock) {
      this.startMock();
      return;
    }

    const modelPath = await resolveModelPath(this.config, this.options.modelPath);
    const binary = await resolveConfiguredWhisperBinary("stream", whisperPathConfig(this.config));
    if (!binary.found) {
      throw new Error(
        [
          "Live transcription requires the whisper-stream binary, but it was not found.",
          `Set ${binary.envVar}, configure whisperStreamPath, or place whisper-stream in ${this.config.paths.binDir}.`,
          "Checked:",
          ...binary.checked.map((candidate) => `  - ${candidate.path}`),
        ].join("\n"),
      );
    }

    const streamOptions = await this.buildSupportedStreamOptions(binary.found.path);
    this.createPolisher();
    this.setStatus("running");
    const run = spawnWhisper({
      backend: this.options.backend ?? this.config.defaultBackend,
      binaryPath: binary.found.path,
      mode: "stream",
      modelPath,
      onError: (error) => this.emitError(error),
      onProcessExit: (result) => {
        this.result = result;
      },
      onStderr: (chunk) => this.emitWarning(chunk.trim(), "engine.stderr"),
      onTranscriptFinal: (event) => this.emitFinal(event.text, event.raw),
      onTranscriptPreview: (event) => this.emitPreview(event.text, event.raw),
      signal: this.abortController.signal,
      stream: streamOptions,
    });
    this.runPromise = run
      .catch((error: unknown) => this.emitError(error))
      .finally(async () => {
        await this.pendingPolish;
        this.polisher?.dispose();
        this.setStatus("stopped");
        this.emit("stopped", {
          sessionId: this.sessionId,
          result: this.result,
          metadata: this.options.metadata,
        });
      })
      .then(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.statusValue === "stopped") {
      return;
    }

    this.setStatus("stopping");
    this.abortController.abort();
    if (this.config.mock) {
      this.result = { exitCode: 0, signal: null };
      this.setStatus("stopped");
      this.emit("stopped", {
        sessionId: this.sessionId,
        result: this.result,
        reason: "stopped",
        metadata: this.options.metadata,
      });
    }
    await this.runPromise;
  }

  async requestPolish(): Promise<void> {
    const input = this.buildPolishInput();
    if (!input) {
      return;
    }

    this.createPolisher(true);
    await this.polish(input);
  }

  private startMock(): void {
    this.createPolisher();
    this.setStatus("running");
    const finalText = "mock transcription ready";
    const timer = setTimeout(() => {
      if (this.statusValue === "stopping" || this.statusValue === "stopped") {
        return;
      }
      void this.completeMock(finalText);
    }, 25);
    this.runPromise = new Promise((resolve) => {
      this.once("stopped", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async completeMock(finalText: string): Promise<void> {
    this.emitPreview("mock transcription", "mock transcription");
    this.emitFinal(finalText, finalText);
    await this.pendingPolish;
    this.polisher?.dispose();
    this.result = { exitCode: 0, signal: null };
    this.setStatus("stopped");
    this.emit("stopped", {
      sessionId: this.sessionId,
      result: this.result,
      reason: "mock-complete",
      metadata: this.options.metadata,
    });
  }

  private buildStreamOptions(): WhisperStreamOptions {
    const preset = (this.options.lowLatency ?? true) ? lowLatencyStreamPreset : defaultStreamPreset;
    return {
      audioContext: this.options.audioContext,
      beamSize: this.options.beamSize ?? preset.beamSize,
      capture: this.options.capture,
      freqThreshold: this.options.freqThreshold,
      hallucinationGuardPhrases: this.options.hallucinationGuardPhrases,
      keep: this.options.keep ?? preset.keep,
      keepContext: this.options.keepContext,
      carryInitialPrompt: this.options.carryInitialPrompt,
      initialPrompt: this.options.initialPrompt ?? this.options.prompt,
      language: this.options.language ?? preset.language,
      length: this.options.length ?? preset.length,
      logprobThreshold: this.options.logprobThreshold,
      maxDecodeSilenceMs: this.options.maxDecodeSilenceMs,
      maxTokens: this.options.maxTokens ?? preset.maxTokens,
      minSpeechMs: this.options.minSpeechMs,
      noFallback: this.options.noFallback ?? preset.noFallback,
      noSpeechThreshold: this.options.noSpeechThreshold,
      printSpecial: this.options.printSpecial,
      saveAudio: this.options.saveAudio,
      silenceHangoverMs: this.options.silenceHangoverMs,
      diagnostics: this.options.diagnostics,
      step: this.options.step ?? preset.step,
      threads: this.options.threads,
      tinydiarize: this.options.tinydiarize,
      translate: this.options.translate,
      vadThreshold: this.options.vadThreshold,
      vadModelPath: this.options.vadModelPath ?? this.config.paths.vadModelPath,
    };
  }

  private async buildSupportedStreamOptions(binaryPath: string): Promise<WhisperStreamOptions> {
    const stream = this.buildStreamOptions();
    const prompt = formatDecoderPrompt(stream.initialPrompt);
    if (!prompt && !stream.carryInitialPrompt && !stream.vadModelPath) {
      return stream;
    }

    const capabilities = await detectWhisperBinaryCapabilities(binaryPath);
    if (!capabilities.vadModel && stream.vadModelPath) {
      // Stock whisper-stream cannot gate its positive-step windows. Its VAD
      // path only works with step 0, so retain the artifact-resistant mode if
      // the project-owned driver has not been installed yet.
      if ((this.options.lowLatency ?? true) && this.options.step === undefined) {
        stream.step = 0;
        stream.length = defaultStreamPreset.length;
        stream.keep = defaultStreamPreset.keep;
        stream.beamSize = defaultStreamPreset.beamSize;
        stream.maxTokens = defaultStreamPreset.maxTokens;
      }
      this.emitWarning(
        "The selected whisper-stream binary does not support --vad-model. Falling back to VAD-gated live transcription; install vocal-stream to keep low-latency speech-gated previews.",
        "engine.speechGate.unavailable",
        { binaryPath, requested: true, supported: false },
      );
      stream.vadModelPath = undefined;
    }

    if (!capabilities.prompt && prompt) {
      this.emitWarning(
        "Live decoder prompts were requested, but the configured whisper-stream binary does not support --prompt. Continuing live transcription without prompt hints.",
        "engine.prompt.unsupported",
        {
          binaryPath,
          requested: true,
          supported: false,
        },
      );
      stream.initialPrompt = undefined;
    }

    if (!capabilities.carryInitialPrompt && stream.carryInitialPrompt) {
      this.emitWarning(
        "carryInitialPrompt was requested, but the configured whisper-stream binary does not support --carry-initial-prompt. Continuing without carrying the initial prompt.",
        "engine.carryInitialPrompt.unsupported",
        {
          binaryPath,
          requested: true,
          supported: false,
        },
      );
      stream.carryInitialPrompt = false;
    }

    return stream;
  }

  private createPolisher(force = false): void {
    if (this.polisher || !this.options.polish?.enabled || (this.options.polish.mode === "manual" && !force)) {
      return;
    }

    this.polisher = new TranscriptPolisher({
      config: {
        ...this.config.openRouter,
        ...(this.options.polish.model ? { model: this.options.polish.model } : {}),
      },
      onPolished: (event) => {
        this.emit("polished", {
          sessionId: this.sessionId,
          raw: event.raw,
          text: event.text,
          sequence: event.sequence,
          metadata: this.options.metadata,
        });
      },
      onWarning: (message) => this.emitWarning(message, "polish.warning"),
    });
  }

  private emitPreview(text: string, raw: string): void {
    this.previewText = text;
    this.emit("preview", {
      sessionId: this.sessionId,
      text,
      raw,
      metadata: this.options.metadata,
    });
  }

  private emitFinal(text: string, raw: string): void {
    this.previewText = "";
    this.transcriptChunks.push(text);
    this.emit("final", {
      sessionId: this.sessionId,
      text,
      raw,
      metadata: this.options.metadata,
    });
  }

  private polish(text: string): Promise<void> {
    if (!this.polisher) {
      return Promise.resolve();
    }

    const pending = this.polisher.polish(text).finally(() => {
      if (this.pendingPolish === pending) {
        this.pendingPolish = undefined;
      }
    });
    this.pendingPolish = pending;
    return pending;
  }

  private emitWarning(message: string, code?: string, details?: SessionWarningEvent["details"]): void {
    if (!message) {
      return;
    }

    this.emit("warning", {
      sessionId: this.sessionId,
      message,
      code,
      details,
      metadata: this.options.metadata,
    });
  }

  private emitError(error: unknown): void {
    this.setStatus("error");
    this.emit("error", {
      sessionId: this.sessionId,
      message: error instanceof Error ? error.message : String(error),
      code: "session.error",
      metadata: this.options.metadata,
    });
  }

  private setStatus(status: LiveSessionStatus): void {
    this.statusValue = status;
    this.emit("status", {
      sessionId: this.sessionId,
      status,
      metadata: this.options.metadata,
    });
  }

  private buildPolishInput(): string {
    const text = this.transcriptChunks.filter((chunk) => chunk.trim().length > 0).join(" ").replace(/\s+/g, " ").trim();
    const preview = this.previewText.trim();
    if (!preview) {
      return text;
    }
    if (!text) {
      return preview;
    }
    return text.endsWith(preview) ? text : `${text} ${preview}`.replace(/\s+/g, " ").trim();
  }
}
