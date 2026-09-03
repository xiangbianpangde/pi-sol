---
name: sol
description: Relay research and planning questions to ChatGPT web GPT-5.6 Sol High via /sol and pi-oracle. Use before solving hard problems, when the user runs /sol, or when the local model needs a web-Sol advisor. Never drive chatgpt.com with agent_browser.
compatibility: Pi coding agent
metadata:
  version: "1.14.0"
  status: "active"
  layer: "task"
  priority: "30"
  triggers: "sol,oracle-relay,chatgpt-web,sol-high"
---

# sol

`/sol` is a thin relay to **ChatGPT web GPT-5.6 Sol High** (Plus maximum). Browser automation stays inside **pi-oracle**'s isolated worker. Local Pi only prepares context, submits, and brings the answer back.

Source repository: **https://github.com/xiangbianpangde/pi-sol** — the dispatch prompt tells Sol to fetch the public repo when the archive is incomplete (no .git / partial tree), so it can inspect the full source tree and exact commit.

## When to Use

- The user runs `/sol`, `/sol-followup`, `/sol-resume`, `/sol-read`, or `/sol-auth`
- Before implementing a hard design, you want a second opinion from web GPT-5.6 Sol
- The user wants to stay in Pi instead of switching to chatgpt.com
- The user is deciding between designs / plans / trade-offs, or says 先问/sol、优先咨询/sol、参考/sol 再下结论

Do **not** use `/sol` for trivial local edits. Do **not** open `chatgpt.com` / `chat.openai.com` with `agent_browser`.

## Commands

```text
/sol [--bg] [--follow <job-id>] [--files a.pdf,src/a.ts] <prompt>
/sol-followup <job-id> [--bg] [--files a,b] <prompt>
/sol-resume [job-id] [--bg]
/sol-read [job-id]
/sol-auth
/sol-diag [--last N] [--candidates]
/sol-open [--grok|--chatgpt] [--url <https-url>]
```

- Default is **synchronous**: wait for the Sol answer in this turn
- `--bg` dispatches and stops; later `/sol-read`
- `--files` is an explicit local file list, not a whole-repo archive
- `/sol-open` opens the oracle auth-seed Chrome **headed and with no debug port**, so a human can repair a stale login or wrong model state that `/sol-auth` cannot fix by itself. It refuses to open while that provider has an active job, and the submit/recover gate refuses to clone a live manual seed; close the window before `/sol`.

## Consult-First Rule (second-opinion-first workflow)

When the user is choosing between designs, plans, or trade-offs — or explicitly asks to 先问/sol / 优先咨询/sol / 参考/sol 再下结论:

1. **Consult Sol first.** Relay the decision + your proposed options/analysis to web GPT-5.6 Sol High via `/sol` (or `oracle_submit` preset `thinking_extended`) before committing to a final position.
2. **Bring Sol's advice back** and present it clearly to the user.
3. **Wait for the user to reference Sol's view** before giving the final conclusion. Do not silently override or ignore the Sol opinion; if you disagree, say why, but only after the user has seen it.

This is a standing preference, not a one-off request: it applies to design / plan / trade-off decisions going forward.

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

