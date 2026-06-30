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
  initialPrompt?: WhisperDecoderPromptInput;
  keep?: number;
  keepContext?: boolean;
  prompt?: WhisperDecoderPromptInput;
  language?: string;
  length?: number;
  lowLatency?: boolean;
  maxTokens?: number;
  metadata?: JsonObject;
  modelPath?: string;
  noFallback?: boolean;
  polish?: {
    enabled?: boolean;
    mode?: "manual" | "live";
    model?: string;
  };
  printSpecial?: boolean;
  saveAudio?: boolean;
  sessionId?: string;
  step?: number;
  threads?: number;
  tinydiarize?: boolean;
  translate?: boolean;
  vadThreshold?: number;
}

export interface FileTranscriptionOptions {
  audioContext?: number;
  backend?: Backend;
  beamSize?: number;
  carryInitialPrompt?: boolean;
  filePath: string;
  freqThreshold?: number;
  initialPrompt?: WhisperDecoderPromptInput;
  keepContext?: boolean;
  prompt?: WhisperDecoderPromptInput;
  language?: string;
  maxTokens?: number;
  metadata?: JsonObject;
  modelPath?: string;
  noFallback?: boolean;
  polish?: {
    enabled?: boolean;
    model?: string;
  };
  printSpecial?: boolean;
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
