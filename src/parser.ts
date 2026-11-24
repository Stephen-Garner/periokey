export type Action =
  | { type: "depth"; value: number }
  | { type: "bleeding" }
  | { type: "back" }
  | { type: "skip" }
  | { type: "pause" }
  | { type: "prev_tooth" }
  | { type: "set_tooth"; tooth: number; surface: Surface; depths: number[] }
  | { type: "goto_tooth"; tooth: number; surface: Surface };

export type Surface = "buccal" | "lingual";

export type ParseResult =
  | { status: "accept"; actions: Action[] }
  | { status: "reject"; reason: string }
  | { status: "ignore"; reason?: string };

export const MIN_DEPTH = 1;
export const MAX_DEPTH = 15;
export const MAX_DEPTHS_PER_PHRASE = 48;
// why: inside chatter, only a run this long counts, so "I have two kids" never types.
export const MIN_RUN_IN_CHATTER = 3;

type Token =
  | { kind: "number"; value: number; strong: boolean }
  | {
      kind: "command";
      command: "bleeding" | "back" | "skip" | "pause";
      strong: boolean;
    }
  | { kind: "out_of_range"; word: string }
  | { kind: "filler" }
  | { kind: "unknown" };

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
};

const HOMOPHONES: Record<string, number> = {
  oh: 0,
  o: 0,
  won: 1,
  to: 2,
  too: 2,
  tree: 3,
  for: 4,
  fore: 4,
  ate: 8,
};

const TENS: Record<string, number> = {
  twenty: 2,
  thirty: 3,
  forty: 4,
  fifty: 5,
  sixty: 6,
  seventy: 7,
  eighty: 8,
  ninety: 9,
};

const OUT_OF_RANGE_WORDS = new Set([
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
]);

const COMMANDS: Record<
  string,
  { command: "bleeding" | "back" | "skip" | "pause"; strong: boolean }
> = {
  bleed: { command: "bleeding", strong: true },
  bleeding: { command: "bleeding", strong: true },
  back: { command: "back", strong: false },
  undo: { command: "back", strong: true },
  skip: { command: "skip", strong: true },
  pause: { command: "pause", strong: true },
  stop: { command: "pause", strong: false },
};

const FILLERS = new Set([
  "um",
  "uh",
  "umm",
  "uhh",
  "hmm",
  "er",
  "ah",
  "and",
  "okay",
  "ok",
  "alright",
  "next",
  "good",
  "great",
  "nice",
  "yep",
  "yeah",
  "yes",
  "now",
  "then",
  "so",
  "here",
  "moving",
  "on",
]);

// why: fast speech glues "2 3" into "23"; real 10 to 15 readings come out alone.
function splitGluedDigits(digits: string): number[] | null {
  if (digits.length === 1) return [Number(digits)];
  const value = Number(digits);
  if (!digits.startsWith("0") && value >= 10 && value <= MAX_DEPTH)
    return [value];
  if (!/^[1-9]+$/.test(digits)) return null;
  return [...digits].map(Number);
}

function tokenizeWord(word: string): Token[] {
  if (/^\d+$/.test(word)) {
    const values = splitGluedDigits(word);
    if (values === null) return [{ kind: "out_of_range", word }];
    return values.map((value) => ({ kind: "number", value, strong: true }));
  }
  if (word in NUMBER_WORDS)
    return [{ kind: "number", value: NUMBER_WORDS[word] ?? 0, strong: true }];
  if (word in HOMOPHONES)
    return [{ kind: "number", value: HOMOPHONES[word] ?? 0, strong: false }];
  if (OUT_OF_RANGE_WORDS.has(word)) return [{ kind: "out_of_range", word }];
  const command = COMMANDS[word];
  if (command) return [{ kind: "command", ...command }];
  if (FILLERS.has(word)) return [{ kind: "filler" }];
  return [{ kind: "unknown" }];
}

export function tokenize(text: string): Token[] {
  const words = text
    .toLowerCase()
    .replace(/[-_]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const tokens: Token[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    const tens = Object.hasOwn(TENS, word) ? TENS[word] : undefined;
    const ones = NUMBER_WORDS[words[i + 1] ?? ""];
    // why: "three two three" said fast often comes back as "three twenty-three".
    if (
      tens !== undefined &&
      typeof ones === "number" &&
      ones >= 1 &&
      ones <= 9
    ) {
      tokens.push(
        { kind: "number", value: tens, strong: true },
        { kind: "number", value: ones, strong: true },
      );
      i++;
    } else tokens.push(...tokenizeWord(word));
  }
  return tokens;
}

function isDepth(token: Token): token is Token & { kind: "number" } {
  return (
    token.kind === "number" &&
    token.value >= MIN_DEPTH &&
    token.value <= MAX_DEPTH
  );
}

// why: keep only runs of 3+ spoken depths from chatter; stray numbers in talk never type.
function extractRuns(tokens: Token[]): Action[] {
  const actions: Action[] = [];
  let run: Action[] = [];
  let strongCount = 0;
  const flush = (): void => {
    if (strongCount >= MIN_RUN_IN_CHATTER) actions.push(...run);
    run = [];
    strongCount = 0;
  };
  for (const token of tokens) {
    if (isDepth(token)) {
      run.push({ type: "depth", value: token.value });
      if (token.strong) strongCount++;
    } else if (
      token.kind === "command" &&
      token.command === "bleeding" &&
      run.at(-1)?.type === "depth"
    ) {
      run.push({ type: "bleeding" });
    } else flush();
  }
  flush();
  return actions;
}

function tooManyDepths(actions: Action[]): ParseResult | null {
  const depthCount = actions.filter((action) => action.type === "depth").length;
  if (depthCount <= MAX_DEPTHS_PER_PHRASE) return null;
  return {
    status: "reject",
    reason: `${depthCount} depths in one phrase; the limit is ${MAX_DEPTHS_PER_PHRASE}`,
  };
}

export function parsePhrase(text: string): ParseResult {
  const tokens = tokenize(text).filter((token) => token.kind !== "filler");
  if (tokens.length === 0) return { status: "ignore" };

  if (tokens.some((token) => token.kind === "unknown")) {
    const actions = extractRuns(tokens);
    if (actions.length === 0) return { status: "ignore" };
    return tooManyDepths(actions) ?? { status: "accept", actions };
  }

  const outOfRange = tokens.find((token) => token.kind === "out_of_range");
  if (outOfRange)
    return {
      status: "reject",
      reason: `"${outOfRange.word}" is not a depth from 1 to 15`,
    };

  const first = tokens[0];
  if (
    tokens.length === 1 &&
    first?.kind === "command" &&
    first.command !== "bleeding"
  ) {
    return { status: "accept", actions: [{ type: first.command }] };
  }

  const actions: Action[] = [];
  for (const token of tokens) {
    if (token.kind === "number") {
      if (token.value < MIN_DEPTH || token.value > MAX_DEPTH) {
        return {
          status: "reject",
          reason: `${token.value} is not a depth from 1 to 15`,
        };
      }
      actions.push({ type: "depth", value: token.value });
    } else if (token.kind === "command" && token.command === "bleeding") {
      const previous = actions.at(-1);
      if (previous?.type === "bleeding")
        return { status: "reject", reason: "bleeding said twice in a row" };
      if (previous === undefined && tokens.length > 1) {
        return { status: "reject", reason: "bleeding must follow a depth" };
      }
      actions.push({ type: "bleeding" });
    } else {
      return {
        status: "reject",
        reason: "back, skip, and pause must be said alone",
      };
    }
  }

  return tooManyDepths(actions) ?? { status: "accept", actions };
}
