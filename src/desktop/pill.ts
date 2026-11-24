import { createEngine, type EngineMessage } from "../engine.ts";
import { browserConnect } from "../stt.ts";
import {
  FRAMES_PER_SEND,
  SAMPLE_RATE,
  levelOf,
  merge,
  resample,
  toPcm16,
} from "../audio.ts";
import {
  configOf,
  desktopInjector,
  loadSettings,
  profilesSafe,
  tauri,
  type Settings,
} from "./host.ts";

const COLS = 13;
const ROWS = 5;
const SHAPE = Array.from(
  { length: COLS },
  (_, c) => 1 - (Math.abs(c - (COLS - 1) / 2) / COLS) * 1.2,
);

type View = {
  status: string;
  listening: boolean;
  provider: string;
  note: string;
  recent: string[];
};

const el = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found;
};

let settings: Settings = await loadSettings();
let view: View | null = null;
let sideNote = "";
let audio: AudioContext | null = null;
let mic: { stream: MediaStream; source: MediaStreamAudioSourceNode } | null =
  null;
let capture: Promise<AudioWorkletNode> | null = null;
let micStarting = false;
let micToken = 0;
let level = 0;
let pending: Float32Array[] = [];
let pendingLength = 0;

const dots = Array.from({ length: COLS * ROWS }, () =>
  document.createElement("i"),
);
el("eq").replaceChildren(...dots);

const engine = createEngine({
  config: configOf(settings),
  profiles: profilesSafe(settings.profileEdits),
  makeInjector: desktopInjector,
  emit,
  openAiConnect: browserConnect,
  micBlockedNote:
    "Microphone blocked or missing. Open Settings, pick a mic, then press Start.",
  noTargetNote:
    'Set "window title contains" in Settings to use Live mode with this profile.',
});

function emit(message: EngineMessage): void {
  if (message.type === "state") {
    view = message as unknown as View;
    render();
    syncMic();
  } else if (message.type === "earcon") earcon(String(message.kind));
  void tauri.event.emit("engine-out", message);
}

function render(): void {
  if (!view) return;
  el("frame").dataset.status = view.status;
  el("go").dataset.on = String(view.listening);
  el("goText").textContent = view.listening ? "Stop" : "Start";
  const label = el("label");
  const note = view.note || sideNote;
  label.textContent = (note || view.status).toLowerCase();
  label.title = note;
  label.dataset.tone = view.note.startsWith("Paused")
    ? "bad"
    : note
      ? "warn"
      : "";
  el("strip").textContent = view.recent.slice(-6).join(" ");
}

function drawEq(): void {
  level *= 0.86;
  dots.forEach((dot, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const half = Math.round(level * SHAPE[col] * (ROWS / 2 + 0.5));
    dot.classList.toggle("on", Math.abs(row - (ROWS - 1) / 2) < half);
  });
  requestAnimationFrame(drawEq);
}

function earcon(kind: string): void {
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  const tick = kind !== "buzz";
  osc.type = tick ? "sine" : "square";
  osc.frequency.value = kind === "ready" ? 1200 : tick ? 1800 : 140;
  const now = audio.currentTime;
  const length = tick ? 0.03 : 0.22;
  gain.gain.setValueAtTime(tick ? 0.08 : 0.05, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + length);
  osc.connect(gain).connect(audio.destination);
  osc.start(now);
  osc.stop(now + length);
}

function captureNode(ctx: AudioContext): Promise<AudioWorkletNode> {
  capture ??= makeCaptureNode(ctx).catch((error: unknown) => {
    capture = null;
    throw error;
  });
  return capture;
}

async function makeCaptureNode(ctx: AudioContext): Promise<AudioWorkletNode> {
  await ctx.audioWorklet.addModule("js/mic-worklet.js");
  const node = new AudioWorkletNode(ctx, "mic-capture");
  const batch = Math.round((FRAMES_PER_SEND * ctx.sampleRate) / SAMPLE_RATE);
  node.port.addEventListener("message", ({ data }: { data: Float32Array }) => {
    level = Math.max(level, levelOf(data));
    if (!engine.isListening()) return;
    pending.push(data);
    pendingLength += data.length;
    if (pendingLength >= batch) {
      engine.sendAudio(
        toPcm16(resample(merge(pending, pendingLength), ctx.sampleRate)),
      );
      pending = [];
      pendingLength = 0;
    }
  });
  node.port.start();
  // why: without a muted path to the speakers, WebView2 can stop calling process().
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);
  return node;
}

function stopMic(): void {
  micToken += 1;
  if (!mic) return;
  mic.source.disconnect();
  for (const track of mic.stream.getTracks()) track.stop();
  mic = null;
  pending = [];
  pendingLength = 0;
}

async function startMic(token: number): Promise<void> {
  audio ??= new AudioContext();
  await audio.resume();
  const node = await captureNode(audio);
  // why: "ideal" falls back to the default mic when the saved one is unplugged.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: settings.mic ? { ideal: settings.mic } : undefined,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  // why: Stop may have come while the mic was opening; a late stream is closed, never kept.
  if (token !== micToken || !engine.isListening()) {
    for (const track of stream.getTracks()) track.stop();
    return;
  }
  const source = audio.createMediaStreamSource(stream);
  source.connect(node);
  mic = { stream, source };
}

function syncMic(): void {
  const wanted = Boolean(view?.listening && view.provider !== "none");
  if (!wanted) return stopMic();
  if (mic || micStarting) return;
  micStarting = true;
  const token = micToken;
  startMic(token)
    .catch(() => {
      if (token !== micToken) return;
      stopMic();
      engine.handle({ type: "micBlocked" });
    })
    .finally(() => {
      micStarting = false;
    });
}

async function applyHotkey(): Promise<void> {
  try {
    await tauri.core.invoke("set_hotkey", {
      hotkey: configOf(settings).hotkey,
    });
    if (sideNote.startsWith("Hotkey")) sideNote = "";
  } catch {
    sideNote = `Hotkey ${configOf(settings).hotkey} is taken; pick another in Settings.`;
    render();
  }
}

el("go").addEventListener("click", () => {
  engine.toggle();
});
el("gear").addEventListener("click", () => {
  void tauri.core.invoke("show_settings");
});
el("hide").addEventListener("click", () => {
  void tauri.core.invoke("hide_pill");
});

void tauri.event.listen("hotkey", () => {
  engine.toggle();
});
void tauri.event.listen("engine-in", ({ payload }) => {
  engine.handle(payload);
});
void tauri.event.listen("settings-changed", async () => {
  settings = await loadSettings();
  stopMic();
  engine.reconfigure(configOf(settings), profilesSafe(settings.profileEdits));
  await applyHotkey();
});
void tauri.event.listen<string>("update-status", ({ payload }) => {
  sideNote = payload;
  render();
});

void applyHotkey();
engine.broadcastState();
requestAnimationFrame(drawEq);
