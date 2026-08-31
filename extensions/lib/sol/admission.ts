import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { getOracleJobsDir, listActiveSolJobs, type SolJobSummary } from "./jobs.ts";

/**
 * ChatGPT account admission is intentionally serialized across local Pi
 * sessions. pi-oracle can run isolated jobs concurrently, but ChatGPT's
 * account-level rate limit makes concurrent /sol submissions unreliable.
 *
 * Lock protocol (audit-hardened, P1-4/P1-5):
 * - Coordination root lives in a per-user private state dir, never the shared
 *   /tmp namespace (prevents cross-user fake-lock / fake-job DoS).
 * - Stale reclaim and release are atomic: the fixed lock path is RENAMED to a
 *   unique trash path first (only one contender can win a rename), then the
 *   trash is deleted after owner-token verification. There is no
 *   "verify-then-rm" sequence on the fixed path, so a stale reclaimer can
 *   never delete a newer generation's lock.
 * - Freshness = PID liveness (primary) + TTL (secondary). A live PID is never
 *   reclaimed even if the TTL elapsed (SIGSTOP/slow disk/sleep are safe).
 */
const SUBMIT_LOCK_NAME = "pi-sol-submit.lock";
const SUBMIT_LOCK_TTL_MS = 15 * 60 * 1000;

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

/** PID liveness: true when the owner PID is still alive (or unverifiable). */
function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		// ESRCH = no such process (dead). EPERM = exists but owned by another user.
		return code === "EPERM";
	}
}

async function readOwner(path: string): Promise<Partial<LeaseOwner> | undefined> {
	try {
		return JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as Partial<LeaseOwner>;
	} catch {
		return undefined;
	}
}

/** A lock is stale only when its owner PID is dead (TTL is a secondary guard). */
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
 * Atomically take the fixed lock path (by rename) and, only after verifying it
 * is the same generation we moved, delete it. Used for both stale reclaim and
 * release. Returns true when the caller moved-and-removed a lock.
 */
async function atomicTakeAndRemove(path: string, expectedToken: string): Promise<boolean> {
	const trash = `${path}.trash.${process.pid}.${randomUUID()}`;
	try {
		await rename(path, trash);
	} catch {
		return false; // another contender already moved it, or it is gone
	}
	const owner = await readOwner(trash);
	if (owner?.token && owner.token !== expectedToken) {
		// We moved a different generation (newer lock). Put it back.
		await rename(trash, path).catch(() => undefined);
		return false;
	}
	await rm(trash, { recursive: true, force: true }).catch(() => undefined);
	return true;
}

function busyReason(activeJobs: SolJobSummary[]): string {
	if (activeJobs.length > 0) {
		const shown = activeJobs
			.slice(0, 3)
			.map((job) => `${job.id} (${job.status})`)
			.join(", ");
		const suffix = activeJobs.length > 3 ? `, +${activeJobs.length - 3} more` : "";
		return `Another ChatGPT /sol job is active: ${shown}${suffix}. Wait for it to finish, then use /sol-read <job-id>. Do not retry this submission.`;
	}
	return "Another Pi session is currently admitting a ChatGPT /sol submission. Wait briefly and retry after it finishes. Do not open a second submission.";
}

/** Acquire a short-lived cross-Pi admission lease before oracle_submit.
 * @param stateDir - per-user private dir for the lock (default: ~/.pi/agent/state)
 * @param jobsDir - oracle job storage dir for active-job scan (default: getOracleJobsDir())
 */
export async function acquireSolSubmitLease(stateDir = getSolStateDir(), jobsDir = getOracleJobsDir()): Promise<SolSubmitAdmission> {
	const path = lockPath(stateDir);
	try {
		await mkdir(stateDir, { recursive: true, mode: 0o700 });
	} catch (error) {
		return {
			acquired: false,
			reason: `Cannot establish ChatGPT /sol admission state dir: ${error instanceof Error ? error.message : String(error)}`,
			activeJobs: [],
		};
	}
	const token = randomUUID();
	for (let attempt = 0; attempt < 3; attempt += 1) {
		let created = false;
		try {
			await mkdir(path, { mode: 0o700 });
			created = true;
			const owner: LeaseOwner = { token, pid: process.pid, createdAt: new Date().toISOString() };
			await writeFile(join(path, "owner.json"), JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
			const activeJobs = listActiveSolJobs(jobsDir);
			if (activeJobs.length > 0) {
				await atomicTakeAndRemove(path, token).catch(() => undefined);
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
			// provably dead; otherwise return busy (never disturb a live submit).
			if (!(await isStaleLock(path))) {
				return { acquired: false, reason: busyReason([]), activeJobs: listActiveSolJobs(jobsDir) };
			}
			// Atomic reclaim: rename the stale lock away; if we win, loop and mkdir fresh.
			const reclaimed = await atomicTakeAndRemove(path, "");
			if (!reclaimed) continue;
		}
	}
	return { acquired: false, reason: busyReason([]), activeJobs: listActiveSolJobs(jobsDir) };
}

/** Release only the lease identified by the owner token, atomically. */
export async function releaseSolSubmitLease(lease: SolSubmitLease): Promise<void> {
	await atomicTakeAndRemove(lease.path, lease.token).catch(() => undefined);
}
