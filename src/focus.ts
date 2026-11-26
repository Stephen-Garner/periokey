import type { Keystroke } from "./keymap.ts";

export type FocusStatus = "match" | "empty" | "mismatch";

export type Injector = {
  name: string;
  type(
    keys: Keystroke[],
    delayMs: number,
    windowMatch?: string,
    programMatch?: string,
  ): Promise<void>;
  // why: returns a status, never a title; Eaglesoft titles hold patient names.
  focusCheck(windowMatch: string, programMatch?: string): Promise<FocusStatus>;
  // why: Stop must reach keys that are already being typed, not only the next phrase.
  stop?(): void;
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
  const stopped = /^STOPPED (\d+)$/.exec(reply);
  if (stopped) return `[live] typing stopped: STOPPED (${stopped[1]}/${total})`;
  return `[live] typing error: ${reply.replace(/^ERR /, "")}`;
}

export function typeReplyProblem(reply: string, total: number): string | null {
  if (reply === "OK") return null;
  const lost = /^LOST_FOCUS (\d+)$/.exec(reply);
  if (lost)
    return `Paused: the dental software lost focus after ${lost[1]} of ${total} keys. Check the chart.`;
  const stopped = /^STOPPED (\d+)$/.exec(reply);
  if (stopped)
    return `Paused: stopped after ${stopped[1]} of ${total} keys. Check the chart.`;
  return `Paused: typing failed (${reply.replace(/^ERR /, "")}). Check the chart.`;
}

// why: reads the count back from typeReplyProblem's Stop message, so a stale Stop can be told apart.
export function stoppedCount(error: unknown): number | null {
  const found =
    error instanceof Error
      ? /^Paused: stopped after (\d+) of /.exec(error.message)
      : null;
  return found ? Number(found[1]) : null;
}
