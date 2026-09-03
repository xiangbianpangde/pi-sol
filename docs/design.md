# /sol design

## Split of work

| Layer | Owns |
|---|---|
| `extensions/sol.ts` | Slash commands, file staging, ChatGPT URL guard, cross-Pi submit admission, patch restore |
| Local Pi model | `oracle_preflight` / `oracle_auth` / `oracle_submit` / `oracle_read` |
| pi-oracle worker | Isolated Chrome, ChatGPT UI, High selection, upload, response |

The extension never drives chatgpt.com. `agent_browser` on ChatGPT hosts is blocked so it cannot steal the oracle session.

Before `oracle_submit`, `lib/sol/admission.ts` takes a short kernel-level admission lease (an exclusive `flock(2)` on a lock file, via `fs-ext`) and inspects `$PI_ORACLE_JOBS_DIR` for active ChatGPT jobs (`queued`, `preparing`, `submitted`, `waiting`). This bounds ChatGPT account submissions across local Pi processes to `maxConcurrentJobs` (default 2, mirrored from pi-oracle's `browser.maxConcurrentJobs`): pi-oracle runs each job in its own isolated browser runtime profile cloned from a single auth seed profile, so concurrent `/sol` submissions are safe up to the provider's account-level capacity. Terminal jobs do not block. The kernel automatically releases the flock when the holding process exits or crashes — there is no TTL, no owner.json, and no stale-lock reclamation. The `oracle_submit` and `oracle_recover` hooks also fail closed when worker patch integrity fails or the provider's auth-seed `SingletonLock` belongs to a live manual Chrome process.

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
- fail closed if the model-selection UI cannot positively prove High; an absent or unknown control is never treated as an assumed High fallback
- follow-up send is accepted when the composer shows `Stop answering` (not only the old `Stop streaming` label)
- reply is complete when Stop answering is gone and Send prompt is enabled again — do not wait for `Copy response` count to exceed the previous assistant count (that is what made /sol lag minutes behind the tab)

## Patch restore

`ensureSolOraclePatches()` runs on Pi `session_start` and every `/sol` turn, and the capacity-consuming tool hook repeats the check immediately before execution.

- The vendor digest must exist, parse, and bind the version, every deployed worker/library copy, and `vendor/sol-high-power-slider.patch`; missing, malformed, or mismatching metadata fails closed rather than bootstrapping trust from current bytes.
- All markers present → installed worker/library bytes must match reviewed pristine or trusted patched hashes; marker-preserving third hashes fail closed.
- Installed version == vendored `0.7.20` and markers missing → copy trusted vendor worker files back after the authority checks.
- Installed version != `0.7.20` → auto re-apply `vendor/sol-high-power-slider.patch` (revendor) to the newer pristine worker; refuse loudly if authority checks, patch application, markers, or syntax checks fail.

## Cross-session submission admission

The admission path is intentionally separate from browser ownership and conversation leases, and mutual exclusion is a KERNEL flock (not a pathname protocol):

1. The `tool_call` hook sees `oracle_submit` and `oracle_recover` before execution.
2. It re-validates the worker patch digest/authority state and refuses execution on any failure.
3. It checks the provider auth-seed `SingletonLock`; a live manual owner blocks the worker so Chrome is never cloned while it is writing.
4. For ChatGPT (the `/sol` provider), it opens `pi-sol-admission.lock` under the per-user private state dir (`PI_SOL_STATE_DIR`, default `~/.pi/agent/state`) and takes an exclusive non-blocking `flock(2)`, retrying on a bounded 5s window.
5. It reads durable `oracle-*/job.json` records from `$PI_ORACLE_JOBS_DIR` and blocks only when the concurrency limit is reached (malformed records fail closed; other users' job dirs are ignored). The authoritative capacity check runs while holding the flock, so the decision is atomic with the reservation.
6. The admission block reason names the active job, seed owner, or patch failure and tells the model to stop; separately, an unverified High selection fails in the worker before upload/send. Neither path changes the preset or silently retries.
7. `tool_result`, `tool_execution_end`, and `session_shutdown` release the lease by unlocking and closing the fd (one-shot; the kernel drops the lock on close).
8. Process death auto-releases the flock — no TTL, no owner.json, no stale reclaim, no trash sweep. Never delete the lock path manually.

Because this is a kernel lock, an OLD Pi process using the pre-ac52249 pathname protocol shares NO mutex with a new flock-based process. Upgrading across that boundary is a stop-the-world operation: close all Pi sessions before installing (the installer refuses while Pi processes are detected unless `PI_SOL_FORCE_UPGRADE=1`).

**Filesystem support boundary.** `PI_SOL_STATE_DIR` must live on a filesystem on which the host OS provides reliable flock/advisory-locking semantics. Network/distributed/FUSE-like filesystems (NFS/SMB/etc.) are not supported unless their locking semantics have been explicitly validated — flock on such mounts may silently degrade or fail, which would break the cross-Pi admission guarantee. There is deliberately no pathname-based fallback for unsupported filesystems: a fallback would reintroduce the audit P1 TOCTOU that the kernel flock was chosen to eliminate.

This closes the race between separate Pi processes while retaining pi-oracle's own same-`conversationId` lease for explicit follow-ups.

Operator is the in-Pi model, not the human.
