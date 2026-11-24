import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  parsePhrase,
  type Action,
  type ParseResult,
  type Surface,
} from "./parser.ts";
import { filterWithNano, needsAiFilter } from "./ai-filter.ts";
import { describeKey, encodeActions, loadProfiles } from "./keymap.ts";
import {
  createOsInjector,
  focusProblem,
  isolatedDesktopWarning,
  type FocusStatus,
  type Injector,
} from "./injector.ts";
import {
  deepgramProvider,
  openAiProvider,
  type PhraseTiming,
  type SttProvider,
  type SttSession,
} from "./stt.ts";
import { keyStatus, readConfig, type Mode } from "./config.ts";
import { createSerialQueue } from "./serial.ts";

try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const config = readConfig(process.env);
const root = fileURLToPath(new URL("..", import.meta.url));
const profiles = loadProfiles(join(root, "profiles"));
if (!profiles.has(config.profile)) {
  throw new Error(
    `PMS_PROFILE "${config.profile}" not found. Choose one of: ${[...profiles.keys()].join(", ")}`,
  );
}

let provider: SttProvider | null = null;
if (config.provider === "deepgram")
  provider = deepgramProvider(config.deepgramKey);
if (config.provider === "openai")
  provider = openAiProvider(
    config.openAiKey,
    config.openAiModel,
    undefined,
    config.vadSilenceMs,
  );

const state = {
  listening: false,
  connecting: false,
  repeat: false,
  repeatNote: "",
  mode: config.mode,
  profile: config.profile,
  note: "",
  recent: [] as string[],
};
const clients = new Set<WebSocket>();
let injector: Injector | null = null;
let globalHotkey = false;
let session: SttSession | null = null;
let sessionId = 0;
let targetSeen = false;
const typing = createSerialQueue((error) =>
  stopListening(
    error instanceof Error && error.message.startsWith("Paused")
      ? error.message
      : `Paused: typing failed (${error instanceof Error ? error.message : String(error)}). Check the chart.`,
  ),
);
let repeatTimer: NodeJS.Timeout | undefined;
// why: gives the filter context; in memory only, never logged or saved.
let recentPhrases: string[] = [];
let pillStatus = "";
let desktopWarning = "";

function send(message: Record<string, unknown>): void {
  const text = JSON.stringify(message);
  for (const client of clients) client.send(text);
}

function broadcastState(): void {
  const active = profiles.get(state.profile);
  const status = state.repeat
    ? "Repeat"
    : state.connecting
      ? "Connecting…"
      : state.listening
        ? "Listening"
        : "Paused";
  if (injector && status !== pillStatus) {
    pillStatus = status;
    injector.showStatus(status);
  }
  send({
    type: "state",
    status,
    listening: state.listening,
    connecting: state.connecting,
    mode: state.mode,
    profile: state.profile,
    profiles: [...profiles.values()].map((p) => ({
      name: p.name,
      label: p.label,
    })),
    provider: provider?.name ?? "none",
    keyStatus: keyStatus(config),
    hotkey: config.hotkey,
    globalHotkey,
    targetWindow: config.targetWindow || active?.window_match || "",
    note: (state.repeat && state.repeatNote) || state.note || desktopWarning,
    recent: state.recent,
  });
}

function targetWindow(): string {
  return config.targetWindow || profiles.get(state.profile)?.window_match || "";
}

function stopListening(note = ""): void {
  state.listening = false;
  state.connecting = false;
  state.note = note;
  sessionId += 1;
  recentPhrases = [];
  session?.close();
  session = null;
  broadcastState();
}

function startListening(): void {
  if (state.mode === "live" && !injector)
    return stopListening("Live mode needs Windows or macOS.");
  if (state.mode === "live" && !targetWindow()) {
    return stopListening(
      "Set TARGET_WINDOW in .env (for example Notepad) to use live mode with this profile.",
    );
  }
  state.listening = true;
  state.note = provider
    ? ""
    : "No API key, so the mic is off. Type phrases below.";
  targetSeen = false;
  state.connecting = provider !== null;
  const id = ++sessionId;
  session =
    provider?.start({
      onReady: () => {
        if (id !== sessionId) return;
        state.connecting = false;
        send({ type: "earcon", kind: "ready" });
        broadcastState();
      },
      onPhrase: (text, timing) => {
        if (id === sessionId) handlePhrase(text, timing);
      },
      onError: (message) => {
        if (id === sessionId) stopListening(message);
      },
    }) ?? null;
  broadcastState();
}

