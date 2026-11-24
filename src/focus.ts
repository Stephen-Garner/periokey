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

export function focusProblem(status: FocusStatus, windowMatch: string): string {
  return status === "empty"
    ? "Paused: no active window detected on this desktop (check you didn't start PerioKey from a sandboxed terminal)."
    : `Paused: Eaglesoft Perio Exam window is not focused (looking for "${windowMatch}").`;
}

// why: console lines carry only counts and helper error text, never titles or words.
export function typeReplyLog(reply: string, total: number): string | null {
  if (reply === "OK") return null;
  const lost = /^LOST_FOCUS (\d+)$/.exec(reply);
  if (lost) return `[live] typing stopped: LOST_FOCUS (${lost[1]}/${total})`;
  return `[live] typing error: ${reply.replace(/^ERR /, "")}`;
}

export function typeReplyProblem(reply: string, total: number): string | null {
  if (reply === "OK") return null;
  const lost = /^LOST_FOCUS (\d+)$/.exec(reply);
  if (lost)
    return `Paused: the dental software lost focus after ${lost[1]} of ${total} keys. Check the chart.`;
  return `Paused: typing failed (${reply.replace(/^ERR /, "")}). Check the chart.`;
}
