import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptStreamFilter } from "../src/engine/transcript-parser.js";

const redraw = (text: string): string => `\x1b[2K\r ${text}\x1e`;
const trailingSilenceRedraw = (text: string): string => `\x1b[2K\r ${text}\x1d`;
const utteranceFinal = (text: string): string => `\x1b[2K\r ${text}\x1c`;

test("previews the whole utterance but does not finalize rolling hypotheses", () => {
  const filter = new TranscriptStreamFilter();

  let update = filter.write(redraw("It's transcribing."));
  assert.deepEqual(update.finals, []);
  assert.equal(update.preview?.text, "It's transcribing.");

  update = filter.write(redraw("It's subscribing."));
  assert.deepEqual(update.finals, []);
  assert.equal(update.preview?.text, "It's subscribing.");

  update = filter.write(redraw("It's transcribing correctly."));
  assert.deepEqual(update.finals, []);
  assert.equal(update.preview?.text, "It's transcribing correctly.");

  update = filter.write(redraw("It's transcribing correctly."));
  assert.deepEqual(update.finals, []);
  assert.equal(update.preview, undefined);

  update = filter.write(utteranceFinal("It's transcribing correctly."));
  assert.deepEqual(update.finals.map(({ text }) => text), ["It's transcribing correctly."]);
});

test("preserves earlier words as the rolling decode window advances", () => {
  const filter = new TranscriptStreamFilter();

  filter.write(redraw("Seems to be working."));
  let update = filter.write(redraw("Seems to be working. Good"));
  assert.deepEqual(update.finals, []);
  assert.equal(update.preview?.text, "Seems to be working. Good");

  update = filter.write(redraw("Seems to be working. Good, but"));
  assert.deepEqual(update.finals, []);
  assert.equal(update.preview?.text, "Seems to be working. Good, but");

  update = filter.write(redraw("Good, but there are issues."));
  assert.deepEqual(update.finals, []);
  assert.equal(update.preview?.text, "Seems to be working. Good, but there are issues.");
});

test("retains the complete reported sentence until the authoritative final decode", () => {
  const filter = new TranscriptStreamFilter();

  filter.write(redraw("Help us fix an issue related to the"));
  let update = filter.write(redraw("fix an issue related to the menu component,"));
  assert.deepEqual(update.finals, []);
  assert.equal(update.preview?.text, "Help us fix an issue related to the menu component,");

  update = filter.write(redraw("an issue related to the menu component, currently"));
  assert.deepEqual(update.finals, []);
  assert.equal(update.preview?.text, "Help us fix an issue related to the menu component, currently");

  update = filter.write(utteranceFinal("Help us fix an issue related to the menu component, currently"));
  assert.deepEqual(update.finals.map(({ text }) => text), [
    "Help us fix an issue related to the menu component, currently",
  ]);
});

test("reconciles a speech-supported opening omitted by the authoritative final", () => {
  const decisions: unknown[] = [];
  const filter = new TranscriptStreamFilter({
    onDecision: (decision) => decisions.push(decision),
  });

  filter.write(redraw("Help us fix an issue"));
  filter.write(redraw("Fix an issue"));
  const update = filter.write(utteranceFinal("Fix an issue"));

  assert.deepEqual(update.finals.map(({ text }) => text), ["Help us fix an issue"]);
  assert.deepEqual(decisions.at(-1), {
    action: "reconciled",
    committed: "Help us",
    hypothesis: "Fix an issue",
    preview: "Help us fix an issue",
    trailingSilence: false,
  });
});

test("reconciles a single opening word when the complete short final overlaps", () => {
  const filter = new TranscriptStreamFilter();

  filter.write(redraw("Currently we notice"));
  filter.write(redraw("We notice"));
  const update = filter.write(utteranceFinal("We notice"));

  assert.deepEqual(update.finals.map(({ text }) => text), ["Currently we notice"]);
});

test("does not reconcile an opening without speech-positive agreement", () => {
  const filter = new TranscriptStreamFilter();

  filter.write(redraw("Help us fix an issue"));
  const update = filter.write(utteranceFinal("Fix an issue"));

  assert.deepEqual(update.finals.map(({ text }) => text), ["Fix an issue"]);
});

