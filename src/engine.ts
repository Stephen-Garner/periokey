import {
  parsePhrase,
  type Action,
  type ParseResult,
  type Surface,
} from "./parser.ts";
import { filterWithNano, needsAiFilter } from "./ai-filter.ts";
import { describeKey, encodeActions, type Profile } from "./keymap.ts";
import { focusProblem, type FocusStatus, type Injector } from "./focus.ts";
import {
  deepgramProvider,
  openAiProvider,
  headerConnect,
  type OpenAiConnect,
  type PhraseTiming,
  type SttProvider,
  type SttSession,
} from "./stt.ts";
import { keyStatus, type Config, type Mode } from "./config.ts";
import { createSerialQueue } from "./serial.ts";

export type EngineMessage = Record<string, unknown>;

export type EngineDeps = {
  config: Config;
  profiles: Map<string, Profile>;
  makeInjector(): Injector | null;
  emit(message: EngineMessage): void;
  openAiConnect?: OpenAiConnect;
  filter?: typeof filterWithNano;
  micBlockedNote?: string;
  noTargetNote?: string;
};

export type Engine = {
  handle(message: unknown): void;
  sendAudio(pcm16: Uint8Array): void;
  isListening(): boolean;
  toggle(): void;
  reconfigure(config: Config, profiles: Map<string, Profile>): void;
  setDesktopWarning(warning: string): void;
  broadcastState(): void;
  close(): void;
};

export function providerFor(
  config: Config,
  connect: OpenAiConnect = headerConnect,
): SttProvider | null {
  if (config.provider === "deepgram")
    return deepgramProvider(config.deepgramKey);
  if (config.provider === "openai")
    return openAiProvider(
      config.openAiKey,
      config.openAiModel,
      undefined,
      config.vadSilenceMs,
      connect,
    );
  return null;
}

const isToothAction = (action: Action): boolean =>
  action.type === "set_tooth" || action.type === "goto_tooth";

const side = (surface: Surface): string => (surface === "lingual" ? "L" : "B");

export function entryLabel(action: Action): string {
  if (action.type === "depth") return String(action.value);
  if (action.type === "set_tooth")
    return `T${action.tooth}${side(action.surface)}:${action.depths.join(",")}`;
  if (action.type === "goto_tooth")
    return `→T${action.tooth}${side(action.surface)}`;
  return {
    bleeding: "B",
    back: "⌫",
    skip: "→",
    pause: "pause",
    prev_tooth: "←T",
  }[action.type];
}

function practiceSummary(action: Action): string | null {
  if (action.type === "set_tooth")
    return `Practice: Tooth ${action.tooth} ${side(action.surface)} → ${action.depths.join(" ")}`;
  if (action.type === "goto_tooth")
    return `Practice: go to Tooth ${action.tooth} ${side(action.surface)}`;
  return null;
}

