# 002: Allow optional AI filter for spoken corrections in Live mode

- **Status:** accepted
- **Date:** 2026-11-24
- **Decided by:** Stephen (ask 4f4f3428)

## Decision

When the optional AI filter is turned on (with an OpenAI key), it may run in both Practice and Live modes to interpret messy spoken self-corrections (for example, "oh, actually make that 4"). Clean charting phrases still go through the fixed-rule parser only, and the AI filter's output is strictly validated to chart actions (depths 1 to 15, bleeding, back, skip, pause, or tooth actions), never free text.

## Options

- **Option A:** Keep the AI filter Practice-only; preserves 100% fixed rules in Live mode, but forces hygienists to use rigid phrasing when correcting mistakes.
- **Option B (chosen):** Allow the optional AI filter in Live mode for messy corrections, strictly locked to validated chart actions; matches natural hygienist speech while keeping output bounded to valid chart keystrokes.

## Reason

Hygienists naturally correct themselves mid-chart ("oh, actually go back and make that 4"). Validating the AI reply strictly against the chart action schema guarantees no free text can ever be typed into Eaglesoft, while Practice-only guards (such as unverified `prev_tooth` or tooth jumps) remain blocked in Live mode.

## What would change our mind

If on-site testing in a practice patient shows more than one unintended key sequence from the AI filter in a full-mouth chart, restrict the filter to Practice-only or tighten the cue and validation rules.
