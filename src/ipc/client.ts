import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorOptions, DoctorResult } from "../service/diagnostics.js";
import type {
  FileTranscriptionOptions,
  LiveTranscriptionOptions,
  SessionErrorEvent,
  SessionStatusEvent,
  SessionStoppedEvent,
  SessionWarningEvent,
  TranscriptFinalEvent,
  TranscriptPolishedEvent,
  TranscriptPreviewEvent,
} from "../service/events.js";
import { defaultIpcEndpoint, resolveVocalConfig, type VocalServiceConfigInput } from "../service/config.js";
import type { ListModelsOptions, ModelListResult } from "../service/models.js";
import type { LiveSessionSnapshot } from "../service/live-session.js";
import type { VocalServiceStatus } from "../service/vocal-service.js";
import { createEnvelope, type IpcEnvelope } from "./protocol.js";
import { connectSocket, type EnvelopeConnection } from "./transport.js";

export interface ConnectVocalGatewayOptions {
  autostart?: boolean;
  endpoint?: string;
  gateway?: string;
  serviceConfig?: VocalServiceConfigInput;
  startTimeoutMs?: number;
}

export interface VocalGatewaySession extends EventEmitter {
  readonly sessionId: string;
  get(): Promise<unknown>;
  requestPolish(): Promise<void>;
  requestPolishAndStop(): Promise<void>;
  stop(): Promise<void>;
}

export interface VocalGatewayStartedEvent {
  session: LiveSessionSnapshot;
  sessionId?: string;
}

export interface VocalGatewayClientEvents {
  "session.error": [SessionErrorEvent];
  "session.started": [VocalGatewayStartedEvent];
  "session.status": [SessionStatusEvent];
  "session.stopped": [SessionStoppedEvent];
  "session.warning": [SessionWarningEvent];
  "transcript.final": [TranscriptFinalEvent];
  "transcript.polished": [TranscriptPolishedEvent];
  "transcript.preview": [TranscriptPreviewEvent];
}

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: IpcEnvelope) => void;
};

interface ManagedGatewayProcess {
  child: ChildProcess;
}

export type VocalClientTranscriptEvent =
  | { type: "preview"; text: string }
  | { type: "final"; text: string }
  | { type: "polished"; text: string; sourceText?: string }
  | { type: "warning"; message: string }
  | { type: "info"; message: string }
  | { type: "error"; message: string; code?: string }
  | { type: "done"; exitCode?: number };

export interface VocalClientListenOptions {
  audioContext?: number;
  audioCtx?: number;
  autostopOnDisconnect?: boolean;
  backend?: LiveTranscriptionOptions["backend"];
  beamSize?: number;
  carryInitialPrompt?: boolean;
  capture?: number | string;
  fallback?: boolean;
  freqThreshold?: number;
  hallucinationGuardPhrases?: string[];
  initialPrompt?: LiveTranscriptionOptions["initialPrompt"];
  keep?: number;
  keepContext?: boolean;
  language?: string;
  length?: number;
  logprobThreshold?: number;
  lowLatency?: boolean;
  maxDecodeSilenceMs?: number;
  maxTokens?: number;
  minSpeechMs?: number;
  metadata?: LiveTranscriptionOptions["metadata"];
  model?: string;
  modelPath?: string;
  noFallback?: boolean;
  noSpeechThreshold?: number;
  polish?: boolean | LiveTranscriptionOptions["polish"];
  polishModel?: string;
  prompt?: LiveTranscriptionOptions["prompt"];
  printSpecial?: boolean;
  saveAudio?: boolean;
  silenceHangoverMs?: number;
  diagnostics?: boolean;
  sessionId?: string;
  step?: number;
  threads?: number;
  tinydiarize?: boolean;
  translate?: boolean;
  vadThreshold?: number;
  vadModelPath?: string;
}

export interface VocalClientTranscribeOptions extends Omit<
  VocalClientListenOptions,
  "autostopOnDisconnect" | "capture" | "keep" | "length" | "lowLatency" | "saveAudio" | "sessionId" | "step"
> {
  entropyThreshold?: number;
  file?: string;
  filePath?: string;
  logprobThreshold?: number;
  noSpeechThreshold?: number;
  sessionId?: string;
  suppressNonSpeechTokens?: boolean;
}

export interface VocalClientTranscriptStream extends AsyncIterable<VocalClientTranscriptEvent> {
  requestPolishAndStop: () => Promise<void> | undefined;
  stop: () => Promise<void> | undefined;
}

