import { mkdir } from "node:fs/promises";
import { openSync, closeSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import fsExt from "fs-ext";

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

export function getSolStateDir(env = process.env): string {
	return env.PI_SOL_STATE_DIR?.trim() || join(homedir(), ".pi", "agent", "state");
}

/**
 * Coordination lock file name.  Admission mutual exclusion is provided by a
 * KERNEL-LEVEL flock on this file (via fs-ext), NOT by a pathname protocol.
 * The kernel automatically releases the lock when the holder process exits or
 * crashes, so there is no stale-lock, TTL, generation-binding, reclaim-token,
 * owner.json, or trash-sweep machinery at all — the audit round P1
 * "read → rename TOCTOU" class is eliminated by construction.
 */
const ADMISSION_LOCK_NAME = "pi-sol-admission.lock";
const LOCK_RETRY_MS = 100;
const LOCK_WAIT_MS = 5000;

export type SolSubmitLease = {
	/** Absolute path of the flock file (kept for diagnostics / tests). */
	path: string;
	/** Unique per-acquire id (kept for diagnostics; release uses the fd). */
	token: string;
	/** Open file descriptor holding the kernel flock. */
	fd: number;
};

export type SolSubmitAdmission =
	| { acquired: true; lease: SolSubmitLease }
	| { acquired: false; reason: string; activeJobs: SolJobSummary[] };

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
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
	// No rm advice: the lock is kernel-managed and auto-released on holder
	// death; telling an agent to delete the lock file would be wrong.
	return `Another Pi session is currently admitting a ChatGPT /sol submission; the admission coordination lock is briefly held. Wait briefly and retry.`;
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

/**
 * Try to take the kernel flock with a bounded wait.  Returns an open fd
 * holding LOCK_EX, or undefined if the window elapsed.  The caller keeps the
 * fd in the lease and releases it in releaseSolSubmitLease; on process death
 * the kernel drops the lock automatically.
 */
function tryTakeFlock(lockPath: string, waitMs: number): number | undefined {
	const fd = openSync(lockPath, "a+", 0o600);
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			fsExt.flockSync(fd, fsExt.constants.LOCK_EX | fsExt.constants.LOCK_NB);
			return fd;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== "EWOULDBLOCK" && code !== "EAGAIN") {
				closeSync(fd);
				throw error;
			}
			if (Date.now() >= deadline) {
				closeSync(fd);
				return undefined;
			}
			const waited = Math.min(LOCK_RETRY_MS, deadline - Date.now());
			// We cannot block the event loop; busy-wait with small synchronous
			// sleep is inappropriate, so loop with an async pause via the caller.
			// This helper is sync; see acquireSolSubmitLease for the async loop.
			if (waited <= 0) break;
		}
	}
	closeSync(fd);
	return undefined;
}

/**
 * Acquire a short-lived cross-Pi admission lease before oracle_submit.
 *
 * Mutual exclusion is a KERNEL flock: only one process can hold LOCK_EX on
 * the lock file at a time, and the kernel releases it on process death.  No
 * owner.json, no generation, no reclaim token, no stale-reclaim, no TTL —
 * the entire audit round P1 TOCTOU class is eliminated by construction.
 * The authoritative active-job capacity check runs AFTER the flock is held,
 * so the decision is atomic with the reservation.
 *
 * @param stateDir - per-user private dir for the lock (default: ~/.pi/agent/state)
 * @param jobsDir - oracle job storage dir for active-job scan (default: getOracleJobsDir())
 * @param maxConcurrentJobs - concurrency cap (default: oracleMaxConcurrentJobs())
 * @param scanActive - injectable active-job scanner (tests use a stateful stub)
 */
export async function acquireSolSubmitLease(
	stateDir = getSolStateDir(),
	jobsDir = getOracleJobsDir(),
	maxConcurrentJobs = oracleMaxConcurrentJobs(),
	scanActive: (jobsDir: string) => SolJobSummary[] = listActiveSolJobs,
): Promise<SolSubmitAdmission> {
	const lockPath = join(stateDir, ADMISSION_LOCK_NAME);
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

	// Fast-path pre-check (optimization only; authoritative check is in-lock).
	const pre = scanActive(jobsDir);
	if (pre.length >= maxConcurrentJobs) {
		return { acquired: false, reason: busyReason(pre), activeJobs: pre };
	}

	// Wait for the kernel flock (bounded).
	let fd: number | undefined;
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (!fd && Date.now() < deadline) {
		fd = tryTakeFlock(lockPath, Math.min(LOCK_RETRY_MS, deadline - Date.now()));
		if (!fd) await sleep(LOCK_RETRY_MS);
	}
	if (!fd) {
		return { acquired: false, reason: busyReason([], lockPath), activeJobs: scanActive(jobsDir) };
	}

	try {
		// AUTHORITATIVE capacity check under the kernel lock.
		const active = scanActive(jobsDir);
		if (active.length >= maxConcurrentJobs) {
			fsExt.flockSync(fd, fsExt.constants.LOCK_UN);
			closeSync(fd);
			return { acquired: false, reason: busyReason(active), activeJobs: active };
		}
		return { acquired: true, lease: { path: lockPath, token: randomUUID(), fd } };
	} catch (error) {
		// Scan failed after acquiring the lock: release and fail closed.
		// The kernel drops the lock on close even if unlock fails.
		try { fsExt.flockSync(fd, fsExt.constants.LOCK_UN); } catch { /* ignore */ }
		closeSync(fd);
		return {
			acquired: false,
			reason: `Cannot scan active /sol jobs after acquiring the coordination lock: ${error instanceof Error ? error.message : String(error)}`,
			activeJobs: [],
		};
	}
}

/**
 * Release the admission lease: unlock + close the fd.  The kernel releases
 * the flock on close, so there is no generation-check or reclaim-token step.
 * Always succeeds (close is authoritative); returns true once the fd is
 * closed so the caller drops the lease from its map.
 */
export async function releaseSolSubmitLease(lease: SolSubmitLease): Promise<boolean> {
	try {
		fsExt.flockSync(lease.fd, fsExt.constants.LOCK_UN);
	} catch { /* close releases the lock anyway */ }
	try {
		closeSync(lease.fd);
		return true;
	} catch {
		return false;
	}
}
