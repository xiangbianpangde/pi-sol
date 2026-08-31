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
			if (!name.startsWith(".staging-") && !name.endsWith(".trash.")) continue;
			const p = join(stateDir, name);
			try {
				const info = await stat(p);
				if (Date.now() - info.mtimeMs > STAGING_SWEEP_MS) await rm(p, { recursive: true, force: true }).catch(() => undefined);
			} catch { /* raced with another sweeper */ }
		}
	} catch { /* best-effort */ }
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
				await rm(tokenPath, { recursive: true, force: true }).catch(() => undefined);
			};
		}
		// EEXIST: another process holds the token. Reclaim only if its owner
		// is provably dead (atomic-published tokens always carry owner.json).
		const existing = await readOwner(tokenPath);
		if (existing && !pidAlive(Number(existing.pid))) {
			const { moved, trash } = await atomicRenameAway(tokenPath);
			if (moved) {
				await rm(trash!, { recursive: true, force: true }).catch(() => undefined);
				continue;
			}
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
				// Re-verify under the token: the path can only be the generation
				// we just verified (no other process can replace it while we
				// hold the token).
				if (!(await isStaleLock(path))) continue;
				const { moved, trash } = await atomicRenameAway(path);
				if (!moved) continue;
				await rm(trash!, { recursive: true, force: true }).catch(() => undefined);
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
