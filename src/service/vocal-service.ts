import type { Backend } from "../engine/types.js";
import { doctor, type DoctorOptions, type DoctorResult } from "./diagnostics.js";
import { transcribeFile } from "./file-transcription.js";
import { LiveSession, type LiveSessionSnapshot } from "./live-session.js";
import { resolveVocalConfig, type ResolvedVocalConfig, type VocalServiceConfigInput } from "./config.js";
import type { FileTranscriptionOptions, FileTranscriptionResult, LiveTranscriptionOptions } from "./events.js";
import { listModels, type ListModelsOptions, type ModelListResult } from "./models.js";

export interface ResolveConfigOptions {
  backend?: Backend;
  modelPath?: string;
}

export interface VocalServiceStatus {
  activeSessions: LiveSessionSnapshot[];
  config: {
    binDir: string;
    defaultBackend: Backend;
    defaultModelPath?: string;
    mock: boolean;
    modelsDir: string;
    rootDir: string;
    runtimeDir: string;
    whisperCppDir: string;
  };
  ok: boolean;
}

export class VocalService {
  private readonly sessions = new Map<string, LiveSession>();

  constructor(readonly config: ResolvedVocalConfig) {}

  async startLiveTranscription(options: LiveTranscriptionOptions = {}): Promise<LiveSession> {
    const session = new LiveSession(this.config, {
      ...options,
      backend: options.backend ?? this.config.defaultBackend,
    });
    if (this.sessions.has(session.sessionId)) {
      throw new Error(`Session already exists: ${session.sessionId}`);
    }

    this.sessions.set(session.sessionId, session);
    session.once("stopped", () => {
      this.sessions.delete(session.sessionId);
    });
    await session.start();
    return session;
  }

  async transcribeFile(options: FileTranscriptionOptions): Promise<FileTranscriptionResult> {
    return transcribeFile(this.config, {
      ...options,
      backend: options.backend ?? this.config.defaultBackend,
    });
  }

  async listModels(options?: ListModelsOptions): Promise<ModelListResult> {
    return listModels(this.config, options);
  }

  async doctor(options?: DoctorOptions): Promise<DoctorResult> {
    return doctor(this.config, options);
  }

  resolveConfig(options: ResolveConfigOptions = {}): ResolvedVocalConfig {
    return {
      ...this.config,
      defaultBackend: options.backend ?? this.config.defaultBackend,
      defaultModelPath: options.modelPath ?? this.config.defaultModelPath,
      paths: {
        ...this.config.paths,
        defaultModelPath: options.modelPath ?? this.config.paths.defaultModelPath,
      },
    };
  }

  getSession(sessionId: string): LiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): LiveSessionSnapshot[] {
    return [...this.sessions.values()].map((session) => session.snapshot());
  }

  status(): VocalServiceStatus {
    return {
      activeSessions: this.listSessions(),
      config: {
        binDir: this.config.paths.binDir,
        defaultBackend: this.config.defaultBackend,
        defaultModelPath: this.config.defaultModelPath,
        mock: this.config.mock,
        modelsDir: this.config.paths.modelsDir,
        rootDir: this.config.paths.rootDir,
        runtimeDir: this.config.paths.runtimeDir,
        whisperCppDir: this.config.paths.whisperCppDir,
      },
      ok: true,
    };
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.stop()));
    this.sessions.clear();
  }
}

export function createVocalService(options: VocalServiceConfigInput = {}): VocalService {
  return new VocalService(resolveVocalConfig(options));
}
