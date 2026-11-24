import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { parsePhrase } from "./parser.ts";
import { filterWithNano, needsAiFilter, readNanoReply } from "./ai-filter.ts";

const routes = (text: string): boolean =>
  needsAiFilter(text, parsePhrase(text));

test("clean runs and lone commands take the instant path, with no AI call", () => {
  for (const text of ["3 2 3", "three two three bleeding", "4 4", "back"])
    assert.equal(routes(text), false, text);
  for (const text of ["undo", "skip", "pause", "bleeding"])
    assert.equal(routes(text), false, text);
});

test("pure chatter with no numbers or chart words skips the AI too", () => {
  assert.equal(routes("how's your dog doing"), false);
  assert.equal(routes("open a little wider please"), false);
});

test("one number, chatter with numbers, corrections, and rejects go to the AI", () => {
  for (const text of [
    "10",
    "12",
    "okay ten",
    "to",
    "for",
    "my son is two and my daughter is four and six",
    "actually scratch the last three, make it 3 3 2",
    "wait that was wrong",
    "go back",
    "twenty",
    "3 2 3 instead",
    "tooth 16 should be 3 3 2",
    "let's pick up from tooth 5",
  ])
    assert.equal(routes(text), true, text);
});

type Reply = {
  status?: number;
  content?: unknown;
  hang?: boolean;
  finish?: string;
};

