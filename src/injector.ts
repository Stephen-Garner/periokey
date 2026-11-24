import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Keystroke } from "./keymap.ts";

export type FocusStatus = "match" | "empty" | "mismatch";

export type Injector = {
  name: string;
  type(keys: Keystroke[], delayMs: number, windowMatch?: string): Promise<void>;
  // why: returns a status, never a title; Eaglesoft titles hold patient names.
  focusCheck(windowMatch: string): Promise<FocusStatus>;
  watchHotkey(hotkey: string, onPress: () => void): boolean;
  showStatus(status: string): void;
  close(): void;
};

const SENDKEYS_NAMED: Record<string, string> = {
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  left: "{LEFT}",
  right: "{RIGHT}",
  up: "{UP}",
  down: "{DOWN}",
  tab: "{TAB}",
  enter: "{ENTER}",
  space: " ",
};

export function toSendKeys(stroke: Keystroke): string {
  const prefix = stroke.mods
    .map((mod) => ({ ctrl: "^", alt: "%", shift: "+" })[mod])
    .join("");
  const named = SENDKEYS_NAMED[stroke.key];
  const body =
    named ??
    (/^[+^%~(){}[\]]$/.test(stroke.key) ? `{${stroke.key}}` : stroke.key);
  return prefix + body;
}

const MAC_KEY_CODES: Record<string, number> = {
  backspace: 51,
  delete: 117,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  tab: 48,
  enter: 36,
  space: 49,
};

