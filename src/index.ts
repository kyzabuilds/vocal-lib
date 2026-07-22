export { connectVocalClient, connectVocalGateway, createVocalClient, VocalGatewayClient } from "./ipc/client.js";
export type {
  ConnectVocalGatewayOptions,
  VocalClientListenOptions,
  VocalClientTranscriptEvent,
  VocalClientTranscriptStream,
  VocalClientTranscribeOptions,
  VocalCompatibilityClient,
  VocalGatewayClientEvents,
  VocalGatewaySession,
  VocalGatewayStartedEvent,
} from "./ipc/client.js";
export { createVocalIpcServer, VocalIpcServer } from "./ipc/server.js";
export type { VocalIpcServerOptions } from "./ipc/server.js";
export {
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  IpcProtocolError,
  ipcProtocolName,
  ipcProtocolVersion,
} from "./ipc/protocol.js";
export type { IpcEnvelope } from "./ipc/protocol.js";
export { createVocalService, VocalService } from "./service/vocal-service.js";
export type { ResolveConfigOptions, VocalServiceStatus } from "./service/vocal-service.js";
export { resolveVocalConfig } from "./service/config.js";
export type { ResolvedVocalConfig, VocalServiceConfigInput } from "./service/config.js";
export type {
  FileTranscriptionOptions,
  FileTranscriptionResult,
  AudioVisualizationEvent,
  JsonObject,
  JsonValue,
  LiveSessionStatus,
  LiveTranscriptionOptions,
  SessionErrorEvent,
  SessionStatusEvent,
  SessionStoppedEvent,
  SessionWarningEvent,
  TranscriptFinalEvent,
  TranscriptPolishedEvent,
  TranscriptPreviewEvent,
} from "./service/events.js";
export type { DiagnosticCheck, DoctorOptions, DoctorResult } from "./service/diagnostics.js";
export type { ListModelsOptions, ModelInfo, ModelListResult } from "./service/models.js";
export type { LiveSessionSnapshot } from "./service/live-session.js";
export {
  OpenRouterTranscriptPolisherProvider,
  TranscriptPolisher,
} from "./engine/transcript-polisher.js";
export type {
  PolishedTranscriptEvent,
  TranscriptPolisherProvider,
} from "./engine/transcript-polisher.js";
export type { AudioVisualizationData, AudioVisualizationOptions, Backend, WhisperDecoderPrompt, WhisperDecoderPromptInput, WhisperStreamOptions } from "./engine/types.js";
