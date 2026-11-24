import WsSocket from "ws";

export const SAMPLE_RATE = 24000;

export const KEYTERMS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "bleeding",
  "back",
  "undo",
  "skip",
  "pause",
];

export type PhraseTiming = {
  speechMs?: number;
  gapMs?: number;
  latencyMs?: number;
};
export type TimedPhrase = { text: string; timing?: PhraseTiming };
const PREFIX_PADDING_MS = 300;

export type SttHandlers = {
  onReady(): void;
  onPhrase(text: string, timing?: PhraseTiming): void;
  onError(message: string): void;
};

export const CLOSED_MESSAGE =
  "Speech connection closed. Press F9 to reconnect.";
export type SttSession = { sendAudio(pcm16: Uint8Array): void; close(): void };
export type SttProvider = {
  name: "deepgram" | "openai";
  start(handlers: SttHandlers): SttSession;
};

export function deepgramUrl(): string {
  const params = new URLSearchParams({
    model: "nova-3",
    language: "en-US",
    encoding: "linear16",
    sample_rate: String(SAMPLE_RATE),
    channels: "1",
    smart_format: "false",
    numerals: "false",
    punctuate: "false",
    interim_results: "true",
    endpointing: "300",
    mip_opt_out: "true",
  });
  for (const term of KEYTERMS) params.append("keyterm", term);
  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
}

type DeepgramMessage = {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
};

export function createDeepgramCollector(): {
  handle(message: DeepgramMessage): string | null;
} {
  let parts: string[] = [];
  return {
    handle(message) {
      if (message.type !== "Results") return null;
      const text = message.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
      if (message.is_final && text) parts.push(text);
      if (!message.speech_final) return null;
      const phrase = parts.join(" ");
      parts = [];
      return phrase || null;
    },
  };
}

function parseJson(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string" && !Buffer.isBuffer(data)) return null;
  try {
    return JSON.parse(String(data)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function deepgramProvider(
  apiKey: string,
  url = deepgramUrl(),
): SttProvider {
  return {
    name: "deepgram",
    start(handlers) {
      const socket = new WebSocket(url, ["token", apiKey]);
      const collector = createDeepgramCollector();
      let closing = false;
      socket.addEventListener("open", () => handlers.onReady());
      socket.addEventListener("close", () => {
        if (!closing) handlers.onError(CLOSED_MESSAGE);
      });
      socket.addEventListener("message", (event) => {
        const message = parseJson(event.data);
        if (!message) return;
        const phrase = collector.handle(message as DeepgramMessage);
        if (phrase) handlers.onPhrase(phrase);
      });
      socket.addEventListener("error", () =>
        handlers.onError("Deepgram connection failed. Check DEEPGRAM_API_KEY."),
      );
      return {
        sendAudio(pcm16) {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(new Uint8Array(pcm16));
        },
        close() {
          closing = true;
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ type: "CloseStream" }));
          socket.close();
        },
      };
    },
  };
}

export function openAiSessionUpdate(
  model: string,
  silenceMs = 300,
): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: SAMPLE_RATE },
          noise_reduction: { type: "near_field" },
          transcription: {
            model,
            language: "en",
            // why: example numbers in the prompt made the model invent "10" and "12" in pauses.
            prompt:
              "Dental periodontal pocket depth charting. Transcribe accurately; write spoken depth measurements as separate space-delimited digits.",
          },
          turn_detection: {
            type: "server_vad",
            silence_duration_ms: silenceMs,
            prefix_padding_ms: PREFIX_PADDING_MS,
            threshold: 0.5,
          },
        },
      },
    },
  };
}

type OpenAiMessage = {
  type?: unknown;
  item_id?: unknown;
  transcript?: unknown;
  audio_start_ms?: unknown;
  audio_end_ms?: unknown;
};

// why: OpenAI's VAD times include prefix padding and the silence wait; remove them to get real speech and pause lengths.
export function createOpenAiCollector(
  silenceMs = 300,
  now = Date.now,
): { handle(message: OpenAiMessage): TimedPhrase[] } {
  const order: string[] = [];
  const done = new Map<string, string>();
  const timing = new Map<string, PhraseTiming>();
  const starts = new Map<string, number>();
  const stoppedAt = new Map<string, number>();
  let lastEnd: number | undefined;
  return {
    handle(message) {
      const id = typeof message.item_id === "string" ? message.item_id : "";
      if (!id) return [];
      const start = message.audio_start_ms;
      const end = message.audio_end_ms;
      if (
        message.type === "input_audio_buffer.speech_started" &&
        typeof start === "number"
      ) {
        starts.set(id, start);
        timing.set(id, {
          gapMs:
            lastEnd === undefined
              ? undefined
              : Math.max(0, start - lastEnd + PREFIX_PADDING_MS + silenceMs),
        });
        return [];
      }
      if (
        message.type === "input_audio_buffer.speech_stopped" &&
        typeof end === "number"
      ) {
        const began = starts.get(id);
        const t = timing.get(id);
        if (t && began !== undefined)
          t.speechMs = Math.max(0, end - began - PREFIX_PADDING_MS - silenceMs);
        lastEnd = end;
        stoppedAt.set(id, now());
        return [];
      }
      if (message.type === "input_audio_buffer.committed") order.push(id);
      else if (
        message.type === "conversation.item.input_audio_transcription.completed"
      ) {
        const text =
          typeof message.transcript === "string"
            ? message.transcript.trim()
            : "";
        done.set(id, text);
      } else if (
        message.type === "conversation.item.input_audio_transcription.failed"
      )
        done.set(id, "");
      else return [];
      const phrases: TimedPhrase[] = [];
      while (order[0] !== undefined && done.has(order[0])) {
        const next = order.shift() ?? "";
        const text = done.get(next) ?? "";
        const t = timing.get(next) ?? {};
        const stopped = stoppedAt.get(next);
        if (stopped !== undefined) t.latencyMs = now() - stopped;
        done.delete(next);
        timing.delete(next);
        starts.delete(next);
        stoppedAt.delete(next);
        if (text) phrases.push({ text, timing: t });
      }
      return phrases;
    },
  };
}

export function openAiProvider(
  apiKey: string,
  model: string,
  url = "wss://api.openai.com/v1/realtime?intent=transcription",
  silenceMs = 300,
): SttProvider {
  return {
    name: "openai",
    start(handlers) {
      const socket = new WsSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const collector = createOpenAiCollector(silenceMs);
      let closing = false;
      socket.on("open", () => {
        socket.send(JSON.stringify(openAiSessionUpdate(model, silenceMs)));
        handlers.onReady();
      });
      socket.on("message", (data) => {
        const message = parseJson(data);
        if (!message) return;
        if (message.type === "error") {
          handlers.onError(
            "OpenAI transcription error. Check OPENAI_API_KEY and OPENAI_STT_MODEL.",
          );
          return;
        }
        for (const phrase of collector.handle(message))
          handlers.onPhrase(phrase.text, phrase.timing);
      });
      socket.on("error", () =>
        handlers.onError("OpenAI connection failed. Check OPENAI_API_KEY."),
      );
      socket.on("close", () => {
        if (!closing) handlers.onError(CLOSED_MESSAGE);
      });
      return {
        sendAudio(pcm16) {
          if (socket.readyState !== WsSocket.OPEN) return;
          const audio = Buffer.from(
            pcm16.buffer,
            pcm16.byteOffset,
            pcm16.byteLength,
          ).toString("base64");
          socket.send(
            JSON.stringify({ type: "input_audio_buffer.append", audio }),
          );
        },
        close() {
          closing = true;
          socket.close();
        },
      };
    },
  };
}
