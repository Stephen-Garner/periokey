import { test } from "node:test";
import assert from "node:assert/strict";
import { levelOf, resample, toPcm16 } from "./audio.ts";

test("48 kHz audio is halved to 24 kHz", () => {
  assert.equal(resample(new Float32Array(4800), 48000).length, 2400);
});

test("PCM16 clamps loud samples instead of wrapping", () => {
  const pcm = new Int16Array(toPcm16(new Float32Array([2, -2, 0])).buffer);
  assert.deepEqual([...pcm], [32767, -32768, 0]);
});

test("silence reads as level 0 and a full-scale tone near 1", () => {
  assert.equal(levelOf(new Float32Array(100)), 0);
  assert.ok(levelOf(new Float32Array(100).fill(0.9)) > 0.95);
});
