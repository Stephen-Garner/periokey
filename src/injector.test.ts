import { test } from "node:test";
import assert from "node:assert/strict";
import type { Keystroke } from "./keymap.ts";
import {
  toSendKeys,
  toAppleScript,
  hotkeyToVirtualKey,
  typeReplyProblem,
  typeCommand,
  statusCommand,
  focusCommand,
  parseFocusReply,
  focusProblem,
  desktopFromLine,
  isolatedDesktopWarning,
  typeReplyLog,
} from "./injector.ts";

test("Windows SendKeys strings for digits, chords, and named keys", () => {
  assert.equal(toSendKeys({ key: "3", mods: [] }), "3");
  assert.equal(toSendKeys({ key: "2", mods: ["ctrl"] }), "^2");
  assert.equal(toSendKeys({ key: "=", mods: ["alt"] }), "%=");
  assert.equal(toSendKeys({ key: "1", mods: ["shift"] }), "+1");
  assert.equal(toSendKeys({ key: "right", mods: [] }), "{RIGHT}");
  assert.equal(toSendKeys({ key: "backspace", mods: [] }), "{BACKSPACE}");
  assert.equal(toSendKeys({ key: "/", mods: [] }), "/");
  assert.equal(toSendKeys({ key: "-", mods: [] }), "-");
});

test("SendKeys special characters are wrapped in braces so they type literally", () => {
  assert.equal(toSendKeys({ key: "+", mods: [] }), "{+}");
  assert.equal(toSendKeys({ key: "%", mods: [] }), "{%}");
  assert.equal(toSendKeys({ key: "(", mods: [] }), "{(}");
});

test("macOS AppleScript lines for digits, chords, and named keys", () => {
  assert.equal(toAppleScript({ key: "3", mods: [] }), 'keystroke "3"');
  assert.equal(
    toAppleScript({ key: "2", mods: ["ctrl"] }),
    'keystroke "2" using {control down}',
  );
  assert.equal(
    toAppleScript({ key: "=", mods: ["alt"] }),
    'keystroke "=" using {option down}',
  );
  assert.equal(toAppleScript({ key: "right", mods: [] }), "key code 124");
  assert.equal(toAppleScript({ key: "backspace", mods: [] }), "key code 51");
  assert.equal(toAppleScript({ key: '"', mods: [] }), 'keystroke "\\""');
});

test("hotkeys F1 to F24 map to Windows virtual key codes; others are refused", () => {
  assert.equal(hotkeyToVirtualKey("F1"), 0x70);
  assert.equal(hotkeyToVirtualKey("F9"), 0x78);
  assert.equal(hotkeyToVirtualKey("F24"), 0x87);
  assert.equal(hotkeyToVirtualKey("F25"), null);
  assert.equal(hotkeyToVirtualKey("Space"), null);
});

test("the Windows helper's typing reply becomes a clear pause message", () => {
  assert.equal(typeReplyProblem("OK", 3), null);
  assert.match(
    typeReplyProblem("LOST_FOCUS 2", 3) ?? "",
    /lost focus after 2 of 3 keys/,
  );
  assert.match(
    typeReplyProblem("ERR Access is denied.", 3) ?? "",
    /typing failed \(Access is denied\.\)/,
  );
});

test("the Windows typing command carries the window match as base64 so spaces are safe", () => {
  const keys: Keystroke[] = [
    { key: "3", mods: [] },
    { key: "b", mods: ["shift"] },
  ];
  const [cmd, delay, match, ...sent] = typeCommand(
    keys,
    40,
    "Perio Exam",
  ).split("\t");
  assert.deepEqual([cmd, delay, sent], ["K", "40", ["3", "+b"]]);
  assert.equal(
    Buffer.from(match ?? "", "base64").toString("utf8"),
    "Perio Exam",
  );
  assert.equal(typeCommand(keys, 40).split("\t")[2], "");
});

test("the Windows pill status command is plain ASCII on one line", () => {
  assert.equal(statusCommand("Listening"), "P\tListening");
  assert.equal(statusCommand("Connecting…"), "P\tConnecting");
});

test("the Windows focus check sends the window match as base64 and reads back a status only", () => {
  const [cmd, match] = focusCommand("Perio Exam").split("\t");
  assert.equal(cmd, "F");
  assert.equal(
    Buffer.from(match ?? "", "base64").toString("utf8"),
    "Perio Exam",
  );
  assert.equal(parseFocusReply("F\tMATCH"), "match");
  assert.equal(parseFocusReply("F\tEMPTY"), "empty");
  assert.equal(parseFocusReply("F\tMISMATCH"), "mismatch");
  assert.equal(parseFocusReply("something else"), "mismatch");
});

test("a failed focus check says whether no window or the wrong window is in front", () => {
  assert.match(focusProblem("empty", "Perio Exam"), /no active window/);
  assert.match(
    focusProblem("mismatch", "Perio Exam"),
    /not focused \(looking for "Perio Exam"\)/,
  );
});

test("the helper's DESKTOP line is read, and only a non-Default desktop warns", () => {
  assert.equal(desktopFromLine("DESKTOP\tDefault"), "Default");
  assert.equal(desktopFromLine("DESKTOP\texebox-12"), "exebox-12");
  assert.equal(desktopFromLine("F\tMATCH"), null);
  assert.equal(isolatedDesktopWarning("Default"), null);
  assert.equal(isolatedDesktopWarning("default"), null);
  assert.match(
    isolatedDesktopWarning("exebox-12") ?? "",
    /isolated Windows desktop "exebox-12".*start-periokey\.bat/,
  );
});

test("typing problems become short console lines with counts only", () => {
  assert.equal(typeReplyLog("OK", 3), null);
  assert.equal(
    typeReplyLog("LOST_FOCUS 2", 3),
    "[live] typing stopped: LOST_FOCUS (2/3)",
  );
  assert.equal(
    typeReplyLog("ERR Access is denied.", 3),
    "[live] typing error: Access is denied.",
  );
});
