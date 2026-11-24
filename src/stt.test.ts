import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import {
  CLOSED_MESSAGE,
  createDeepgramCollector,
  createOpenAiCollector,
  deepgramProvider,
  openAiProvider,
  deepgramUrl,
  openAiSessionUpdate,
  KEYTERMS,
} from "./stt.ts";

function result(transcript: string, isFinal: boolean, speechFinal: boolean) {
  return {
    type: "Results",
    is_final: isFinal,
    speech_final: speechFinal,
    channel: { alternatives: [{ transcript }] },
  };
}

test("the collector ignores interim guesses and joins final segments at speech_final", () => {
  const collector = createDeepgramCollector();
  assert.equal(collector.handle(result("three", false, false)), null);
  assert.equal(collector.handle(result("three two", true, false)), null);
  assert.equal(collector.handle(result("thr", false, false)), null);
  assert.equal(
    collector.handle(result("three", true, true)),
    "three two three",
  );
});

test("the collector starts fresh after each phrase and skips empty phrases", () => {
  const collector = createDeepgramCollector();
  assert.equal(collector.handle(result("four", true, true)), "four");
  assert.equal(collector.handle(result("", true, true)), null);
  assert.equal(collector.handle(result("five", true, true)), "five");
});

test("an interim guess is never acted on, even when speech_final arrives with no finals", () => {
  const collector = createDeepgramCollector();
  assert.equal(collector.handle(result("seven", false, false)), null);
  assert.equal(collector.handle(result("", true, true)), null);
});

test("non-result messages are ignored", () => {
  const collector = createDeepgramCollector();
  assert.equal(collector.handle({ type: "Metadata" }), null);
});

test("the Deepgram URL turns off formatting, opts out of training, and boosts perio words", () => {
  const params = new URL(deepgramUrl()).searchParams;
  assert.equal(params.get("model"), "nova-3");
  assert.equal(params.get("smart_format"), "false");
  assert.equal(params.get("numerals"), "false");
  assert.equal(params.get("punctuate"), "false");
  assert.equal(params.get("endpointing"), "300");
  assert.equal(params.get("mip_opt_out"), "true");
  assert.equal(params.get("interim_results"), "true");
  assert.deepEqual(params.getAll("keyterm"), KEYTERMS);
  assert.ok(
    KEYTERMS.includes("fifteen") &&
      KEYTERMS.includes("bleeding") &&
      KEYTERMS.includes("undo"),
  );
});

test("the OpenAI session is transcription-only, with the chosen model and 24 kHz audio", () => {
  const update = openAiSessionUpdate("gpt-4o-transcribe") as {
    session: {
      type: string;
      audio: {
        input: {
          format: { rate: number };
          transcription: { model: string; prompt: string };
        };
      };
    };
  };
  assert.equal(update.session.type, "transcription");
  assert.equal(
    update.session.audio.input.transcription.model,
    "gpt-4o-transcribe",
  );
  assert.equal(update.session.audio.input.format.rate, 24000);
  const prompt = update.session.audio.input.transcription.prompt;
  assert.match(prompt, /space-delimited digits/);
  assert.doesNotMatch(prompt, /\d/);
});

function committed(id: string) {
  return { type: "input_audio_buffer.committed", item_id: id };
}

function completed(id: string, transcript: string) {
  return {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: id,
    transcript,
  };
}

test("OpenAI phrases come out in committed order, and a failed item never stalls the queue", () => {
  const collector = createOpenAiCollector();
  assert.deepEqual(collector.handle(committed("a")), []);
  assert.deepEqual(collector.handle(committed("b")), []);
  assert.deepEqual(collector.handle(committed("c")), []);
  assert.deepEqual(collector.handle(completed("b", "two")), []);
  assert.deepEqual(
    collector
      .handle({
        type: "conversation.item.input_audio_transcription.failed",
        item_id: "a",
      })
      .map((p) => p.text),
    ["two"],
  );
  assert.deepEqual(
    collector.handle(completed("c", " three ")).map((p) => p.text),
    ["three"],
  );
  assert.deepEqual(collector.handle({ type: "session.updated" }), []);
});

function started(id: string, ms: number) {
  return {
    type: "input_audio_buffer.speech_started",
    item_id: id,
    audio_start_ms: ms,
  };
}
function stopped(id: string, ms: number) {
  return {
    type: "input_audio_buffer.speech_stopped",
    item_id: id,
    audio_end_ms: ms,
  };
}

test("OpenAI VAD events give real speech length, pause, and latency per phrase", () => {
  let clock = 1000;
  const collector = createOpenAiCollector(300, () => clock);
  collector.handle(started("a", 1000));
  collector.handle(stopped("a", 3000));
  collector.handle(committed("a"));
  clock = 1250;
  assert.deepEqual(collector.handle(completed("a", "3 2 3")), [
    {
      text: "3 2 3",
      timing: { gapMs: undefined, speechMs: 1400, latencyMs: 250 },
    },
  ]);
  collector.handle(started("b", 3200));
  collector.handle(stopped("b", 4600));
  collector.handle(committed("b"));
  const [b] = collector.handle(completed("b", "4"));
  assert.equal(b?.timing?.gapMs, 800);
  assert.equal(b?.timing?.speechMs, 800);
});

test("the OpenAI silence threshold follows the setting", () => {
  const update = openAiSessionUpdate("m", 450) as {
    session: {
      audio: { input: { turn_detection: { silence_duration_ms: number } } };
    };
  };
  assert.equal(
    update.session.audio.input.turn_detection.silence_duration_ms,
    450,
  );
});

type Seen = { ready: number; errors: string[]; auth: string };

async function withServer(
  run: (url: string, server: WebSocketServer, seen: Seen) => Promise<void>,
): Promise<void> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const seen: Seen = { ready: 0, errors: [], auth: "" };
  server.on("connection", (_client, request) => {
    seen.auth = request.headers.authorization ?? "";
  });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`ws://127.0.0.1:${port}`, server, seen);
  } finally {
    server.close();
  }
}

function handlersFor(seen: Seen) {
  return {
    onReady: () => (seen.ready += 1),
    onPhrase: () => {},
    onError: (message: string) => seen.errors.push(message),
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition never became true");
}

for (const [name, make] of [
  ["Deepgram", (url: string) => deepgramProvider("dg", url)],
  ["OpenAI", (url: string) => openAiProvider("oa", "gpt-4o-transcribe", url)],
] as const) {
  test(`${name}: ready fires once the socket opens, and an unexpected close reports an error`, async () => {
    await withServer(async (url, server, seen) => {
      make(url).start(handlersFor(seen));
      await until(() => seen.ready === 1);
      for (const client of server.clients) client.close();
      await until(() => seen.errors.length > 0);
      assert.equal(seen.errors[0], CLOSED_MESSAGE);
    });
  });

  test(`${name}: closing on purpose reports no error`, async () => {
    await withServer(async (url, _server, seen) => {
      const session = make(url).start(handlersFor(seen));
      await until(() => seen.ready === 1);
      session.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(seen.errors, []);
    });
  });
}

test("OpenAI signs in with an Authorization header, not a browser subprotocol", async () => {
  await withServer(async (url, _server, seen) => {
    const fake = "abc";
    const session = openAiProvider(fake, "gpt-4o-transcribe", url).start(
      handlersFor(seen),
    );
    await until(() => seen.ready === 1);
    assert.equal(seen.auth, `Bearer ${fake}`);
    session.close();
  });
});
