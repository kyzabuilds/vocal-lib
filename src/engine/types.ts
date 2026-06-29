export type Backend = "auto" | "cpu" | "vulkan" | "hip";

export type WhisperBinaryKind = "cli" | "stream";

export interface BinaryCandidate {
  path: string;
  source: "environment" | "local-bin" | "vendor";
}

export interface BinaryResolution {
  kind: WhisperBinaryKind;
  found: BinaryCandidate | null;
  checked: BinaryCandidate[];
  envVar: string;
}

export interface SpawnWhisperOptions {
  binaryPath: string;
  modelPath: string;
  backend: Backend;
  inputPath?: string;
  mode: WhisperBinaryKind;
  onTranscriptFinal?: (event: TranscriptOutputEvent) => void;
  onTranscriptPreview?: (event: TranscriptOutputEvent) => void;
  signal?: AbortSignal;
  stream?: WhisperStreamOptions;
}

export interface WhisperStreamOptions {
  audioContext?: number;
  beamSize?: number;
  capture?: number;
  freqThreshold?: number;
  keep?: number;
  keepContext?: boolean;
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
