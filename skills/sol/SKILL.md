---
name: sol
description: Relay research and planning questions to ChatGPT web GPT-5.6 Sol High via /sol and pi-oracle. Use before solving hard problems, when the user runs /sol, or when the local model needs a web-Sol advisor. Never drive chatgpt.com with agent_browser.
compatibility: Pi coding agent
metadata:
  version: "1.11.0"
  status: "active"
  layer: "task"
  priority: "30"
  triggers: "sol,oracle-relay,chatgpt-web,sol-high"
---

# sol

`/sol` is a thin relay to **ChatGPT web GPT-5.6 Sol High** (Plus maximum). Browser automation stays inside **pi-oracle**'s isolated worker. Local Pi only prepares context, submits, and brings the answer back.

## When to Use

- The user runs `/sol`, `/sol-followup`, `/sol-resume`, `/sol-read`, or `/sol-auth`
- Before implementing a hard design, you want a second opinion from web GPT-5.6 Sol
- The user wants to stay in Pi instead of switching to chatgpt.com

Do **not** use `/sol` for trivial local edits. Do **not** open `chatgpt.com` / `chat.openai.com` with `agent_browser`.

## Commands

```text
/sol [--bg] [--follow <job-id>] [--files a.pdf,src/a.ts] <prompt>
/sol-followup <job-id> [--bg] [--files a,b] <prompt>
/sol-resume [job-id] [--bg]
/sol-read [job-id]
/sol-auth
/sol-diag [--last N] [--candidates]
```

- Default is **synchronous**: wait for the Sol answer in this turn
- `--bg` dispatches and stops; later `/sol-read`
- `--files` is an explicit local file list, not a whole-repo archive

## Trigger Diagnostics (record-only)

`/sol` is an **explicit trigger only** today; nothing fires automatically. A record-only classifier (zero behavior change) observes every user prompt and appends one JSONL line per observation to `~/.pi/agent/logs/sol-trigger.jsonl` — this is the REAL default when `$PI_SOL_TRIGGER_LOG` is unset (`off`/`0` disables).

- Fields: `schema_version`, `ruleset_version` (detect-v3; bump on every rule change), `source` (slash|semantic|oracle), `phase` (command|agent_start|oracle_*), `parse_status` (error when malformed /sol), `command`, `matches`, `suppressed`, `candidate`/`near`, `needs_confirmation`, `confidence` (feature score, NOT a probability), `score`, `dispatch_id`, `content_match`, `assoc` (request-hash|session-last), `oracle_phase`, `staged_files_count`, `preview` (≤160 chars; redaction runs on the FULL text before truncation; no full prompt, tokens, or file contents).
- Honesty rules: `content_match` proves only that the same content id was seen again in the session — NOT that it is the same relay, and NOT proof of no loss/duplication. `assoc: session-last` is a heuristic (latest dispatch of the session, 30-min TTL); `assoc: request-hash` means oracle_submit's normalized prompt matched the CURRENT session dispatch's fingerprint. Never cross-session match.
- Classifier ruleset (detect-v3): explicit intent beats heuristics — second_opinion/decision_ask strong; opt-out and negation are hard vetoes; code/quote presence is a shallow negative, never a veto of "让 Sol 复核 + 代码/材料"; `structured_list` scans code-stripped text WITH line breaks (fenced-code numbers never trigger); `id` is a content fingerprint only, never a request id.
- Sampling hygiene (P0 from Sol audit rounds): existing log dir/file permissions are tightened to 0700/0600 on every write (chmod BEFORE append, not only on create); `/sol-diag` isolates the current ruleset and warns about other-ruleset rows (`[other-ruleset rows=N]`); starting real sampling rotates to a fresh JSONL (`$PI_SOL_TRIGGER_LOG=/path/v3.jsonl`) or filters by `ruleset_version`; `--candidates` excludes `parse_status=error` and other rulesets.

## Stage 2 sampling protocol (Sol-audit approved, 2026-08-30)

- Path: restart pi with a fresh `$PI_SOL_TRIGGER_LOG=<new>.jsonl` (rotate), collect 1–2 days, then label.
- Strata (MUTUALLY EXCLUSIVE): candidate | near | none | veto | slash_anchor | malformed_slash. Candidate/near/none/veto only from `ruleset_version=current` + `source=semantic` + `phase=agent_start`; veto extracted from none; slash_anchor = `source=slash` + `phase IN (command, agent_start)` (never oracle_*).
- Tags (ORTHOGONAL, multi-select): english, negation, mixed_scope, mentioned_vs_used, quoted_or_example, local_action_plus_advice, structured_text, decision_recall…
- Exporter invariant: stream the JSONL window line-by-line (never batch on the 1-MiB tail reader).
- Label fields: record_id, ruleset_version, stratum, source, phase, label (trigger | not_trigger | uncertain), reason_primary (fixed enum), reason_secondary[], tags[], annotator, labeled_at, notes. `uncertain` requires notes.

## Stage 3 transaction invariants (Sol-audit approved)

