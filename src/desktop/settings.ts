import { TEN_TO_FIFTEEN_STYLES, type Profile } from "../keymap.ts";
import type { Action } from "../parser.ts";
import { SITES_PER_TOOTH, TEETH, applyToChart, emptyChart } from "../chart.ts";
import {
  cleanKey,
  configOf,
  loadSettings,
  profilesSafe,
  profilesWith,
  saveSettings,
  tauri,
  type Settings,
} from "./host.ts";

type View = {
  status: string;
  mode: "practice" | "live";
  profile: string;
  note: string;
};
type Heard = {
  text: string;
  ai: boolean;
  verdict: string;
  reason: string;
  depths: number;
  timing: { speechMs?: number; gapMs?: number; latencyMs?: number };
};

const el = <T extends HTMLElement = HTMLInputElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
};

let settings: Settings = await loadSettings();
let view: View | null = null;
let log: Heard[] = [];
const chart = emptyChart();

const send = (message: Record<string, unknown>): void => {
  void tauri.event.emit("engine-in", message);
};

function keyFields(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>("[data-key]")];
}

function fillForm(): void {
  const config = configOf(settings);
  el<HTMLSelectElement>("provider").value = config.provider ?? "openai";
  for (const [id, name] of [
    ["openaiKey", "OPENAI_API_KEY"],
    ["deepgramKey", "DEEPGRAM_API_KEY"],
  ] as const) {
    el(id).value = "";
    el(id).placeholder = settings.env[name] ? "saved (hidden)" : "not set";
  }
  el("hotkey").value = config.hotkey;
  const profiles = profilesSafe(settings.profileEdits);
  const select = el<HTMLSelectElement>("profile");
  select.replaceChildren(
    ...[...profiles.values()].map((p) => new Option(p.label, p.name)),
  );
  select.value = view?.profile ?? config.profile;
  fillKeys(profiles.get(select.value));
}

function fillKeys(profile: Profile | undefined): void {
  if (!profile) return;
  for (const field of keyFields())
    field.value = String(profile[field.dataset.key as keyof Profile] ?? "");
}

// why: WebView2 hides mic names and ids until the mic is allowed once, so ask here and close it.
async function allowMic(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();
}

async function listMics(): Promise<void> {
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.some((d) => d.kind === "audioinput" && !d.deviceId)) {
    await allowMic().catch(() => {
      el("saved").textContent = "Allow the microphone to choose one.";
    });
    devices = await navigator.mediaDevices.enumerateDevices();
  }
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const select = el<HTMLSelectElement>("mic");
  select.replaceChildren(
    new Option("System default", ""),
    ...inputs.map(
      (d, i) => new Option(d.label || `Microphone ${i + 1}`, d.deviceId),
    ),
  );
  select.value = settings.mic;
}

function edits(): Partial<Profile> {
  const out: Record<string, string | number> = {};
  for (const field of keyFields()) {
    const name = field.dataset.key ?? "";
    if (field.value.trim() === "") continue;
    out[name] =
      name === "inter_key_delay_ms" ? Number(field.value) : field.value.trim();
  }
  return out as Partial<Profile>;
}

async function save(): Promise<void> {
  const env = { ...settings.env };
  const provider = el<HTMLSelectElement>("provider").value;
  env.STT_PROVIDER = provider;
  for (const [id, name] of [
    ["openaiKey", "OPENAI_API_KEY"],
    ["deepgramKey", "DEEPGRAM_API_KEY"],
  ] as const) {
    const typed = el(id).value.trim();
    if (!typed) continue;
    const key = cleanKey(typed);
    if (!key) {
      el("saved").textContent =
        "That key has spaces or symbols a key cannot have. Paste it again.";
      return;
    }
    env[name] = key;
  }
  env.PERIOKEY_HOTKEY = el("hotkey").value.trim() || "F9";
  const profile = el<HTMLSelectElement>("profile").value;
  env.PMS_PROFILE = profile;
  const next: Settings = {
    env,
    mic: el<HTMLSelectElement>("mic").value,
    profileEdits: { ...settings.profileEdits, [profile]: edits() },
  };
  try {
    profilesWith(next.profileEdits);
  } catch (error) {
    el("saved").textContent = error instanceof Error ? error.message : "";
    return;
  }
  await saveSettings(next);
  settings = next;
  fillForm();
  el("saved").textContent = "Saved.";
  await tauri.event.emit("settings-changed");
}

function renderState(): void {
  if (!view) return;
  el("status").textContent = view.status.toLowerCase();
  el("note").textContent = view.note;
  for (const button of document.querySelectorAll<HTMLElement>("[data-mode]"))
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.mode === view.mode),
    );
  el("practice").hidden = view.mode !== "practice";
}

function cell(text: string, className = ""): HTMLDivElement {
  const div = document.createElement("div");
  div.textContent = text;
  div.className = className;
  return div;
}

