import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readConfig } from "./config.ts";
import { createEngine, type EngineMessage } from "./engine.ts";
import type { Injector } from "./focus.ts";
import type { Keystroke } from "./keymap.ts";
import { loadProfiles } from "./load-profiles.ts";
import type { Action, ParseResult } from "./parser.ts";
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

test("desktop live: refuses to start until the office sets the program file name", () => {
  const sent: EngineMessage[] = [];
  const engine = createEngine({
    config: readConfig({
      PERIOKEY_MODE: "live",
      TARGET_WINDOW: "Perio Exam",
    }),
    profiles,
    emit: (message) => sent.push(message),
    makeInjector: () => fakeInjector([]),
    noProgramNote: "check the program first",
  });
  try {
    engine.toggle();
    assert.equal(engine.isListening(), false);
    const last = sent.filter((m) => m.type === "state").at(-1);
    assert.equal(last?.note, "check the program first");
  } finally {
    engine.close();
  }
});

test("desktop live: the program file name goes with every focus check and typed phrase", async () => {
  const speech = fakeSpeech();
  const typed: Keystroke[][] = [];
  const programs: (string | undefined)[] = [];
  const injector = fakeInjector(typed);
  injector.focusCheck = async (_window, program) => {
    programs.push(program);
    return "match";
  };
  injector.type = async (keys, _delay, _window, program) => {
    programs.push(program);
    typed.push(keys);
  };
  const checked = new Map(profiles);
  const eaglesoft = profiles.get("eaglesoft");
  assert.ok(eaglesoft);
  checked.set("eaglesoft", { ...eaglesoft, program_match: "Eaglesoft.exe" });
  const engine = createEngine({
    config: readConfig({
      OPENAI_API_KEY: "k",
      PERIOKEY_MODE: "live",
      TARGET_WINDOW: "Perio Exam",
      AI_FILTER: "off",
    }),
    profiles: checked,
    emit() {},
    makeInjector: () => injector,
    openAiConnect: speech.connect,
    noProgramNote: "check the program first",
  });
  try {
    engine.toggle();
    await until(() => engine.isListening());
    speech.say("three two three");
    await until(() => typed.length === 1);
    assert.ok(programs.length >= 2);
    assert.ok(programs.every((program) => program === "Eaglesoft.exe"));
  } finally {
    engine.close();
  }
});

test("live: Stop while keys are being typed tells the typer to stop", async () => {
  const speech = fakeSpeech();
  let stops = 0;
  let typing = false;
  const injector = fakeInjector([]);
  injector.type = () => {
    typing = true;
    return new Promise(() => {});
  };
  injector.stop = () => {
    stops += 1;
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
    speech.say("three two three");
    await until(() => typing);
    const before = stops;
    engine.toggle();
    assert.equal(stops, before + 1);
  } finally {
    engine.close();
  }
});

// why: Live mode may use the AI filter for corrections (decision 002), but tooth jumps stay Practice-only.
for (const jump of [
  { type: "goto_tooth", tooth: 5, surface: "buccal" },
  { type: "set_tooth", tooth: 5, surface: "buccal", depths: [3, 2, 3] },
] satisfies Action[]) {
  test(`live: an AI reply with ${jump.type} is refused with a buzz and types nothing`, async () => {
    const speech = fakeSpeech();
    const sent: EngineMessage[] = [];
    const typed: Keystroke[][] = [];
    const asked: string[] = [];
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
      filter: async (_key, _model, text) => {
        asked.push(text);
        return { status: "accept", actions: [jump] };
      },
    });
    try {
      engine.toggle();
      await until(() => engine.isListening());
      speech.say("actually go to tooth five");
      await until(() =>
        sent.some((m) => m.type === "earcon" && m.kind === "buzz"),
      );
      assert.deepEqual(asked, ["actually go to tooth five"]);
      const last = sent.filter((m) => m.type === "state").at(-1);
      assert.match(String(last?.note), /tooth jumps are Practice-only/);
      assert.equal(typed.length, 0);
      assert.equal(
        sent.some((m) => m.type === "entry"),
        false,
      );
    } finally {
      engine.close();
    }
  });
}

test("live: a clean single depth types it with fixed rules and never calls the AI", async () => {
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
    filter: async (_key, _model, text) => {
      asked.push(text);
      return { status: "ignore", reason: "conversation" };
    },
  });
  try {
    engine.toggle();
    await until(() => engine.isListening());
    speech.say("three");
    await until(() => typed.length === 1);
    assert.deepEqual(typed[0], [{ key: "3", mods: [] }]);
    assert.deepEqual(asked, []);
  } finally {
    engine.close();
  }
});

// why: Stop, then Start, while a phrase is typing; the old phrase's Stop reply arrives in the new session.
for (const sent of [0, 2]) {
  test(`live: a late "stopped after ${sent}" from before Stop ${sent === 0 ? "leaves the new session listening" : "pauses the new session with the count"}`, async () => {
    const speech = fakeSpeech();
    const states: EngineMessage[] = [];
    const pending: { finish?: (error: Error) => void } = {};
    const injector = fakeInjector([]);
    injector.type = () =>
      new Promise((_resolve, reject) => {
        pending.finish = reject;
      });
    injector.stop = () => {};
    const engine = createEngine({
      config: readConfig({
        OPENAI_API_KEY: "k",
        PERIOKEY_MODE: "live",
        TARGET_WINDOW: "Perio Exam",
        AI_FILTER: "off",
      }),
      profiles,
      emit: (message) => {
        if (message.type === "state") states.push(message);
      },
      makeInjector: () => injector,
      openAiConnect: speech.connect,
    });
    try {
      engine.toggle();
      await until(() => engine.isListening());
      speech.say("three two three");
      await until(() => pending.finish !== undefined);
      engine.toggle();
      engine.toggle();
      assert.equal(engine.isListening(), true);
      finish?.(
        new Error(`Paused: stopped after ${sent} of 3 keys. Check the chart.`),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const note = String(states.at(-1)?.note);
      if (sent === 0) {
        assert.equal(engine.isListening(), true);
        assert.doesNotMatch(note, /stopped after/);
      } else {
        assert.equal(engine.isListening(), false);
        assert.match(note, /stopped after 2 of 3 keys/);
      }
    } finally {
      engine.close();
    }
  });
}
