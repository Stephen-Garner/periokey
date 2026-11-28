import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearKeys,
  cleanKey,
  configOf,
  desktopInjector,
  focusFrom,
  loadKeyStatus,
  loadKeys,
  loadSettings,
  saveKey,
  saveSettings,
  profilesSafe,
  profilesWith,
  settingsFrom,
} from "./host.ts";

test("profile edits override the shipped keys but never the name", () => {
  const profiles = profilesWith({
    eaglesoft: { prev_tooth: "up", name: "other" },
  });
  assert.equal(profiles.get("eaglesoft")?.prev_tooth, "up");
  assert.equal(profiles.has("other"), false);
});

test("a bad profile edit is rejected, not saved quietly", () => {
  assert.throws(() => profilesWith({ eaglesoft: { skip: "nope" } }), /skip/);
});

test("settings read from an empty or partial file fall back to defaults", () => {
  assert.deepEqual(settingsFrom(""), { env: {}, mic: "", profileEdits: {} });
  assert.equal(settingsFrom('{"mic":"abc","env":null}').mic, "abc");
});

test("focus replies map to statuses; anything unknown is treated as empty", () => {
  assert.equal(focusFrom("MATCH"), "match");
  assert.equal(focusFrom("MISMATCH"), "mismatch");
  assert.equal(focusFrom("ERR boom"), "empty");
});

test("a corrupt settings file falls back to defaults instead of crashing", () => {
  assert.deepEqual(settingsFrom("{not json"), {
    env: {},
    mic: "",
    profileEdits: {},
  });
});

test("a bad saved profile edit falls back to the shipped profiles", () => {
  const profiles = profilesSafe({ eaglesoft: { skip: "nope" } });
  assert.equal(profiles.get("eaglesoft")?.skip, "right");
});

test("pasted keys lose a Bearer prefix; keys with spaces or symbols are refused", () => {
  assert.equal(cleanKey("Bearer sk-abc_1.2"), "sk-abc_1.2");
  assert.equal(cleanKey("sk-abc"), "sk-abc");
  assert.equal(cleanKey("sk abc"), null);
  assert.equal(cleanKey("  sk-abc\n"), "sk-abc");
  assert.equal(cleanKey('sk-a"bc'), null);
});

test("a settings file with a number where text belongs keeps only the text values", () => {
  const settings = settingsFrom(
    '{"env":{"STT_PROVIDER":42,"PERIOKEY_HOTKEY":"F8"}}',
  );
  assert.deepEqual(settings.env, { PERIOKEY_HOTKEY: "F8" });
  assert.doesNotThrow(() => configOf(settings));
});

test("Stop tells Rust to drop the phrase being typed, and the pause says how many keys went out", async () => {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  let reply: ((value: string) => void) | undefined;
  const invoke = <T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    calls.push([command, args]);
    if (command !== "send_keys") return Promise.resolve(undefined as T);
    return new Promise<T>((resolve) => {
      reply = (value) => resolve(value as T);
    });
  };
  const injector = desktopInjector(invoke);
  const keys = [
    { key: "3", mods: [] },
    { key: "2", mods: [] },
    { key: "3", mods: [] },
  ];
  const typing = injector.type(keys, 0, "Perio Exam", "Eaglesoft.exe");
  injector.stop?.();
  reply?.("STOPPED 1");
  await assert.rejects(typing, /stopped after 1 of 3 keys/);
  const sent = calls.find(([command]) => command === "send_keys")?.[1];
  assert.equal(sent?.programMatch, "Eaglesoft.exe");
  assert.deepEqual(calls.find(([command]) => command === "stop_typing")?.[1], {
    upTo: sent?.token,
  });
});

type Call = { command: string; args?: Record<string, unknown> };

function fakeInvoke(replies: Record<string, unknown>): {
  calls: Call[];
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
} {
  const calls: Call[] = [];
  return {
    calls,
    invoke: async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return replies[command] as T;
    },
  };
}

test("saved settings never carry an API key, even if one slipped into env", async () => {
  const fake = fakeInvoke({});
  await saveSettings(
    {
      env: {
        OPENAI_API_KEY: "sk-1",
        DEEPGRAM_API_KEY: "dg-1",
        PMS_PROFILE: "eaglesoft",
      },
      mic: "",
      profileEdits: {},
    },
    fake.invoke,
  );
  const json = String(fake.calls[0]?.args?.json);
  assert.equal(fake.calls[0]?.command, "save_settings");
  assert.equal(json.includes("sk-1") || json.includes("dg-1"), false);
  assert.equal(JSON.parse(json).env.PMS_PROFILE, "eaglesoft");
});

test("keys left in an old settings file are ignored", async () => {
  const old = '{"env":{"OPENAI_API_KEY":"sk-old","STT_PROVIDER":"openai"}}';
  const settings = await loadSettings(
    fakeInvoke({ load_settings: old }).invoke,
  );
  assert.deepEqual(settings.env, { STT_PROVIDER: "openai" });
  assert.equal(configOf(settings).openAiKey, "");
});

test("Settings sees only saved or unset, never a key value", async () => {
  const status = await loadKeyStatus(
    fakeInvoke({ api_key_status: { openai: "sk-leak", deepgram: true } })
      .invoke,
  );
  assert.deepEqual(status, { openai: false, deepgram: true });
  assert.equal(JSON.stringify(status).includes("sk-leak"), false);
});

test("the pill's keys come from the credential store and feed the config", async () => {
  const keys = await loadKeys(
    fakeInvoke({
      read_api_keys: {
        DEEPGRAM_API_KEY: "dg-1",
        PATH: "/bin",
        OPENAI_API_KEY: 7,
      },
    }).invoke,
  );
  assert.deepEqual(keys, { DEEPGRAM_API_KEY: "dg-1" });
  const config = configOf(
    settingsFrom('{"env":{"STT_PROVIDER":"deepgram"}}'),
    keys,
  );
  assert.equal(config.provider, "deepgram");
  assert.equal(config.deepgramKey, "dg-1");
});

test("setting and clearing keys go to the credential store commands", async () => {
  const fake = fakeInvoke({});
  await saveKey("OPENAI_API_KEY", "sk-2", fake.invoke);
  await clearKeys(fake.invoke);
  assert.deepEqual(fake.calls, [
    { command: "set_api_key", args: { name: "OPENAI_API_KEY", value: "sk-2" } },
    { command: "clear_api_keys", args: undefined },
  ]);
});
