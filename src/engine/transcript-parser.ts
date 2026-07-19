export interface TranscriptEvent {
  text: string;
  raw: string;
}

export interface TranscriptStreamUpdate {
  finals: TranscriptEvent[];
  preview?: TranscriptEvent;
}

// whisper-stream's stdout is a terminal render stream, not line-delimited data, and
// it has two very different shapes depending on --step:
//   - sliding-window mode (--step > 0) repeatedly emits `\33[2K\r<window text>` to
//     overwrite the current line, then a bare `\n` (every n_new_line steps) to commit it.
//   - VAD mode (--step 0) transcribes the trailing --length seconds every time it
//     detects a pause, WITHOUT clearing its audio buffer. Consecutive transcriptions
//     therefore overlap by several seconds and re-decode the same words (often
//     differently as more right-context arrives), wrapped in `### Transcription N
//     START/END` markers with `[t0 --> t1] text` segments inside.
// For VAD we run LocalAgreement-2: a word is only committed once two consecutive
// overlapping windows agree on it; the unstable tail stays a preview. For the
// sliding-window mode we faithfully interpret the control codes (CR / erase-line =
// reset current line, LF = commit). The project-owned vocal-stream adds an ASCII
// record separator after every redraw and a file separator after its full-utterance
// decode. Rolling hypotheses remain provisional; only that complete decode is final.
const ansiCsi = /^\x1b\[[0-?]*[ -/]*([@-~])/;
// A possibly-incomplete CSI sequence: ESC, optional `[`, params, no final byte yet.
const partialCsi = /^\x1b\[?[0-?]*[ -/]*$/;
const blockStart = /^### Transcription \d+ START/i;
const blockEnd = /^### Transcription \d+ END/i;
const defaultTrailingSilencePhrases = ["thank you"];

export interface TranscriptStreamFilterOptions {
  /**
   * Phrases held as previews when their confirming hypothesis comes from a
   * VAD-negative trailing-silence decode. Pass [] to disable the narrow guard.
   */
  trailingSilencePhrases?: readonly string[];
  onDecision?: (decision: TranscriptAgreementDecision) => void;
}

export interface TranscriptAgreementDecision {
  action: "committed" | "finalized" | "held" | "previewed" | "reconciled";
  committed: string;
  hypothesis: string;
  preview: string;
  trailingSilence: boolean;
}

export class TranscriptStreamFilter {
  private line = "";
  private carry = ""; // trailing bytes of an escape sequence split across chunks

  // sliding-window (--step > 0) state
  private lastFinal = "";
  private lastPreview = "";

  // project-owned vocal-stream state
  private projectStream = false;
  private projectAgreement = new Agreement();
  private projectConfirmed = "";
  private projectSpeechSupported = "";
  private lastProjectPreview = "";

  // VAD (--step 0) state
  private vad = false;
  private inBlock = false;
  private block: string[] = [];
  private agreement = new Agreement();
  private confirmedBuffer = ""; // confirmed words not yet flushed as a sentence line
  private lastVadPreview = "";

  constructor(private readonly options: TranscriptStreamFilterOptions = {}) {}

  write(input: string): TranscriptStreamUpdate {
    const finals: TranscriptEvent[] = [];
    const chunk = this.carry + input;
    this.carry = "";

    for (let index = 0; index < chunk.length; ) {
      const char = chunk[index];

      if (char === "\x1b") {
        const rest = chunk.slice(index);
        const match = ansiCsi.exec(rest);
        if (match) {
          if (match[1] === "K") this.line = ""; // erase-line: clear current line
          index += match[0].length;
          continue;
        }
        if (partialCsi.test(rest)) {
          this.carry = rest; // sequence split across chunks; finish it next write
          break;
        }
        index += 1; // lone ESC
        continue;
      }

      if (char === "\r") {
        this.line = ""; // binary always clears+reprints, so CR resets the line
        index += 1;
        continue;
      }

      if (char === "\x1e") {
        this.projectStream = true;
        this.handleProjectHypothesis(this.line, finals);
        this.line = "";
        index += 1;
        continue;
      }

      if (char === "\x1d") {
        this.projectStream = true;
        this.handleProjectHypothesis(this.line, finals, true);
        this.line = "";
        index += 1;
        continue;
      }

      if (char === "\x1c") {
        this.projectStream = true;
        this.handleProjectFinal(this.line, finals);
        this.line = "";
        index += 1;
        continue;
      }

      if (char === "\n") {
        this.handleLine(this.line, finals);
        this.line = "";
        index += 1;
        continue;
      }

      if (char >= " " || char === "\t") {
        this.line += char;
      }

      index += 1;
    }

    return { finals, preview: this.peekPreview() };
  }

  flush(): TranscriptEvent | null {
    if (this.projectStream) {
      // SIGINT can stop the native process before it gets a chance to run the
      // full-utterance decode. Preserve the speech-gated provisional transcript
      // rather than silently dropping everything the user just said.
      const tail = this.projectText();
      this.resetProjectUtterance();
      this.line = "";
      return tail.length > 0 ? { text: tail, raw: tail } : null;
    }

    if (this.vad) {
      const tail = joinText(this.confirmedBuffer, this.agreement.tentativeText());
      this.agreement.acceptTentative();
      this.confirmedBuffer = "";
      this.lastVadPreview = "";
      return tail.length > 0 ? { text: tail, raw: tail } : null;
    }

    const event = this.commit(this.line);
    this.line = "";
    return event;
  }

  hasPending(): boolean {
    if (this.projectStream) {
      return false;
    }

    if (this.vad) {
      return this.confirmedBuffer.length > 0 || this.agreement.tentativeText().length > 0;
    }

    return cleanTranscriptText(stripMarkers(this.line)).length > 0;
  }

  private handleLine(raw: string, finals: TranscriptEvent[]): void {
    const trimmed = raw.trim();

    if (this.projectStream) {
      if (trimmed) this.handleProjectHypothesis(raw, finals);
      const fallback = this.projectText();
      if (fallback) {
        finals.push({ text: fallback, raw });
      }
      this.resetProjectUtterance();
      return;
    }

    if (blockStart.test(trimmed)) {
      this.vad = true;
      this.inBlock = true;
      this.block = [];
      return;
    }

    if (blockEnd.test(trimmed)) {
      if (this.inBlock) {
        this.inBlock = false;
        this.endBlock(finals);
      }
      return;
    }

    if (this.vad) {
      if (this.inBlock) {
        const text = cleanTranscriptText(stripMarkers(raw));
        if (text) this.block.push(text);
      }
      return;
    }

    const event = this.commit(raw);
    if (event) finals.push(event);
  }

  private endBlock(finals: TranscriptEvent[]): void {
    const blockText = cleanTranscriptText(this.block.join(" "));
    this.block = [];
    if (!blockText) return;

    const confirmed = this.agreement.feed(blockText);
    if (confirmed) {
      this.confirmedBuffer = joinText(this.confirmedBuffer, confirmed);
    }

    this.flushSentences(finals);
  }

  private handleProjectHypothesis(raw: string, finals: TranscriptEvent[], trailingSilence = false): void {
    const text = cleanStreamingHypothesis(stripMarkers(raw));
    if (!text) return;

    const protectedPhrases = trailingSilence
      ? (this.options.trailingSilencePhrases ?? defaultTrailingSilencePhrases)
      : [];
    const confirmed = this.projectAgreement.feed(text, protectedPhrases);
    if (confirmed) {
      this.projectConfirmed = joinText(this.projectConfirmed, confirmed);
      if (!trailingSilence) {
        this.projectSpeechSupported = joinText(this.projectSpeechSupported, confirmed);
      }
    }
    const preview = this.projectText();
    this.options.onDecision?.({
      action: this.projectAgreement.tentativeHidden() ? "held" : (confirmed ? "committed" : "previewed"),
      committed: confirmed,
      hypothesis: text,
      preview,
      trailingSilence,
    });
  }

  private handleProjectFinal(raw: string, finals: TranscriptEvent[]): void {
    const decoded = cleanStreamingHypothesis(stripMarkers(raw));
    const preview = this.projectText();
    const reconciliation = decoded
      ? reconcileSupportedPrefix(this.projectSpeechSupported, decoded)
      : { text: preview, prefix: "" };
    const text = reconciliation.text;
    if (text) {
      finals.push({ text, raw });
    }
    this.options.onDecision?.({
      action: reconciliation.prefix ? "reconciled" : "finalized",
      committed: reconciliation.prefix,
      hypothesis: decoded,
      preview,
      trailingSilence: false,
    });
    this.resetProjectUtterance();
  }

  private projectText(): string {
    return joinText(this.projectConfirmed, this.projectAgreement.tentativeText());
  }

  private resetProjectUtterance(): void {
    this.projectAgreement = new Agreement();
    this.projectConfirmed = "";
    this.projectSpeechSupported = "";
    this.lastProjectPreview = "";
  }

  // Emit a final line for every complete sentence in the confirmed buffer, keeping
  // any trailing incomplete sentence for the next block.
  private flushSentences(finals: TranscriptEvent[]): void {
    const buffer = this.confirmedBuffer;
    const sentenceEnd = /[.?!](?=\s|$)/g;
    let lastEnd = -1;
    let match: RegExpExecArray | null;
    while ((match = sentenceEnd.exec(buffer)) !== null) {
      lastEnd = match.index;
    }

    if (lastEnd < 0) return;

    const done = buffer.slice(0, lastEnd + 1).trim();
    this.confirmedBuffer = buffer.slice(lastEnd + 1).trim();
    for (const sentence of done.match(/.+?[.?!]+(?=\s|$)/g) ?? [done]) {
      const text = sentence.trim();
      if (text) finals.push({ text, raw: text });
    }
  }

  private commit(line: string): TranscriptEvent | null {
    const text = cleanTranscriptText(stripMarkers(line));
    if (text.length === 0) return null;

    const deduped = trimSeamOverlap(this.lastFinal, text);
    if (deduped.length === 0) return null;

    this.lastFinal = text;
    this.lastPreview = "";
    return { text: deduped, raw: line };
  }

  private peekPreview(): TranscriptEvent | undefined {
    if (this.projectStream) {
      const text = this.projectText();
      if (text.length === 0) {
        if (this.lastProjectPreview.length === 0 || !this.projectAgreement.tentativeHidden()) return undefined;
        this.lastProjectPreview = "";
        return { text: "", raw: "" };
      }
      if (text === this.lastProjectPreview) return undefined;

      this.lastProjectPreview = text;
      return { text, raw: text };
    }

    if (this.vad) {
      const text = joinText(this.confirmedBuffer, this.agreement.tentativeText());
      if (text.length === 0 || text === this.lastVadPreview) return undefined;

      this.lastVadPreview = text;
      return { text, raw: text };
    }

    const text = trimSeamOverlap(this.lastFinal, cleanTranscriptText(stripMarkers(this.line)));
    if (text.length === 0 || text === this.lastPreview) return undefined;

    this.lastPreview = text;
    return { text, raw: this.line };
  }
}

// LocalAgreement-2: whisper-stream re-decodes an overlapping trailing window on every
// pause, so each window is a fresh hypothesis of the same recent speech. We commit a
// word only once two consecutive windows agree on it; the still-unstable tail is held
// back as a preview. Already-committed words are stripped from the front of each new
// window by aligning its prefix against the committed tail.
export class Agreement {
  private committed: Token[] = [];
  private prev: Token[] = []; // uncommitted tail of the previous window
  private hiddenTailTokenCount = 0;

  feed(blockText: string, protectedTrailingPhrases: readonly string[] = []): string {
    const window = tokens(blockText);
    const fresh = this.dropCommitted(window);
    let agreed = commonPrefixLength(this.prev, fresh);
    let advancedPrefix: Token[] = [];
    let advancedOverlap: Token[] = [];

    // A short rolling audio window eventually drops its oldest words. When the
    // new hypothesis starts with a suffix of the previous one, preserve the
    // words that slid out and treat the overlap as consecutive agreement.
    if (agreed === 0) {
      const overlap = suffixPrefixOverlapLength(this.prev, fresh);
      if (overlap > 0) {
        advancedPrefix = this.prev.slice(0, this.prev.length - overlap);
        advancedOverlap = this.prev.slice(this.prev.length - overlap);
        agreed = overlap;
      }
    }

    this.hiddenTailTokenCount = protectedTailLength(fresh, protectedTrailingPhrases);
    const confirmLength = Math.min(agreed, fresh.length - this.hiddenTailTokenCount);
    const confirmed = [
      ...advancedPrefix,
      ...(advancedOverlap.length > 0
        ? advancedOverlap.slice(0, confirmLength)
        : fresh.slice(0, confirmLength)),
    ];

    this.committed.push(...confirmed);
    // ponytail: unbounded transcripts only need a short lookback to re-align windows.
    if (this.committed.length > 256) this.committed.splice(0, this.committed.length - 256);
    // Keep a guarded trailing phrase in the tentative tail whether it is new or
    // agreed. A later speech-positive hypothesis can still confirm it; an
    // utterance boundary discards it.
    this.prev = fresh.slice(confirmLength);

    return tokenText(confirmed);
  }

  tentativeText(): string {
    return tokenText(this.prev.slice(0, this.prev.length - this.hiddenTailTokenCount));
  }

  tentativeHidden(): boolean {
    return this.hiddenTailTokenCount > 0;
  }

  acceptTentative(): void {
    this.committed.push(...this.prev);
    this.prev = [];
    this.hiddenTailTokenCount = 0;
  }

  // Drop the leading words of a window that reproduce the committed tail. Handles both
  // refined re-transcriptions (window restates confirmed words) and a slid buffer
  // (window's front overlaps the committed tail). ponytail: if whisper re-spells a
  // committed word the alignment shortens and that word can re-print once.
  private dropCommitted(window: Token[]): Token[] {
    const maxOverlap = Math.min(this.committed.length, window.length, 64);
    for (let length = maxOverlap; length >= 1; length -= 1) {
      const tail = this.committed.slice(this.committed.length - length);
      if (tokensEqual(tail, window.slice(0, length))) {
        return window.slice(length);
      }
    }

    return window;
  }
}

interface Token {
  text: string;
  norm: string;
}

function tokens(text: string): Token[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((piece) => ({ text: piece, norm: piece.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") }))
    .filter((token) => token.norm.length > 0);
}

function tokenText(tokenList: Token[]): string {
  return tokenList.map((token) => token.text).join(" ");
}

function tokensEqual(a: Token[], b: Token[]): boolean {
  return a.length === b.length && a.every((token, index) => token.norm === b[index].norm);
}

function commonPrefixLength(a: Token[], b: Token[]): number {
  const limit = Math.min(a.length, b.length);
  let length = 0;
  while (length < limit && a[length].norm === b[length].norm) {
    length += 1;
  }

  return length;
}

function suffixPrefixOverlapLength(previous: Token[], current: Token[]): number {
  const limit = Math.min(previous.length, current.length);
  for (let length = limit; length >= 1; length -= 1) {
    if (tokensEqual(previous.slice(previous.length - length), current.slice(0, length))) {
      return length;
    }
  }

  return 0;
}

function reconcileSupportedPrefix(
  supportedText: string,
  authoritativeText: string,
): { text: string; prefix: string } {
  const supported = tokens(supportedText);
  const authoritative = tokens(authoritativeText);
  if (supported.length < 3 || authoritative.length < 2) {
    return { text: authoritativeText, prefix: "" };
  }

  const maximum = Math.min(supported.length, authoritative.length);
  for (let overlap = maximum; overlap >= 2; overlap -= 1) {
    const prefixLength = supported.length - overlap;
    if (prefixLength === 0) return { text: authoritativeText, prefix: "" };
    if (!tokensEqual(
      supported.slice(prefixLength),
      authoritative.slice(0, overlap),
    )) continue;

    // Two matching words are sufficient only when they cover at least half of
    // the authoritative decode (including a short "we notice" final). Longer
    // finals require three matching words. This prevents a generic one- or
    // two-word coincidence from resurrecting an unrelated rolling hypothesis.
    const strongOverlap = overlap >= 3
      || overlap === authoritative.length
      || overlap * 2 >= authoritative.length;
    if (!strongOverlap) continue;

    const prefix = tokenText(supported.slice(0, prefixLength));
    // Preserve the supported preview's casing through the overlap while taking
    // the authoritative decode's punctuation at the seam and all of its tail.
    const merged = supported.map((token) => ({ ...token }));
    merged[merged.length - 1] = {
      ...merged[merged.length - 1],
      text: authoritative[overlap - 1].text,
    };
    return {
      text: tokenText([...merged, ...authoritative.slice(overlap)]),
      prefix,
    };
  }

  return { text: authoritativeText, prefix: "" };
}

function protectedTailLength(
  fresh: Token[],
  protectedTrailingPhrases: readonly string[],
): number {
  let protectedLength = 0;
  for (const phrase of protectedTrailingPhrases) {
    const phraseTokens = tokens(phrase);
    if (phraseTokens.length === 0 || phraseTokens.length > fresh.length) continue;

    // Only guard an exact hypothesis tail. A matching phrase in the middle of
    // a longer hypothesis is ordinary speech and must not be special-cased.
    const candidate = fresh.slice(fresh.length - phraseTokens.length);
    if (tokensEqual(candidate, phraseTokens)) {
      protectedLength = Math.max(protectedLength, phraseTokens.length);
    }
  }

  return protectedLength;
}

function joinText(...parts: string[]): string {
  return cleanTranscriptText(parts.filter((part) => part && part.trim().length > 0).join(" "));
}

function stripMarkers(text: string): string {
  return text
    .replace(/^\[\d{2}:\d{2}:\d{2}(?:[.,]\d{3})?\s+-->\s+\d{2}:\d{2}:\d{2}(?:[.,]\d{3})?\]\s*/, "")
    .replace(/\[(?:BLANK_AUDIO|NO_SPEECH|SILENCE|MUSIC|NOISE|LAUGHTER|APPLAUSE|BREATH|BACKGROUND_NOISE)\]/gi, "")
    .replace(/\[SPEAKER_TURN\]/g, "")
    .replace(/^\[Start speaking\]$/i, "")
    .replace(/^### Transcription \d+ (?:START|END).*$/i, "")
    .trim();
}

function cleanTranscriptText(text: string): string {
  return text.replace(/^[\s,;:.!?]+/, "").replace(/\s+/g, " ").trim();
}

// Whisper commonly uses an ellipsis at the end of an incomplete decode window.
// In a rolling stream that boundary moves every few hundred milliseconds, so the
// ellipsis is decoder state rather than durable transcript punctuation. Remove it
// before agreement can make it irreversible. Single periods remain untouched.
function cleanStreamingHypothesis(text: string): string {
  return cleanTranscriptText(text.replace(/\.{2,}|…+/gu, " "));
}

// The only genuine duplication in sliding-window mode is the keep_ms audio carried into
// the next window, which can repeat a few trailing words of the previous final at the
// start of the next one. Trim that overlap; bounded to a short window so it can't eat
// real text.
function trimSeamOverlap(previous: string, current: string): string {
  const previousWords = words(previous);
  const currentWords = words(current);
  const maxOverlap = Math.min(8, previousWords.length, currentWords.length);

  for (let length = maxOverlap; length >= 1; length -= 1) {
    const tail = previousWords.slice(previousWords.length - length).map(normalizeWord);
    const head = currentWords.slice(0, length).map(normalizeWord);
    if (tail.every((word, i) => word === head[i])) {
      return cleanTranscriptText(current.slice(currentWords[length - 1].end));
    }
  }

  return current;
}

interface Word {
  text: string;
  end: number;
}

function words(text: string): Word[] {
  const spans: Word[] = [];
  const pattern = /[\p{L}\p{N}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    spans.push({ text: match[0], end: match.index + match[0].length });
  }

  return spans;
}

function normalizeWord(word: Word): string {
  return word.text.toLowerCase();
}
