import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readConfig } from "./config.ts";
import { createEngine, type EngineMessage } from "./engine.ts";
import type { Injector } from "./focus.ts";
import type { Keystroke } from "./keymap.ts";
import { loadProfiles } from "./load-profiles.ts";
import type { ParseResult } from "./parser.ts";
import type { OpenAiConnect } from "./stt.ts";

const profiles = loadProfiles(
  fileURLToPath(new URL("../profiles", import.meta.url)),
);

type Listener = (event: { data?: unknown }) => void;

function fakeSpeech(): { connect: OpenAiConnect; say(text: string): void } {
  const listeners = new Map<string, Listener[]>();
  let item = 0;
  const fire = (type: string, data?: string): void => {
    for (const listener of listeners.get(type) ?? []) listener({ data });
  };
  return {
    connect: () => {
      setTimeout(() => fire("open"), 0);
      return {
        readyState: 1,
        send() {},
        close() {},
        addEventListener(type, listener) {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
      };
    },
    say(text) {
      const item_id = `item-${++item}`;
      fire(
        "message",
        JSON.stringify({ type: "input_audio_buffer.committed", item_id }),
      );
      fire(
        "message",
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id,
          transcript: text,
        }),
      );
    },
  };
}

function fakeInjector(typed: Keystroke[][]): Injector {
  return {
    name: "fake",
    async type(keys) {
      typed.push(keys);
    },
    async focusCheck() {
      return "match";
    },
    watchHotkey: () => false,
    showStatus() {},
    close() {},
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "condition never became true");
}

test("live: an AI correction types Backspace then the new depth into the dental software", async () => {
  const speech = fakeSpeech();
  const typed: Keystroke[][] = [];
  const asked: string[] = [];
  const engine = createEngine({
    config: readConfig({
      OPENAI_API_KEY: "k",
      PERIOKEY_MODE: "live",
      TARGET_WINDOW: "Perio Exam",
    }),
    profiles,
    emit() {},
    makeInjector: () => fakeInjector(typed),
    openAiConnect: speech.connect,
    filter: async (_key, _model, text): Promise<ParseResult> => {
      asked.push(text);
      return {
        status: "accept",
        actions: [{ type: "back" }, { type: "depth", value: 4 }],
      };
    },
  });
  try {
    engine.toggle();
    await until(() => engine.isListening());
    speech.say("oh undo that and put four");
    await until(() => typed.length === 1);
    assert.deepEqual(asked, ["oh undo that and put four"]);
    assert.deepEqual(typed[0], [
      { key: "backspace", mods: [] },
      { key: "4", mods: [] },
    ]);
  } finally {
    engine.close();
  }
});

test("practice: a whole-tooth redo shows the Left key and never types", async () => {
  const sent: EngineMessage[] = [];
  const typed: Keystroke[][] = [];
  const engine = createEngine({
    config: readConfig({ OPENAI_API_KEY: "k" }),
    profiles,
    emit: (message) => sent.push(message),
    makeInjector: () => fakeInjector(typed),
    filter: async () => ({
      status: "accept",
      actions: [
        { type: "prev_tooth" },
        { type: "depth", value: 3 },
        { type: "depth", value: 3 },
        { type: "depth", value: 2 },
      ],
    }),
  });
  try {
    engine.handle({ type: "simulate", text: "redo that tooth as 3 3 2" });
    await until(() => sent.some((m) => m.type === "entry"));
    const entry = sent.find((m) => m.type === "entry");
    assert.deepEqual(entry?.keys, ["←", "3", "3", "2"]);
    assert.equal(typed.length, 0);
  } finally {
    engine.close();
  }
});

test("reconfigure swaps the speech key without a restart", () => {
  const sent: EngineMessage[] = [];
  const engine = createEngine({
    config: readConfig({}),
    profiles,
    emit: (message) => sent.push(message),
    makeInjector: () => null,
  });
  try {
    engine.reconfigure(readConfig({ DEEPGRAM_API_KEY: "d" }), profiles);
    const last = sent.filter((m) => m.type === "state").at(-1);
    assert.equal(last?.provider, "deepgram");
  } finally {
    engine.close();
  }
});

test("live: a whole-tooth redo is refused with a buzz and types nothing", async () => {
  const speech = fakeSpeech();
  const sent: EngineMessage[] = [];
  const typed: Keystroke[][] = [];
  const engine = createEngine({
    config: readConfig({
      OPENAI_API_KEY: "k",
      PERIOKEY_MODE: "live",
      TARGET_WINDOW: "Perio Exam",
    }),
    profiles,
    emit: (message) => sent.push(message),
    makeInjector: () => fakeInjector(typed),
    openAiConnect: speech.connect,
    filter: async () => ({
      status: "accept",
      actions: [{ type: "prev_tooth" }, { type: "depth", value: 3 }],
    }),
  });
  try {
    engine.toggle();
    await until(() => engine.isListening());
    speech.say("redo that tooth as 3");
    await until(() =>
      sent.some((m) => m.type === "earcon" && m.kind === "buzz"),
    );
    assert.equal(typed.length, 0);
    assert.equal(
      sent.some((m) => m.type === "entry"),
      false,
    );
  } finally {
    engine.close();
  }
});

test("live: Stop pressed during the focus check means nothing is typed", async () => {
  const speech = fakeSpeech();
  const typed: Keystroke[][] = [];
  let hold = false;
  let release: (() => void) | undefined;
  const injector = fakeInjector(typed);
  injector.focusCheck = () => {
    // why: checks made while starting pass at once; only the one before typing is held.
    if (!hold) return Promise.resolve("match");
    return new Promise((resolve) => {
      release = () => resolve("match");
    });
  };
  const engine = createEngine({
    config: readConfig({
      OPENAI_API_KEY: "k",
      PERIOKEY_MODE: "live",
      TARGET_WINDOW: "Perio Exam",
      AI_FILTER: "off",
    }),
    profiles,
    emit() {},
    makeInjector: () => injector,
    openAiConnect: speech.connect,
  });
  try {
    engine.toggle();
    await until(() => engine.isListening());
    await new Promise((resolve) => setTimeout(resolve, 20));
    hold = true;
    speech.say("three two three");
    await until(() => release !== undefined);
    engine.toggle();
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(typed.length, 0);
  } finally {
    engine.close();
  }
});
