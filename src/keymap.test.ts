import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  encodeActions,
  validateProfile,
  describeKey,
  type Keystroke,
  type Profile,
  type TenToFifteenStyle,
} from "./keymap.ts";
import { parsePhrase, type Action } from "./parser.ts";
import { loadProfiles } from "./load-profiles.ts";

const profiles = loadProfiles(
  fileURLToPath(new URL("../profiles", import.meta.url)),
);

function profile(name: string): Profile {
  const found = profiles.get(name);
  assert.ok(found, `profile ${name} should exist`);
  return found;
}

function keysFor(text: string, name: string): string[] {
  const result = parsePhrase(text);
  assert.equal(result.status, "accept");
  const keys =
    result.status === "accept"
      ? encodeActions(result.actions, profile(name))
      : null;
  assert.ok(keys, `"${text}" should encode for ${name}`);
  return keys.map(describeKey);
}

test("only the Eaglesoft and generic profiles ship, and both pass validation", () => {
  assert.deepEqual([...profiles.keys()].toSorted(), ["eaglesoft", "generic"]);
  for (const p of profiles.values()) assert.equal(p.inter_key_delay_ms, 40);
});

test("single digits are the same key in every profile", () => {
  for (const name of profiles.keys())
    assert.deepEqual(keysFor("three two four", name), ["3", "2", "4"]);
});

function depthKeys(value: number, style: TenToFifteenStyle): string[] {
  const p = { ...profile("generic"), ten_to_fifteen: style };
  return (encodeActions([{ type: "depth", value }], p) ?? []).map(describeKey);
}

test("ten to fifteen use each encoding style, so a profile needs one line to switch", () => {
  assert.deepEqual(keysFor("twelve", "generic"), ["1", "2"]);
  assert.deepEqual(depthKeys(12, "ctrl_digit"), ["Ctrl+2"]);
  assert.deepEqual(depthKeys(10, "ctrl_digit"), ["Ctrl+0"]);
  assert.deepEqual(depthKeys(15, "slash_then_digit"), ["/", "5"]);
  assert.deepEqual(depthKeys(11, "minus_then_digit"), ["-", "1"]);
  assert.deepEqual(depthKeys(13, "alt_equals_digit"), ["Alt+=", "3"]);
  assert.deepEqual(depthKeys(14, "shift_one_digit"), ["Shift+1", "4"]);
});

test("commands map to the profile's bleeding, undo, and skip keys", () => {
  assert.deepEqual(keysFor("three bleeding", "generic"), ["3", "B"]);
  assert.deepEqual(keysFor("back", "eaglesoft"), ["⌫"]);
  assert.deepEqual(keysFor("skip", "eaglesoft"), ["→"]);
  const g = { ...profile("eaglesoft"), bleeding: "g" };
  assert.deepEqual(encodeActions([{ type: "bleeding" }], g)?.map(describeKey), [
    "G",
  ]);
});

test("pause types nothing", () => {
  assert.deepEqual(keysFor("pause", "generic"), []);
});

test("bleeding_steps_back_first steps left, marks, and steps right", () => {
  const p = { ...profile("eaglesoft"), bleeding_steps_back_first: true };
  const keys: Keystroke[] | null = encodeActions(
    [{ type: "depth", value: 4 }, { type: "bleeding" }],
    p,
  );
  assert.deepEqual(keys?.map(describeKey), ["4", "←", "B", "→"]);
});

test("after_each_depth adds a separator after every depth only", () => {
  const p = { ...profile("generic"), after_each_depth: "tab" as const };
  const keys = encodeActions(
    [
      { type: "depth", value: 3 },
      { type: "bleeding" },
      { type: "depth", value: 12 },
    ],
    p,
  );
  assert.deepEqual(keys?.map(describeKey), ["3", "tab", "B", "1", "2", "tab"]);
});

test("Eaglesoft types single digits and bleeding, and refuses 10 to 15 until its key is verified", () => {
  assert.deepEqual(keysFor("three two bleeding four", "eaglesoft"), [
    "3",
    "2",
    "B",
    "4",
  ]);
  const result = parsePhrase("three twelve");
  assert.equal(result.status, "accept");
  if (result.status === "accept")
    assert.equal(encodeActions(result.actions, profile("eaglesoft")), null);
  assert.equal(profile("eaglesoft").window_match, "Perio Exam");
  assert.ok(
    "New Perio Exam for - Test Patient (123)"
      .toLowerCase()
      .includes(profile("eaglesoft").window_match.toLowerCase()),
  );
});

test("a bad profile is refused with a clear reason", () => {
  assert.throws(
    () =>
      validateProfile({
        ...profile("generic"),
        ten_to_fifteen: "ctrl_shift_magic",
      }),
    /ten_to_fifteen must be one of/,
  );
  assert.throws(
    () => validateProfile({ ...profile("generic"), inter_key_delay_ms: -5 }),
    /inter_key_delay_ms/,
  );
  assert.throws(
    () => validateProfile({ ...profile("generic"), undo: "banana" }),
    /undo must be/,
  );
});

test("tooth edits and jumps have no keys yet, so the whole phrase is refused", () => {
  const edit: Action = {
    type: "set_tooth",
    tooth: 16,
    surface: "buccal",
    depths: [3, 3, 2],
  };
  const jump: Action = { type: "goto_tooth", tooth: 5, surface: "lingual" };
  for (const name of profiles.keys()) {
    assert.equal(encodeActions([edit], profile(name)), null, name);
    assert.equal(encodeActions([jump], profile(name)), null, name);
    assert.equal(
      encodeActions([{ type: "depth", value: 3 }, jump], profile(name)),
      null,
      name,
    );
  }
});

test("prev_tooth presses the profile's previous-tooth key, Left in Eaglesoft", () => {
  const redo: Action[] = [
    { type: "prev_tooth" },
    { type: "depth", value: 3 },
    { type: "depth", value: 2 },
  ];
  assert.deepEqual(
    encodeActions(redo, profile("eaglesoft"))?.map(describeKey),
    ["←", "3", "2"],
  );
  assert.throws(
    () => validateProfile({ ...profile("generic"), prev_tooth: "banana" }),
    /prev_tooth must be/,
  );
});
