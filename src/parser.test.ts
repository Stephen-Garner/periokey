import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePhrase, type Action } from "./parser.ts";

function depths(...values: number[]): Action[] {
  return values.map((value) => ({ type: "depth", value }));
}

function accepted(text: string): Action[] {
  const result = parsePhrase(text);
  assert.equal(
    result.status,
    "accept",
    `expected "${text}" to be accepted, got ${JSON.stringify(result)}`,
  );
  return result.status === "accept" ? result.actions : [];
}

function assertStatus(text: string, status: "reject" | "ignore"): void {
  assert.equal(
    parsePhrase(text).status,
    status,
    `"${text}" should be ${status}`,
  );
}

test("plain number words become depths", () => {
  assert.deepEqual(accepted("three two three"), depths(3, 2, 3));
  assert.deepEqual(accepted("one five nine"), depths(1, 5, 9));
});

test("noisy-room homophones map to digits", () => {
  assert.deepEqual(accepted("to too"), depths(2, 2));
  assert.deepEqual(accepted("for fore"), depths(4, 4));
  assert.deepEqual(accepted("ate won tree"), depths(8, 1, 3));
  assert.deepEqual(accepted("three to four"), depths(3, 2, 4));
});

test("oh maps to zero, which is out of range, so the phrase is rejected", () => {
  assertStatus("three oh two", "reject");
  assertStatus("zero", "reject");
  assertStatus("0", "reject");
});

test("ten to fifteen stay whole, as words or digits", () => {
  assert.deepEqual(
    accepted("ten eleven twelve thirteen fourteen fifteen"),
    depths(10, 11, 12, 13, 14, 15),
  );
  assert.deepEqual(accepted("12 3"), depths(12, 3));
  assert.deepEqual(accepted("15"), depths(15));
});

test("glued digits split into single depths", () => {
  assert.deepEqual(accepted("323"), depths(3, 2, 3));
  assert.deepEqual(accepted("23"), depths(2, 3));
  assert.deepEqual(accepted("34"), depths(3, 4));
  assert.deepEqual(accepted("123"), depths(1, 2, 3));
  assert.deepEqual(accepted("321"), depths(3, 2, 1));
  assert.deepEqual(accepted("323432"), depths(3, 2, 3, 4, 3, 2));
  assert.deepEqual(accepted("323 432 321"), depths(3, 2, 3, 4, 3, 2, 3, 2, 1));
});

test("glued digits containing 0, other than 10, are rejected", () => {
  assertStatus("302", "reject");
  assertStatus("05", "reject");
  assertStatus("20", "reject");
  assertStatus("30", "reject");
  assertStatus("100", "reject");
  assertStatus("2150", "reject");
});

test("compound tens followed by one to nine split into two digits", () => {
  assert.deepEqual(accepted("three twenty-three"), depths(3, 2, 3));
  assert.deepEqual(accepted("three twenty three"), depths(3, 2, 3));
  assert.deepEqual(accepted("thirty-two four"), depths(3, 2, 4));
});

test("numbers above 15 that cannot split reject the phrase", () => {
  assertStatus("twenty", "reject");
  assertStatus("three twenty", "reject");
  assertStatus("sixteen", "reject");
  assertStatus("hundred", "reject");
  assertStatus("two hundred", "reject");
});

test("ten to fifteen stay whole next to single digits", () => {
  assert.deepEqual(accepted("ten"), depths(10));
  assert.deepEqual(accepted("12"), depths(12));
  assert.deepEqual(accepted("three twelve three"), depths(3, 12, 3));
});

test("rapid runs across many teeth are accepted up to 48 depths", () => {
  assert.deepEqual(
    accepted("3 2 3 4 3 2 2 1 3"),
    depths(3, 2, 3, 4, 3, 2, 2, 1, 3),
  );
  assert.equal(accepted("323 ".repeat(16)).length, 48);
  assertStatus("323 ".repeat(16) + "3", "reject");
});

