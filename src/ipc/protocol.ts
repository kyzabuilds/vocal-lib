export const ipcProtocolName = "vocal.ipc" as const;
export const ipcProtocolVersion = 1 as const;

export type IpcEnvelopeType = "request" | "response" | "event" | "error";

export interface IpcEnvelope {
  protocol: typeof ipcProtocolName;
  version: typeof ipcProtocolVersion;
  id?: string;
  type: IpcEnvelopeType;
  method?: string;
  sessionId?: string;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class IpcProtocolError extends Error {
  constructor(
    message: string,
    readonly code = "protocol.invalid",
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function createEnvelope(input: Omit<IpcEnvelope, "protocol" | "version">): IpcEnvelope {
  return {
    protocol: ipcProtocolName,
    version: ipcProtocolVersion,
    ...input,
  };
}

export function encodeEnvelope(envelope: IpcEnvelope): string {
  validateEnvelope(envelope);
  return `${JSON.stringify(envelope)}\n`;
}

export function decodeEnvelope(line: string): IpcEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new IpcProtocolError("IPC message is not valid JSON.", "protocol.json", error);
  }

  validateEnvelope(parsed);
  return parsed;
}

export function validateEnvelope(value: unknown): asserts value is IpcEnvelope {
  if (!value || typeof value !== "object") {
    throw new IpcProtocolError("IPC message must be an object.");
  }

  const envelope = value as Partial<IpcEnvelope>;
  if (envelope.protocol !== ipcProtocolName) {
    throw new IpcProtocolError(`Unsupported IPC protocol: ${String(envelope.protocol)}`, "protocol.name");
  }

  if (envelope.version !== ipcProtocolVersion) {
    throw new IpcProtocolError(`Unsupported IPC protocol version: ${String(envelope.version)}`, "protocol.version");
  }

  if (envelope.type !== "request" && envelope.type !== "response" && envelope.type !== "event" && envelope.type !== "error") {
    throw new IpcProtocolError(`Unsupported IPC message type: ${String(envelope.type)}`, "protocol.type");
  }

  if ((envelope.type === "request" || envelope.type === "event") && typeof envelope.method !== "string") {
    throw new IpcProtocolError("IPC request/event messages require a method.", "protocol.method");
  }

  if ((envelope.type === "response" || envelope.type === "error") && envelope.id !== undefined && typeof envelope.id !== "string") {
    throw new IpcProtocolError("IPC response/error id must be a string when present.", "protocol.id");
  }

  if (envelope.sessionId !== undefined && typeof envelope.sessionId !== "string") {
    throw new IpcProtocolError("IPC sessionId must be a string when present.", "protocol.sessionId");
  }
}

export function errorEnvelope(error: unknown, id?: string): IpcEnvelope {
  if (error instanceof IpcProtocolError) {
    return createEnvelope({
      id,
      type: "error",
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
  }

  return createEnvelope({
    id,
    type: "error",
    error: {
      code: "internal.error",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}
