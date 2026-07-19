import type { Backend, SpawnWhisperResult, WhisperDecoderPromptInput, WhisperStreamOptions } from "../engine/types.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface TranscriptPreviewEvent {
  sessionId: string;
  text: string;
  raw: string;
  metadata?: JsonObject;
}

export interface TranscriptFinalEvent extends TranscriptPreviewEvent {}

export interface TranscriptPolishedEvent {
  sessionId: string;
  text: string;
  raw: string;
  sequence?: number;
  metadata?: JsonObject;
}

export interface SessionWarningEvent {
  sessionId: string;
  message: string;
  code?: string;
  details?: unknown;
  metadata?: JsonObject;
}

export interface SessionErrorEvent {
  sessionId: string;
  message: string;
  code?: string;
  details?: unknown;
  metadata?: JsonObject;
}

export interface SessionStatusEvent {
  sessionId: string;
  status: LiveSessionStatus;
  metadata?: JsonObject;
}

export interface SessionStoppedEvent {
  sessionId: string;
  result?: SpawnWhisperResult;
  reason?: string;
  metadata?: JsonObject;
}

export type LiveSessionStatus = "starting" | "running" | "stopping" | "stopped" | "error";

export interface LiveTranscriptionOptions {
  audioContext?: number;
  autostopOnDisconnect?: boolean;
  backend?: Backend;
  beamSize?: number;
  carryInitialPrompt?: boolean;
  capture?: number;
  freqThreshold?: number;
  /**
   * Exact phrases that require speech-positive agreement before finalization
   * when VAD has entered trailing silence. Default: ["thank you"]. Pass [] to disable.
   */
  hallucinationGuardPhrases?: string[];
  initialPrompt?: WhisperDecoderPromptInput;
  keep?: number;
  keepContext?: boolean;
  prompt?: WhisperDecoderPromptInput;
  language?: string;
  length?: number;
  /** Average token log-probability paired with noSpeechThreshold. Default: -1.0. */
  logprobThreshold?: number;
  /**
   * Use whisper-stream's short sliding windows so interim words are emitted
   * while the speaker is still talking instead of waiting for a VAD boundary.
   */
  lowLatency?: boolean;
  maxTokens?: number;
  /** Decode at most this much trailing silence for right context. Default: 150 ms. */
  maxDecodeSilenceMs?: number;
  /** Consecutive VAD-positive audio required before decoding. Default: 300 ms. */
  minSpeechMs?: number;
  metadata?: JsonObject;
  modelPath?: string;
  noFallback?: boolean;
  noSpeechThreshold?: number;
  polish?: {
    enabled?: boolean;
    mode?: "manual" | "live";
    model?: string;
  };
  printSpecial?: boolean;
  saveAudio?: boolean;
  /** VAD-negative audio required to reset an utterance. Default: 450 ms. */
  silenceHangoverMs?: number;
  /** Emit structured VAD/confidence timing records on the native driver's stderr. */
  diagnostics?: boolean;
  sessionId?: string;
  step?: number;
  threads?: number;
  tinydiarize?: boolean;
  translate?: boolean;
  vadThreshold?: number;
  /** Path to the Silero VAD model used by the project-owned vocal-stream driver. */
  vadModelPath?: string;
}

export interface FileTranscriptionOptions {
  audioContext?: number;
  backend?: Backend;
  beamSize?: number;
  carryInitialPrompt?: boolean;
  entropyThreshold?: number;
  filePath: string;
  freqThreshold?: number;
  initialPrompt?: WhisperDecoderPromptInput;
  keepContext?: boolean;
  prompt?: WhisperDecoderPromptInput;
  language?: string;
  logprobThreshold?: number;
  maxTokens?: number;
  metadata?: JsonObject;
  modelPath?: string;
  noFallback?: boolean;
  noSpeechThreshold?: number;
  polish?: {
    enabled?: boolean;
    model?: string;
  };
  printSpecial?: boolean;
  suppressNonSpeechTokens?: boolean;
  threads?: number;
  tinydiarize?: boolean;
  translate?: boolean;
  vadThreshold?: number;
}

export interface FileTranscriptionResult {
  text: string;
  raw: string;
  polished?: {
    raw: string;
    text: string;
    sequence: number;
  };
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export function toWhisperStreamOptions(options: LiveTranscriptionOptions | FileTranscriptionOptions): WhisperStreamOptions {
  return {
    audioContext: options.audioContext,
    beamSize: options.beamSize,
    carryInitialPrompt: options.carryInitialPrompt,
    freqThreshold: options.freqThreshold,
    hallucinationGuardPhrases: "hallucinationGuardPhrases" in options ? options.hallucinationGuardPhrases : undefined,
    initialPrompt: options.initialPrompt ?? options.prompt,
    keepContext: options.keepContext,
    language: options.language,
    maxTokens: options.maxTokens,
    noFallback: options.noFallback,
    printSpecial: options.printSpecial,
    threads: options.threads,
    tinydiarize: options.tinydiarize,
    translate: options.translate,
    vadThreshold: options.vadThreshold,
  };
}
