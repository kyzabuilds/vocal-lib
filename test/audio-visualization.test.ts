import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { parseAudioVisualizationData } from "../src/engine/whisper-process.js";
import { createEnvelope, decodeEnvelope, encodeEnvelope, type IpcEnvelope } from "../src/ipc/protocol.js";
import { createVocalIpcServer } from "../src/ipc/server.js";
import { resolveVocalConfig } from "../src/service/config.js";
import { LiveSession } from "../src/service/live-session.js";

test("validates structured native audio visualization records", () => {
  assert.deepEqual(parseAudioVisualizationData(
    '{"timestamp":50,"sequence":1,"rms":0.1,"peak":0.3,"level":0.2,"speech":true}',
  ), {
    timestamp: 50,
    sequence: 1,
    rms: 0.1,
    peak: 0.3,
    level: 0.2,
    speech: true,
  });
  assert.equal(parseAudioVisualizationData('{"timestamp":0,"level":2}'), null);
  assert.equal(parseAudioVisualizationData("not-json"), null);
});

test("mock sessions emit deterministic audio only when visualization is enabled", async () => {
  const enabled = new LiveSession(resolveVocalConfig({ mock: true }), {
    sessionId: "meter-enabled",
    visualization: { enabled: true, intervalMs: 33 },
  });
  const events: unknown[] = [];
  enabled.on("audio", (event) => events.push(event));
  const stopped = new Promise<void>((resolve) => enabled.once("stopped", () => resolve()));
  await enabled.start();
  await stopped;
  assert.ok(events.length >= 2);
  assert.equal((events[0] as { sessionId: string }).sessionId, "meter-enabled");

  const disabled = new LiveSession(resolveVocalConfig({ mock: true }), { sessionId: "meter-disabled" });
  let audioCount = 0;
  disabled.on("audio", () => audioCount += 1);
  const disabledStopped = new Promise<void>((resolve) => disabled.once("stopped", () => resolve()));
  await disabled.start();
  await disabledStopped;
  assert.equal(audioCount, 0);
});

test("stdio IPC forwards session.audio without changing transcript events", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = createVocalIpcServer({ serviceConfig: { mock: true } });
  server.attachStdio(input, output);
  const envelopes: IpcEnvelope[] = [];
  let remainder = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    remainder += chunk;
    const lines = remainder.split("\n");
    remainder = lines.pop() ?? "";
    for (const line of lines) if (line) envelopes.push(decodeEnvelope(line));
  });
  input.write(encodeEnvelope(createEnvelope({
    id: "start",
    method: "session.start",
    type: "request",
    payload: { sessionId: "ipc-meter", visualization: { enabled: true, intervalMs: 33 } },
  })));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for mock IPC session")), 1000);
    const poll = setInterval(() => {
      if (envelopes.some((event) => event.method === "session.stopped")) {
        clearTimeout(timeout);
        clearInterval(poll);
        resolve();
      }
    }, 10);
  });
  assert.ok(envelopes.some((event) => event.method === "session.audio"));
  assert.ok(envelopes.some((event) => event.method === "transcript.preview"));
  assert.ok(envelopes.some((event) => event.method === "transcript.final"));
  input.end();
  output.end();
});
