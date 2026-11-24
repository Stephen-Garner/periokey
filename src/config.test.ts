import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfig, keyStatus } from "./config.ts";

test("with no settings, PerioKey starts in practice mode on the Eaglesoft profile with no provider", () => {
  const config = readConfig({});
  assert.equal(config.provider, null);
  assert.equal(config.mode, "practice");
  assert.equal(config.profile, "eaglesoft");
  assert.equal(config.hotkey, "F9");
  assert.equal(config.openAiModel, "gpt-4o-transcribe");
  assert.equal(config.vadSilenceMs, 300);
  assert.match(keyStatus(config), /No API key/);
});

test("Deepgram is chosen first when its key is set", () => {
  assert.equal(
    readConfig({ DEEPGRAM_API_KEY: "dg", OPENAI_API_KEY: "oa" }).provider,
    "deepgram",
  );
  assert.equal(readConfig({ OPENAI_API_KEY: "oa" }).provider, "openai");
});

test("STT_PROVIDER picks a provider only when that provider's key is set", () => {
  assert.equal(
    readConfig({
      STT_PROVIDER: "openai",
      DEEPGRAM_API_KEY: "dg",
      OPENAI_API_KEY: "oa",
    }).provider,
    "openai",
  );
  assert.equal(
    readConfig({ STT_PROVIDER: "openai", DEEPGRAM_API_KEY: "dg" }).provider,
    "deepgram",
  );
});

test("the key status never shows the key itself", () => {
  const status = keyStatus(
    readConfig({ DEEPGRAM_API_KEY: "secret-value-123" }),
  );
  assert.equal(status, "Deepgram key set");
  assert.ok(!status.includes("secret-value-123"));
});

test("live mode is only on when asked for exactly", () => {
  assert.equal(readConfig({ PERIOKEY_MODE: "live" }).mode, "live");
  assert.equal(readConfig({ PERIOKEY_MODE: "LIVE!" }).mode, "practice");
});

test("VAD_SILENCE_MS sets the OpenAI silence threshold, falling back to 300", () => {
  assert.equal(readConfig({ VAD_SILENCE_MS: "500" }).vadSilenceMs, 500);
  assert.equal(readConfig({ VAD_SILENCE_MS: "abc" }).vadSilenceMs, 300);
});

test("the gpt-5-nano filter is on only with an OpenAI key, and AI_FILTER=off turns it off", () => {
  assert.equal(readConfig({}).aiFilter, false);
  assert.equal(readConfig({ DEEPGRAM_API_KEY: "dg" }).aiFilter, false);
  const on = readConfig({ OPENAI_API_KEY: "oa" });
  assert.equal(on.aiFilter, true);
  assert.equal(on.openAiFilterModel, "gpt-5-nano");
  assert.equal(
    readConfig({ OPENAI_API_KEY: "oa", AI_FILTER: "off" }).aiFilter,
    false,
  );
  assert.equal(
    readConfig({ OPENAI_API_KEY: "oa", AI_FILTER: "False" }).aiFilter,
    false,
  );
  assert.equal(
    readConfig({ OPENAI_API_KEY: "oa", OPENAI_FILTER_MODEL: "m" })
      .openAiFilterModel,
    "m",
  );
});