test("does not reconcile weak or non-prefix authoritative overlap", () => {
  const weak = new TranscriptStreamFilter();
  weak.write(redraw("Please open the settings"));
  weak.write(redraw("Open the settings"));
  let update = weak.write(utteranceFinal("Settings are ready"));
  assert.deepEqual(update.finals.map(({ text }) => text), ["Settings are ready"]);

  const interior = new TranscriptStreamFilter();
  interior.write(redraw("Please open the settings panel"));
  interior.write(redraw("Open the settings panel"));
  update = interior.write(utteranceFinal("The settings panel is open"));
  assert.deepEqual(update.finals.map(({ text }) => text), ["The settings panel is open"]);
});

test("preserves a speech-gated provisional utterance when the process is stopped", () => {
  const filter = new TranscriptStreamFilter();

  let update = filter.write(redraw("Thank you."));
  assert.deepEqual(update.finals, []);
  assert.equal(update.preview?.text, "Thank you.");

  assert.deepEqual(filter.flush(), { text: "Thank you.", raw: "Thank you." });
  assert.equal(filter.hasPending(), false);
});

test("allows a real isolated short phrase in the full-utterance decode", () => {
  const filter = new TranscriptStreamFilter();

  filter.write(redraw("Thank you."));
  const update = filter.write(utteranceFinal("Thank you."));

  assert.deepEqual(update.finals.map(({ text }) => text), ["Thank you."]);
  assert.equal(update.preview, undefined);
});

test("removes rolling-window ellipses before they can become final", () => {
  const filter = new TranscriptStreamFilter();

  let update = filter.write(redraw("I want to clean up the current..."));
  assert.equal(update.preview?.text, "I want to clean up the current");

  update = filter.write(redraw("I want to clean up the current... modal."));
  assert.deepEqual(update.finals, []);
  assert.equal(update.preview?.text, "I want to clean up the current modal.");
  assert.equal(update.finals.some(({ text }) => text.includes("...")), false);
});

test("preserves ordinary sentence periods in project-stream hypotheses", () => {
  const filter = new TranscriptStreamFilter();

  filter.write(redraw("The modal. The transition works."));
  const update = filter.write(utteranceFinal("The modal. The transition works."));

  assert.deepEqual(update.finals.map(({ text }) => text), ["The modal. The transition works."]);
});

test("holds a known outro when only trailing silence corroborates it", () => {
  const filter = new TranscriptStreamFilter();

  filter.write(redraw("We are done. Thank you."));
  let update = filter.write(trailingSilenceRedraw("We are done. Thank you."));

  assert.deepEqual(update.finals, []);
  assert.equal(update.preview?.text, "We are done.");

  update = filter.write("\n");
  assert.deepEqual(update.finals.map(({ text }) => text), ["We are done."]);
  assert.equal(filter.flush(), null);
});

test("does not preview a known outro first introduced by trailing silence", () => {
  const decisions: unknown[] = [];
  const filter = new TranscriptStreamFilter({ onDecision: (decision) => decisions.push(decision) });

  filter.write(redraw("We are done."));
  const update = filter.write(trailingSilenceRedraw("We are done. Thank you."));

  assert.deepEqual(update.finals, []);
  assert.equal(update.preview, undefined);
  assert.deepEqual(decisions.at(-1), {
    action: "held",
    committed: "We are done.",
    hypothesis: "We are done. Thank you.",
    preview: "We are done.",
    trailingSilence: true,
  });
});

test("allows the trailing-silence phrase guard to be disabled", () => {
  const filter = new TranscriptStreamFilter({ trailingSilencePhrases: [] });

  filter.write(redraw("Thank you."));
  const update = filter.write(trailingSilenceRedraw("Thank you."));

  assert.deepEqual(update.finals, []);
  assert.equal(update.preview, undefined);
});

test("preserves stock line-delimited stream behavior", () => {
  const filter = new TranscriptStreamFilter();
  const update = filter.write(" ordinary stock output\n");

  assert.deepEqual(update.finals.map(({ text }) => text), ["ordinary stock output"]);
});
