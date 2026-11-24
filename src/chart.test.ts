import { test } from "node:test";
import assert from "node:assert/strict";
import { applyToChart, emptyChart } from "./chart.ts";

const d = (value: number) => ({ type: "depth", value }) as const;

test("depths fill sites in order and back erases the last one", () => {
  const chart = emptyChart();
  applyToChart(chart, [d(3), d(2), d(4), { type: "back" }]);
  assert.deepEqual(chart.values.slice(0, 3), ["3", "2", ""]);
  assert.equal(chart.cursor, 2);
});

test("redo that tooth moves back to the start of the group just finished", () => {
  const chart = emptyChart();
  applyToChart(chart, [d(3), d(3), d(3)]);
  applyToChart(chart, [{ type: "prev_tooth" }, d(3), d(3), d(2)]);
  assert.deepEqual(chart.values.slice(0, 4), ["3", "3", "2", ""]);
  assert.equal(chart.cursor, 3);
});

test("prev_tooth never moves before the first site", () => {
  const chart = emptyChart();
  applyToChart(chart, [{ type: "prev_tooth" }]);
  assert.equal(chart.cursor, 0);
});

test("a tooth outside the chart leaves a note and changes nothing", () => {
  const chart = emptyChart();
  const note = applyToChart(chart, [
    { type: "goto_tooth", tooth: 30, surface: "buccal" },
  ]);
  assert.match(note, /outside/);
  assert.equal(chart.cursor, 0);
});
