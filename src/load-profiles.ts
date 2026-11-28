import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { profilesFrom, type Profile } from "./keymap.ts";

export function loadProfiles(dir: string): Map<string, Profile> {
  return profilesFrom(
    readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8"))),
  );
}
