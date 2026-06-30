import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { encodeEnvelope, decodeEnvelope, type IpcEnvelope } from "./protocol.js";

export interface EnvelopeConnectionEvents {
  close: [];
  envelope: [IpcEnvelope];
  error: [Error];
}

export class EnvelopeConnection extends EventEmitter {
  private buffer = "";

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {
    super();
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.readChunk(chunk));
    input.on("error", (error) => this.emit("error", error));
    input.on("close", () => this.emit("close"));
    input.on("end", () => this.emit("close"));
  }

  override on<K extends keyof EnvelopeConnectionEvents>(
    eventName: K,
    listener: (...args: EnvelopeConnectionEvents[K]) => void,
  ): this {
    return super.on(eventName, listener);
  }

  send(envelope: IpcEnvelope): void {
    this.output.write(encodeEnvelope(envelope));
  }

  close(): void {
    if ("end" in this.output && typeof this.output.end === "function") {
      this.output.end();
    }
  }

  private readChunk(chunk: string): void {
    this.buffer += chunk;
    for (; ;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) {
        return;
      }

      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) {
        continue;
      }

      try {
        this.emit("envelope", decodeEnvelope(line));
      } catch (error) {
        this.emit("error", error);
      }
    }
  }
}

export function connectSocket(endpoint: string): Promise<EnvelopeConnection> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    socket.once("connect", () => resolve(new EnvelopeConnection(socket, socket)));
    socket.once("error", reject);
  });
}

export function socketFromStream(socket: Socket): EnvelopeConnection {
  return new EnvelopeConnection(socket, socket);
}
