import { defaultOpenRouterTimeoutMs, OpenRouterClient, type OpenRouterConfig } from "../llm/openrouter.js";

export interface TranscriptPolisherOptions {
  config: OpenRouterConfig;
  maxContextChars?: number;
  maxInputChars?: number;
  onPolished: (event: PolishedTranscriptEvent) => void;
  onWarning?: (message: string) => void;
  timeoutMs?: number;
}

export interface PolishedTranscriptEvent {
  raw: string;
  text: string;
  sequence: number;
}

export class TranscriptPolisher {
  private readonly client: OpenRouterClient;
  private readonly maxContextChars: number;
  private readonly maxInputChars: number;
  private readonly timeoutMs: number;
  private controller: AbortController | undefined;
  private context = "";
  private sequence = 0;
  private warned = false;

  constructor(private readonly options: TranscriptPolisherOptions) {
    this.client = new OpenRouterClient(options.config);
    this.maxContextChars = options.maxContextChars ?? 1_200;
    this.maxInputChars = options.maxInputChars ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? defaultOpenRouterTimeoutMs;
  }

  async polish(rawText: string): Promise<void> {
    const input = rawText.trim();
    if (!input) {
      return;
    }

    this.context = keepTail(joinText(this.context, input), this.maxContextChars);

    if (!this.options.config.apiKey) {
      this.warn("OpenRouter polishing is enabled, but VOCAL_OPENROUTER_API_KEY is not configured. Continuing with raw transcript.");
      return;
    }

    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const sequence = ++this.sequence;

    try {
      const text = await this.client.polishText({
        input: keepHead(input, this.maxInputChars),
        priorContext: contextBeforeCurrent(this.context, input, this.maxContextChars),
        signal: controller.signal,
        timeoutMs: this.timeoutMs,
      });

      if (controller.signal.aborted || sequence !== this.sequence) {
        return;
      }

      this.options.onPolished({ raw: input, text, sequence });
    } catch (error: unknown) {
      if (controller.signal.aborted || sequence !== this.sequence) {
        return;
      }

      this.warn(formatWarning(error));
    }
  }

  dispose(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  private warn(message: string): void {
    if (this.warned) {
      return;
    }

    this.warned = true;
    this.options.onWarning?.(message);
  }
}

function contextBeforeCurrent(context: string, input: string, maxLength: number): string | undefined {
  const previous = context.endsWith(input) ? context.slice(0, -input.length).trim() : context;
  return previous.length > 0 ? keepTail(previous, maxLength) : undefined;
}

function formatWarning(error: unknown): string {
  if (error instanceof Error) {
    return `OpenRouter polishing failed: ${error.message} Continuing with raw transcript.`;
  }

  return "OpenRouter polishing failed. Continuing with raw transcript.";
}

function joinText(...parts: string[]): string {
  return parts.filter((part) => part.trim().length > 0).join(" ").replace(/\s+/g, " ").trim();
}

function keepHead(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength).trim();
}

function keepTail(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(value.length - maxLength).replace(/^\S+\s*/, "").trim();
}