function renderChart(): void {
  const half = SITES_PER_TOOTH / 2;
  const cells = [
    cell("tooth", "head"),
    cell(`buccal 1-${half}`, "head span split"),
    cell(`lingual ${half + 1}-${SITES_PER_TOOTH}`, "head span"),
  ];
  for (let tooth = 0; tooth < TEETH; tooth += 1) {
    cells.push(cell(String(tooth + 1), "tooth"));
    for (let site = 0; site < SITES_PER_TOOTH; site += 1) {
      const index = tooth * SITES_PER_TOOTH + site;
      const box = cell(chart.values[index], site === half - 1 ? "split" : "");
      box.classList.toggle("cursor", index === chart.cursor);
      box.classList.toggle("bleed", chart.bleed.has(index));
      cells.push(box);
    }
  }
  el("grid").replaceChildren(...cells);
}

function cadence(): string {
  const timed = log.filter((h) => h.timing.speechMs);
  const speech = timed.reduce((sum, h) => sum + (h.timing.speechMs ?? 0), 0);
  const nums = timed.reduce((sum, h) => sum + h.depths, 0);
  const gaps = log.flatMap((h) => h.timing.gapMs ?? []);
  const count = (v: string) => log.filter((h) => h.verdict === v).length;
  const speed = speech ? ((nums * 1000) / speech).toFixed(1) : "-";
  const pause = gaps.length
    ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)
    : "-";
  return `phrases ${log.length} · ${speed} nums/sec · avg pause ${pause} ms · accepted ${count("accept")} / rejected ${count("reject")} / ignored ${count("ignore")}`;
}

function logLine(h: Heard): string {
  const t = h.timing;
  const times = [
    t.speechMs !== undefined && `${(t.speechMs / 1000).toFixed(1)}s speech`,
    t.gapMs !== undefined && `${t.gapMs}ms pause`,
    t.latencyMs !== undefined && `${t.latencyMs}ms latency`,
  ].filter(Boolean);
  const verdict =
    h.verdict === "accept"
      ? `accept (${h.depths} depths)`
      : h.reason
        ? `${h.verdict}: ${h.reason}`
        : h.verdict;
  return [`"${h.text}" → ${verdict}${h.ai ? " (nano)" : ""}`, ...times].join(
    " · ",
  );
}

function renderLog(): void {
  el("cadence").textContent = cadence();
  el("log").replaceChildren(
    ...log.slice(-20).map((h) => {
      const item = document.createElement("li");
      item.textContent = logLine(h);
      return item;
    }),
  );
}

void tauri.event.listen<Record<string, unknown>>(
  "engine-out",
  ({ payload }) => {
    if (payload.type === "state") {
      const first = view === null;
      view = payload as unknown as View;
      renderState();
      if (first) fillForm();
    } else if (payload.type === "entry" && view?.mode === "practice") {
      const note = applyToChart(chart, payload.actions as Action[]);
      if (note) el("note").textContent = note;
      renderChart();
    } else if (payload.type === "heard") {
      log.push(payload as unknown as Heard);
      renderLog();
    }
  },
);

for (const select of document.querySelectorAll<HTMLSelectElement>(
  '[data-key="ten_to_fifteen"]',
))
  select.replaceChildren(...TEN_TO_FIFTEEN_STYLES.map((s) => new Option(s, s)));

for (const button of document.querySelectorAll<HTMLElement>("[data-mode]"))
  button.addEventListener("click", () => {
    const mode = button.dataset.mode ?? "practice";
    send({ type: "mode", mode });
    settings = { ...settings, env: { ...settings.env, PERIOKEY_MODE: mode } };
    void saveSettings(settings);
  });
el<HTMLSelectElement>("profile").addEventListener("change", (event) => {
  const name = (event.target as HTMLSelectElement).value;
  send({ type: "profile", name });
  fillKeys(profilesSafe(settings.profileEdits).get(name));
});
el("save").addEventListener("click", () => {
  void save();
});
el("clearKeys").addEventListener("click", () => {
  const env = { ...settings.env };
  delete env.OPENAI_API_KEY;
  delete env.DEEPGRAM_API_KEY;
  settings = { ...settings, env };
  void saveSettings(settings).then(async () => {
    fillForm();
    el("saved").textContent = "Saved keys cleared.";
    await tauri.event.emit("settings-changed");
  });
});
el<HTMLFormElement>("simulate").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = el("phrase").value.trim();
  if (text) send({ type: "simulate", text });
  el("phrase").value = "";
});
el("clear").addEventListener("click", () => {
  Object.assign(chart, emptyChart());
  log = [];
  renderChart();
  renderLog();
  send({ type: "clear" });
});
// why: the clipboard can outlive the app, so only counts and timings are copied, never words.
function statLine(h: Heard): string {
  const t = h.timing;
  return [
    h.verdict,
    `${h.depths} depths`,
    h.ai ? "nano" : "",
    t.speechMs === undefined ? "" : `${t.speechMs}ms speech`,
    t.gapMs === undefined ? "" : `${t.gapMs}ms pause`,
    t.latencyMs === undefined ? "" : `${t.latencyMs}ms latency`,
  ]
    .filter(Boolean)
    .join(" · ");
}

el("copyLog").addEventListener("click", () => {
  void navigator.clipboard
    .writeText([cadence(), ...log.map(statLine)].join("\n"))
    .catch(() => {
      el("note").textContent = "Could not copy the log.";
    });
});
navigator.mediaDevices.addEventListener("devicechange", () => {
  void listMics();
});

fillForm();
void listMics();
renderChart();
renderLog();
send({ type: "hello" });
