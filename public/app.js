const SITES_PER_TOOTH = 6;
const TEETH = 16;
const SAMPLE_RATE = 24000;
const FRAMES_PER_SEND = 2400;

const el = (id) => document.getElementById(id);
const socket = new WebSocket(`ws://${location.host}/ws`);
let state = null;
let audio = null;
let micStarted = false;
let mic = null;
let captureNode = null;
let workletLoaded = null;
let chosenMic = "";
try {
  chosenMic = localStorage.getItem("micDevice") || "";
} catch {}
let pending = [];
let pendingLength = 0;
let log = [];
let floatWin = null;
const chart = {
  values: Array(SITES_PER_TOOTH * TEETH).fill(""),
  bleed: new Set(),
  cursor: 0,
};

function audioContext() {
  // why: forcing 24 kHz can leave Chrome on macOS capturing silence; resample() converts instead.
  audio ??= new AudioContext();
  return audio;
}

function earcon(kind) {
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

function merge(chunks, length) {
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// why: browsers often run the mic at 44.1 or 48 kHz; the speech APIs expect 24 kHz.
function resample(input, fromRate) {
  if (fromRate === SAMPLE_RATE) return input;
  const ratio = fromRate / SAMPLE_RATE;
  const out = new Float32Array(Math.round(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const pos = i * ratio;
    const j = Math.min(Math.floor(pos), input.length - 1);
    const next = input[Math.min(j + 1, input.length - 1)];
    out[i] = input[j] + (next - input[j]) * (pos - j);
  }
  return out;
}

function toPcm16(samples) {
  const out = new Int16Array(samples.length);
  samples.forEach((sample, i) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  });
  return out;
}

function showLevel(chunk) {
  let sum = 0;
  for (const sample of chunk) sum += sample * sample;
  const rms = Math.sqrt(sum / chunk.length);
  // why: dB scale so quiet laptop mics still move the bar (-60 dB empty, 0 dB full).
  const db = 20 * Math.log10(rms + 1e-8);
  const width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
  el("level").style.width = width;
  const floatLevel = floatWin?.document.getElementById("level");
  if (floatLevel) floatLevel.style.width = state?.listening ? width : "0";
}

async function captureNodeFor(ctx) {
  workletLoaded ??= ctx.audioWorklet
    .addModule("/mic-worklet.js")
    .catch((error) => {
      workletLoaded = null;
      throw error;
    });
  await workletLoaded;
  if (captureNode) return captureNode;
  const node = new AudioWorkletNode(ctx, "mic-capture");
  const batch = Math.round((FRAMES_PER_SEND * ctx.sampleRate) / SAMPLE_RATE);
  node.port.addEventListener("message", ({ data }) => {
    showLevel(data);
    if (!state?.listening || socket.readyState !== WebSocket.OPEN) {
      pending = [];
      pendingLength = 0;
      return;
    }
    pending.push(data);
    pendingLength += data.length;
    if (pendingLength >= batch) {
      const samples = resample(merge(pending, pendingLength), ctx.sampleRate);
      socket.send(toPcm16(samples).buffer);
      pending = [];
      pendingLength = 0;
    }
  });
  node.port.start();
  // why: without a muted path to the speakers, Safari and Chrome can stop calling process().
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);
  captureNode = node;
  return node;
}

function stopMic() {
  if (!mic) return;
  mic.source.disconnect();
  for (const track of mic.stream.getTracks()) track.stop();
  mic = null;
}

async function startMic(restart = false) {
  if (!state || state.provider === "none") return;
  const ctx = audioContext();
  await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
  if (ctx.state !== "running") throw new Error("audio is blocked");
  if (micStarted && !restart) return;
  micStarted = true;
  try {
    const node = await captureNodeFor(ctx);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: chosenMic ? { exact: chosenMic } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    stopMic();
    const source = ctx.createMediaStreamSource(stream);
    source.connect(node);
    mic = { stream, source };
    await listMics();
  } catch (error) {
    stopMic();
    micStarted = false;
    throw error;
  }
}

async function listMics() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const active = mic?.stream.getAudioTracks()[0]?.getSettings().deviceId;
  const select = el("micDevice");
  select.replaceChildren(
    ...inputs.map(
      (d, i) => new Option(d.label || `Microphone ${i + 1}`, d.deviceId),
    ),
  );
  select.value = active || chosenMic || select.value;
}

function sendJson(message) {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(message));
}

async function toggle() {
  if (!state?.listening) {
    try {
      await startMic();
    } catch (error) {
      showNote(`Microphone error: ${error.message}`);
      return;
    }
  }
  sendJson({ type: "toggle" });
}

