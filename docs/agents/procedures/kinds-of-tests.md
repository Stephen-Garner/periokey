# Kinds of Tests

Which test to write. Every kind must fail when the behavior it guards breaks (CORE-9).

## End-to-end tests first, for a user path

A user path is what a person does from start to finish: sign in, save a word, see it in the list. An end-to-end test drives the real app through that path. It is the hardest kind to fool, because it checks what the user sees. Keep a few, for the main paths only: they are slow, and on a phone they need the device slot (`docs/agents/ram-rules.md`). The plan's `proof:` line names the path.

## Property tests, for rules about data

A property test states a rule that must hold for every input, such as "sorting never loses an item" or "a user only sees their own data". A library then makes up hundreds of inputs to try to break it. Tie each one to its row in `docs/invariants.md`, and name the test file in that row's Check column. The project's preset names the library (`node scripts/presets.mjs show <name>`), such as `fast-check` for TypeScript, `hypothesis` for Python, and `proptest` for Rust.

## Differential tests, for a rewrite or a move

When code is rewritten or moved, the old code is the answer key. Give the same inputs to the old and the new code, and compare the outputs. Keep a short list of differences approved on purpose, each with its reason; any other difference fails.

## Unit tests, for everything else

One function's rules, with the date pinned and no network. Most tests are these, and they run fast.

A test that passes sometimes and fails sometimes: `docs/agents/procedures/flaky-test.md`.
