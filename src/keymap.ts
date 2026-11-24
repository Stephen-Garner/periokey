import type { Action } from "./parser.ts";

export type Modifier = "ctrl" | "alt" | "shift";
export type Keystroke = { key: string; mods: Modifier[] };

export const TEN_TO_FIFTEEN_STYLES = [
  "two_digits",
  "ctrl_digit",
  "slash_then_digit",
  "minus_then_digit",
  "alt_equals_digit",
  "shift_one_digit",
  "not_set",
] as const;
export type TenToFifteenStyle = (typeof TEN_TO_FIFTEEN_STYLES)[number];

export const SEPARATORS = ["none", "tab", "enter", "space"] as const;
export type Separator = (typeof SEPARATORS)[number];

export const NAMED_KEYS = [
  "backspace",
  "delete",
  "left",
  "right",
  "up",
  "down",
  "tab",
  "enter",
  "space",
] as const;

export type Profile = {
  name: string;
  label: string;
  window_match: string;
  ten_to_fifteen: TenToFifteenStyle;
  after_each_depth: Separator;
  bleeding: string;
  undo: string;
  skip: string;
  prev_tooth: string;
  inter_key_delay_ms: number;
  bleeding_steps_back_first: boolean;
};

function isKeyName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value.length === 1 || (NAMED_KEYS as readonly string[]).includes(value))
  );
}

export function validateProfile(raw: unknown): Profile {
  if (typeof raw !== "object" || raw === null)
    throw new Error("profile must be a JSON object");
  const p = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof p.name !== "string" || !/^[a-z_]+$/.test(p.name))
    problems.push("name must be lowercase letters and _");
  if (typeof p.label !== "string") problems.push("label must be text");
  if (typeof p.window_match !== "string")
    problems.push("window_match must be text");
  if (
    !(TEN_TO_FIFTEEN_STYLES as readonly unknown[]).includes(p.ten_to_fifteen)
  ) {
    problems.push(
      `ten_to_fifteen must be one of ${TEN_TO_FIFTEEN_STYLES.join(", ")}`,
    );
  }
  if (!(SEPARATORS as readonly unknown[]).includes(p.after_each_depth)) {
    problems.push(`after_each_depth must be one of ${SEPARATORS.join(", ")}`);
  }
  for (const field of ["bleeding", "undo", "skip", "prev_tooth"]) {
    if (!isKeyName(p[field]))
      problems.push(
        `${field} must be one character or one of ${NAMED_KEYS.join(", ")}`,
      );
  }
  const delay = p.inter_key_delay_ms;
  if (
    typeof delay !== "number" ||
    !Number.isInteger(delay) ||
    delay < 0 ||
    delay > 1000
  ) {
    problems.push("inter_key_delay_ms must be a whole number from 0 to 1000");
  }
  if (typeof p.bleeding_steps_back_first !== "boolean")
    problems.push("bleeding_steps_back_first must be true or false");
  if (problems.length > 0)
    throw new Error(`bad profile ${String(p.name)}: ${problems.join("; ")}`);
  return p as Profile;
}

export function profilesFrom(raws: unknown[]): Map<string, Profile> {
  const profiles = new Map<string, Profile>();
  for (const raw of raws) {
    const profile = validateProfile(raw);
    profiles.set(profile.name, profile);
  }
  return profiles;
}

function key(name: string, mods: Modifier[] = []): Keystroke {
  return { key: name, mods };
}

function encodeDepth(value: number, profile: Profile): Keystroke[] | null {
  if (value < 10) return [key(String(value))];
  const digit = String(value - 10);
  switch (profile.ten_to_fifteen) {
    case "two_digits":
      return [key("1"), key(digit)];
    case "ctrl_digit":
      return [key(digit, ["ctrl"])];
    case "slash_then_digit":
      return [key("/"), key(digit)];
    case "minus_then_digit":
      return [key("-"), key(digit)];
    case "alt_equals_digit":
      return [key("=", ["alt"]), key(digit)];
    case "shift_one_digit":
      return [key("1", ["shift"]), key(digit)];
    case "not_set":
      return null;
  }
}

export function encodeActions(
  actions: Action[],
  profile: Profile,
): Keystroke[] | null {
  const keys: Keystroke[] = [];
  for (const action of actions) {
    if (action.type === "depth") {
      const depthKeys = encodeDepth(action.value, profile);
      if (depthKeys === null) return null;
      keys.push(...depthKeys);
      if (profile.after_each_depth !== "none")
        keys.push(key(profile.after_each_depth));
    } else if (action.type === "bleeding") {
      if (profile.bleeding_steps_back_first)
        keys.push(key("left"), key(profile.bleeding), key("right"));
      else keys.push(key(profile.bleeding));
    } else if (action.type === "back") {
      keys.push(key(profile.undo));
    } else if (action.type === "skip") {
      keys.push(key(profile.skip));
    } else if (action.type === "prev_tooth") {
      keys.push(key(profile.prev_tooth));
    } else if (action.type === "set_tooth" || action.type === "goto_tooth") {
      // why: no profile has a checked tooth-jump key yet, so refuse the whole phrase.
      return null;
    }
  }
  return keys;
}

export function describeKey(stroke: Keystroke): string {
  const names: Record<string, string> = {
    left: "←",
    right: "→",
    up: "↑",
    down: "↓",
    backspace: "⌫",
  };
  const label =
    names[stroke.key] ??
    (stroke.key.length === 1 ? stroke.key.toUpperCase() : stroke.key);
  return [
    ...stroke.mods.map((mod) => mod[0]?.toUpperCase() + mod.slice(1)),
    label,
  ].join("+");
}