- harness-owned `request_id`; model has NO `sol_confirm`, only UI/command can write confirmed; model can only call `sol_submit(request_id)`.
- `submission_plan_digest` = hash(normalized_request + source_digest + manifest_hash + provider + preset + followup_target); any material change invalidates confirmation.
- States: detected → candidate → confirmed/rejected/expired → staged → submitting → submitted/succeeded/failed_definite/cancelled/expired/submit_unknown; terminal states are immutable (new attempts = new revision).
- `submission_id`/idempotency key persisted BEFORE the external call; timeout → submit_unknown → reconcile; never auto-resubmit.
- submit gate re-checks expiry; re-verifies staged file hash/size vs manifest; job id is write-once for the submission.
- Crash in `submitting` → resume as submit_unknown + reconcile, never as confirmed/staged.
- `request_revision` (prompt/files/hashes/provider/preset/followup changes) is separate from `ruleset_version`; explicit `/sol` = confirmation_kind=explicit_command (no extra confirm prompt).

## Procedure

0. `/sol` already restores pi-oracle High/Power-slider worker patches on `session_start` and before this turn. **You** are the operator of that restore, not the user. Never tell the user to run apply scripts or `pi update`.
1. Call `oracle_preflight` with `provider: "chatgpt"`.
2. If auth is missing/stale, call `oracle_auth` (`provider: "chatgpt"`) and preflight again. `/sol` is allowed to auto-sync Chrome cookies. If Chrome has the cookie DB locked, tell the user to quit Chrome and rerun `/sol-auth`. If auth hits Cloudflare「请稍候…」or `about:blank`, the Chrome UI is not English — tell them to put English first in `chrome://settings/languages`, relaunch Chrome, then `/sol-auth` again.
3. If jobs fail with "redirected away from the expected authenticated chat origin" or readiness timeouts while the seed cookies are fresh, Cloudflare's managed challenge is blocking headless Chrome (the tab dies to `about:blank` after ~40s and the worker misreports it). The fix is `browser.runMode: "headed"` in `~/.pi/agent/extensions/oracle.json` — verify it is still there before debugging anything else.
3b. If a job reports `ChatGPT is showing a transient outage/rate-limit page ... rate limit`, the extension's positive-scope sanitizer only trusts provider-owned error surfaces (alert/status/dialog/banner/log). Only when such a surface is verified should you treat it as a genuine rate limit; a plain error string is not proof of account-level quota exhaustion. If genuine, this is the ChatGPT account quota window (Plus), not auth and not a session lock — pi-oracle runs isolated-profile concurrency (`maxConcurrentJobs`; only same-`conversationId` is prohibited). Check there is no other active job; if none are active, stop retrying and tell the user the quota window is exhausted (no downgrade to Instant/Standard, no silent fallback). The `/sol` extension serializes ChatGPT submissions across local Pi sessions with a short atomic admission lease (per-user private state dir) plus active `job.json` inspection; if it blocks `oracle_submit` for an active job, report that job id and stop without retrying. Keep one /sol submission at a time.
4. Submit with `oracle_submit`:
   - `provider`: `chatgpt`
   - `preset`: `thinking_extended` (maps to GPT-5.6 Sol **High**, Plus max)
   - `files`: only the staged / user-listed paths
   - `followUpJobId` only for `/sol-followup` or `--follow`
5. If the turn is sync, poll `oracle_read` every 10–15 seconds until terminal, then present the saved answer. Do not wait a full minute between polls.
6. If `--bg`, stop after submit and give the job id plus `/sol-read`.
7. If the job fails with `Could not open effort dropdown` or `Could not find model family control`, run `node ~/.pi/agent/extensions/lib/sol/apply-sol-patches.mjs --restore` yourself, then retry the **same** `thinking_extended` submit once. Do not fall back to Instant/Standard. Do not ask the user to apply patches.

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
- After `pi update npm:pi-oracle` the installed worker loses the High/Power-slider patch. `/sol` restores it automatically; on a version change it re-applies `vendor/sol-high-power-slider.patch` to the new worker (auto-revendor, previous vendor kept in `vendor/previous/`). If the patch no longer applies cleanly, `ensureSolOraclePatches` fails loudly with the reject summary — stop and report that blocker; do not silently fall back or hand steps to the user. If you still see the old effort-dropdown error, restore it yourself with the apply script above — never hand that step to the user.

## Verification

- `/sol ping` (or a real question) after `/sol-auth` returns a Sol answer or a clear auth/login blocker
- `node ~/.pi/agent/extensions/lib/sol/run-sol-smoke.mjs` is self-contained: it reuses the newest real oracle job as template, or builds a minimal job + tar.zst from scratch when /tmp has none
- `/sol --bg …` then `/sol-read` shows the same job
- `agent_browser` open chatgpt.com is blocked
- A `.exe` in `--files` is rejected before submit
- `npx --yes tsx --test ~/.pi/agent/extensions/__tests__/sol-trigger.test.ts` covers classifier normalization/signals/suppressors/vetoes (ruleset detect-v3); `sol-trigger-log.test.ts` covers default-path write (isolated HOME), off-disabling, redact-before-truncate, secret patterns, 0700/0600 create AND upgrade, ruleset stats isolation and version fields; `/sol-diag` shows live rows
