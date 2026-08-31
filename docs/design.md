# /sol design

## Split of work

| Layer | Owns |
|---|---|
| `extensions/sol.ts` | Slash commands, file staging, ChatGPT URL guard, cross-Pi submit admission, patch restore |
| Local Pi model | `oracle_preflight` / `oracle_auth` / `oracle_submit` / `oracle_read` |
| pi-oracle worker | Isolated Chrome, ChatGPT UI, High selection, upload, response |

The extension never drives chatgpt.com. `agent_browser` on ChatGPT hosts is blocked so it cannot steal the oracle session.

Before `oracle_submit`, `lib/sol/admission.ts` takes a short atomic local lease and inspects `$PI_ORACLE_JOBS_DIR` for active ChatGPT jobs (`queued`, `preparing`, `submitted`, `waiting`). This deliberately serializes ChatGPT account submissions across local Pi processes: pi-oracle may support isolated-profile concurrency, but the ChatGPT account-level rate limit makes concurrent `/sol` submissions unsafe. Terminal jobs do not block; a bounded TTL recovers a lease after a crashed Pi process.

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
- follow-up send is accepted when the composer shows `Stop answering` (not only the old `Stop streaming` label)
- reply is complete when Stop answering is gone and Send prompt is enabled again — do not wait for `Copy response` count to exceed the previous assistant count (that is what made /sol lag minutes behind the tab)

## Patch restore

`ensureSolOraclePatches()` runs on Pi `session_start` and every `/sol` turn.

- Installed version == vendored `0.7.20` and markers missing → copy vendor worker files back.
- Installed version != `0.7.20` → refuse. A newer worker must be re-vendored, not clobbered.

## Cross-session submission admission

The admission path is intentionally separate from browser ownership and conversation leases:

1. The `tool_call` hook sees `oracle_submit` before execution.
2. For ChatGPT (the `/sol` provider), it atomically creates `pi-sol-submit.lock` under `$PI_ORACLE_JOBS_DIR`.
3. It reads durable `oracle-*/job.json` records and blocks when any job is still open.
4. The block reason names the active job and tells the model to stop and use `/sol-read <job-id>`; it never changes the preset or silently retries.
5. `tool_result`, `tool_execution_end`, and `session_shutdown` release the lease. A 15-minute TTL makes crashed locks recoverable.

This closes the race between separate Pi processes while retaining pi-oracle's own same-`conversationId` lease for explicit follow-ups.

Operator is the in-Pi model, not the human.