export function createEngine(deps: EngineDeps): Engine {
  let config = deps.config;
  let profiles = deps.profiles;
  const connect = deps.openAiConnect ?? headerConnect;
  const filter = deps.filter ?? filterWithNano;
  const emit = deps.emit;
  let provider = providerFor(config, connect);
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
  let injector: Injector | null = null;
  let globalHotkey = false;
  let session: SttSession | null = null;
  let sessionId = 0;
  let targetSeen = false;
  let repeatTimer: ReturnType<typeof setTimeout> | undefined;
  // why: gives the filter context; in memory only, never logged or saved.
  let recentPhrases: string[] = [];
  let pillStatus = "";
  let desktopWarning = "";
  const typing = createSerialQueue((error) =>
    stopListening(
      error instanceof Error && error.message.startsWith("Paused")
        ? error.message
        : `Paused: typing failed (${error instanceof Error ? error.message : String(error)}). Check the chart.`,
    ),
  );

  function targetWindow(): string {
    return (
      config.targetWindow || profiles.get(state.profile)?.window_match || ""
    );
  }

  function broadcastState(): void {
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
    emit({
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
      targetWindow: targetWindow(),
      note: (state.repeat && state.repeatNote) || state.note || desktopWarning,
      recent: state.recent,
    });
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
        deps.noTargetNote ??
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
          emit({ type: "earcon", kind: "ready" });
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

  function flashRepeat(note = ""): void {
    state.repeat = true;
    state.repeatNote = note;
    clearTimeout(repeatTimer);
    repeatTimer = setTimeout(() => {
      state.repeat = false;
      broadcastState();
    }, 1500);
    emit({ type: "earcon", kind: "buzz" });
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
    const id = sessionId;
    if (!config.aiFilter || !needsAiFilter(text, parsed)) {
      const job = decide(text, parsed, false, id, timing);
      if (job) void typing(job);
      return;
    }
    // why: the filter runs inside the typing queue, so phrases type in the order spoken.
    void typing(async () => {
      const result = await filter(
        config.openAiKey,
        config.openAiFilterModel,
        text,
        context,
      );
      if (id !== sessionId) return;
      await decide(text, result, true, id, timing)?.();
    });
  }

  function decide(
    text: string,
    result: ParseResult,
    ai: boolean,
    id: number,
    timing?: PhraseTiming,
  ): (() => Promise<void>) | null {
    // why: practice only, so live mode never echoes patient speech; kept in memory, never saved.
    if (state.mode === "practice")
      emit({
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
    // why: the previous-tooth key is unverified in real Eaglesoft, so live mode refuses it.
    if (
      mode === "live" &&
      result.actions.some((a) => a.type === "prev_tooth")
    ) {
      flashRepeat(
        "Redo a whole tooth is Practice-only until the previous-tooth key is checked in Eaglesoft.",
      );
      return null;
    }
    // why: practice still fills the chart so cadence tests are not blocked; live refuses.
    if (keys === null && mode === "live") {
      flashRepeat("The 10 to 15 mm key is not set for this profile yet.");
      return null;
    }
    return async () => {
      if (id !== sessionId) return;
      if (mode === "live") {
        if (!state.listening || !injector || !keys) return;
        const focus = await focusOnTarget();
        // why: Stop may have been pressed while the focus check was running.
        if (id !== sessionId || !state.listening) return;
        if (focus !== "match") return pauseForFocus(focus);
        await injector.type(keys, profile.inter_key_delay_ms, targetWindow());
      }
      state.recent = [...state.recent, ...result.actions.map(entryLabel)].slice(
        -9,
      );
      emit({
        type: "entry",
        actions: result.actions,
        keys: keys
          ? keys.map(describeKey)
          : toothJump
            ? result.actions.flatMap((action) => practiceSummary(action) ?? [])
            : [`(10-15 key not set for ${profile.label})`],
      });
      emit({ type: "earcon", kind: "tick" });
      broadcastState();
    };
  }

  function setMode(mode: Mode): void {
    stopListening();
    state.mode = mode;
    if (mode === "live" && !injector) {
      injector = deps.makeInjector();
      globalHotkey = injector?.watchHotkey(config.hotkey, toggle) ?? false;
      pillStatus = "";
    }
    broadcastState();
  }

  const focusTimer = setInterval(() => {
    if (state.mode !== "live" || !state.listening) return;
    void focusOnTarget().then((focus) => {
      if (focus === "match") targetSeen = true;
      else if (targetSeen && state.listening) pauseForFocus(focus);
    });
  }, 500);

  function handle(raw: unknown): void {
    if (typeof raw !== "object" || raw === null) return;
    const message = raw as {
      type?: unknown;
      text?: unknown;
      name?: unknown;
      mode?: unknown;
    };
    if (message.type === "toggle") toggle();
    if (message.type === "clear") recentPhrases = [];
    if (message.type === "micBlocked" && state.listening)
      stopListening(
        deps.micBlockedNote ??
          "Click Start listening once in this tab to allow microphone access.",
      );
    if (
      message.type === "simulate" &&
      state.mode === "practice" &&
      typeof message.text === "string"
    )
      handlePhrase(message.text);
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
    if (message.type === "hello") broadcastState();
  }

  if (state.mode === "live") setMode("live");

  return {
    handle,
    sendAudio(pcm16) {
      if (state.listening && session) session.sendAudio(pcm16);
    },
    isListening: () => state.listening,
    toggle,
    reconfigure(next, nextProfiles) {
      stopListening();
      config = next;
      profiles = nextProfiles;
      provider = providerFor(config, connect);
      if (!profiles.has(state.profile)) state.profile = config.profile;
      broadcastState();
    },
    setDesktopWarning(warning) {
      desktopWarning = warning;
      broadcastState();
    },
    broadcastState,
    close() {
      clearInterval(focusTimer);
      clearTimeout(repeatTimer);
      session?.close();
      injector?.close();
    },
  };
}
