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
	return env.PI_SOL_STATE_DIR?.trim() || join(env.HOME ?? homedir(), ".pi", "agent", "state");
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

export type SolOperationLease = {
	/** Absolute path of the shared seed-operation flock file. */
	path: string;
	/** Unique per-acquire id (kept for diagnostics; release uses the fd). */
	token: string;
	/** Open file descriptor holding the kernel flock. */
	fd: number;
};

/** Backward-compatible name for callers that reserve a submit handoff. */
export type SolSubmitLease = SolOperationLease;

export type SolOperationAdmission =
	| { acquired: true; lease: SolOperationLease }
	| { acquired: false; reason: string };

export type SolSubmitAdmission =
	| { acquired: true; lease: SolSubmitLease }
	| { acquired: false; reason: string; activeJobs: SolJobSummary[] };

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function busyReason(activeJobs: SolJobSummary[]): string {
	if (activeJobs.length > 0) {
		const shown = activeJobs
			.slice(0, 3)
			.map((job) => `${job.id} (${job.status})`)
			.join(", ");
		const suffix = activeJobs.length > 3 ? `, +${activeJobs.length - 3} more` : "";
		return `ChatGPT /sol concurrency limit reached: active jobs ${shown}${suffix}. Wait for one to finish, then use /sol-read <job-id> and retry.`;
	}
	// No rm advice: the lock is kernel-managed and auto-released on holder
	// death; telling an agent to delete the lock file would be wrong. The same
	// lock also protects /sol-open seed startup, so keep this wording generic.
	return `Another Pi session is currently holding the /sol seed-operation/admission coordination lock; wait briefly and retry.`;
}

type StateDirResult = { ok: true } | { ok: false; reason: string };

async function ensurePrivateStateDir(stateDir: string): Promise<StateDirResult> {
	try {
		await mkdir(stateDir, { recursive: true, mode: 0o700 });
		await chmodPrivate(stateDir);
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			reason: `Cannot establish /sol seed-operation state dir: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
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
function tryTakeFlock(lockPath: string): number | undefined {
	// Try ONCE with LOCK_NB.  The caller owns the bounded async retry loop
	// (sleep between attempts), so we never busy-spin the event loop
	// (audit round P2-3).
	const fd = openSync(lockPath, "a+", 0o600);
	try {
		fsExt.flockSync(fd, fsExt.constants.LOCK_EX | fsExt.constants.LOCK_NB);
		return fd;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		closeSync(fd);
		if (code !== "EWOULDBLOCK" && code !== "EAGAIN") throw error;
		return undefined;
	}
}

/**
 * Acquire the shared per-user seed-operation lease. Both /sol-open and the
 * capacity-consuming oracle hooks use this exact kernel flock. A caller keeps
 * the returned lease for the whole operation; the kernel releases it if the
 * owning Pi process crashes.
 */
export async function acquireSolOperationLease(stateDir = getSolStateDir()): Promise<SolOperationAdmission> {
	const setup = await ensurePrivateStateDir(stateDir);
	if (!setup.ok) return setup;

	const lockPath = join(stateDir, ADMISSION_LOCK_NAME);
	let fd: number | undefined;
	const deadline = Date.now() + LOCK_WAIT_MS;
	try {
		while (fd === undefined && Date.now() < deadline) {
			fd = tryTakeFlock(lockPath);
			if (fd === undefined) await sleep(LOCK_RETRY_MS);
		}
	} catch (error) {
		return {
			acquired: false,
			reason: `Cannot acquire /sol seed-operation coordination lock: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (fd === undefined) return { acquired: false, reason: busyReason([]) };
	return { acquired: true, lease: { path: lockPath, token: randomUUID(), fd } };
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
	// Fast-path pre-check (optimization only; authoritative check is in-lock).
	let pre: SolJobSummary[];
	try {
		pre = scanActive(jobsDir);
	} catch (error) {
		return {
			acquired: false,
			reason: `Cannot scan active /sol jobs before acquiring the coordination lock: ${error instanceof Error ? error.message : String(error)}`,
			activeJobs: [],
		};
	}
	if (pre.length >= maxConcurrentJobs) {
		return { acquired: false, reason: busyReason(pre), activeJobs: pre };
	}

	// The same lease protects /sol-open seed startup. The submit caller keeps
	// it until the oracle tool has completed its seed clone/handoff.
	const operation = await acquireSolOperationLease(stateDir);
	if (!operation.acquired) {
		let activeJobs: SolJobSummary[] = [];
		try { activeJobs = scanActive(jobsDir); } catch { /* preserve the lock failure */ }
		return { acquired: false, reason: operation.reason, activeJobs };
	}

	const { fd } = operation.lease;
	try {
		// AUTHORITATIVE capacity check under the kernel lock.
		const active = scanActive(jobsDir);
		if (active.length >= maxConcurrentJobs) {
			fsExt.flockSync(fd, fsExt.constants.LOCK_UN);
			closeSync(fd);
			return { acquired: false, reason: busyReason(active), activeJobs: active };
		}
		return { acquired: true, lease: operation.lease };
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
 * Release the shared operation lease: unlock + close the fd. The kernel
 * releases the flock on close, so there is no generation-check or reclaim
 * token step. Always succeeds (close is authoritative); callers may safely
 * drop the lease after this one-shot operation.
 */
const RELEASED_LEASES = new WeakSet<SolOperationLease>();

export async function releaseSolOperationLease(lease: SolOperationLease): Promise<boolean> {
	// One-shot release (audit round P2-2): a lease is released exactly once.
	// Once unlock/close has been attempted, ownership is gone — the fd must
	// never be reused by a later event, because the kernel may have recycled
	// the numeric descriptor. Return true (dropped from the map) either way;
	// a close failure is a diagnostic, not a reason to keep retrying a raw fd.
	if (RELEASED_LEASES.has(lease)) return true;
	RELEASED_LEASES.add(lease);
	try {
		fsExt.flockSync(lease.fd, fsExt.constants.LOCK_UN);
	} catch { /* close releases the lock anyway */ }
	try {
		closeSync(lease.fd);
	} catch {
		// The fd may already be gone (kernel closed it on our exit path, or a
		// recycled descriptor). We still report success: the lease is consumed.
	}
	return true;
}

/** Backward-compatible submit-specific release name. */
export async function releaseSolSubmitLease(lease: SolSubmitLease): Promise<boolean> {
	return releaseSolOperationLease(lease);
}
