# 001: Desktop API key storage in OS credential store

- **Status:** accepted
- **Date:** 2026-11-24
- **Decided by:** Stephen (ask 22cf9579)

## Decision

The Tauri desktop app stores Deepgram and OpenAI API keys in the operating system's credential store (Windows Credential Manager on Windows; Keychain on macOS), never in plain-text `settings.json`, and never sends saved API key values back to the Settings window.

## Options

- **Option A:** Save keys in plain-text `settings.json` in the user config folder; simple, but leaves keys readable as plain text on disk.
- **Option B:** Require `.env` only and remove key fields from Settings; keeps the original rule, but awkward for a dental office installing a Windows `.exe`.
- **Option C (chosen):** Store keys in the OS credential store (Windows Credential Manager), expose only saved/unset status to the Settings window, and keep key access restricted to the pill/engine window (or Rust backend); strongest local privacy with zero extra cloud servers or HIPAA BAA scope.
- **Option D:** Add a Cloudflare Worker token broker; avoids pasting provider keys on the PC, but adds a cloud server, requires an office login secret anyway, and cannot proxy OpenAI filter text without a Cloudflare Enterprise HIPAA BAA.

## Reason

For a single dental office whose Windows PC already holds Eaglesoft patient charts behind a Windows login, storing keys encrypted in Windows Credential Manager is private, stays completely off GitHub (which is public), avoids extra cloud infrastructure during exams, and keeps HIPAA BAA scope limited to the speech/AI provider.

## What would change our mind

If PerioKey is distributed to multiple outside dental offices that should not hold shared provider keys, revisit a short-lived token broker (or per-office keys).