export interface VocalCompatibilityClient {
  close: () => Promise<void>;
  disconnect: () => Promise<void>;
  doctor: (options?: DoctorOptions) => Promise<DoctorResult>;
  gateway: {
    start: (options?: ConnectVocalGatewayOptions) => Promise<VocalServiceStatus>;
    status: (options?: ConnectVocalGatewayOptions) => Promise<VocalServiceStatus>;
    stop: (options?: ConnectVocalGatewayOptions) => Promise<unknown>;
  };
  listen: (options: VocalClientListenOptions) => VocalClientTranscriptStream;
  models: (options?: ListModelsOptions) => Promise<ModelListResult>;
  transcribe: (options: VocalClientTranscribeOptions) => AsyncIterable<VocalClientTranscriptEvent>;
}

export class VocalGatewayClient extends EventEmitter {
  private readonly pending = new Map<string, PendingRequest>();
  private disconnected = false;

  constructor(
    private readonly connection: EnvelopeConnection,
    readonly endpoint: string,
    private readonly gatewayProcess?: ManagedGatewayProcess,
  ) {
    super();
    connection.on("envelope", (envelope) => this.handleEnvelope(envelope));
    connection.on("error", (error) => this.rejectAll(error));
    connection.on("close", () => this.rejectAll(new Error("Vocal gateway connection closed.")));
  }

  override on<K extends keyof VocalGatewayClientEvents>(
    eventName: K,
    listener: (...args: VocalGatewayClientEvents[K]) => void,
  ): this {
    return super.on(eventName, listener);
  }

  async request(method: string, payload?: unknown, sessionId?: string): Promise<IpcEnvelope> {
    if (this.disconnected) {
      throw new Error("Vocal gateway client is disconnected.");
    }

    const id = randomUUID();
    const envelope = createEnvelope({ id, method, payload, sessionId, type: "request" });
    const promise = new Promise<IpcEnvelope>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.connection.send(envelope);
    return promise;
  }

  async status(): Promise<VocalServiceStatus> {
    return (await this.request("service.status")).payload as VocalServiceStatus;
  }

  async doctor(options?: DoctorOptions): Promise<DoctorResult> {
    return (await this.request("service.doctor", options)).payload as DoctorResult;
  }

  async listModels(options?: ListModelsOptions): Promise<ModelListResult> {
    return (await this.request("models.list", options)).payload as ModelListResult;
  }

  async transcribeFile(options: FileTranscriptionOptions, sessionId: string = randomUUID()): Promise<string> {
    const response = await this.request("transcribe.file", options, sessionId);
    return response.sessionId ?? String((response.payload as { sessionId?: unknown } | undefined)?.sessionId ?? "");
  }

  async startSession(options: LiveTranscriptionOptions): Promise<VocalGatewaySession> {
    const sessionId = options.sessionId?.trim() || randomUUID();
    const session = new GatewaySession(this, sessionId);
    try {
      const response = await this.request("session.start", { ...options, sessionId }, sessionId);
      const responseSessionId = response.sessionId ?? String((response.payload as { sessionId?: unknown } | undefined)?.sessionId ?? "");
      if (responseSessionId && responseSessionId !== sessionId) {
        session.dispose();
        return new GatewaySession(this, responseSessionId);
      }
      return session;
    } catch (error) {
      session.dispose();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.disconnect();
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) {
      return;
    }

    if (this.gatewayProcess) {
      await this.shutdownGateway().catch(() => undefined);
    }

    this.disconnected = true;
    this.connection.close();

    if (this.gatewayProcess) {
      await stopManagedGateway(this.gatewayProcess.child);
    }
  }

  async shutdownGateway(): Promise<unknown> {
    return (await this.request("service.shutdown")).payload;
  }