function toggle(): void {
  if (state.listening) stopListening();
  else startListening();
}

const isToothAction = (action: Action): boolean =>
  action.type === "set_tooth" || action.type === "goto_tooth";

const side = (surface: Surface): string => (surface === "lingual" ? "L" : "B");

function label(action: Action): string {
  if (action.type === "depth") return String(action.value);
  if (action.type === "set_tooth")
    return `T${action.tooth}${side(action.surface)}:${action.depths.join(",")}`;
  if (action.type === "goto_tooth")
    return `→T${action.tooth}${side(action.surface)}`;
  return { bleeding: "B", back: "⌫", skip: "→", pause: "pause" }[action.type];
}

function practiceSummary(action: Action): string | null {
  if (action.type === "set_tooth")
    return `Practice: Tooth ${action.tooth} ${side(action.surface)} → ${action.depths.join(" ")}`;
  if (action.type === "goto_tooth")
    return `Practice: go to Tooth ${action.tooth} ${side(action.surface)}`;
  return null;
}

function flashRepeat(note = ""): void {
  state.repeat = true;
  state.repeatNote = note;
  clearTimeout(repeatTimer);
  repeatTimer = setTimeout(() => {
    state.repeat = false;
    broadcastState();
  }, 1500);
  send({ type: "earcon", kind: "buzz" });
  broadcastState();
}

async function focusOnTarget(): Promise<FocusStatus> {
  if (!injector) return "empty";
  return injector.focusCheck(targetWindow()).catch(() => "empty" as const);
}

function pauseForFocus(status: FocusStatus): void {
  console.warn(`[live] focus check failed: ${status}`);
  stopListening(focusProblem(status, targetWindow()));
}

function handlePhrase(text: string, timing?: PhraseTiming): void {
  const parsed = parsePhrase(text);
  const context = recentPhrases;
  recentPhrases = [...recentPhrases, text].slice(-3);
  if (!config.aiFilter || !needsAiFilter(text, parsed)) {
    const job = decide(text, parsed, false, timing);
    if (job) void typing(job);
    return;
  }
  const id = sessionId;
  // why: the filter runs inside the typing queue, so phrases type in the order spoken.
  void typing(async () => {
    const result = await filterWithNano(
      config.openAiKey,
      config.openAiFilterModel,
      text,
      context,
    );
    if (id !== sessionId) return;
    await decide(text, result, true, timing)?.();
  });
}

function decide(
  text: string,
  result: ParseResult,
  ai: boolean,
  timing?: PhraseTiming,
): (() => Promise<void>) | null {
  // why: practice only, so live mode never echoes patient speech; kept in memory, never saved.
  if (state.mode === "practice")
    send({
      type: "heard",
      text,
      ai,
      verdict: result.status,
      reason: result.status === "accept" ? "" : (result.reason ?? ""),
      depths:
        result.status === "accept"
          ? result.actions.filter((a) => a.type === "depth").length
          : 0,
      timing: timing ?? {},
    });
  if (result.status === "ignore") return null;
  if (result.status === "reject") {
    flashRepeat();
    return null;
  }
  if (result.actions.some((action) => action.type === "pause")) {
    stopListening();
    return null;
  }

  const profile = profiles.get(state.profile);
  if (!profile) return null;
  const keys = encodeActions(result.actions, profile);
  const mode: Mode = state.mode;
  const toothJump = result.actions.some(isToothAction);
  if (toothJump && mode === "live") {
    flashRepeat(
      "Click that tooth in Eaglesoft — voice tooth jumps are Practice-only for now.",
    );
    return null;
  }
  // why: practice still fills the chart so cadence tests are not blocked; live refuses.
  if (keys === null && mode === "live") {
    flashRepeat("The 10 to 15 mm key is not set for this profile yet.");
    return null;
  }
  return async () => {
    if (mode === "live") {
      if (!state.listening || !injector || !keys) return;
      const focus = await focusOnTarget();
      if (focus !== "match") return pauseForFocus(focus);
      await injector.type(keys, profile.inter_key_delay_ms, targetWindow());
    }
    state.recent = [...state.recent, ...result.actions.map(label)].slice(-9);
    send({
      type: "entry",
      actions: result.actions,
      keys: keys
        ? keys.map(describeKey)
        : toothJump
          ? result.actions.flatMap((action) => practiceSummary(action) ?? [])
          : [`(10-15 key not set for ${profile.label})`],
    });
    send({ type: "earcon", kind: "tick" });
    broadcastState();
  };
}

