import { mkdir, readFile, rename, rm, stat, writeFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { getOracleJobsDir, listActiveSolJobs, type SolJobSummary } from "./jobs.ts";

/**
 * ChatGPT account admission is intentionally serialized across local Pi
 * sessions. pi-oracle can run isolated jobs concurrently, but ChatGPT's
 * account-level rate limit makes concurrent /sol submissions unreliable.
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
	| { acquired: false; reason: string; activeJobs: SolJobSummary[] };

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
			// staging dirs are `.staging-<pid>-<uuid>`; trash dirs are
			// `<fixed>.<path>.trash.<pid>.<uuid>` — both must be swept (the
			// latter now also keeps a live-holder token after a failed restore,
			// so it must be reaped once it goes stale, never left forever).
			if (!name.includes(".trash.") && !name.startsWith(".staging-")) continue;
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
 * (audit round 6 P1-2).
 * @internal exported for deterministic tests
 */
export async function releaseTokenGeneration(tokenPath: string, owner: LeaseOwner): Promise<void> {
	const current = await readOwner(tokenPath);
	if (current?.token === owner.token) {
		await rm(tokenPath, { recursive: true, force: true }).catch(() => undefined);
	}
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

function busyReason(activeJobs: SolJobSummary[], lockPath?: string): string {
	if (activeJobs.length > 0) {
		const shown = activeJobs
			.slice(0, 3)
			.map((job) => `${job.id} (${job.status})`)
			.join(", ");
		const suffix = activeJobs.length > 3 ? `, +${activeJobs.length - 3} more` : "";
		return `Another ChatGPT /sol job is active: ${shown}${suffix}. Wait for it to finish, then use /sol-read <job-id>. Do not retry this submission.`;
	}
	const recovery = lockPath
		? ` If you are sure no other /sol is running, remove the stale lock: rm -rf ${lockPath}`
		: "";
	return `Another Pi session is currently admitting a ChatGPT /sol submission. Wait briefly and retry after it finishes. Do not open a second submission.${recovery}`;
}

/** Acquire a short-lived cross-Pi admission lease before oracle_submit.
 * @param stateDir - per-user private dir for the lock (default: ~/.pi/agent/state)
 * @param jobsDir - oracle job storage dir for active-job scan (default: getOracleJobsDir())
 */
export async function acquireSolSubmitLease(stateDir = getSolStateDir(), jobsDir = getOracleJobsDir()): Promise<SolSubmitAdmission> {
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
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const staging = await createStagingDir(stateDir);
		const owner: LeaseOwner = { token, pid: process.pid, createdAt: new Date().toISOString() };
		const published = await atomicPublishLock(staging, path, owner);
		if (!published) {
			// EEXIST: another process holds the lock. Reclaim only when its
			// owner is provably dead AND the TTL elapsed; otherwise busy.
			if (!(await isStaleLock(path))) {
				return { acquired: false, reason: busyReason([], path), activeJobs: listActiveSolJobs(jobsDir) };
			}
			// Serialize the reclaim under the reclaim token: only one process
			// may mutate the fixed lock path at a time.
			const releaseToken = await acquireReclaimToken(stateDir);
			if (!releaseToken) continue; // another reclaimer in progress; retry
			try {
				// Re-verify under the token: read the CURRENT owner and confirm
				// the lock is still stale before touching it.
				const observed = await readOwner(path);
				if (!observed || !(await isStaleLock(path))) continue;
				// Generation-bound move (audit round 7): even if the reclaim
				// token were double-held (a paused holder whose live token was
				// displaced), the SUBMIT LOCK itself is only removed when the
				// moved dir is exactly the stale generation we observed.  A
				// newer live lock is restored/kept, never deleted — the
				// submit-lock split-brain cannot re-open.
				const { moved, keep } = await moveReclaimCandidate(path, observed);
				if (!moved || !keep) continue;
			} finally {
				await releaseToken();
			}
			continue;
		}
		// Fresh lock atomically published to the fixed path.
		const activeJobs = listActiveSolJobs(jobsDir);
		if (activeJobs.length > 0) {
			// We own this fresh lock; remove it before reporting busy.
			await rm(path, { recursive: true, force: true }).catch(() => undefined);
			return { acquired: false, reason: busyReason(activeJobs), activeJobs };
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
			if (owner?.token === lease.token) await rm(lease.path, { recursive: true, force: true });
			return true; // released, or the path is already not ours
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