  private handleEnvelope(envelope: IpcEnvelope): void {
    if ((envelope.type === "response" || envelope.type === "error") && envelope.id) {
      const pending = this.pending.get(envelope.id);
      if (!pending) {
        return;
      }

      this.pending.delete(envelope.id);
      if (envelope.type === "error") {
        pending.reject(new Error(envelope.error?.message ?? "Vocal gateway request failed."));
      } else {
        pending.resolve(envelope);
      }
      return;
    }

    if (envelope.type === "event" && envelope.method) {
      this.emit(envelope.method, {
        ...(isRecord(envelope.payload) ? envelope.payload : { payload: envelope.payload }),
        sessionId: envelope.sessionId,
      });
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class GatewaySession extends EventEmitter implements VocalGatewaySession {
  private readonly disposers: Array<() => void> = [];
  private stopped = false;

  constructor(
    private readonly client: VocalGatewayClient,
    readonly sessionId: string,
  ) {
    super();
    for (const eventName of [
      "session.error",
      "session.status",
      "session.stopped",
      "session.warning",
      "transcript.final",
      "transcript.polished",
      "transcript.preview",
    ] as const) {
      const handler = (event: unknown) => {
        if (isRecord(event) && event.sessionId === this.sessionId) {
          if (eventName === "session.stopped") {
            this.stopped = true;
          }
          this.emit(eventName, event);
          if (eventName === "session.stopped") {
            this.dispose();
          }
        }
      };
      EventEmitter.prototype.on.call(client, eventName, handler);
      this.disposers.push(() => EventEmitter.prototype.off.call(client, eventName, handler));
    }
  }

  async get(): Promise<unknown> {
    return (await this.client.request("session.get", undefined, this.sessionId)).payload;
  }

  async requestPolish(): Promise<void> {
    if (this.stopped) {
      return;
    }

    try {
      await this.client.request("session.polish", undefined, this.sessionId);
    } catch (error) {
      if (!isUnknownSessionError(error, this.sessionId)) {
        throw error;
      }
      this.stopped = true;
    }
  }

  async requestPolishAndStop(): Promise<void> {
    await this.requestPolish();
    await this.stop();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    try {
      await this.client.request("session.stop", undefined, this.sessionId);
    } catch (error) {
      if (!isUnknownSessionError(error, this.sessionId)) {
        throw error;
      }
      this.stopped = true;
    }
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
  }
}

export async function connectVocalGateway(options: ConnectVocalGatewayOptions = {}): Promise<VocalGatewayClient> {
  const serviceConfig = options.serviceConfig;
  const endpoint = options.endpoint ?? options.gateway ?? defaultIpcEndpoint(resolveVocalConfig(serviceConfig));
  const autostart = options.autostart ?? true;
  let gatewayProcess: ManagedGatewayProcess | undefined;

  try {
    return new VocalGatewayClient(await connectSocket(endpoint), endpoint);
  } catch (error) {
    if (!autostart) {
      throw new Error(`Unable to connect to Vocal gateway at ${endpoint}. Start it with: vocal-gateway --socket ${endpoint}`);
    }
    gatewayProcess = startGateway(endpoint, serviceConfig);
  }

  const connection = await waitForGateway(endpoint, options.startTimeoutMs ?? 3000);
  return new VocalGatewayClient(connection, endpoint, gatewayProcess);
}

export async function createVocalClient(options: ConnectVocalGatewayOptions = {}): Promise<VocalCompatibilityClient> {
  const client = await connectVocalGateway(options);
  return createCompatibilityClient(client);
}

export async function connectVocalClient(options: ConnectVocalGatewayOptions = {}): Promise<VocalCompatibilityClient> {
  return createVocalClient(options);
}

function createCompatibilityClient(client: VocalGatewayClient): VocalCompatibilityClient {
  return {
    close: () => client.close(),
    disconnect: () => client.disconnect(),
    doctor: (options?: DoctorOptions) => client.doctor(options),
    gateway: {
      start: async () => client.status(),
      status: async () => client.status(),
      stop: async () => client.shutdownGateway(),
    },
    listen: (options: VocalClientListenOptions) => {
      return createSessionIterator(client, { ...options, autostopOnDisconnect: true });
    },
    models: (options?: ListModelsOptions) => client.listModels(options),
    transcribe: (options: VocalClientTranscribeOptions) => createFileIterator(
      client,
      {
        ...options,
        filePath: typeof options.file === "string" ? options.file : String(options.filePath ?? ""),
      },
    ),
  };
}

function createSessionIterator(client: VocalGatewayClient, options: VocalClientListenOptions) {
  const sessionId = stringOption(options.sessionId) ?? randomUUID();
  const queue = createAsyncQueue<VocalClientTranscriptEvent>();
  let sessionObserved = false;
  const markSessionObserved = (): void => {
    sessionObserved = true;
    startWatching();
  };
  const unbind = bindTranscriptQueue(client, sessionId, queue, markSessionObserved);
  let pollActive = false;
  let watchTimer: NodeJS.Timeout | undefined;
  let stopRequested = false;
  const stopWatching = (): void => {
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = undefined;
    }
  };
  const finishIfNeeded = (): void => {
    if (!queue.isEnded()) {
      queue.push({ type: "done" });
      queue.end();
      unbind();
    }
    stopWatching();
  };
  const pollSession = async (): Promise<void> => {
    if (pollActive || queue.isEnded()) {
      if (queue.isEnded()) {
        stopWatching();
      }
      return;
    }

    if (!sessionObserved && !iterator.session) {
      return;
    }

    pollActive = true;
    try {
      await client.request("session.get", undefined, sessionId);
    } catch (error) {
      if (isUnknownSessionError(error, sessionId)) {
        finishIfNeeded();
      } else if (error instanceof Error && error.message === "Vocal gateway connection closed.") {
        if (!queue.isEnded()) {
          queue.push({ type: "error", message: error.message });
          queue.end();
          unbind();
        }
        stopWatching();
      }
    } finally {
      pollActive = false;
    }
  };
  const startWatching = (): void => {
    if (watchTimer) {
      return;
    }

    watchTimer = setInterval(() => {
      void pollSession();
    }, 1000);
    watchTimer.unref?.();
  };
  const iterator = queue.iterable as VocalClientTranscriptStream & { session?: VocalGatewaySession };
  iterator.stop = async () => {
    stopRequested = true;
    if (!sessionObserved && !iterator.session) {
      return;
    }

    try {
      await client.request("session.stop", undefined, sessionId);
    } catch (error) {
      if (!isUnknownSessionError(error, sessionId)) {
        throw error;
      }
    }
    finishIfNeeded();
  };
  iterator.requestPolishAndStop = async () => {
    stopRequested = true;
    if (!sessionObserved && !iterator.session) {
      return;
    }

    try {
      await client.request("session.polish", undefined, sessionId);
    } catch (error) {
      if (!isUnknownSessionError(error, sessionId)) {
        throw error;
      }
    }
    await iterator.stop();
  };
  void client.startSession({ ...options, sessionId } as unknown as LiveTranscriptionOptions).then((session) => {
    iterator.session = session;
    sessionObserved = true;
    startWatching();
    if (stopRequested) {
      void iterator.stop();
    }
  }).catch((error: unknown) => {
    unbind();
    queue.push({ type: "error", message: error instanceof Error ? error.message : String(error) });
    queue.end();
    stopWatching();
  });
  return iterator;
}

function createFileIterator(client: VocalGatewayClient, options: VocalClientTranscribeOptions) {
  const sessionId = stringOption(options.sessionId) ?? randomUUID();
  const queue = createAsyncQueue<VocalClientTranscriptEvent>();
  const unbind = bindTranscriptQueue(client, sessionId, queue);
  void client.transcribeFile(options as unknown as FileTranscriptionOptions, sessionId).catch((error: unknown) => {
    unbind();
    queue.push({ type: "error", message: error instanceof Error ? error.message : String(error) });
    queue.end();
  });
  return queue.iterable;
}

function bindTranscriptQueue(
  client: VocalGatewayClient,
  sessionId: string,
  queue: ReturnType<typeof createAsyncQueue<VocalClientTranscriptEvent>>,
  onSessionEvent: () => void = () => undefined,
): () => void {
  const handlers = {
    "session.error": (event: unknown) => {
      if (matchesSession(event, sessionId)) {
        onSessionEvent();
        queue.push({ type: "error", message: messageFromEvent(event), code: codeFromEvent(event) });
      }
    },
    "session.stopped": (event: unknown) => {
      if (matchesSession(event, sessionId)) {
        onSessionEvent();
        const result = isRecord(event) ? event.result : undefined;
        queue.push({ type: "done", exitCode: exitCodeFromResult(result) });
        queue.end();
        unbind();
      }
    },
    "session.warning": (event: unknown) => {
      if (matchesSession(event, sessionId)) {
        onSessionEvent();
        queue.push({ type: "warning", message: messageFromEvent(event) });
      }
    },
    "transcript.final": (event: unknown) => {
      if (matchesSession(event, sessionId)) {
        onSessionEvent();
        queue.push({ type: "final", text: textFromEvent(event) });
      }
    },
    "transcript.polished": (event: unknown) => {
      if (matchesSession(event, sessionId)) {
        onSessionEvent();
        queue.push({ type: "polished", text: textFromEvent(event), sourceText: rawFromEvent(event) });
      }
    },
    "transcript.preview": (event: unknown) => {
      if (matchesSession(event, sessionId)) {
        onSessionEvent();
        queue.push({ type: "preview", text: textFromEvent(event) });
      }
    },
  };
  const unbind = () => {
    for (const [name, handler] of Object.entries(handlers)) {
      EventEmitter.prototype.off.call(client, name, handler);
    }
  };

  for (const [name, handler] of Object.entries(handlers)) {
    EventEmitter.prototype.on.call(client, name, handler);
  }

  return unbind;
}

function createAsyncQueue<T>(): { end: () => void; isEnded: () => boolean; iterable: AsyncIterable<T>; push: (value: T) => void } {
  const values: T[] = [];
  const waiters: Array<(value: IteratorResult<T>) => void> = [];
  let ended = false;

  return {
    end: () => {
      if (ended) {
        return;
      }
      ended = true;
      while (waiters.length > 0) {
        waiters.shift()?.({ done: true, value: undefined });
      }
    },
    isEnded: () => ended,
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            const value = values.shift();
            if (value !== undefined) {
              return { done: false, value };
            }
            if (ended) {
              return { done: true, value: undefined };
            }
            return new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve));
          },
        };
      },
    },
    push: (value) => {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value });
      } else {
        values.push(value);
      }
    },
  };
}

