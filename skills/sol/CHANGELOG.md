# sol CHANGELOG

## 1.4.3 - 2026-08-31

- Added cross-Pi ChatGPT admission control for `oracle_submit`: an atomic short-lived lease closes the multi-session race, and active `job.json` records prevent a second `/sol` job while one is queued or running.
- Added explicit `oracle_submit` blocking diagnostics and release hooks for `tool_result`, `tool_execution_end`, and session shutdown; stale leases recover after a bounded TTL.
- Added regression coverage for active-job filtering, lease recovery, and the user-visible busy reason.

## 1.4.2 - 2026-08-30

- Added rate-limit failure semantics to the procedure: `ChatGPT is showing a transient outage/rate-limit page ... rate limit` at send readiness = account-level quota window (Plus), NOT auth and NOT a single-session lock (pi-oracle is isolated-profile concurrent; only same-conversationId is prohibited). If no other active jobs, stop retrying, report the quota window, keep one /sol submission at a time. No downgrade.

## 1.4.1 - 2026-08-30

- Sol audit round 3 (new-thread follow-up after two same-thread timeouts, 3m10s): **FINAL PASS — detect-v3 frozen, phase 2 sampling approved.** Non-blocking findings closed:
  - `--candidates` now also filters `ruleset_version === DETECTOR_RULESET` (in addition to parse_status and source).
  - chmod order: existing file is chmod 0600 BEFORE append (closes the narrow append-then-chmod window); dir chmod before write as well.
  - Regression test: logs dir deleted between writes self-heals (lastMkdir cache reset path verified).
  - SKILL.md: stage 2 sampling protocol (mutually-exclusive strata, orthogonal tags, stream-exporter invariant, label schema) and stage 3 transaction invariants (submission_plan_digest, idempotency key, terminal immutability, write-once job id, crash recovery) — both Sol-audit approved.
  - Verified: 53/53 tests.

## 1.4.0 - 2026-08-30

- Sol audit round 2 (same-thread follow-up, 3m53s, CONDITIONAL PASS): both P0s fixed, verdict ready to upgrade to PASS on review:
  - **Ruleset isolation (P0-1)**: `/sol-diag` now stats the CURRENT ruleset only and flags `[other-ruleset rows=N]`; sampling guidance: rotate to a fresh JSONL or filter `ruleset_version`; `--candidates` excludes `parse_status=error` (malformed /sol no longer pollutes the semantic candidate pool).
  - **Permission upgrade (P0-2)**: every write now `chmod`s the EXISTING dir/file (0700/0600), not only on create — verified by an upgrade-path test (0755/0644 → 0700/0600).
  - **P1 classifier fix**: `structured_list` now scans the code-stripped text WITH line breaks (`textWithBreaks`), so fenced-code numbering no longer triggers it (ruleset detect-v3); normalize exposes `textWithBreaks` for structure signals.
  - **P2 reliability**: write-failure recovery resets the mkdir cache (`lastMkdir=""`) so a deleted logs dir self-heals on the next write.
  - Verified: 52/52 tests; reproduction before fix confirmed both P0 issues and the fenced-code false positive.

## 1.3.0 - 2026-08-30

- Sol audit round (real /sol submission, thinking_extended): accepted the auditor's Conditional Pass and fixed its P0/P1 findings before sampling (still zero behavior change to /sol forwarding):
  - Classifier ruleset bumped to **detect-v2** (`ruleset_version` + `schema_version` recorded on every row):
    - `structured_list` now matches raw newlines (whitespace collapsing killed `^|\n` anchors);
    - code/quote presence demoted from hard veto to shallow negative (`code_heavy`/`quote_heavy` −1.5): explicit「让 Sol 复核 + 代码/材料」now reaches candidate;
    - `explicit_optout` is a hard veto (was −3, could be outweighed) with broader patterns (外部/本地/无需第二意见/不要转给外部);
    - new `negation_veto` («并不是在请求第二意见» no longer fires second_opinion);
    - new signals: `decision_ask` (应该/推荐/compare/vs/choose…), `risk_analysis` (失败模式/替代方案/failure modes…), research/compare in English; `long_prompt` demoted to weak metadata (0.5/0.2); `local_action` −1.
  - Logger: **redact-before-truncate** (masking runs on full text, then 160-char preview — truncate-first leaked secret prefixes); extended patterns (sk-proj-/sk-ant-api03-/github_pat_/ASIA…/Authorization Bearer/quoted multi-word secrets); private permissions 0700/0600; throttled write-error surfacing (no silent drops); tail semantics for reads (last 20k, not first 20k); malformed /sol rows recorded with `parse_status: error` instead of disappearing.
  - Association: same-session-only + 30-min TTL (`DISPATCH_TTL_MS`); cross-session request-hash mis-link removed; `seenCommandIds` keyed `session::id`; `dispatch_id` carries a session prefix; `/sol-diag --candidates` filters source=semantic; diag notes when logging is off.
  - Verified: 48/48 tests; end-to-end shows session-isolated dispatch association (A/B same prompt → own dispatch_id; B submit links only to B) and malformed `/sol --files` recorded as parse-error.