export function toAppleScript(stroke: Keystroke): string {
  const using =
    stroke.mods.length === 0
      ? ""
      : ` using {${stroke.mods.map((mod) => ({ ctrl: "control", alt: "option", shift: "shift" })[mod] + " down").join(", ")}}`;
  const code = MAC_KEY_CODES[stroke.key];
  if (code !== undefined) return `key code ${code}${using}`;
  const escaped = stroke.key.replace(/["\\]/g, (char) => `\\${char}`);
  return `keystroke "${escaped}"${using}`;
}

export function hotkeyToVirtualKey(hotkey: string): number | null {
  const match = /^F([1-9]|1[0-9]|2[0-4])$/.exec(hotkey);
  return match ? 0x6f + Number(match[1]) : null;
}

export function typeCommand(
  keys: Keystroke[],
  delayMs: number,
  windowMatch = "",
): string {
  const match = Buffer.from(windowMatch, "utf8").toString("base64");
  return ["K", String(delayMs), match, ...keys.map(toSendKeys)].join("\t");
}

export function focusCommand(windowMatch: string): string {
  return `F\t${Buffer.from(windowMatch, "utf8").toString("base64")}`;
}

export function parseFocusReply(reply: string): FocusStatus {
  if (reply === "F\tMATCH") return "match";
  if (reply === "F\tEMPTY") return "empty";
  return "mismatch";
}

export function focusProblem(status: FocusStatus, windowMatch: string): string {
  return status === "empty"
    ? "Paused: no active window detected on this desktop (check you didn't start PerioKey from a sandboxed terminal)."
    : `Paused: Eaglesoft Perio Exam window is not focused (looking for "${windowMatch}").`;
}

export function desktopFromLine(line: string): string | null {
  return line.startsWith("DESKTOP\t") ? line.slice("DESKTOP\t".length) : null;
}

export function isolatedDesktopWarning(desktop: string): string | null {
  if (desktop.toLowerCase() === "default") return null;
  return `Running on isolated Windows desktop "${desktop}" (not "Default"). Keystrokes and the floating pill will not reach Eaglesoft. Start PerioKey by double-clicking start-periokey.bat on Windows.`;
}

// why: console lines carry only counts and helper error text, never titles or words.
export function typeReplyLog(reply: string, total: number): string | null {
  if (reply === "OK") return null;
  const lost = /^LOST_FOCUS (\d+)$/.exec(reply);
  if (lost) return `[live] typing stopped: LOST_FOCUS (${lost[1]}/${total})`;
  return `[live] typing error: ${reply.replace(/^ERR /, "")}`;
}

export function statusCommand(status: string): string {
  return `P\t${status.replace(/[^\x20-\x7e]/g, "")}`;
}

export function typeReplyProblem(reply: string, total: number): string | null {
  if (reply === "OK") return null;
  const lost = /^LOST_FOCUS (\d+)$/.exec(reply);
  if (lost)
    return `Paused: the dental software lost focus after ${lost[1]} of ${total} keys. Check the chart.`;
  return `Paused: typing failed (${reply.replace(/^ERR /, "")}). Check the chart.`;
}

function windowsInjector(onDesktop?: (name: string) => void): Injector {
  const script = fileURLToPath(new URL("./win-helper.ps1", import.meta.url));
  const helper: ChildProcessWithoutNullStreams = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    { stdio: "pipe" },
  );
  type Waiter = { resolve(line: string): void; reject(error: Error): void };
  const waiting: Waiter[] = [];
  let dead: Error | null = null;
  let onHotkey: (() => void) | null = null;
  createInterface({ input: helper.stdout }).on("line", (line) => {
    const desktop = desktopFromLine(line);
    if (desktop !== null) onDesktop?.(desktop);
    else if (line === "H" || line === "HOTKEY") onHotkey?.();
    else waiting.shift()?.resolve(line);
  });
  function fail(error: Error): void {
    dead ??= error;
    for (const waiter of waiting.splice(0)) waiter.reject(dead);
  }
  helper.on("error", (error) =>
    fail(
      new Error(`The Windows typing helper could not run: ${error.message}`),
    ),
  );
  helper.on("exit", () =>
    fail(new Error("The Windows typing helper stopped.")),
  );
  helper.stdin.on("error", () =>
    fail(new Error("The Windows typing helper stopped.")),
  );
  function ask(command: string): Promise<string> {
    if (dead) return Promise.reject(dead);
    return new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      helper.stdin.write(`${command}\n`);
    });
  }
  return {
    name: "windows",
    async type(keys, delayMs, windowMatch) {
      if (keys.length === 0) return;
      const reply = await ask(typeCommand(keys, delayMs, windowMatch));
      const problem = typeReplyProblem(reply, keys.length);
      if (problem) {
        console.warn(typeReplyLog(reply, keys.length));
        throw new Error(problem);
      }
    },
    async focusCheck(windowMatch) {
      return parseFocusReply(await ask(focusCommand(windowMatch)));
    },
    watchHotkey(hotkey, onPress) {
      const vk = hotkeyToVirtualKey(hotkey);
      if (vk === null) return false;
      onHotkey = onPress;
      helper.stdin.write(`H\t${vk}\n`);
      return true;
    },
    showStatus(status) {
      if (!dead) helper.stdin.write(`${statusCommand(status)}\n`);
    },
    close() {
      helper.kill();
    },
  };
}

function osascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    );
  });
}

function macInjector(): Injector {
  return {
    name: "mac",
    async type(keys, delayMs) {
      if (keys.length === 0) return;
      const lines = keys.map(toAppleScript).join(`\ndelay ${delayMs / 1000}\n`);
      await osascript(`tell application "System Events"\n${lines}\nend tell`);
    },
    async focusCheck(windowMatch) {
      const app = await osascript(
        'tell application "System Events" to get name of first application process whose frontmost is true',
      );
      if (!app) return "empty";
      return app.toLowerCase().includes(windowMatch.toLowerCase())
        ? "match"
        : "mismatch";
    },
    watchHotkey() {
      return false;
    },
    showStatus() {},
    close() {},
  };
}

export function createOsInjector(
  platform: NodeJS.Platform = process.platform,
  onDesktop?: (name: string) => void,
): Injector | null {
  if (platform === "win32") return windowsInjector(onDesktop);
  if (platform === "darwin") return macInjector();
  return null;
}