function startGateway(endpoint: string, serviceConfig: VocalServiceConfigInput | undefined): ManagedGatewayProcess {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const gatewayPath = resolve(moduleDir, "../bin/gateway.js");
  if (!existsSync(gatewayPath)) {
    throw new Error(
      [
        `Vocal gateway executable was not found at ${gatewayPath}.`,
        "Build vocal-lib before using gateway autostart, or start a gateway manually with --gateway.",
      ].join("\n"),
    );
  }

  const child = spawn(process.execPath, [gatewayPath, "--socket", endpoint, ...gatewayConfigArgs(serviceConfig)], {
    detached: false,
    stdio: "ignore",
  });
  return { child };
}

async function stopManagedGateway(child: ChildProcess): Promise<void> {
  if (hasExited(child)) {
    return;
  }

  if (await waitForChildExit(child, 1000)) {
    return;
  }

  child.kill("SIGTERM");
  if (await waitForChildExit(child, 1000)) {
    return;
  }

  child.kill("SIGKILL");
  await waitForChildExit(child, 500);
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("close", onExit);
    };
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve(hasExited(child));
    }, timeoutMs);
    timeout.unref?.();
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

function gatewayConfigArgs(serviceConfig: VocalServiceConfigInput | undefined): string[] {
  const args: string[] = [];
  pushFlag(args, "--root-dir", serviceConfig?.paths?.rootDir);
  pushFlag(args, "--bin-dir", serviceConfig?.paths?.binDir);
  pushFlag(args, "--models-dir", serviceConfig?.paths?.modelsDir);
  pushFlag(args, "--runtime-dir", serviceConfig?.paths?.runtimeDir);
  pushFlag(args, "--whisper-cli", serviceConfig?.paths?.whisperCliPath);
  pushFlag(args, "--whisper-cpp-dir", serviceConfig?.paths?.whisperCppDir);
  pushFlag(args, "--whisper-stream", serviceConfig?.paths?.whisperStreamPath);
  pushFlag(args, "--default-model", serviceConfig?.paths?.defaultModelPath ?? serviceConfig?.defaults?.modelPath);
  pushFlag(args, "--backend", serviceConfig?.defaults?.backend);
  if (serviceConfig?.mock) {
    args.push("--mock");
  }
  return args;
}

