import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { getOracleJobsDir, listActiveSolJobs, type SolJobSummary } from "./jobs.ts";

/**
 * ChatGPT account admission is intentionally serialized across local Pi
 * sessions. pi-oracle can run isolated jobs concurrently, but ChatGPT's
 * account-level rate limit makes concurrent /sol submissions unreliable.
 *
 * Lock protocol (audit-hardened):
 * - Coordination root lives in a per-user private state dir, never the shared
 *   /tmp namespace (prevents cross-user fake-lock / fake-job DoS).
 * - Fresh mkdir is the atomic acquire primitive.
 * - Release: read owner token at the fixed path; only the matching owner
 *   removes it. A live owner's lock is never stale, so the read→rm window
 *   cannot be hijacked by a reclaimer (a reclaimer only acts on a dead PID).
 * - Stale reclaim: rename the lock to a unique trash path (atomic — only one
 *   contender wins), delete it, then mkdir fresh. No token verification after
 *   rename, because staleness (dead PID + TTL) was already proven first; the
 *   rename only serializes concurrent reclaimers.
 * - Freshness = PID liveness (primary) + TTL (secondary). A live PID is never
 *   reclaimed, so SIGSTOP / slow disk / sleep cannot break an active submit.
 */
const SUBMIT_LOCK_NAME = "pi-sol-submit.lock";
const RECLAIM_TOKEN_NAME = "pi-sol-submit.reclaim-token";
const SUBMIT_LOCK_TTL_MS = 15 * 60 * 1000;
/** Ownerless reclaim-token grace before it is considered stale (crash window). */
const TOKEN_INIT_GRACE_MS = 5 * 1000;

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

/** PID liveness: only ESRCH proves dead; every other outcome is treated as
 * possibly-alive (fail closed toward "do not reclaim"). */
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
 * can win a rename of the SAME current generation; however a stale proof taken
 * earlier does not bind to a later generation. All callers must hold the
 * reclaim token (see below) so that no other process can replace the path
 * between staleness verification and this rename.
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
 * Acquire the reclaim token: a private mkdir that serializes ALL mutations of
 * the fixed lock path (stale reclaim and release). Holding this token while
 * verifying staleness and renaming binds the stale proof to the exact
 * generation being removed — no other process can replace the path in between,
 * so an old stale proof can never delete a newer live generation.
 *
 * The token records its owner (PID). If the owner died, the token itself is
 * stale and is reclaimed atomically (rename to a unique trash path), so a
 * crash while holding the token cannot wedge future reclaims forever.
 * An ownerless token (created but owner.json never written before a crash) is
 * reclaimed after a short grace period via the same atomic rename.
 * Returns a release function, or undefined when another live process holds it.
 */
async function acquireReclaimToken(stateDir: string): Promise<(() => Promise<void>) | undefined> {
	const tokenPath = join(stateDir, RECLAIM_TOKEN_NAME);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		try {
			await mkdir(tokenPath, { mode: 0o700 });
		} catch {
			// EEXIST: another process (maybe crashed) holds the token.
			const owner = await readOwner(tokenPath);
			let reclaimable = false;
			if (owner && !pidAlive(Number(owner.pid))) {
				reclaimable = true; // recorded owner provably dead
			} else if (!owner) {
				// Ownerless token: created but owner.json never written (crash
				// between mkdir and write). Reclaim after a short grace so we
				// never race the writer that is still initializing it.
				try {
					const info = await stat(tokenPath);
					reclaimable = Date.now() - info.mtimeMs > TOKEN_INIT_GRACE_MS;
				} catch {
					reclaimable = true;
				}
			}
			if (reclaimable) {
				const { moved, trash } = await atomicRenameAway(tokenPath);
				if (moved) {
					await rm(trash!, { recursive: true, force: true }).catch(() => undefined);
					continue; // retry mkdir now that the dead token is gone
				}
			}
			return undefined;
		}
		const owner: LeaseOwner = { token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() };
		await writeFile(join(tokenPath, "owner.json"), JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			await rm(tokenPath, { recursive: true, force: true }).catch(() => undefined);
		};
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
	const token = randomUUID();
	for (let attempt = 0; attempt < 4; attempt += 1) {
		let created = false;
		try {
			await mkdir(path, { mode: 0o700 });
			created = true;
			const owner: LeaseOwner = { token, pid: process.pid, createdAt: new Date().toISOString() };
			await writeFile(join(path, "owner.json"), JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
			const activeJobs = listActiveSolJobs(jobsDir);
			if (activeJobs.length > 0) {
				// We own this fresh lock; remove it before reporting busy.
				await rm(path, { recursive: true, force: true }).catch(() => undefined);
				return { acquired: false, reason: busyReason(activeJobs), activeJobs };
			}
			return { acquired: true, lease: { path, token } };
		} catch (error) {
			if (created) await rm(path, { recursive: true, force: true }).catch(() => undefined);
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
				return {
					acquired: false,
					reason: `Cannot establish ChatGPT /sol admission lease: ${error instanceof Error ? error.message : String(error)}`,
					activeJobs: listActiveSolJobs(jobsDir),
				};
			}
			// Another process holds the lock. Reclaim only when its owner is
			// provably dead AND the TTL elapsed; otherwise return busy.
			if (!(await isStaleLock(path))) {
				return { acquired: false, reason: busyReason([], path), activeJobs: listActiveSolJobs(jobsDir) };
			}
			// Serialize the reclaim: only one process at a time may mutate the
			// fixed lock path. Holding the token between staleness verification
			// and rename binds the stale proof to the exact generation being
			// removed — an older stale proof can never delete a newer live lock.
			const releaseToken = await acquireReclaimToken(stateDir);
			if (!releaseToken) continue; // another reclaimer in progress; retry
			try {
				// Re-verify under the token: the path can only be the generation
				// we just verified (no other process can replace it while we hold
				// the token). If it is no longer stale, someone already recovered.
				if (!(await isStaleLock(path))) continue;
				const { moved, trash } = await atomicRenameAway(path);
				if (!moved) continue;
				await rm(trash!, { recursive: true, force: true }).catch(() => undefined);
			} finally {
				await releaseToken();
			}
		}
	}
	return { acquired: false, reason: busyReason([], path), activeJobs: listActiveSolJobs(jobsDir) };
}

/** Release the lease: remove the fixed lock path only if it is still ours.
 * Must hold the reclaim token so that a concurrent stale reclaim cannot
 * replace the path between our read and rm. */
/** Release the lease: remove the fixed lock path only if it is still ours.
 * Must hold the reclaim token so that a concurrent stale reclaim cannot
 * replace the path between our read and rm. If the token cannot be acquired
 * (another process is mid-mutation), retry briefly; never fall back to a bare
 * read→rm, because that would re-open the generation race. If the token is
 * still unavailable after the retries, leave the lock in place (fail-safe:
 * the stale-reclaim path or the operator hint handles it). */
export async function releaseSolSubmitLease(lease: SolSubmitLease): Promise<void> {
	const stateDir = dirname(lease.path);
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const releaseToken = await acquireReclaimToken(stateDir);
		if (!releaseToken) {
			await new Promise((r) => setTimeout(r, 50));
			continue;
		}
		try {
			const owner = await readOwner(lease.path);
			if (owner?.token === lease.token) await rm(lease.path, { recursive: true, force: true });
		} finally {
			await releaseToken();
		}
		return;
	}
	// Fail-safe: no bare mutation of the fixed path ever.
}

/** Tighten an existing (not just newly created) state dir to 0700. */
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