0. `/sol` already restores pi-oracle High/Power-slider worker patches on `session_start` and before this turn. **You** are the operator of that restore, not the user. The `oracle_submit` and `oracle_recover` tool gate re-checks patch integrity and hard-blocks failures; never bypass it, tell the user to run apply scripts, or downgrade the model.
1. Call `oracle_preflight` with `provider: "chatgpt"`.
2. If auth is missing/stale, call `oracle_auth` (`provider: "chatgpt"`) and preflight again. `/sol` is allowed to auto-sync Chrome cookies. If Chrome has the cookie DB locked, tell the user to quit Chrome and rerun `/sol-auth`. If auth hits Cloudflare「请稍候…」or `about:blank`, the Chrome UI is not English — tell them to put English first in `chrome://settings/languages`, relaunch Chrome, then `/sol-auth` again.
3. If jobs fail with "redirected away from the expected authenticated chat origin" or readiness timeouts while the seed cookies are fresh, Cloudflare's managed challenge is blocking headless Chrome (the tab dies to `about:blank` after ~40s and the worker misreports it). The fix is `browser.runMode: "headed"` in `~/.pi/agent/extensions/oracle.json` — verify it is still there before debugging anything else.
3b. If a job reports `ChatGPT is showing a transient outage/rate-limit page ... rate limit`, the extension's positive-scope sanitizer only trusts provider-owned error surfaces (alert/status/dialog/banner/log). Only when such a surface is verified should you treat it as a genuine rate limit; a plain error string is not proof of account-level quota exhaustion. If genuine, this is the ChatGPT account quota window (Plus), not auth and not a session lock — pi-oracle runs isolated-profile concurrency (`maxConcurrentJobs`; only same-`conversationId` is prohibited). Check there is no other active job; if none are active, stop retrying and tell the user the quota window is exhausted (no downgrade to Instant/Standard, no silent fallback). The `/sol` extension bounds ChatGPT submissions across local Pi sessions with a short atomic admission lease plus active `job.json` inspection; if it blocks `oracle_submit` for an active job, report that job id and stop without retrying. If it reports that the manual auth seed is open, close that provider's `/sol-open` window and retry once. Do not clone or mutate a live seed.
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
- Before submitting, check system load (`uptime`, `ps`). On a loaded box the isolated Chrome can time out on page load, and a job can be accepted by ChatGPT yet fail the read with `os error 35` (daemon busy); `oracle_recover` then also refuses because no assistant reply exists yet, so the whole round is lost. Wait for quieter load instead of burning audit rounds.
- After `pi update npm:pi-oracle` the installed worker loses the High/Power-slider patch. `/sol` restores it automatically; on a version change it re-applies `vendor/sol-high-power-slider.patch` to the new worker (auto-revendor, previous vendor kept in `vendor/previous/`). If the patch no longer applies cleanly, `ensureSolOraclePatches` fails loudly with the reject summary — stop and report that blocker; do not silently fall back or hand steps to the user. If you still see the old effort-dropdown error, restore it yourself with the apply script above — never hand that step to the user.

## Verification

- `/sol ping` (or a real question) after `/sol-auth` returns a Sol answer or a clear auth/login blocker
- `node ~/.pi/agent/extensions/lib/sol/run-sol-smoke.mjs` is self-contained: it reuses the newest real oracle job as template, or builds a minimal job + tar.zst from scratch when /tmp has none
- `/sol --bg …` then `/sol-read <uuid-v4-job-id>` shows the same job; path traversal IDs are rejected and saved responses are read only from the verified job directory
- `/sol-open` accepts HTTPS provider URLs only and refuses to open while that provider has an active job
- `agent_browser` open chatgpt.com is blocked
- A `.exe` in `--files` is rejected before submit
- From the pi-sol checkout, `node --experimental-strip-types --test extensions/__tests__/*.test.ts` runs the complete deterministic suite (the installer does not copy test files into `~/.pi/agent`); the trigger tests cover classifier normalization/signals/suppressors/vetoes and private redacted diagnostics; `/sol-diag` shows live rows.

## Release evidence bundle

When an audit needs a reviewer to reproduce the suite from the archive, ship the
**whole `node_modules/`**, never an enumerated subset of source files. Pass
`node_modules/` explicitly to `oracle_submit`; explicit directory selection
overrides pi-oracle's default bulky-directory exclusion. A picked subset keeps
failing on module resolution one dependency at a time (this burned three audit
rounds: the `patches.ts` façade, then eight `lib/sol/*.ts` modules, then
`fs-ext`'s build dep `nan`). Closure-by-construction beats guessing.

A native addon's prebuilt `.node` is not portable across OS/arch, so the archive
carries the addon **source plus its build deps** and the target machine rebuilds.
Fix the evidence bundle once, then let the reviewer prove it mechanically:

```sh
find . -name '._*' -type f -delete      # macOS tar emits AppleDouble from xattr
rm -rf node_modules/fs-ext/build         # do not reuse a foreign native binary
npm rebuild fs-ext --offline --cache=<empty-dir> --nodedir=<local-node-prefix>
file node_modules/fs-ext/build/Release/fs_ext.node   # must match the host
node --experimental-strip-types --test extensions/__tests__/*.test.ts
```

`--offline` against an empty cache is the actual closure test: any missing
transitive dep surfaces as `Cannot find module 'nan'` or `ENOTCACHED` rather than
silently passing. Expect `183 tests / 183 pass / 0 fail / 0 skipped`. Host toolchain
(Node headers, C/C++ compiler, Python/node-gyp) is a normal native-addon
prerequisite, not a closure defect. `com.apple.provenance` is SIP-protected and
cannot be stripped with `xattr -c`; AppleDouble noise is archive hygiene, never a
blocker.
