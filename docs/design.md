# /sol design

## Split of work

| Layer | Owns |
|---|---|
| `extensions/sol.ts` | Slash commands, file staging, ChatGPT URL guard, patch restore |
| Local Pi model | `oracle_preflight` / `oracle_auth` / `oracle_submit` / `oracle_read` |
| pi-oracle worker | Isolated Chrome, ChatGPT UI, High selection, upload, response |

The extension never drives chatgpt.com. `agent_browser` on ChatGPT hosts is blocked so it cannot steal the oracle session.

## ChatGPT Plus UI (2026-08)

Composer shows `button "High"`. Open it and you get `menu "High"` + `menuitem "Power"` + `Show advanced options`. There is no Instant / Thinking / Pro radio sheet and no Light / Standard / Extended combobox.

pi-oracle 0.7.20 treated `menu "High"` as that old sheet, then failed:

- `Could not open effort dropdown for requested effort: Extended`
- `Could not find model family control for instant`

Vendor patches (`extensions/lib/sol/vendor`) teach the worker:

- closed High and open High+Power already *are* `thinking_extended`
- Power-slider is not a model-configuration sheet
- Instant / Medium must not skip as High
- wait if the High button has not hydrated
- assumed High fallback only when no other compact tier is visible

## Patch restore

`ensureSolOraclePatches()` runs on Pi `session_start` and every `/sol` turn.

- Installed version == vendored `0.7.20` and markers missing → copy vendor worker files back.
- Installed version != `0.7.20` → refuse. A newer worker must be re-vendored, not clobbered.

Operator is the in-Pi model, not the human.
