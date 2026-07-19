import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer, type Server } from "node:net";
import { createVocalService, type VocalService } from "../service/vocal-service.js";
import type { FileTranscriptionOptions, LiveTranscriptionOptions } from "../service/events.js";
import { defaultIpcEndpoint, resolveVocalConfig, type VocalServiceConfigInput } from "../service/config.js";
import { createEnvelope, errorEnvelope, type IpcEnvelope } from "./protocol.js";
import { EnvelopeConnection, socketFromStream } from "./transport.js";

export interface VocalIpcServerOptions {
  endpoint?: string;
  service?: VocalService;
  serviceConfig?: VocalServiceConfigInput;
}

interface ClientState {
  autostopSessions: Set<string>;
  connection: EnvelopeConnection;
}

export class VocalIpcServer {
  readonly endpoint: string;
  readonly service: VocalService;
  private netServer: Server | undefined;
  private shuttingDown = false;

  constructor(options: VocalIpcServerOptions = {}) {
    this.service = options.service ?? createVocalService(options.serviceConfig);
    this.endpoint = options.endpoint ?? defaultIpcEndpoint(this.service.config);
  }

  async listen(): Promise<string> {
    await mkdir(dirname(this.endpoint), { recursive: true });
    if (process.platform !== "win32") {
      await unlink(this.endpoint).catch(() => undefined);
    }

    this.netServer = createServer((socket) => this.attachConnection(socketFromStream(socket)));
    await new Promise<void>((resolve, reject) => {
      this.netServer?.once("error", reject);
      this.netServer?.listen(this.endpoint, resolve);
    });
    this.netServer.off("error", this.throwServerError);
    return this.endpoint;
  }

  attachStdio(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): void {
    this.attachConnection(new EnvelopeConnection(input, output));
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    await this.service.stopAll();
    await new Promise<void>((resolve) => {
      if (!this.netServer) {
        resolve();
        return;
      }
      this.netServer.close(() => resolve());
    });
    if (process.platform !== "win32") {
      await unlink(this.endpoint).catch(() => undefined);
    }
  }

  private attachConnection(connection: EnvelopeConnection): void {
    const client: ClientState = { autostopSessions: new Set(), connection };

    connection.on("envelope", (envelope) => {
      void this.handleEnvelope(client, envelope);
    });
    connection.on("error", (error) => {
      connection.send(errorEnvelope(error));
    });
    connection.on("close", () => {
      void this.cleanupClient(client);
    });
  }

  private async handleEnvelope(client: ClientState, envelope: IpcEnvelope): Promise<void> {
    if (envelope.type !== "request") {
      client.connection.send(errorEnvelope(new Error("Gateway only accepts request envelopes."), envelope.id));
      return;
    }

    try {
      switch (envelope.method) {
        case "service.status":
          this.respond(client, envelope, this.service.status());
          break;
        case "service.doctor":
          this.respond(client, envelope, await this.service.doctor(asRecord(envelope.payload)));
          break;
        case "service.shutdown":
          this.respond(client, envelope, { ok: true });
          setImmediate(() => void this.close());
          break;
        case "models.list":
          this.respond(client, envelope, await this.service.listModels(asRecord(envelope.payload)));
          break;
        case "transcribe.file":
          await this.handleFileTranscription(client, envelope);
          break;
        case "session.start":
          await this.handleSessionStart(client, envelope);
          break;
        case "session.stop":
          await this.handleSessionStop(client, envelope);
          break;
        case "session.polish":
          await this.handleSessionPolish(client, envelope);
          break;
        case "session.get":
          this.handleSessionGet(client, envelope);
          break;
        case "session.list":
          this.respond(client, envelope, { sessions: this.service.listSessions() });
          break;
        default:
          throw new Error(`Unknown IPC method: ${String(envelope.method)}`);
      }
    } catch (error) {
      client.connection.send(errorEnvelope(error, envelope.id));
    }
  }

  private async handleSessionStart(client: ClientState, envelope: IpcEnvelope): Promise<void> {
    const options = normalizeLiveOptions(asRecord(envelope.payload));
    const session = await this.service.startLiveTranscription(options);
    this.bindSessionEvents(client.connection, session);
    if (options.autostopOnDisconnect) {
      client.autostopSessions.add(session.sessionId);
    }
    this.respond(client, envelope, session.snapshot(), session.sessionId);
    this.event(client.connection, "session.started", { session: session.snapshot() }, session.sessionId);
  }