async function openFloat() {
  if (!("documentPictureInPicture" in window))
    return showNote(
      "The floating button needs Chrome or Edge 116 or newer. Use this tab instead.",
    );
  if (floatWin) return floatWin.focus();
  floatWin = await window.documentPictureInPicture.requestWindow({
    width: 250,
    height: 110,
  });
  const doc = floatWin.document;
  const css = doc.createElement("link");
  css.rel = "stylesheet";
  css.href = "/style.css";
  doc.head.append(css);
  doc.body.className = "floating";
  doc.body.innerHTML =
    '<button id="toggle" type="button" class="pill"></button><div class="meter" aria-hidden="true"><span id="level"></span></div><ol id="recent" class="recent"></ol>';
  doc.getElementById("toggle").addEventListener("click", () => void toggle());
  floatWin.addEventListener("pagehide", () => {
    floatWin = null;
  });
  if (state) renderFloat();
}

function renderFloat() {
  const doc = floatWin?.document;
  if (!doc) return;
  const button = doc.getElementById("toggle");
  button.textContent = `${state.status} · ${state.listening ? "Stop" : "Start"}`;
  button.dataset.status = state.status;
  if (!state.listening) doc.getElementById("level").style.width = "0";
  doc.getElementById("recent").replaceChildren(
    ...state.recent.slice(-6).map((value) => {
      const item = doc.createElement("li");
      item.textContent = value;
      return item;
    }),
  );
}

function showNote(text) {
  el("note").textContent = text;
  el("note").hidden = !text;
}

function siteOf(action) {
  return (
    (action.tooth - 1) * SITES_PER_TOOTH +
    (action.surface === "lingual" ? SITES_PER_TOOTH / 2 : 0)
  );
}

function applyToChart(actions) {
  // why: the cursor may sit one past the last site, so a full chart's back erases the last cell.
  const end = chart.values.length;
  for (const action of actions) {
    if (action.type === "depth") {
      if (chart.cursor >= end) continue;
      chart.values[chart.cursor] = String(action.value);
      chart.bleed.delete(chart.cursor);
      chart.cursor += 1;
    } else if (action.type === "bleeding") {
      chart.bleed.add(Math.max(chart.cursor - 1, 0));
    } else if (action.type === "back") {
      chart.cursor = Math.max(chart.cursor - 1, 0);
      chart.values[chart.cursor] = "";
      chart.bleed.delete(chart.cursor);
    } else if (action.type === "skip") {
      chart.cursor = Math.min(chart.cursor + 1, end);
    } else if (action.tooth < 1 || action.tooth > TEETH) {
      showNote(
        `Tooth ${action.tooth} is outside the 1–${TEETH} practice chart.`,
      );
    } else if (action.type === "goto_tooth") {
      chart.cursor = siteOf(action);
    } else if (action.type === "set_tooth") {
      const base = siteOf(action);
      const toothEnd = (action.tooth - 1) * SITES_PER_TOOTH + SITES_PER_TOOTH;
      action.depths.slice(0, toothEnd - base).forEach((depth, i) => {
        chart.values[base + i] = String(depth);
        chart.bleed.delete(base + i);
      });
    }
  }
  renderChart();
  renderLog();
}

function cell(text, className = "") {
  const div = document.createElement("div");
  div.textContent = text;
  div.className = className;
  return div;
}