test("bleeding attaches to the depth before it", () => {
  assert.deepEqual(accepted("three bleeding two"), [
    { type: "depth", value: 3 },
    { type: "bleeding" },
    { type: "depth", value: 2 },
  ]);
  assert.deepEqual(accepted("four bleed"), [
    { type: "depth", value: 4 },
    { type: "bleeding" },
  ]);
});

test("bleeding said alone marks the last site", () => {
  assert.deepEqual(accepted("bleeding"), [{ type: "bleeding" }]);
});

test("bleeding twice in a row, or before any depth in a longer phrase, is rejected", () => {
  assertStatus("three bleeding bleeding", "reject");
  assertStatus("bleeding three two", "reject");
});

test("bleeding does not count toward the depth limit", () => {
  const actions = accepted("323 ".repeat(16) + "bleeding");
  assert.equal(actions.filter((action) => action.type === "depth").length, 48);
  assert.deepEqual(actions.at(-1), { type: "bleeding" });
});

test("standalone commands", () => {
  assert.deepEqual(accepted("back"), [{ type: "back" }]);
  assert.deepEqual(accepted("undo"), [{ type: "back" }]);
  assert.deepEqual(accepted("skip"), [{ type: "skip" }]);
  assert.deepEqual(accepted("pause"), [{ type: "pause" }]);
  assert.deepEqual(accepted("Stop."), [{ type: "pause" }]);
});

test("back, skip, and pause mixed with depths reject the phrase", () => {
  assertStatus("three back", "reject");
  assertStatus("skip two", "reject");
  assertStatus("back back", "reject");
});

test("fillers and lead-ins are dropped", () => {
  assert.deepEqual(accepted("um three, uh, two and four"), depths(3, 2, 4));
  assert.deepEqual(accepted("okay three two three"), depths(3, 2, 3));
  assert.deepEqual(accepted("next, good, two"), depths(2));
  assert.deepEqual(accepted("alright moving on bleeding"), [
    { type: "bleeding" },
  ]);
});

test("pure chatter is ignored silently", () => {
  assertStatus("", "ignore");
  assertStatus("um", "ignore");
  assertStatus("okay great", "ignore");
  assertStatus("open wide", "ignore");
  assertStatus("open a little wider", "ignore");
  assertStatus("you're doing great", "ignore");
  assertStatus("how was your weekend", "ignore");
  assertStatus("I'm going to get that for you", "ignore");
  assertStatus("lean back for me", "ignore");
});

test("chatter with one or two stray numbers is ignored, never typed", () => {
  assertStatus("see you in six months", "ignore");
  assertStatus("I have two kids", "ignore");
  assertStatus("your two kids", "ignore");
  assertStatus("maybe three or four weeks", "ignore");
  assertStatus("three or four weeks", "ignore");
  assertStatus("three to four weeks", "ignore");
  assertStatus("three two hold on", "ignore");
  assertStatus("twenty minutes", "ignore");
});

test("a run of three or more depths is pulled out of chatter", () => {
  assert.deepEqual(
    accepted("open wider, three two three four three two"),
    depths(3, 2, 3, 4, 3, 2),
  );
  assert.deepEqual(
    accepted("open wider three two three four three two bleeding"),
    [...depths(3, 2, 3, 4, 3, 2), { type: "bleeding" }],
  );
  assert.deepEqual(accepted("looks good three two three bleeding"), [
    ...depths(3, 2, 3),
    { type: "bleeding" },
  ]);
  assert.deepEqual(accepted("hold on 323 432"), depths(3, 2, 3, 4, 3, 2));
  assert.deepEqual(accepted("wow 2 3 then later 4 3 2 1"), depths(4, 3, 2, 1));
});

test("punctuation and case do not matter", () => {
  assert.deepEqual(accepted("Three, two. THREE!"), depths(3, 2, 3));
});
