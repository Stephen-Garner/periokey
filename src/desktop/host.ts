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

export function settingsFrom(raw: string): Settings {
  const parsed: unknown = raw ? JSON.parse(raw) : {};
  const p = (typeof parsed === "object" && parsed ? parsed : {}) as Partial<
    Record<keyof Settings, unknown>
  >;
  return {
    env: record(p.env),
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

export function desktopInjector(): Injector {
  return {
    name: "desktop",
    async type(keys: Keystroke[], delayMs: number, windowMatch = "") {
      const reply = await tauri.core.invoke<string>("send_keys", {
        keys,
        delayMs,
        windowMatch,
      });
      const line = typeReplyLog(reply, keys.length);
      if (line) console.warn(line);
      const problem = typeReplyProblem(reply, keys.length);
      if (problem) throw new Error(problem);
    },
    focusCheck: async (windowMatch) =>
      focusFrom(
        await tauri.core.invoke<string>("focus_check", { windowMatch }),
      ),
    watchHotkey: () => false,
    showStatus: () => {},
    close: () => {},
  };
}
