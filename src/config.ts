export type Mode = "practice" | "live";

export type Config = {
  provider: "deepgram" | "openai" | null;
  deepgramKey: string;
  openAiKey: string;
  openAiModel: string;
  vadSilenceMs: number;
  aiFilter: boolean;
  openAiFilterModel: string;
  profile: string;
  mode: Mode;
  hotkey: string;
  targetWindow: string;
  port: number;
};

export function readConfig(env: Record<string, string | undefined>): Config {
  const deepgramKey = env.DEEPGRAM_API_KEY?.trim() ?? "";
  const openAiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const wanted = env.STT_PROVIDER?.trim().toLowerCase();
  let provider: Config["provider"] = null;
  const filterSetting = env.AI_FILTER?.trim().toLowerCase();
  if (wanted === "openai" && openAiKey) provider = "openai";
  else if (wanted === "deepgram" && deepgramKey) provider = "deepgram";
  else if (deepgramKey) provider = "deepgram";
  else if (openAiKey) provider = "openai";
  return {
    provider,
    deepgramKey,
    openAiKey,
    openAiModel: env.OPENAI_STT_MODEL?.trim() || "gpt-4o-transcribe",
    vadSilenceMs: Number(env.VAD_SILENCE_MS) || 300,
    aiFilter:
      openAiKey !== "" && filterSetting !== "off" && filterSetting !== "false",
    openAiFilterModel: env.OPENAI_FILTER_MODEL?.trim() || "gpt-5-nano",
    profile: env.PMS_PROFILE?.trim() || "eaglesoft",
    mode: env.PERIOKEY_MODE?.trim() === "live" ? "live" : "practice",
    hotkey: env.PERIOKEY_HOTKEY?.trim() || "F9",
    targetWindow: env.TARGET_WINDOW?.trim() ?? "",
    port: Number(env.PORT) || 4317,
  };
}

export function keyStatus(config: Config): string {
  if (config.provider === "deepgram") return "Deepgram key set";
  if (config.provider === "openai") return "OpenAI key set";
  return "No API key: type phrases below to practice";
}
