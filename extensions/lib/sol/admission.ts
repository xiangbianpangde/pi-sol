import { mkdir, readFile, rename, rm, stat, writeFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { getOracleJobsDir, listActiveSolJobs, type SolJobSummary } from "./jobs.ts";

/**
 * Max concurrent ChatGPT /sol jobs, mirrored from pi-oracle's
 * browser.maxConcurrentJobs (default 2).  /sol submissions are NO LONGER
 * globally serialized: pi-oracle runs each job in its own isolated browser
 * runtime profile cloned from one auth seed profile, so concurrent jobs are
 * safe.  Our admission layer only enforces the same upper bound (fail-fast,
 * friendly message) and coordinates the brief oracle_submit call.
 */
export function oracleMaxConcurrentJobs(env = process.env): number {
	const fromEnv = Number(env.PI_SOL_MAX_CONCURRENT_JOBS);
	if (Number.isInteger(fromEnv) && fromEnv >= 1 && fromEnv <= 32) return fromEnv;
	try {
		const cfgPath = join(env.HOME ?? homedir(), ".pi", "agent", "extensions", "oracle.json");
		if (existsSync(cfgPath)) {
			const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
			const raw = cfg?.browser?.maxConcurrentJobs;
			// Strict: must be a JSON number (rejects `true`/`"2"` coercions, and
			// ensures the mirrored cap is a real integer in [1, 32]).
			if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 32) return raw;
		}
	} catch { /* fall back to the pi-oracle default */ }
	return 2;
}

/**
 * ChatGPT /sol admission now supports CONCURRENT jobs (maxConcurrentJobs,
 * default 2, mirroring pi-oracle). pi-oracle runs each job in its own
 * isolated browser runtime profile cloned from a single auth seed profile,
 * so concurrent jobs do not share a browser session.  This admission layer
 * enforces the upper bound fail-fast (friendly message instead of a queued
 * wait) and coordinates the brief oracle_submit call itself.
 *
 * Lock protocol (audit-hardened, round 5):
 * - Coordination root lives in a per-user private state dir (PI_SOL_STATE_DIR,
 *   default ~/.pi/agent/state), never the shared /tmp namespace.
 * - Every lock (submit lock and reclaim token) is published ATOMICALLY: the
 *   owner.json is written into a unique staging dir first, then the staging
 *   dir is renamed onto the fixed path. rename() is atomic, so the fixed path
 *   either does not exist or is fully initialized — there is NO ownerless
 *   intermediate state visible to other processes (closes the mkdir→write
 *   crash window that earlier rounds flagged as split-brain).
 * - Stale reclaim: only when the recorded owner PID is provably dead (ESRCH)
 *   AND the TTL elapsed; the reclaim itself runs under the reclaim token so a
 *   stale proof can never be applied to a newer generation.
 * - Release: only the matching owner token may remove the fixed path, and only
 *   while holding the reclaim token. If the token is unavailable the release
 *   retries and returns false — the caller keeps the lease so it can retry on
 *   later events (tool_execution_end / session_shutdown) instead of wedging.
 * - pidAlive: only ESRCH proves death; every other errno is possibly-alive.
 */
const SUBMIT_LOCK_NAME = "pi-sol-submit.lock";
const RECLAIM_TOKEN_NAME = "pi-sol-submit.reclaim-token";
const SUBMIT_LOCK_TTL_MS = 15 * 60 * 1000;
const STAGING_SWEEP_MS = 60 * 1000;

export type SolSubmitLease = {
	path: string;
	token: string;
};

export type SolSubmitAdmission =
	| { acquired: true; lease: SolSubmitLease }
	| { acquired: false; reason: string; activeJobs: SolJobSummary[]; pendingLease?: SolSubmitLease };

type LeaseOwner = {
	token: string;
	pid: number;
	createdAt: string;
};

export function getSolStateDir(env = process.env): string {
	return env.PI_SOL_STATE_DIR?.trim() || join(homedir(), ".pi", "agent", "state");
}

function lockPath(stateDir: string): string {
	return join(stateDir, SUBMIT_LOCK_NAME);
}

/** PID liveness: only ESRCH proves dead; every other outcome is possibly-alive. */
function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		// ESRCH = no such process (provably dead). EPERM and any other errno
		// (platform quirks, containers, permissions) are treated as alive.
		return code !== "ESRCH";
	}
}

async function readOwner(path: string): Promise<Partial<LeaseOwner> | undefined> {
	try {
		return JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as Partial<LeaseOwner>;
	} catch {
		return undefined;
	}
}

