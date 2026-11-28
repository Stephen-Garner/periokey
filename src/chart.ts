import type { Action } from "./parser.ts";

export const SITES_PER_TOOTH = 6;
export const TEETH = 16;
const GROUP = SITES_PER_TOOTH / 2;

export type Chart = { values: string[]; bleed: Set<number>; cursor: number };

export const emptyChart = (): Chart => ({
  values: Array<string>(SITES_PER_TOOTH * TEETH).fill(""),
  bleed: new Set(),
  cursor: 0,
});

const siteOf = (tooth: number, lingual: boolean): number =>
  (tooth - 1) * SITES_PER_TOOTH + (lingual ? GROUP : 0);

export function applyToChart(chart: Chart, actions: Action[]): string {
  const end = chart.values.length;
  let note = "";
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
    } else if (action.type === "prev_tooth") {
      // why: matches Eaglesoft's Left key, which jumps back one 3-site tooth group.
      chart.cursor = Math.max(
        Math.floor((chart.cursor - 1) / GROUP) * GROUP,
        0,
      );
    } else if (action.type === "pause") {
      continue;
    } else if (action.tooth < 1 || action.tooth > TEETH) {
      note = `Tooth ${action.tooth} is outside the 1-${TEETH} practice chart.`;
    } else if (action.type === "goto_tooth") {
      chart.cursor = siteOf(action.tooth, action.surface === "lingual");
    } else {
      const base = siteOf(action.tooth, action.surface === "lingual");
      const toothEnd = action.tooth * SITES_PER_TOOTH;
      action.depths.slice(0, toothEnd - base).forEach((depth, i) => {
        chart.values[base + i] = String(depth);
        chart.bleed.delete(base + i);
      });
    }
  }
  return note;
}