function pushFlag(args: string[], flag: string, value: string | undefined): void {
  if (value && value.trim().length > 0) {
    args.push(flag, value);
  }
}

async function waitForGateway(endpoint: string, timeoutMs: number): Promise<EnvelopeConnection> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await connectSocket(endpoint);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error(`Vocal gateway did not become ready at ${endpoint}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function matchesSession(event: unknown, sessionId: string): boolean {
  return isRecord(event) && event.sessionId === sessionId;
}

function textFromEvent(event: unknown): string {
  return isRecord(event) && typeof event.text === "string" ? event.text : "";
}

function rawFromEvent(event: unknown): string | undefined {
  return isRecord(event) && typeof event.raw === "string" ? event.raw : undefined;
}

function messageFromEvent(event: unknown): string {
  return isRecord(event) && typeof event.message === "string" ? event.message : String(event);
}

function codeFromEvent(event: unknown): string | undefined {
  return isRecord(event) && typeof event.code === "string" ? event.code : undefined;
}

function exitCodeFromResult(result: unknown): number | undefined {
  return isRecord(result) && typeof result.exitCode === "number" ? result.exitCode : undefined;
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isUnknownSessionError(error: unknown, sessionId: string): boolean {
  return error instanceof Error && error.message === `Unknown session: ${sessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
