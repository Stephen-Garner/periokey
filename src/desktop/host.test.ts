import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanKey,
  focusFrom,
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