## 1.2.1 - 2026-08-30

- Static-review fixes for the diagnostic sampler (before data collection):
  - **Default path bug**: unset `PI_SOL_TRIGGER_LOG` previously made `logSolTrigger()` return early (no writes at all; only `/sol-diag` had the default fallback). Now unset → writes `~/.pi/agent/logs/sol-trigger.jsonl`; default path resolved lazily (per-call `homedir()`) so tests isolate HOME. Regression test `sol-trigger-log.test.ts` covers default write, `off` disables, and redaction.
  - `relay_of_command` → `content_match` (same content id within 5 min). Documented as content-match only, never proof of relay identity, loss, or duplication.
  - oracle association is honest: `assoc=request-hash` when `oracle_submit` prompt hash matches the dispatch request hash (best-effort), else `assoc=session-last` (heuristic) — both recorded, never claimed as proof.
  - `redactPreview`: private-key blocks, AWS key ids, JWTs, sk- keys, long hex/base64, emails, `password/secret/token=…` are masked before logging.
  - Logging switched to one tiny synchronous append (durable before the turn continues; no dangling promise lost at exit); record-only failure behavior unchanged.
  - Verified: 39/39 tests pass; end-to-end chain shows two dispatches of the same prompt get distinct `dispatch_id` and the submit links via request-hash.

## 1.2.0 - 2026-08-30

- Added record-only trigger diagnostics (first step of the trigger-mechanism fix). No behavior change: `/sol` remains an explicit trigger only.
  - `lib/sol/trigger-detect.ts`: conservative classifier (signals vs suppressors, candidate/near/none, needs_confirmation, confidence, stable content `id`), limited normalization (leading whitespace, fenced/inline code, blockquotes).
  - `lib/sol/trigger-log.ts`: JSONL append to `~/.pi/agent/logs/sol-trigger.jsonl` (`$PI_SOL_TRIGGER_LOG`, `off` disables); fire-and-forget, never breaks a turn; record fields `source=slash|semantic|oracle`, `phase`, `matches`/`suppressed`, `dispatch_id`, `relay_of_command`, `staged_files_count`.
  - `sol.ts`: every `before_agent_start` prompt is classified and logged; oracle_* tool calls are linked to the active dispatch (`oracle_phase`); `/sol-diag` reads stats + recent rows.
  - Verified: 31 tests pass (new `sol-trigger.test.ts` + existing sol tests); diagnostic chain exercised end-to-end (command → relay → dispatch → oracle_submit).

## 1.1.0 - 2026-08-28

- Root-caused the live /sol outage: Cloudflare's managed challenge blocks headless Chrome (interactive checkbox never auto-passes; the tab dies to `about:blank` ~40s in and the worker misreports it as "redirected away from the expected authenticated chat origin"). Fix: `browser.runMode: "headed"` in `~/.pi/agent/extensions/oracle.json`. Verified by a real `oracle_submit` round-trip (`SOL_LIVE_OK`).
- `run-sol-smoke.mjs` gained `--headed` to exercise the headed path directly.
- Procedure gained a step mapping the misleading redirect/timeout errors to the runMode fix.

## 1.0.0 - 2026-08-20

- First governed version (frontmatter metadata added; validator `--strict` clean).
- Stability: pi-oracle version changes now auto-revendor via `vendor/sol-high-power-slider.patch` instead of dead-ending; loud failure with reject summary when the patch no longer applies.
- Worker restores verified with `node --check`; previous vendor kept in `vendor/previous/`.
- `run-sol-smoke.mjs` is self-contained (template discovery or scratch-built minimal job); the hardcoded `/tmp/oracle-63411a6d-…` template dependency is gone.