function setMode(mode: Mode): void {
  stopListening();
  state.mode = mode;
  if (mode === "live" && !injector) {
    injector = createOsInjector(process.platform, (desktop) => {
      console.log(
        `[live] helper started (desktop: ${desktop}, hotkey: ${config.hotkey})`,
      );
      const warning = isolatedDesktopWarning(desktop);
      if (!warning) return;
      console.warn(`[live] WARNING: ${warning.replace(/^R/, "r")}`);
      desktopWarning = warning;
      broadcastState();
    });
    globalHotkey = injector?.watchHotkey(config.hotkey, toggle) ?? false;
    pillStatus = "";
  }
  broadcastState();
}

setInterval(() => {
  if (state.mode !== "live" || !state.listening) return;
  void focusOnTarget().then((focus) => {
    if (focus === "match") targetSeen = true;
    else if (targetSeen && state.listening) pauseForFocus(focus);
  });
}, 500);

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer((request, response) => {
  const path = request.url === "/" ? "/index.html" : (request.url ?? "");
  const type = contentTypes[extname(path)];
  if (!type || !/^\/[a-z-]+\.[a-z]+$/.test(path)) {
    response.writeHead(404).end();
    return;
  }
  readFile(join(root, "public", path))
    .then((body) => response.writeHead(200, { "content-type": type }).end(body))
    .catch(() => response.writeHead(404).end());
});

const allowedOrigins = new Set([
  `http://127.0.0.1:${config.port}`,
  `http://localhost:${config.port}`,
]);
const sockets = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: ({ origin }: { origin: string }) => allowedOrigins.has(origin),
});

sockets.on("connection", (client) => {
  clients.add(client);
  client.on("close", () => clients.delete(client));
  client.on("message", (data, isBinary) => {
    if (isBinary) {
      if (state.listening && session && Buffer.isBuffer(data))
        session.sendAudio(data);
      return;
    }
    let message: { type?: string; text?: string; name?: string; mode?: string };
    try {
      message = JSON.parse(String(data)) as typeof message;
    } catch {
      return;
    }
    if (message.type === "toggle") toggle();
    if (message.type === "clear") recentPhrases = [];
    if (message.type === "micBlocked" && state.listening)
      stopListening(
        "Click Start listening once in this tab to allow microphone access.",
      );
    if (
      message.type === "simulate" &&
      state.mode === "practice" &&
      typeof message.text === "string"
    ) {
      handlePhrase(message.text);
    }
    if (
      message.type === "profile" &&
      typeof message.name === "string" &&
      profiles.has(message.name)
    ) {
      stopListening();
      state.profile = message.name;
      broadcastState();
    }
    if (
      message.type === "mode" &&
      (message.mode === "practice" || message.mode === "live")
    )
      setMode(message.mode);
  });
  broadcastState();
});

if (state.mode === "live") setMode("live");
server.listen(config.port, "127.0.0.1", () => {
  console.log(`PerioKey is running: open http://localhost:${config.port}`);
  console.log(
    `Mode ${state.mode}, profile ${state.profile}, speech ${provider?.name ?? "none (practice by typing)"}`,
  );
});