/** A lock is stale only when its owner PID is dead AND the TTL elapsed. */
async function isStaleLock(path: string): Promise<boolean> {
	const owner = await readOwner(path);
	if (owner && pidAlive(Number(owner.pid))) return false;
	try {
		const info = await stat(path);
		return Date.now() - info.mtimeMs > SUBMIT_LOCK_TTL_MS;
	} catch {
		return true;
	}
}

/**
 * Atomically move the target path to a unique trash path. Only one contender
 * can win a rename of the SAME current generation. All callers must hold the
 * reclaim token so no other process can replace the path in between.
 */
async function atomicRenameAway(path: string): Promise<{ moved: boolean; trash?: string }> {
	const trash = `${path}.trash.${process.pid}.${randomUUID()}`;
	try {
		await rename(path, trash);
		return { moved: true, trash };
	} catch {
		return { moved: false };
	}
}

/**
 * Atomically publish a fully-initialized lock directory.
 *
 * Writes owner.json into a UNIQUE staging directory first, then renames it to
 * the fixed path. rename() is atomic: the fixed path either does not exist or
 * is fully initialized. There is no ownerless intermediate state visible to
 * other processes, so a contender can never observe a half-initialized lock
 * and must never guess staleness from a grace timer (audit P1-2/P1-5).
 * Returns false when the fixed path already exists (someone else holds it).
 */
