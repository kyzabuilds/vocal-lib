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
// reset current line, LF = commit) instead of guessing intent from word overlap.
const ansiCsi = /^\x1b\[[0-?]*[ -/]*([@-~])/;
// A possibly-incomplete CSI sequence: ESC, optional `[`, params, no final byte yet.
const partialCsi = /^\x1b\[?[0-?]*[ -/]*$/;
const blockStart = /^### Transcription \d+ START/i;
const blockEnd = /^### Transcription \d+ END/i;

export class TranscriptStreamFilter {
  private line = "";
  private carry = ""; // trailing bytes of an escape sequence split across chunks

  // sliding-window (--step > 0) state
  private lastFinal = "";
  private lastPreview = "";

  // VAD (--step 0) state
  private vad = false;
  private inBlock = false;
  private block: string[] = [];
  private agreement = new Agreement();
  private confirmedBuffer = ""; // confirmed words not yet flushed as a sentence line
  private lastVadPreview = "";

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
    if (this.vad) {
      return this.confirmedBuffer.length > 0 || this.agreement.tentativeText().length > 0;
    }

    return cleanTranscriptText(stripMarkers(this.line)).length > 0;
  }

  private handleLine(raw: string, finals: TranscriptEvent[]): void {
    const trimmed = raw.trim();

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
class Agreement {
  private committed: Token[] = [];
  private prev: Token[] = []; // uncommitted tail of the previous window

  feed(blockText: string): string {
    const window = tokens(blockText);
    const fresh = this.dropCommitted(window);
    const agreed = commonPrefixLength(this.prev, fresh);
    const confirmed = fresh.slice(0, agreed);

    this.committed.push(...confirmed);
    // ponytail: unbounded transcripts only need a short lookback to re-align windows.
    if (this.committed.length > 256) this.committed.splice(0, this.committed.length - 256);
    this.prev = fresh.slice(agreed);

    return tokenText(confirmed);
  }

  tentativeText(): string {
    return tokenText(this.prev);
  }

  acceptTentative(): void {
    this.committed.push(...this.prev);
    this.prev = [];
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
