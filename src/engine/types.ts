export type Backend = "auto" | "cpu" | "vulkan" | "hip";

export type WhisperBinaryKind = "cli" | "stream";

export type WhisperDecoderPromptInput = string | WhisperDecoderPrompt;

export interface WhisperDecoderPrompt {
  formatting?: string[];
  phrases?: string[];
  punctuation?: string[];
  text?: string;
  vocabulary?: string[];
}

export interface BinaryCandidate {
  path: string;
  source: "configuration" | "environment" | "local-bin" | "vendor";
}

export interface BinaryResolution {
  kind: WhisperBinaryKind;
  found: BinaryCandidate | null;
  checked: BinaryCandidate[];
  envVar: string;
}

export interface WhisperBinaryCapabilities {
  carryInitialPrompt: boolean;
  prompt: boolean;
}

export interface SpawnWhisperOptions {
  binaryPath: string;
  modelPath: string;
  backend: Backend;
  carryInitialPrompt?: boolean;
  initialPrompt?: WhisperDecoderPromptInput;
  inputPath?: string;
  mode: WhisperBinaryKind;
  onError?: (error: Error) => void;
  onProcessExit?: (event: WhisperProcessExitEvent) => void;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  onTranscriptFinal?: (event: TranscriptOutputEvent) => void;
  onTranscriptPreview?: (event: TranscriptOutputEvent) => void;
  onWarning?: (event: WhisperWarningEvent) => void;
  signal?: AbortSignal;
  stream?: WhisperStreamOptions;
}

export interface WhisperStreamOptions {
  audioContext?: number;
  beamSize?: number;
  carryInitialPrompt?: boolean;
  capture?: number;
  freqThreshold?: number;
  keep?: number;
  keepContext?: boolean;
  initialPrompt?: WhisperDecoderPromptInput;
  language?: string;
  length?: number;
  maxTokens?: number;
  noFallback?: boolean;
  printSpecial?: boolean;
  saveAudio?: boolean;
  step?: number;
  threads?: number;
  tinydiarize?: boolean;
  translate?: boolean;
  vadThreshold?: number;
}

export interface SpawnWhisperResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface TranscriptOutputEvent {
  text: string;
  raw: string;
}

export interface WhisperProcessExitEvent {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface WhisperWarningEvent {
  message: string;
  code?: string;
  details?: unknown;
}

export interface WhisperPathConfig {
  binDir?: string;
  whisperCppDir?: string;
  whisperCliPath?: string;
  whisperStreamPath?: string;
}