async function atomicPublishLock(stagingDir: string, fixedPath: string, owner: LeaseOwner): Promise<boolean> {
	try {
		await writeFile(join(stagingDir, "owner.json"), JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
		await rename(stagingDir, fixedPath);
		return true;
	} catch {
		await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
		return false;
	}
}

/**
 * Remove our own freshly-published coordination lock and VERIFY the removal,
 * or escalate loudly.  We never swallow a cleanup failure: a leaked live-PID
 * lock (owner alive → never stale) would wedge all future /sol admissions
 * until this Pi exits (audit round P2-C2).
 */
/** Async wrapper around existsSync for use in return expressions. */
async function existsSyncAuto(path: string): Promise<boolean> {
	return existsSync(path);
}

async function removeOwnFreshLockOrThrow(path: string): Promise<void> {
	// ATOMIC REMOVAL: fs.rm(recursive) is not atomic — it can delete
	// owner.json first and then fail on the parent-dir permission, leaving an
	// ownerless lock dir at the FIXED path (which readOwner would misjudge as
	// "not ours", wedging admission until the owner Pi exits).  Instead we
	// rename the fixed path to a unique trash dir FIRST (atomic: the fixed
	// path is gone in one step) and only then best-effort delete the trash;
	// any leftover trash is reaped by sweepStaleStaging.  The fixed path
	// never carries a partial-rm remnant (audit round P2).
	const trash = `${path}.trash.${process.pid}.${randomUUID()}`;
	try {
		await rename(path, trash);
	} catch (error) {
		if (!existsSync(path)) return; // already gone
		throw new Error(`Cannot remove own coordination lock ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	await rm(trash, { recursive: true, force: true }).catch(() => undefined);
	if (existsSync(path)) {
		throw new Error(`Coordination lock ${path} still exists after removal; refusing to forget ownership`);
	}
}

/** Create a unique staging dir next to the fixed path (same filesystem). */
async function createStagingDir(stateDir: string): Promise<string> {
	const staging = join(stateDir, `.staging-${process.pid}-${randomUUID()}`);
	await mkdir(staging, { mode: 0o700 });
	return staging;
}

/** Best-effort sweep of stale staging/trash dirs left by crashed processes. */
async function sweepStaleStaging(stateDir: string): Promise<void> {
	try {
		for (const name of await readdir(stateDir)) {
			// Only sweep pi-sol's own staging/trash dirs (not generic .trash.
			// from other modules in the shared stateDir — audit round P2).
			// Staging: .staging-<pid>-<uuid>
			// Trash:   pi-sol-submit.lock.trash.<pid>.<uuid> or
			//          pi-sol-submit.reclaim-token.trash.<pid>.<uuid>
			if (!name.startsWith(".staging-") &&
			    !name.startsWith(SUBMIT_LOCK_NAME + ".trash.") &&
			    !name.startsWith(RECLAIM_TOKEN_NAME + ".trash.")) continue;
			const p = join(stateDir, name);
			try {
				const info = await stat(p);
				if (Date.now() - info.mtimeMs > STAGING_SWEEP_MS) await rm(p, { recursive: true, force: true }).catch(() => undefined);
			} catch { /* raced with another sweeper */ }
		}
	} catch { /* best-effort */ }
}

/**
 * Move the current reclaim-token generation away and verify it is EXACTLY the
 * observed (dead) generation.  Returns keep=true only when the caller may
 * discard the moved dir and continue reclaiming.  When a newer LIVE
 * generation replaced the fixed path between readOwner and this call, the
 * moved dir is RESTORED; if the path was re-occupied before the restore could
 * run, the moved dir is KEPT (never deleted) so a live holder's token is
 * never destroyed — sweepStaleStaging reclaims it later. keep=false — the
 * caller does NOT own the token (audit round 6/7 P1-2).
 * @internal exported for deterministic interleaving tests
 */
export async function moveReclaimCandidate(
	tokenPath: string,
	observed: Partial<LeaseOwner> | undefined,
): Promise<{ moved: boolean; keep: boolean; trash?: string }> {
	// PRE-RENAME VERIFICATION (audit round P1): read the current owner
	// immediately before the rename.  Only proceed if it still matches the
	// observed (dead) generation.  This eliminates the deterministic
	// counterexample where a stale proof for A renames away a live B that
	// was published between the original readOwner and this call — the
	// pre-rename re-read sees B (live) and aborts, never moving a live
	// holder's token.  The remaining TOCTOU (re-read → rename) is
	// microseconds against a dead generation, not a live one.
	const current = await readOwner(tokenPath);
	if (observed && (!current || current.token !== observed.token)) {
		return { moved: false, keep: false };
	}
	const { moved, trash } = await atomicRenameAway(tokenPath);
	if (!moved) return { moved: false, keep: false };
	const movedOwner = await readOwner(trash!);
	if (movedOwner && observed && movedOwner.token === observed.token) {
		await rm(trash!, { recursive: true, force: true }).catch(() => undefined);
		return { moved: true, keep: true };
	}
	// Mismatch: a newer live generation was moved. Restore it so the current
	// holder keeps authority.  If the path was already re-occupied, KEEP the
	// moved dir (do NOT delete it) — deleting a live holder's token would let
	// that holder and the new path owner both believe they hold the token
	// (double-holder window).  The stale trash dir is swept later.
	const restored = await restoreMovedGeneration(tokenPath, trash!);
	if (!restored) {
		return { moved: true, keep: false, trash };
	}
	return { moved: true, keep: false };
}

/**
 * Try to put a displaced generation directory back onto the fixed path.
 * Fails (returns false) when another process re-occupied the path in the
 * meantime.  The moved dir must then be KEPT (not deleted) by the caller so
 * a live holder's token is never destroyed.
 * @internal exported for deterministic restore-failure tests
 */
export async function restoreMovedGeneration(tokenPath: string, trash: string): Promise<boolean> {
	return rename(trash, tokenPath)
		.then(() => true)
		.catch(() => false);
}

/**
 * Generation-safe release: only remove the fixed path while it is STILL our
 * generation.  A concurrent reclaim may have replaced us with a newer live
 * token; removing that would delete another holder's serialization token
 * (audit round 6 P1-2).  Uses atomic rename-to-trash so the fixed path is
 * removed in one namespace mutation (no read→rm TOCTOU, no partial-rm
 * ownerless residue) — audit round P1.
 * @internal exported for deterministic tests
 */
export async function releaseTokenGeneration(tokenPath: string, owner: LeaseOwner): Promise<void> {
	const current = await readOwner(tokenPath);
	if (current?.token !== owner.token) return; // not ours anymore
	const trash = `${tokenPath}.trash.${process.pid}.${randomUUID()}`;
	try {
		await rename(tokenPath, trash);
	} catch {
		// Path may already be gone (a concurrent reclaim removed it); either
		// way it is no longer ours to manage.
		return;
	}
	await rm(trash, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Acquire the reclaim token: an atomically-published directory that
 * serializes ALL mutations of the fixed lock path (stale reclaim and release).
 * Holding the token while verifying staleness and renaming binds the stale
 * proof to the exact generation being removed — no other process can replace
 * the path in between, so an old stale proof can never delete a newer live
 * generation. A crashed holder leaves a fully-initialized token whose owner
 * PID is provably dead, so it is reclaimable. Returns a release function, or
 * undefined when another live process holds it.
 */
async function acquireReclaimToken(stateDir: string): Promise<(() => Promise<void>) | undefined> {
	const tokenPath = join(stateDir, RECLAIM_TOKEN_NAME);
	await sweepStaleStaging(stateDir);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const staging = await createStagingDir(stateDir);
		const owner: LeaseOwner = { token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() };
		const published = await atomicPublishLock(staging, tokenPath, owner);
		if (published) {
			let released = false;
			return async () => {
				if (released) return;
				released = true;
				// Generation-safe release: only remove the fixed path while it is
				// STILL our generation.  A concurrent reclaim may have replaced
				// us with a newer live token; removing that would delete another
				// holder's serialization token (audit round 6 P1-2).
				await releaseTokenGeneration(tokenPath, owner);
			};
		}
		// EEXIST: another process holds the token. Reclaim only if its owner
		// is provably dead (atomic-published tokens always carry owner.json).
		const existing = await readOwner(tokenPath);
		if (existing && !pidAlive(Number(existing.pid))) {
			const { moved, keep } = await moveReclaimCandidate(tokenPath, existing);
			if (moved && keep) continue; // safe: the dead generation is gone; try publishing ours
		}
		return undefined;
	}
	return undefined;
}

function busyReason(activeJobs: SolJobSummary[], _lockPath?: string): string {
	if (activeJobs.length > 0) {
		const shown = activeJobs
			.slice(0, 3)
			.map((job) => `${job.id} (${job.status})`)
			.join(", ");
		const suffix = activeJobs.length > 3 ? `, +${activeJobs.length - 3} more` : "";
		return `ChatGPT /sol concurrency limit reached: active jobs ${shown}${suffix}. Wait for one to finish, then use /sol-read <job-id> and retry.`;
	}
	// No rm -rf advice: the coordination lock may be legitimately held by a
	// live oracle_submit that simply took longer than the wait window.  Stale
	// locks are reclaimed automatically by the protocol (PID dead + TTL); we
	// never instruct an agent to bypass the generation/reclaim authority.
	return `Another Pi session is currently admitting a ChatGPT /sol submission; the admission coordination lock is briefly held. Wait briefly and retry.`;
}

/** Acquire a short-lived cross-Pi admission lease before oracle_submit.
 * @param stateDir - per-user private dir for the lock (default: ~/.pi/agent/state)
 * @param jobsDir - oracle job storage dir for active-job scan (default: getOracleJobsDir())
 */
export async function acquireSolSubmitLease(
	stateDir = getSolStateDir(),
	jobsDir = getOracleJobsDir(),
	maxConcurrentJobs = oracleMaxConcurrentJobs(),
	scanActive: (jobsDir: string) => SolJobSummary[] = listActiveSolJobs,
): Promise<SolSubmitAdmission> {
	const path = lockPath(stateDir);
	try {
		await mkdir(stateDir, { recursive: true, mode: 0o700 });
		await chmodPrivate(stateDir);
	} catch (error) {
		return {
			acquired: false,
			reason: `Cannot establish ChatGPT /sol admission state dir: ${error instanceof Error ? error.message : String(error)}`,
			activeJobs: [],
		};
	}
	await sweepStaleStaging(stateDir);
	const token = randomUUID();
	const activeJobs = scanActive(jobsDir);
	if (activeJobs.length >= maxConcurrentJobs) {
		return { acquired: false, reason: busyReason(activeJobs), activeJobs };
	}
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const staging = await createStagingDir(stateDir);
		const owner: LeaseOwner = { token, pid: process.pid, createdAt: new Date().toISOString() };
		const published = await atomicPublishLock(staging, path, owner);
		if (!published) {
			// EEXIST: another process holds the coordination lock.  In
			// parallel mode we do NOT reject a live holder — the oracle_submit
			// call is brief and the lock is released quickly.  Reclaim a stale
			// lock (crashed owner) so the path doesn't wedge.  Otherwise wait
			// briefly, re-check the upper bound, and retry.
			if (await isStaleLock(path)) {
				const releaseToken = await acquireReclaimToken(stateDir);
				if (!releaseToken) continue;
				try {
					const observed = await readOwner(path);
					if (!observed || !(await isStaleLock(path))) continue;
					const { moved, keep } = await moveReclaimCandidate(path, observed);
					if (!moved || !keep) continue;
				} finally { await releaseToken(); }
				continue;
			}
			// Live holder: wait for the brief oracle_submit call to release it.
			// 250ms × 20 attempts = 5s window (audit round P2-2: 600ms had no
			// reliable latency contract; 5s covers cold spawn / fs / IPC).
			await new Promise((r) => setTimeout(r, 250));
			const active = scanActive(jobsDir);
			if (active.length >= maxConcurrentJobs) {
				return { acquired: false, reason: busyReason(active), activeJobs: active };
			}
			continue;
		}
		// Fresh lock atomically published.  AUTHORITATIVE capacity check:
		// re-scan AFTER acquiring the coordination lock, so the decision is
		// atomic with the reservation.  A contender that passed an earlier
		// pre-lock scan cannot slip past the limit while the previous holder
		// completed its submit and released (audit round P1).
		let active: SolJobSummary[];
		try {
			active = scanActive(jobsDir);
		} catch (error) {
			// A scan failure right after we published our OWN fresh lock must
			// not leave a live-PID wedge (nobody owns the lease, yet the PID
			// is alive so it can never be reclaimed as stale).  We try to
			// clean our generation; if even cleanup fails, we return the lease
			// as pendingLease so the caller registers it in submitLeases and
			// the release machinery retries until success (audit round P2).
			try {
				await removeOwnFreshLockOrThrow(path);
			} catch { /* cleanup failure — preserve ownership for retry */ }
			// If cleanup succeeded, pendingLease is undefined; the tool_call
			// handler skips registration.  If cleanup failed, the lease is
			// passed back so it stays owned (not lost) — the existing
			// release-keeps-lease / session_shutdown retry machinery handles
			// eventual cleanup.  In either case we fail-closed (no submit).
			return {
				acquired: false,
				reason: `Cannot scan active /sol jobs after acquiring the coordination lock: ${error instanceof Error ? error.message : String(error)}`,
				activeJobs: [],
				...(await existsSyncAuto(path) ? { pendingLease: { path, token } } : {}),
			};
		}
		if (active.length >= maxConcurrentJobs) {
			// Confirm our own generation is removed before reporting busy;
			// never swallow a cleanup failure (a leaked live-PID lock would
			// wedge all future /sol admissions until this Pi exits).
			// If cleanup fails, preserve ownership via pendingLease for
			// retry by the release machinery (audit round P2).
			try {
				await removeOwnFreshLockOrThrow(path);
			} catch { /* cleanup failure — preserve ownership */ }
			return {
				acquired: false,
				reason: busyReason(active),
				activeJobs: active,
				...(await existsSyncAuto(path) ? { pendingLease: { path, token } } : {}),
			};
		}
		return { acquired: true, lease: { path, token } };
	}
	return { acquired: false, reason: busyReason([], path), activeJobs: listActiveSolJobs(jobsDir) };
}

/**
 * Release the lease: remove the fixed lock path only if it is still ours.
 * Must hold the reclaim token so a concurrent stale reclaim cannot replace
 * the path between our read and rm. If the token cannot be acquired, retry
 * briefly and return false — the caller must KEEP the lease so a later event
 * (tool_execution_end / session_shutdown) can retry. Never fall back to a
 * bare read→rm, because that would re-open the generation race.
 */
export async function releaseSolSubmitLease(lease: SolSubmitLease, options: { maxAttempts?: number; retryMs?: number } = {}): Promise<boolean> {
	const stateDir = dirname(lease.path);
	const maxAttempts = options.maxAttempts ?? 20;
	const retryMs = options.retryMs ?? 50;
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const releaseToken = await acquireReclaimToken(stateDir);
		if (!releaseToken) {
			await new Promise((r) => setTimeout(r, retryMs));
			continue;
		}
		try {
			const owner = await readOwner(lease.path);
			if (owner?.token !== lease.token) return true; // released, or not ours
			// Atomic removal (rename-to-trash first); if cleanup fails we
			// CONTINUE so the retry loop covers BOTH reclaim-token contention
			// AND fixed-path rename failure — never give up after one attempt
			// (audit round P2 shutdown retry budget).
			try {
				await removeOwnFreshLockOrThrow(lease.path);
			} catch {
				continue; // retry: loop will try to acquire the reclaim token again
			}
			return true;
		} finally {
			await releaseToken();
		}
	}
	return false; // still ours but the token stayed unavailable; keep the lease
}

/** Tighten an existing (not just newly created) state dir to 0700. Fail closed
 * when the private-permission invariant cannot be established: a shared or
 * world-readable coordination root would defeat the cross-user DoS protection. */
async function chmodPrivate(dir: string): Promise<void> {
	const { chmod, stat } = await import("node:fs/promises");
	await chmod(dir, 0o700);
	const info = await stat(dir);
	if ((info.mode & 0o777) !== 0o700) {
		throw new Error(`coordination state dir ${dir} is not private (mode ${(info.mode & 0o777).toString(8)}); refusing to continue`);
	}
}
