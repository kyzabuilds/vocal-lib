export const defaultOpenRouterBaseUrl = "https://openrouter.ai/api/v1";
export const defaultOpenRouterModel = "google/gemini-2.5-flash-lite";
export const defaultOpenRouterPreflightTtlMs = 30_000;
export const defaultOpenRouterPreflightTimeoutMs = 1_000;
export const defaultOpenRouterTimeoutMs = 3_000;

export interface OpenRouterConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
}

export interface PolishRequest {
  input: string;
  priorContext?: string;
  preflightTimeoutMs?: number;
  signal?: AbortSignal;
  systemPrompt?: string;
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    text?: string;
    message?: {
      content?: ChatMessageContent;
    };
  }>;
  error?: {
    message?: string;
  };
}

type ChatMessageContent = unknown;

export const transcriptPolishSystemPrompt = [
  "Reformat the raw speech transcript into a clean, natural statement.",
  "Return only the polished text. Do not add labels, markdown, quotes, commentary, or explanations.",
  "Fix casing, punctuation, sentence boundaries, spacing, and paragraph breaks.",
  "Treat the input as dictated speech that may include ASR mistakes and speaker mistakes.",
  "Remove filler, stutters, repeated overlap, false starts, trailing apologies, and abandoned wording when they are not part of the intended message.",
  "Correct obvious homophones, wrong word boundaries, and near-phonetic errors when context makes the intended wording clear.",
  "Preserve the speaker's intent, tone, ordering of ideas, names, numbers, commands, and technical terms.",
  "Do not answer questions, add facts, summarize, or make uncertain guesses.",
  "If the text is already clean, return it unchanged.",
].join("\n");

export function readOpenRouterConfig(env: NodeJS.ProcessEnv = process.env): OpenRouterConfig {
  return {
    apiKey: cleanOptional(env.VOCAL_OPENROUTER_API_KEY),
    baseUrl: cleanOptional(env.VOCAL_OPENROUTER_BASE_URL) ?? defaultOpenRouterBaseUrl,
    model: cleanOptional(env.VOCAL_OPENROUTER_MODEL) ?? defaultOpenRouterModel,
  };
}

export class OpenRouterClient {
  private lastPreflight: { checkedAt: number; key: string } | undefined;

  constructor(private readonly config: OpenRouterConfig) {}

  async polishText(request: PolishRequest): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error("VOCAL_OPENROUTER_API_KEY is not configured.");
    }

    await this.preflight({
      signal: request.signal,
      timeoutMs: request.preflightTimeoutMs ?? defaultOpenRouterPreflightTimeoutMs,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? defaultOpenRouterTimeoutMs);
    const onAbort = (): void => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetch(`${trimTrailingSlash(this.config.baseUrl)}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/local-first/vocal-cli",
          "X-OpenRouter-Title": "Vocal CLI",
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: "system",
              content: request.systemPrompt ?? transcriptPolishSystemPrompt,
            },
            {
              role: "user",
              content: buildUserPrompt(request.input, request.priorContext),
            },
          ],
          temperature: 0,
          max_tokens: maxPolishTokens(request.input),
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as ChatCompletionResponse | null;
        const detail = body?.error?.message ? ` ${body.error.message}` : "";
        throw new Error(`OpenRouter request failed with HTTP ${response.status}.${detail}`);
      }

      const body = (await response.json().catch(() => null)) as ChatCompletionResponse | null;
      const content = extractChoiceText(body);
      if (!content) {
        throw new Error(`OpenRouter returned a response without polished text (${summarizeResponseShape(body)}).`);
      }

      return normalizePolishedText(content);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("OpenRouter polish request timed out or was aborted.");
      }

      throw error;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async preflight(options: { signal?: AbortSignal; timeoutMs: number }): Promise<void> {
    const key = `${this.config.baseUrl}\n${this.config.model}`;
    if (this.lastPreflight?.key === key && Date.now() - this.lastPreflight.checkedAt < defaultOpenRouterPreflightTtlMs) {
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetch(`${trimTrailingSlash(this.config.baseUrl)}${modelEndpointsPath(this.config.model)}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "HTTP-Referer": "https://github.com/local-first/vocal-cli",
          "X-OpenRouter-Title": "Vocal CLI",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as ChatCompletionResponse | null;
        const detail = body?.error?.message ? ` ${body.error.message}` : "";
        throw new Error(`OpenRouter preflight failed with HTTP ${response.status}.${detail}`);
      }

      this.lastPreflight = { checkedAt: Date.now(), key };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("OpenRouter preflight timed out or was aborted.");
      }

      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function extractChoiceText(body: ChatCompletionResponse | null): string | null {
  const choice = body?.choices?.[0];
  return extractTextContent(choice?.message?.content) ?? extractTextContent(choice?.text);
}

