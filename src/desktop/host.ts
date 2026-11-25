import eaglesoft from "../../profiles/eaglesoft.json" with { type: "json" };
import generic from "../../profiles/generic.json" with { type: "json" };
import { profilesFrom, type Keystroke, type Profile } from "../keymap.ts";
import { readConfig, type Config } from "../config.ts";
import {
  typeReplyLog,
  typeReplyProblem,
  type FocusStatus,
  type Injector,
} from "../focus.ts";

type Tauri = {
  core: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  };
  event: {
    listen<T>(
      name: string,
      handler: (event: { payload: T }) => void,
    ): Promise<() => void>;
    emit(name: string, payload?: unknown): Promise<void>;
  };
};

export const tauri = Reflect.get(globalThis, "__TAURI__") as Tauri;

export type ProfileEdits = Record<string, Partial<Profile>>;

export type Settings = {
  env: Record<string, string>;
  mic: string;
  profileEdits: ProfileEdits;
};

export const BASE_PROFILES: unknown[] = [eaglesoft, generic];

const record = (value: unknown): Record<string, never> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, never>)
    : {};

// why: a hand-edited file may hold {"STT_PROVIDER": 42}; reading it must not crash startup.
const textOnly = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record(value) as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

function parseOrEmpty(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// why: a broken settings file must not stop the windows from opening; it reads as blank.
export function settingsFrom(raw: string): Settings {
  const parsed = parseOrEmpty(raw);
  const p = (typeof parsed === "object" && parsed ? parsed : {}) as Partial<
    Record<keyof Settings, unknown>
  >;
  return {
    env: textOnly(p.env),
    mic: typeof p.mic === "string" ? p.mic : "",
    profileEdits: record(p.profileEdits),
  };
}

export function profilesWith(edits: ProfileEdits): Map<string, Profile> {
  return profilesFrom(
    BASE_PROFILES.map((base) => {
      const name = (base as { name: string }).name;
      return { ...(base as object), ...edits[name], name };
    }),
  );
}

export function profilesSafe(edits: ProfileEdits): Map<string, Profile> {
  try {
    return profilesWith(edits);
  } catch {
    return profilesWith({});
  }
}

// why: people paste "Bearer sk-..." or stray spaces; a key is only these characters.
export function cleanKey(typed: string): string | null {
  const key = typed.trim().replace(/^bearer\s+/i, "");
  return /^[A-Za-z0-9_.-]+$/.test(key) ? key : null;
}

export const configOf = (settings: Settings): Config =>
  readConfig(settings.env);

export const loadSettings = async (): Promise<Settings> =>
  settingsFrom(await tauri.core.invoke<string>("load_settings"));

export const saveSettings = (settings: Settings): Promise<void> =>
  tauri.core.invoke("save_settings", { json: JSON.stringify(settings) });

export function focusFrom(reply: string): FocusStatus {
  if (reply === "MATCH") return "match";
  if (reply === "MISMATCH") return "mismatch";
  return "empty";
}

type Invoke = Tauri["core"]["invoke"];

// why: each phrase gets a number; Stop tells Rust to drop every phrase up to the newest one.
export function desktopInjector(
  invoke: Invoke = (command, args) => tauri.core.invoke(command, args),
): Injector {
  let token = 0;
  return {
    name: "desktop",
    async type(
      keys: Keystroke[],
      delayMs: number,
      windowMatch = "",
      programMatch = "",
    ) {
      token += 1;
      const reply = await invoke<string>("send_keys", {
        keys,
        delayMs,
        windowMatch,
        programMatch,
        token,
      });
      const line = typeReplyLog(reply, keys.length);
      if (line) console.warn(line);
      const problem = typeReplyProblem(reply, keys.length);
      if (problem) throw new Error(problem);
    },
    focusCheck: async (windowMatch, programMatch = "") =>
      focusFrom(
        await invoke<string>("focus_check", { windowMatch, programMatch }),
      ),
    stop() {
      void invoke("stop_typing", { upTo: token }).catch(() => {});
    },
    watchHotkey: () => false,
    showStatus: () => {},
    close: () => {},
  };
}