async function withNano(
  reply: Reply,
  run: (
    url: string,
    bodies: unknown[],
    heads: IncomingMessage[],
  ) => Promise<void>,
): Promise<void> {
  const bodies: unknown[] = [];
  const heads: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += String(chunk)));
    request.on("end", () => {
      bodies.push(JSON.parse(raw));
      heads.push(request);
      if (reply.hang) return;
      response
        .writeHead(reply.status ?? 200, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            choices: [
              {
                finish_reason: reply.finish ?? "stop",
                message: { content: reply.content },
              },
            ],
          }),
        );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1/chat/completions`, bodies, heads);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const correction = JSON.stringify({
  intent: "actions",
  actions: [
    { type: "back" },
    { type: "back" },
    { type: "back" },
    { type: "depth", value: 3 },
    { type: "depth", value: 3 },
    { type: "depth", value: 2 },
  ],
});

test("a natural correction becomes three backs, then 3 3 2, from one nano call", async () => {
  await withNano({ content: correction }, async (url, bodies, heads) => {
    const result = await filterWithNano(
      "key-1",
      "gpt-5-nano",
      "actually scratch the last three, make it 3 3 2",
      ["a", "b", "3 2 3", "4 3 3"],
      url,
    );
    assert.deepEqual(result, {
      status: "accept",
      actions: [
        { type: "back" },
        { type: "back" },
        { type: "back" },
        { type: "depth", value: 3 },
        { type: "depth", value: 3 },
        { type: "depth", value: 2 },
      ],
    });
    const body = bodies[0] as {
      model: string;
      reasoning_effort: string;
      max_completion_tokens: number;
      response_format: { type: string };
      messages: { role: string; content: string }[];
    };
    assert.equal(body.model, "gpt-5-nano");
    assert.equal(body.reasoning_effort, "minimal");
    assert.equal(body.max_completion_tokens, 512);
    assert.equal(body.response_format.type, "json_object");
    assert.deepEqual(JSON.parse(body.messages[1]?.content ?? ""), {
      recent: ["b", "3 2 3", "4 3 3"],
      phrase: "actually scratch the last three, make it 3 3 2",
    });
    assert.equal(heads[0]?.headers.authorization, "Bearer key-1");
  });
});

test("chatter the model marks as ignore types nothing", async () => {
  await withNano({ content: '{"intent":"ignore"}' }, async (url) => {
    assert.deepEqual(
      await filterWithNano("k", "m", "is it 10 or 12 today", [], url),
      { status: "ignore", reason: "conversation" },
    );
  });
});

test("an HTTP error, a timeout, or a cut-off reply is dropped as ignore, with the reason", async () => {
  await withNano({ status: 500, content: correction }, async (url) => {
    assert.deepEqual(await filterWithNano("k", "m", "10", [], url), {
      status: "ignore",
      reason: "http 500",
    });
  });
  await withNano({ hang: true }, async (url) => {
    assert.deepEqual(await filterWithNano("k", "m", "10", [], url, 50), {
      status: "ignore",
      reason: "timeout",
    });
  });
  await withNano({ content: correction, finish: "length" }, async (url) => {
    assert.deepEqual(await filterWithNano("k", "m", "10", [], url), {
      status: "ignore",
      reason: "truncated",
    });
  });
});

test("any bad reply is ignored whole, so nothing half-typed reaches the chart", () => {
  const bad = [
    "not json",
    '{"intent":"actions"}',
    '{"intent":"actions","actions":[]}',
    '{"intent":"actions","actions":[{"type":"depth","value":16}]}',
    '{"intent":"actions","actions":[{"type":"depth","value":2.5}]}',
    '{"intent":"actions","actions":[{"type":"depth","value":3},{"type":"enter"}]}',
    JSON.stringify({
      intent: "actions",
      actions: Array.from({ length: 13 }, () => ({ type: "back" })),
    }),
    JSON.stringify({
      intent: "actions",
      actions: Array.from({ length: 49 }, () => ({ type: "depth", value: 3 })),
    }),
  ];
  for (const content of bad)
    assert.equal(readNanoReply(content).status, "ignore", content);
  assert.deepEqual(readNanoReply("not json"), {
    status: "ignore",
    reason: "invalid json",
  });
  assert.deepEqual(
    readNanoReply('{"intent":"actions","actions":[{"type":"enter"}]}'),
    { status: "ignore", reason: "invalid actions" },
  );
  assert.deepEqual(
    readNanoReply(
      '{"intent":"actions","actions":[{"type":"depth","value":10},{"type":"bleeding"}]}',
    ),
    {
      status: "accept",
      actions: [{ type: "depth", value: 10 }, { type: "bleeding" }],
    },
  );
});

const reply = (actions: unknown[]): string =>
  JSON.stringify({ intent: "actions", actions });

test("a named-tooth edit and a resume both come through, alone or in one phrase", () => {
  const edit = {
    type: "set_tooth",
    tooth: 16,
    surface: "lingual",
    depths: [3, 3, 2],
  };
  const jump = { type: "goto_tooth", tooth: 5, surface: "buccal" };
  assert.deepEqual(readNanoReply(reply([edit])), {
    status: "accept",
    actions: [edit],
  });
  assert.deepEqual(readNanoReply(reply([jump])), {
    status: "accept",
    actions: [jump],
  });
  assert.deepEqual(readNanoReply(reply([edit, jump])), {
    status: "accept",
    actions: [edit, jump],
  });
});

test("a bad tooth, surface, or depth list throws out the whole reply", () => {
  const bad = [
    { type: "set_tooth", tooth: 0, surface: "buccal", depths: [3] },
    { type: "set_tooth", tooth: 33, surface: "buccal", depths: [3] },
    { type: "set_tooth", tooth: 4.5, surface: "buccal", depths: [3] },
    { type: "set_tooth", tooth: 4, surface: "mesial", depths: [3] },
    { type: "set_tooth", tooth: 4, depths: [3] },
    { type: "set_tooth", tooth: 4, surface: "buccal", depths: [] },
    { type: "set_tooth", tooth: 4, surface: "buccal", depths: [3, 16] },
    {
      type: "set_tooth",
      tooth: 4,
      surface: "buccal",
      depths: [1, 2, 3, 1, 2, 3, 1],
    },
    { type: "set_tooth", tooth: 4, surface: "buccal" },
    { type: "goto_tooth", tooth: 40, surface: "buccal" },
    { type: "goto_tooth", tooth: 4, surface: "top" },
  ];
  for (const action of bad)
    assert.deepEqual(
      readNanoReply(reply([{ type: "depth", value: 3 }, action])),
      { status: "ignore", reason: "invalid actions" },
      JSON.stringify(action),
    );
});