function extractTextContent(content: ChatMessageContent | undefined, options: { trim?: boolean } = {}): string | null {
  const shouldTrim = options.trim ?? true;

  if (typeof content === "string") {
    const text = shouldTrim ? content.trim() : content;
    return text.length > 0 ? text : null;
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((part) => extractTextContent(part, options) ?? "")
      .join("");
    const text = shouldTrim ? joined.trim() : joined;

    return text.length > 0 ? text : null;
  }

  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    for (const key of ["text", "content", "output_text", "value"]) {
      const extracted = extractTextContent(record[key], options);
      if (extracted) {
        return extracted;
      }
    }
  }

  return null;
}

function summarizeResponseShape(body: ChatCompletionResponse | null): string {
  if (!body) {
    return "empty or invalid JSON";
  }

  const bodyKeys = Object.keys(body);
  if (looksLikeOpenRouterGenerationMetadata(body as Record<string, unknown>)) {
    return `generation metadata instead of chat completion (${bodyKeys.slice(0, 5).join(", ")})`;
  }

  const choice = body.choices?.[0];
  if (!choice) {
    return `no choices; top-level keys: ${bodyKeys.slice(0, 8).join(", ") || "none"}`;
  }

  const content = choice.message?.content ?? choice.text;
  if (Array.isArray(content)) {
    const types = content
      .map((part) =>
        part && typeof part === "object" && typeof (part as Record<string, unknown>).type === "string"
          ? (part as Record<string, unknown>).type
          : "unknown",
      )
      .join(", ");
    return `content parts: ${types || "none"}`;
  }

  if (content && typeof content === "object") {
    return `content object keys: ${Object.keys(content).join(", ") || "none"}`;
  }

  return `content type: ${typeof content}`;
}

function buildUserPrompt(input: string, priorContext: string | undefined): string {
  const parts = [];
  const context = priorContext?.trim();
  if (context) {
    parts.push(`Prior transcript context. Use this only to keep names, terms, and topic continuity consistent. Do not rewrite it:\n<context>\n${context}\n</context>`);
  }

  parts.push(`Polish only this raw transcript chunk:\n<raw_transcript>\n${input}\n</raw_transcript>`);
  return parts.join("\n\n");
}

function maxPolishTokens(input: string): number {
  return Math.min(4096, Math.max(128, Math.ceil(input.length / 3) + 128));
}

function modelEndpointsPath(model: string): string {
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0 || slashIndex === model.length - 1) {
    throw new Error(`OpenRouter model must use author/slug format for preflight: ${model}`);
  }

  const author = encodeURIComponent(model.slice(0, slashIndex));
  const slug = encodeURIComponent(model.slice(slashIndex + 1));
  return `/models/${author}/${slug}/endpoints`;
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}

function normalizePolishedText(value: string): string {
  const metadata = parseJsonObject(value);
  if (metadata && looksLikeOpenRouterGenerationMetadata(metadata)) {
    throw new Error("OpenRouter returned generation metadata instead of polished text.");
  }

  return stripWrappingQuotes(value);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function looksLikeOpenRouterGenerationMetadata(value: Record<string, unknown>): boolean {
  return "generation_id" in value && "provider_name" in value && "api_key" in value;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
