---
name: sol
description: Relay research and planning questions to ChatGPT web GPT-5.6 Sol High via /sol and pi-oracle. Use before solving hard problems, when the user runs /sol, or when the local model needs a web-Sol advisor. Never drive chatgpt.com with agent_browser.
---

# sol

`/sol` is a thin relay to **ChatGPT web GPT-5.6 Sol High** (Plus maximum). Browser automation stays inside **pi-oracle**'s isolated worker. Local Pi only prepares context, submits, and brings the answer back.

## When to Use

- The user runs `/sol`, `/sol-followup`, `/sol-read`, or `/sol-auth`
- Before implementing a hard design, you want a second opinion from web GPT-5.6 Sol
- The user wants to stay in Pi instead of switching to chatgpt.com

Do **not** use `/sol` for trivial local edits. Do **not** open `chatgpt.com` / `chat.openai.com` with `agent_browser`.

## Commands

```text
/sol [--bg] [--follow <job-id>] [--files a.pdf,src/a.ts] <prompt>
/sol-followup <job-id> [--bg] [--files a,b] <prompt>
/sol-read [job-id]
/sol-auth
```

- Default is **synchronous**: wait for the Sol answer in this turn
- `--bg` dispatches and stops; later `/sol-read`
- `--files` is an explicit local file list, not a whole-repo archive

## Procedure

0. `/sol` already restores pi-oracle High/Power-slider worker patches on `session_start` and before this turn. **You** are the operator of that restore, not the user. Never tell the user to run apply scripts or `pi update`.
1. Call `oracle_preflight` with `provider: "chatgpt"`.
2. If auth is missing/stale, call `oracle_auth` (`provider: "chatgpt"`) and preflight again. `/sol` is allowed to auto-sync Chrome cookies. If Chrome has the cookie DB locked, tell the user to quit Chrome and rerun `/sol-auth`. If auth hits Cloudflare「请稍候…」or `about:blank`, the Chrome UI is not English — tell them to put English first in `chrome://settings/languages`, relaunch Chrome, then `/sol-auth` again.
3. Submit with `oracle_submit`:
   - `provider`: `chatgpt`
   - `preset`: `thinking_extended` (maps to GPT-5.6 Sol **High**, Plus max)
   - `files`: only the staged / user-listed paths
   - `followUpJobId` only for `/sol-followup` or `--follow`
4. If the turn is sync, poll `oracle_read` every 10–15 seconds until terminal, then present the saved answer. Do not wait a full minute between polls.
5. If `--bg`, stop after submit and give the job id plus `/sol-read`.
6. If the job fails with `Could not open effort dropdown` or `Could not find model family control`, run `node ~/.pi/agent/extensions/lib/sol/apply-sol-patches.mjs --restore` yourself, then retry the **same** `thinking_extended` submit once. Do not fall back to Instant/Standard. Do not ask the user to apply patches.

## File limits (ChatGPT web)

Honor these before submit. `/sol` prechecks them when `--files` is used:

- Max **10 files** per turn
- **512 MiB**/file hard cap; images **20 MiB**; spreadsheets ~**50 MiB**; text/docs ~**2M tokens**
- Paid ~**80 uploads / 3 hours**; Free **3 / day**; user storage **25 GB**
- Documents/spreadsheets/presentations/images/text only
- Block executables/installers (`.exe`, `.dmg`, `.apk`, …)
- Content-policy, login, and challenge failures are terminal — do not bypass

Outside-project files are copied to `.pi/sol-staging/<id>/` so `oracle_submit` can take project-relative paths. If no files are given, use the staged `request.md` only. Never default to archiving `.`.

## Pitfalls

- Default is Plus High (`thinking_extended`). Extra High / Pro need a Pro plan; do not silently upgrade.
- `agent_browser` on ChatGPT is blocked on purpose; it would collide with the oracle worker session.
- pi-oracle jobs live under `$PI_ORACLE_JOBS_DIR` or `/tmp/oracle-<id>/`.
- If the worker says High is unavailable, stop and report that. Do not invent Instant/Medium as a silent fallback.
- After `pi update npm:pi-oracle` the installed worker loses the High/Power-slider patch. `/sol` restores it automatically. If you still see the old effort-dropdown error, restore it yourself with the apply script above — never hand that step to the user.

## Verification

- `/sol ping` (or a real question) after `/sol-auth` returns a Sol answer or a clear auth/login blocker
- `/sol --bg …` then `/sol-read` shows the same job
- `agent_browser` open chatgpt.com is blocked
- A `.exe` in `--files` is rejected before submit
