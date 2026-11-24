import { test } from "node:test";
import assert from "node:assert/strict";
import { focusFrom, profilesWith, settingsFrom } from "./host.ts";

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