  private async handleFileTranscription(client: ClientState, envelope: IpcEnvelope): Promise<void> {
    const sessionId = envelope.sessionId ?? `file-${Date.now().toString(36)}`;
    const options = normalizeFileOptions(asRecord(envelope.payload));
    this.respond(client, envelope, { sessionId }, sessionId);
    void this.service.transcribeFile(options)
      .then((result) => {
        if (result.text) {
          this.event(client.connection, "transcript.final", { text: result.text, raw: result.raw }, sessionId);
        }
        if (result.polished) {
          this.event(client.connection, "transcript.polished", result.polished, sessionId);
        }
        if (result.stderr.trim()) {
          this.event(client.connection, "session.warning", { message: result.stderr.trim(), code: "engine.stderr" }, sessionId);
        }
        this.event(client.connection, "session.stopped", { result }, sessionId);
      })
      .catch((error: unknown) => {
        this.event(client.connection, "session.error", errorToPayload(error), sessionId);
        this.event(client.connection, "session.stopped", { reason: "error" }, sessionId);
      });
  }

  private async handleSessionStop(client: ClientState, envelope: IpcEnvelope): Promise<void> {
    const sessionId = requireSessionId(envelope);
    const session = this.service.getSession(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    await session.stop();
    this.respond(client, envelope, { ok: true }, sessionId);
  }

  private async handleSessionPolish(client: ClientState, envelope: IpcEnvelope): Promise<void> {
    const sessionId = requireSessionId(envelope);
    const session = this.service.getSession(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    await session.requestPolish();
    this.respond(client, envelope, { ok: true }, sessionId);
  }

  private handleSessionGet(client: ClientState, envelope: IpcEnvelope): void {
    const sessionId = requireSessionId(envelope);
    const session = this.service.getSession(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    this.respond(client, envelope, session.snapshot(), sessionId);
  }

  private bindSessionEvents(connection: EnvelopeConnection, session: Awaited<ReturnType<VocalService["startLiveTranscription"]>>): void {
    session.on("status", (payload) => this.event(connection, "session.status", payload, session.sessionId));
    session.on("preview", (payload) => this.event(connection, "transcript.preview", payload, session.sessionId));
    session.on("final", (payload) => this.event(connection, "transcript.final", payload, session.sessionId));
    session.on("polished", (payload) => this.event(connection, "transcript.polished", payload, session.sessionId));
    session.on("warning", (payload) => this.event(connection, "session.warning", payload, session.sessionId));
    session.on("error", (payload) => this.event(connection, "session.error", payload, session.sessionId));
    session.on("stopped", (payload) => this.event(connection, "session.stopped", payload, session.sessionId));
  }

  private respond(client: ClientState, request: IpcEnvelope, payload: unknown, sessionId?: string): void {
    client.connection.send(createEnvelope({
      id: request.id,
      payload,
      sessionId,
      type: "response",
    }));
  }

  private event(connection: EnvelopeConnection, method: string, payload: unknown, sessionId?: string): void {
    connection.send(createEnvelope({
      method,
      payload,
      sessionId,
      type: "event",
    }));
  }

  private async cleanupClient(client: ClientState): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    await Promise.all(
      [...client.autostopSessions].map(async (sessionId) => {
        await this.service.getSession(sessionId)?.stop();
      }),
    );
  }

  private throwServerError(error: Error): void {
    throw error;
  }
}

export function createVocalIpcServer(options: VocalIpcServerOptions = {}): VocalIpcServer {
  return new VocalIpcServer(options);
}

function normalizeLiveOptions(payload: Record<string, unknown>): LiveTranscriptionOptions {
  return {
    audioContext: numberValue(payload.audioContext ?? payload.audioCtx),
    autostopOnDisconnect: booleanValue(payload.autostopOnDisconnect),
    backend: backendValue(payload.backend),
    beamSize: numberValue(payload.beamSize),
    carryInitialPrompt: booleanValue(payload.carryInitialPrompt),
    capture: numberValue(payload.capture),
    freqThreshold: numberValue(payload.freqThreshold),
    hallucinationGuardPhrases: Array.isArray(payload.hallucinationGuardPhrases)
      ? (stringArrayValue(payload.hallucinationGuardPhrases) ?? [])
      : undefined,
    initialPrompt: promptValue(payload.initialPrompt ?? payload.prompt),
    keep: numberValue(payload.keep),
    keepContext: booleanValue(payload.keepContext),
    language: stringValue(payload.language),
    length: numberValue(payload.length),
    logprobThreshold: numberValue(payload.logprobThreshold),
    lowLatency: booleanValue(payload.lowLatency),
    maxDecodeSilenceMs: numberValue(payload.maxDecodeSilenceMs),
    maxTokens: numberValue(payload.maxTokens),
    minSpeechMs: numberValue(payload.minSpeechMs),
    metadata: objectValue(payload.metadata),
    modelPath: stringValue(payload.modelPath ?? payload.model),
    noFallback: payload.noFallback === undefined ? payload.fallback === false : booleanValue(payload.noFallback),
    noSpeechThreshold: numberValue(payload.noSpeechThreshold),
    polish: polishValue(payload),
    prompt: promptValue(payload.prompt),
    printSpecial: booleanValue(payload.printSpecial),
    saveAudio: booleanValue(payload.saveAudio),
    silenceHangoverMs: numberValue(payload.silenceHangoverMs),
    diagnostics: booleanValue(payload.diagnostics),
    sessionId: stringValue(payload.sessionId),
    step: numberValue(payload.step),
    threads: numberValue(payload.threads),
    tinydiarize: booleanValue(payload.tinydiarize),
    translate: booleanValue(payload.translate),
    vadThreshold: numberValue(payload.vadThreshold),
    vadModelPath: stringValue(payload.vadModelPath),
  };
}

function normalizeFileOptions(payload: Record<string, unknown>): FileTranscriptionOptions {
  const filePath = stringValue(payload.filePath ?? payload.file);
  if (!filePath) {
    throw new Error("transcribe.file requires payload.filePath.");
  }

  return {
    ...normalizeLiveOptions(payload),
    entropyThreshold: numberValue(payload.entropyThreshold),
    filePath,
    logprobThreshold: numberValue(payload.logprobThreshold),
    noSpeechThreshold: numberValue(payload.noSpeechThreshold),
    suppressNonSpeechTokens: booleanValue(payload.suppressNonSpeechTokens),
  };
}

function polishValue(payload: Record<string, unknown>): LiveTranscriptionOptions["polish"] {
  const direct = payload.polish;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const record = direct as Record<string, unknown>;
    return {
      enabled: booleanValue(record.enabled),
      mode: polishModeValue(record.mode),
      model: stringValue(record.model),
    };
  }

  return {
    enabled: booleanValue(direct),
    model: stringValue(payload.polishModel),
  };
}

function polishModeValue(value: unknown): NonNullable<LiveTranscriptionOptions["polish"]>["mode"] {
  if (value === "manual" || value === "live") {
    return value;
  }

  return undefined;
}

function promptValue(value: unknown): LiveTranscriptionOptions["prompt"] {
  if (typeof value === "string") {
    return stringValue(value);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return {
    formatting: stringArrayValue(record.formatting),
    phrases: stringArrayValue(record.phrases),
    punctuation: stringArrayValue(record.punctuation),
    text: stringValue(record.text),
    vocabulary: stringArrayValue(record.vocabulary ?? record.commonVocabulary),
  };
}

function backendValue(value: unknown): LiveTranscriptionOptions["backend"] {
  if (value === "auto" || value === "cpu" || value === "vulkan" || value === "hip") {
    return value;
  }
  if (value === undefined) {
    return undefined;
  }
  throw new Error(`Invalid backend: ${String(value)}`);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return strings.length > 0 ? strings : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function objectValue(value: unknown): LiveTranscriptionOptions["metadata"] {
  return value && typeof value === "object" && !Array.isArray(value) ? value as LiveTranscriptionOptions["metadata"] : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requireSessionId(envelope: IpcEnvelope): string {
  if (!envelope.sessionId) {
    throw new Error(`${envelope.method} requires sessionId.`);
  }
  return envelope.sessionId;
}

function errorToPayload(error: unknown): { code: string; message: string } {
  return {
    code: "session.error",
    message: error instanceof Error ? error.message : String(error),
  };
}
