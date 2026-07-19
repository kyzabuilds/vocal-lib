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
  vadModel: boolean;
}

export interface SpawnWhisperOptions {
  binaryPath: string;
  modelPath: string;
  backend: Backend;
  carryInitialPrompt?: boolean;
  entropyThreshold?: number;
  initialPrompt?: WhisperDecoderPromptInput;
  inputPath?: string;
  logprobThreshold?: number;
  mode: WhisperBinaryKind;
  noFallback?: boolean;
  noSpeechThreshold?: number;
  onError?: (error: Error) => void;
  onProcessExit?: (event: WhisperProcessExitEvent) => void;
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  onTranscriptFinal?: (event: TranscriptOutputEvent) => void;
  onTranscriptPreview?: (event: TranscriptOutputEvent) => void;
  onWarning?: (event: WhisperWarningEvent) => void;
  signal?: AbortSignal;
  stream?: WhisperStreamOptions;
  suppressNonSpeechTokens?: boolean;
}

export interface WhisperStreamOptions {
  audioContext?: number;
  beamSize?: number;
  carryInitialPrompt?: boolean;
  capture?: number;
  freqThreshold?: number;
  hallucinationGuardPhrases?: string[];
  keep?: number;
  keepContext?: boolean;
  initialPrompt?: WhisperDecoderPromptInput;
  language?: string;
  length?: number;
  logprobThreshold?: number;
  maxDecodeSilenceMs?: number;
  maxTokens?: number;
  minSpeechMs?: number;
  noFallback?: boolean;
  noSpeechThreshold?: number;
  printSpecial?: boolean;
  saveAudio?: boolean;
  silenceHangoverMs?: number;
  diagnostics?: boolean;
  step?: number;
  threads?: number;
  tinydiarize?: boolean;
  translate?: boolean;
  vadThreshold?: number;
  vadModelPath?: string;
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
