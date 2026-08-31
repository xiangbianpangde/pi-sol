# sol CHANGELOG

## 1.9.1 - 2026-08-31

- **Audit round 7 (after 0647f4cb incomplete → self-verified model's thinking notes)**:
  - Restore-failure keep-trash: moveReclaimCandidate now KEEPS a displaced live
    token on restore failure instead of deleting it (the previous code destroyed
    a live holder's token, creating a double-holder window). The stale trash
    dir is swept by sweepStaleStaging.
  - sweepStaleStaging now matches `.trash.` ANYWHERE in the name (previously
    only matched `endsWith(".trash.")` which never matched the actual
    `path.trash.pid.uuid` format).
  - Region re-activation bug: composerContinuationDepth >= 0 re-activated the
    region on EVERY line after the composer, so the region never ended —
    all subsequent shallower lines were swallowed forever. Fixed to activate
    region only when markComposer returns true (just set the depth).
  - Submit-lock reclaim also uses generation-bound moveReclaimCandidate
    instead of bare atomicRenameAway + unconditional delete, so even if the
    reclaim token were double-held, the submit lock cannot be split-brained.
  - Tests: 118/118 (restore-failure trash kept, sweep .trash., region
    re-activation, submit-lock generation binding, all prior regressions).

 - 2026-08-31

- **Sol audit round 6 (8438259 fixes 3 P1 + 1 P2 + 1 P3; re-audited at d415ef11)**:
  - P1 exact-role-shaped markdown: the role regex now REQUIRES the element
    reference marker (`[ref=...]`) and the composer value-continuation region
    (bare lines after the textbox until the next real element) swallows every
    line without a ref marker — `- dialog "..."`, `- alert "rate limit"`, bare
    `- status`, even `- alert [ref=...]` lookalikes in a /sol prompt can no
    longer become STRONG provider evidence.
  - P1 reclaim-token generation binding: moveReclaimCandidate verifies the
    moved dir is EXACTLY the observed dead generation before discarding it;
    a stale proof for an older generation now restores a newer live token
    instead of deleting it. releaseTokenGeneration only removes the path while
    it is still our generation.
  - P1 sanitizer deployment marker: ROLE_WITH_REF added to
    SOL_PATCH_MARKERS.helpers so an old worker (all Power-slider markers
    present, missing ROLE_WITH_REF) is detected and redeployed.
  - P2 composer region scope: region ends at the next real element line, so
    sibling containers' nested provider alerts are no longer swallowed.
  - P3: session_shutdown deletes leases by toolCallId key, not lease object.
  - Tests: 116/116 (generation-binding reclaim race, old-holder release,
    exact-role-shaped markdown, fake-ref lookalike, sibling-subtree alert,
    region-end, deployment-marker redeploy).

 - 2026-08-31

- **Sol audit round 5 (186690d2, FAIL 4 P1 → fixes)**:
  - P1 atomic publish: submit lock and reclaim token are now published by
    writing owner.json into a UNIQUE staging dir and renaming it onto the fixed
    path. rename() is atomic, so the fixed path never exposes an ownerless
    intermediate state (closes the mkdir→write crash-window split-brain for
    both the reclaim token and the primary submit lock).
  - P1 release wedge: `releaseSolSubmitLease` returns false when it cannot
    acquire the reclaim token; the caller now KEEPS the lease so
    tool_execution_end / session_shutdown retry instead of forgetting a
    still-held lock (no more permanent /sol block while the lease owner is
    alive).
  - P1 sanitizer scope: error-role subtree collection now only keeps descendant
    lines whose accessibility kind is `paragraph` or a nested error role;
    generic/heading/textbox/button/link/navigation shapes (user conversation,
    composer continuation, sidebar) never enter STRONG surfaces — including
    multi-line composer continuation and generic messages nested inside a
    dialog.
  - Tests: 106/106 (atomic-publish ownerless invariant, dead-owner token
    reclaim, release-keeps-lease-on-token-busy, multi-line composer + dialog
    generic exclusion, completion-guard marker, prior concurrency/crash/upgrade
    regressions).

 - 2026-08-31

- **Sol audit round 4 (fa556f6f, FAIL 4 P1 → fixes)**:
  - P1-1 release fallback: removed the bare read→rm fallback in
    `releaseSolSubmitLease`. Release now acquires the reclaim token (retrying up
    to 20x) and only mutates the fixed path while holding it; never falls back
    to a tokenless rm that could delete a newer generation.
  - P1-2 ownerless reclaim-token: a token directory created but whose
    `owner.json` was never written (crash between mkdir and write) is now
    reclaimed after a 5s init grace via atomic rename, so it can never wedge
    reclaims forever.
  - P1-3 completion guard deployment: the streaming hard guard marker
    ("while the model is still streaming (Stop control visible)") is added to
    `SOL_PATCH_MARKERS.runJob`, so an eddf08b worker with older markers only
    will be detected as missing and redeployed with the new guard.
  - P1-4 composer-in-dialog: `classifyProviderBlockerEvidence` now marks a
    composer textbox nested inside an error-role subtree as `hasComposer` but
    never includes its value in strong surfaces (user text cannot become a
    strong provider blocker).
  - P2 pidAlive: only ESRCH proves death; all other errno are treated as
    possibly-alive (fail closed toward "do not reclaim").
  - Tests: 103/103 (release-token-unavailable, ownerless-token reclaim,
    composer-in-dialog strong-surface exclusion, completion-guard marker,
    plus all prior concurrency/crash/upgrade regressions).

 - 2026-08-31

- **Sol audit round 4 partial (37b6e670, response truncated by premature completion → fixes)**:
  - `releaseSolSubmitLease` now serializes with stale reclaim via the reclaim
    token: release reads the owner and removes the fixed path only while
    holding the token, closing the read→rm window against a concurrent
    reclaimer replacing the generation (no double-holder / no deleted-new-lock).
  - Completion guard: while the Stop control is visible the worker never emits
    a completion signature, so the copy-count heuristic can no longer truncate
    a long response mid-stream.
  - Tests: release-vs-stale-reclaim interleaving (newer generation survives),
    concurrent same-lease release generation safety. 99/99 pass.

 - 2026-08-31

- **Sol audit round 3 (e89f638, FAIL → fixes applied)**:
  - P1 stale-proof/generation binding: stale reclaim now runs under an exclusive
    reclaim token (private mkdir). Holding the token between staleness
    verification and rename binds the stale proof to the exact generation being
    removed; an old stale proof can never rename+delete a newer live lock.
  - P1 composer-absent fallback: sanitizer now returns structured evidence —
    STRONG (error-role subtree text, immediate) vs WEAK (composer-absent +
    no-conversation-chrome fallback). The worker requires 3 consecutive weak
    frames before treating it as a real full-page outage, so a transient
    post-send rerender cannot re-inject user text into the rate-limit detector.
  - Fixed hasComposer detection when the composer textbox is nested inside an
    error-role subtree (dialog), and added status/log role coverage.
  - Tests: concurrent same-lease release generation safety, old-token release
    against a newer generation, stale-reclaim-vs-live-generation race, 3+ level
    descendant collection, composer-in-dialog, status/log subtrees,
    composer+chrome transiently absent. 98/98 pass.

 - 2026-08-31

- **Sol audit round 2 (17215b7, FAIL → fixes applied)**:
  - P1 stale-reclaim bug: stale locks (dead PID + TTL) could never be reclaimed
    because the reclaim path passed an empty expected-token that never matched a
    real UUID owner. Reclaim now renames the lock to a unique trash path first
    (atomic, serializes concurrent reclaimers) and deletes it without token
    verification — staleness was already proven before the rename.
  - P1 generation race: release no longer renames-then-verifies (which could
    briefly move a newer generation's lock). Release reads the owner token at
    the fixed path and only removes it when it is still ours; a live owner is
    never stale so the read→rm window cannot be hijacked.
  - P1 sanitizer scope: now collects the full subtree of each provider error
    surface (alert/status/dialog/banner/log) including descendant text, and
    handles unnamed roles. The composer-absent fallback now requires the
    absence of conversation chrome (Copy message/Stop answering/…) so a
    transient post-send rerender cannot re-scan user text as a blocker.
  - P2 state-dir permissions: existing (not just created) state dir is chmod
    0700 on acquire.
  - P2 tests: added stale-reclaim (dead PID reclaims; live PID never reclaims),
    error-role subtree, unnamed role, dialog/banner subtree, and composer-absent
    rerender regression tests. 90/90 pass.
  - docs/design.md admission section updated to match the new protocol.

 - 2026-08-31

- **Audit-driven refactor (Sol round on a3594c2+59d09e9, FAIL → fixes applied)**:
  - P1-1 deployment: `sanitizeProviderBlockerSnapshot` added to `SOL_PATCH_MARKERS.runJob` so already-patched workers redeploy the new sanitizer on next `ensureSolOraclePatches()`.
  - P1-2 unified detection: `classifyChatPage`, `sendAcceptanceState`, and all `throwIfProviderTransientError` sites now use one positive-scope sanitizer (no more raw full-snapshot scans).
  - P1-3 positive scoping: only provider-owned `alert/status/dialog/banner/log` roles are consulted for rate-limit text; user conversation, composer value, and sidebar titles are never scanned. Real limit pages (banner with composer present, Send-missing, full-page outage) still detected.
  - P1-4/P1-5 lock protocol: coordination root moved to per-user private `~/.pi/agent/state/` (`PI_SOL_STATE_DIR`); stale reclaim + release use atomic `rename` to a unique trash path (no verify-then-rm generation race); freshness = PID liveness primary + TTL secondary (live PIDs are never reclaimed).
  - P2-3 fail-closed jobs: unparseable `oracle-*/job.json` counts as unknown ACTIVE (no silent pass-through); job dirs owned by other OS users are ignored (no cross-user fake-job DoS).
  - P2-5 tests: 7 new sanitizer regression tests (composer value, multi-line composer, sidebar title, post-send conversation message, main banner, Send-missing banner, full-page outage). 83/83 pass.
  - P2-4 docs: SKILL rate-limit semantics and design auto-revendor notes updated to match implementation.

 - 2026-08-31

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
