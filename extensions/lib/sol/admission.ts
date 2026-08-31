import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { getOracleJobsDir, listActiveSolJobs, type SolJobSummary } from "./jobs.ts";

/**
 * ChatGPT account admission is intentionally serialized across local Pi
 * sessions. pi-oracle can run isolated jobs concurrently, but ChatGPT's
 * account-level rate limit makes concurrent /sol submissions unreliable.
 * The directory lock closes the cross-process TOCTOU window; job.json
 * inspection also catches jobs admitted by an older Pi process.
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

function lockPath(jobsDir: string): string {
	return join(jobsDir, SUBMIT_LOCK_NAME);
}

async function isStaleLock(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return Date.now() - info.mtimeMs > SUBMIT_LOCK_TTL_MS;
	} catch {
		return false;
	}
}

async function releasePath(lease: SolSubmitLease): Promise<void> {
	try {
		const owner = JSON.parse(await readFile(join(lease.path, "owner.json"), "utf8")) as Partial<LeaseOwner>;
		if (owner.token !== lease.token) return;
	} catch {
		// If the owner metadata vanished, do not remove a lock we can no longer
		// prove belongs to this process.
		return;
	}
	await rm(lease.path, { recursive: true, force: true });
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

/** Acquire a short-lived cross-Pi admission lease before oracle_submit. */
export async function acquireSolSubmitLease(jobsDir = getOracleJobsDir()): Promise<SolSubmitAdmission> {
	const path = lockPath(jobsDir);
	try {
		await mkdir(jobsDir, { recursive: true, mode: 0o700 });
	} catch (error) {
		return {
			acquired: false,
			reason: `Cannot establish ChatGPT /sol admission directory: ${error instanceof Error ? error.message : String(error)}`,
			activeJobs: listActiveSolJobs(jobsDir),
		};
	}
	const token = randomUUID();
	for (let attempt = 0; attempt < 2; attempt += 1) {
		let created = false;
		try {
			await mkdir(path, { mode: 0o700 });
			created = true;
			const owner: LeaseOwner = { token, pid: process.pid, createdAt: new Date().toISOString() };
			await writeFile(join(path, "owner.json"), JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
			const activeJobs = listActiveSolJobs(jobsDir);
			if (activeJobs.length > 0) {
				await releasePath({ path, token });
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
			if (!(await isStaleLock(path))) {
				return { acquired: false, reason: busyReason([]), activeJobs: listActiveSolJobs(jobsDir) };
			}
			await rm(path, { recursive: true, force: true }).catch(() => undefined);
		}
	}
	return { acquired: false, reason: busyReason([]), activeJobs: listActiveSolJobs(jobsDir) };
}

/** Release only the lease identified by the owner token. */
export async function releaseSolSubmitLease(lease: SolSubmitLease): Promise<void> {
	await releasePath(lease).catch(() => undefined);
}
