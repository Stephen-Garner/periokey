import {
  MAX_DEPTH,
  MAX_DEPTHS_PER_PHRASE,
  MIN_DEPTH,
  tokenize,
  type Action,
  type ParseResult,
  type Surface,
} from "./parser.ts";

const CORRECTION_CUES = [
  "actually",
  "scratch",
  "change",
  "last",
  "instead",
  "make",
  "wait",
  "wrong",
  "go back",
  "delete",
  "remove",
  "fix",
  "correction",
  "tooth",
  "pick",
];
const MAX_BACKS = 12;
const MAX_TOOTH = 32;
const SITES_PER_SURFACE = 6;
const SIMPLE_TYPES = new Set(["bleeding", "back", "skip", "pause"]);

const SYSTEM_PROMPT = `You filter speech heard while a dental hygienist charts periodontal pocket depths by voice.
You get JSON: {"recent": [the last few phrases, oldest first], "phrase": the new phrase}.
Reply with strict JSON only, one of:
{"intent":"ignore"} when the phrase is casual conversation, even if it holds numbers such as ages, months, times, prices, or "10 or 12".
{"intent":"actions","actions":[...]} when the hygienist is charting or correcting the chart. Action items:
{"type":"depth","value":N} with N a whole number from 1 to 15, {"type":"bleeding"}, {"type":"back"} (erase the last entry), {"type":"skip"}, {"type":"pause"}.
{"type":"set_tooth","tooth":16,"surface":"buccal","depths":[3,3,2]} to correct a named tooth (tooth 1 to 32, 1 to 6 depths).
{"type":"goto_tooth","tooth":5,"surface":"buccal"} to resume at or jump to a named tooth, as in "let's pick up from tooth 5" or "go to tooth 4 lingual".
Surface is "lingual" for lingual, palatal, tongue, or inside; "buccal" for buccal, facial, cheek, or outside; "buccal" when not said.
For a correction, first send one back per entry to erase, then the new depths. Example: "actually scratch the last three, make it 3 3 2" gives three back actions, then depths 3, 3, 2.
One phrase can hold both a tooth edit and a jump. Example: "actually tooth 16 lingual should be 3 3 2, now pick up from tooth 5" gives set_tooth 16 lingual [3,3,2], then goto_tooth 5 buccal.
When unsure, reply {"intent":"ignore"}.`;

export function needsAiFilter(text: string, parseResult: ParseResult): boolean {
  const tokens = tokenize(text);
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, " ")} `;
  const hasCue = CORRECTION_CUES.some((cue) => lower.includes(` ${cue} `));
  const hasPerioWord = tokens.some(
    (token) => token.kind !== "filler" && token.kind !== "unknown",
  );
  if (!hasCue && !hasPerioWord) return false;
  if (hasCue || parseResult.status !== "accept") return true;
  if (tokens.some((token) => token.kind === "unknown")) return true;
  const depths = parseResult.actions.filter((a) => a.type === "depth").length;
  const loneCommand = parseResult.actions.length === 1 && depths === 0;
  return depths < 2 && !loneCommand;
}

const isDepth = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= MIN_DEPTH &&
  value <= MAX_DEPTH;

const isTooth = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= MAX_TOOTH;

const isSurface = (value: unknown): value is Surface =>
  value === "buccal" || value === "lingual";

function toAction(item: unknown): Action | null {
  if (typeof item !== "object" || item === null) return null;
  const { type, value, tooth, surface, depths } = item as Record<
    string,
    unknown
  >;
  if (typeof type === "string" && SIMPLE_TYPES.has(type))
    return { type } as Action;
  if (type === "depth") return isDepth(value) ? { type, value } : null;
  if (!isTooth(tooth) || !isSurface(surface)) return null;
  if (type === "goto_tooth") return { type, tooth, surface };
  if (
    type === "set_tooth" &&
    Array.isArray(depths) &&
    depths.length >= 1 &&
    depths.length <= SITES_PER_SURFACE &&
    depths.every(isDepth)
  )
    return { type, tooth, surface, depths: [...depths] };
  return null;
}

export function readNanoReply(content: string): ParseResult {
  let reply: { intent?: unknown; actions?: unknown };
  try {
    reply = JSON.parse(content) as typeof reply;
  } catch {
    return { status: "ignore", reason: "invalid json" };
  }
  if (reply?.intent === "ignore")
    return { status: "ignore", reason: "conversation" };
  if (reply?.intent !== "actions" || !Array.isArray(reply.actions))
    return { status: "ignore", reason: "invalid json" };
  const actions = reply.actions.map(toAction);
  if (actions.length === 0 || actions.includes(null))
    return { status: "ignore", reason: "invalid actions" };
  const valid = actions as Action[];
  const count = (type: Action["type"]): number =>
    valid.filter((action) => action.type === type).length;
  if (count("back") > MAX_BACKS || count("depth") > MAX_DEPTHS_PER_PHRASE)
    return { status: "ignore", reason: "invalid actions" };
  return { status: "accept", actions: valid };
}

export async function filterWithNano(
  apiKey: string,
  model: string,
  text: string,
  recentContext: string[],
  url = "https://api.openai.com/v1/chat/completions",
  timeoutMs = 5000,
): Promise<ParseResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        reasoning_effort: "minimal",
        max_completion_tokens: 512,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              recent: recentContext.slice(-3),
              phrase: text,
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      return { status: "ignore", reason: `http ${response.status}` };
    const data = (await response.json()) as {
      choices?: { finish_reason?: unknown; message?: { content?: unknown } }[];
    };
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length")
      return { status: "ignore", reason: "truncated" };
    const content = choice?.message?.content;
    return typeof content === "string"
      ? readNanoReply(content)
      : { status: "ignore", reason: "invalid json" };
  } catch (error) {
    // why: a slow or broken filter must never crash or type; dropping the phrase is safe.
    const name = error instanceof Error ? error.name : "";
    return {
      status: "ignore",
      reason:
        name === "TimeoutError" || name === "AbortError"
          ? "timeout"
          : "network error",
    };
  }
}
