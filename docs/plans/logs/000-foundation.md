# 000: Foundation log

## 2026-11-24 builder: kit installed

Kit installed with `node ~/dev/starter-kit/kit/sync.mjs --write`.

## 2026-11-24 builder: first working PerioKey

Built the parser, profiles (Eaglesoft default), key encoder, Windows and macOS typing, Deepgram and OpenAI speech adapters, the server, and the page. Eaglesoft's 10 to 15 key is unknown, so it refuses those depths until checked on-site.

| Check | Result |
|---|---|
| `pnpm test` | 43 of 43 pass |
| `pnpm exec tsc --noEmit` | pass |
| eslint and oxlint checks from `scripts/kit.config.json` | pass |
| Practice-mode smoke test on port 4399 | pass |
| Real Eaglesoft, real speech key | not run (no Windows PC or keys here) |

Proposed for `docs/change-checklist.md`: when `profiles/` changes, ask who checked the key in the real software.