function renderChart() {
  const half = SITES_PER_TOOTH / 2;
  const cells = [
    cell("Tooth", "head"),
    cell(`Buccal (1-${half})`, "head span split"),
    cell(`Lingual (${half + 1}-${SITES_PER_TOOTH})`, "head span"),
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

function cadence() {
  const timed = log.filter((h) => h.timing.speechMs);
  const speech = timed.reduce((sum, h) => sum + h.timing.speechMs, 0);
  const nums = timed.reduce((sum, h) => sum + h.depths, 0);
  const gaps = log.map((h) => h.timing.gapMs).filter((g) => g !== undefined);
  const count = (v) => log.filter((h) => h.verdict === v).length;
  return `Phrases: ${log.length} · Speed: ${speech ? ((nums * 1000) / speech).toFixed(1) : "-"} nums/sec · Avg pause: ${gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : "-"} ms · Accepted: ${count("accept")} / Rejected: ${count("reject")} / Ignored: ${count("ignore")}`;
}

function logLine(h) {
  const t = h.timing;
  const times = [
    t.speechMs !== undefined && `${(t.speechMs / 1000).toFixed(1)}s speech`,
    t.gapMs !== undefined && `${t.gapMs}ms pause`,
    t.latencyMs !== undefined && `${t.latencyMs}ms latency`,
  ].filter(Boolean);
  const verdict =
    h.verdict === "accept"
      ? `accept (${h.depths} depths)`
      : h.verdict === "reject"
        ? `reject: ${h.reason}`
        : h.reason
          ? `ignore (${h.reason})`
          : "ignore";
  const via = h.ai ? " (nano)" : "";
  return [`"${h.text}" → ${verdict}${via}`, ...times].join(" · ");
}

function renderLog() {
  el("cadence").textContent = cadence();
  el("log").replaceChildren(
    ...log.slice(-20).map((h) => {
      const item = document.createElement("li");
      item.textContent = logLine(h);
      return item;
    }),
  );
}

function renderState() {
  el("status").textContent = state.status;
  el("status").dataset.status = state.status;
  el("toggle").textContent =
    `${state.listening ? "Stop" : "Start"} listening (${state.hotkey})`;
  el("provider").textContent =
    state.provider === "none"
      ? state.keyStatus
      : `${state.provider === "deepgram" ? "Deepgram Nova-3" : "OpenAI"}, ${state.keyStatus}`;
  el("target").textContent =
    state.mode === "practice"
      ? "Practice chart below (nothing is typed)"
      : `Types into: ${state.targetWindow || "(not set)"}`;
  const select = el("profile");
  if (select.options.length !== state.profiles.length) {
    select.replaceChildren(
      ...state.profiles.map((p) => new Option(p.label, p.name)),
    );
  }
  select.value = state.profile;
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.setAttribute(
      "aria-checked",
      String(button.dataset.mode === state.mode),
    );
  }
  el("practice").hidden = state.mode !== "practice";
  el("mic").hidden = !state.listening || state.provider === "none";
  if (!state.listening) el("level").style.width = "0";
  showNote(state.note);
  el("recent").replaceChildren(
    ...state.recent.map((value) => {
      const item = document.createElement("li");
      item.textContent = value;
      return item;
    }),
  );
  renderFloat();
}

socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.type === "state") {
    state = message;
    renderState();
    if (state.listening && state.provider !== "none")
      startMic().catch(() => sendJson({ type: "micBlocked" }));
  } else if (message.type === "earcon") {
    earcon(message.kind);
  } else if (message.type === "entry") {
    el("keys").textContent = message.keys.length
      ? message.keys.join("  ")
      : "none";
    if (state?.mode === "practice") applyToChart(message.actions);
  } else if (message.type === "heard") {
    el("heard").textContent = `Last heard: "${message.text}"`;
    log.push(message);
    renderLog();
  }
});
socket.addEventListener("close", () =>
  showNote("PerioKey stopped. Start it again in the terminal, then reload."),
);

el("toggle").addEventListener("click", toggle);
el("float").addEventListener("click", () =>
  openFloat().catch((error) =>
    showNote(`Could not open the floating button: ${error.message}`),
  ),
);
el("micDevice").addEventListener("change", (event) => {
  chosenMic = event.target.value;
  try {
    localStorage.setItem("micDevice", chosenMic);
  } catch {}
  if (micStarted)
    startMic(true).catch((error) =>
      showNote(`Microphone error: ${error.message}`),
    );
});
navigator.mediaDevices.addEventListener("devicechange", () => void listMics());
void listMics();
el("profile").addEventListener("change", (event) =>
  sendJson({ type: "profile", name: event.target.value }),
);
for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () =>
    sendJson({ type: "mode", mode: button.dataset.mode }),
  );
}
el("simulate").addEventListener("submit", (event) => {
  event.preventDefault();
  audioContext();
  const text = el("phrase").value.trim();
  if (text) sendJson({ type: "simulate", text });
  el("phrase").value = "";
});
el("clear").addEventListener("click", () => {
  chart.values.fill("");
  chart.bleed.clear();
  chart.cursor = 0;
  renderChart();
  renderLog();
  log = [];
  renderLog();
  sendJson({ type: "clear" });
});
el("copyLog").addEventListener("click", () => {
  const text = [cadence(), ...log.map(logLine)].join("\n");
  navigator.clipboard
    .writeText(text)
    .catch(() => showNote("Could not copy the log."));
});
document.addEventListener("keydown", (event) => {
  if (!state || state.globalHotkey || event.key !== state.hotkey) return;
  event.preventDefault();
  void toggle();
});

renderChart();
renderLog();
