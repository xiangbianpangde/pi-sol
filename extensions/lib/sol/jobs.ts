import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_ORACLE_JOBS_DIR = "/tmp";
export const ORACLE_JOBS_DIR_ENV = "PI_ORACLE_JOBS_DIR";

export function getOracleJobsDir(env = process.env): string {
	return env[ORACLE_JOBS_DIR_ENV]?.trim() || DEFAULT_ORACLE_JOBS_DIR;
}

export type SolJobSummary = {
	id: string;
	status: string;
	provider?: string;
	error?: string;
	responsePath?: string;
	responsePreview?: string;
	chatUrl?: string;
	conversationId?: string;
	dir: string;
};

export function getSolJobDir(jobId: string, jobsDir = getOracleJobsDir()): string {
	return join(jobsDir, `oracle-${jobId}`);
}

export function readSolJob(jobIdOrDir: string, jobsDir = getOracleJobsDir()): SolJobSummary | undefined {
	const dir = existsSync(join(jobIdOrDir, "job.json")) ? jobIdOrDir : getSolJobDir(jobIdOrDir, jobsDir);
	const jobPath = join(dir, "job.json");
	if (!existsSync(jobPath)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(jobPath, "utf8")) as {
			id?: string;
			status?: string;
			provider?: string;
			selection?: { provider?: string };
			error?: string;
			responsePath?: string;
			chatUrl?: string;
			conversationId?: string;
		};
		const responsePath = raw.responsePath && existsSync(raw.responsePath) ? raw.responsePath : undefined;
		let responsePreview: string | undefined;
		if (responsePath) {
			try {
				responsePreview = readFileSync(responsePath, "utf8").slice(0, 8000);
			} catch {
				responsePreview = undefined;
			}
		}
		return {
			id: raw.id ?? jobIdOrDir,
			status: raw.status ?? "unknown",
			provider: raw.provider ?? raw.selection?.provider,
			error: raw.error,
			responsePath,
			responsePreview,
			chatUrl: raw.chatUrl,
			conversationId: raw.conversationId,
			dir,
		};
	} catch {
		return undefined;
	}
}

export function listRecentSolJobIds(limit = 5, jobsDir = getOracleJobsDir()): string[] {
	if (!existsSync(jobsDir)) return [];
	return readdirSync(jobsDir)
		.filter((name) => name.startsWith("oracle-"))
		.map((name) => join(jobsDir, name))
		.filter((dir) => existsSync(join(dir, "job.json")))
		.sort()
		.reverse()
		.slice(0, limit)
		.map((dir) => dir.replace(/^.*oracle-/, ""));
}

const ACTIVE_SOL_JOB_STATUSES = new Set(["queued", "preparing", "submitted", "waiting"]);

/**
 * Jobs that can still consume ChatGPT account/browser capacity.
 *
 * Fail-closed rules (audit P2-3/P1-5):
 * - A job dir owned by another OS user is never trusted (prevents cross-user
 *   fake job.json DoS in the shared /tmp namespace).
 * - An unparseable job.json under oracle-* counts as ACTIVE (unknown status)
 *   instead of being silently ignored, so a corrupt/half-written record can
 *   never admit a second concurrent submission.
 */
export function listActiveSolJobs(jobsDir = getOracleJobsDir()): SolJobSummary[] {
	if (!existsSync(jobsDir)) return [];
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	return readdirSync(jobsDir)
		.filter((name) => name.startsWith("oracle-"))
		.map((name) => join(jobsDir, name))
		.filter((dir) => {
			if (!existsSync(join(dir, "job.json"))) return false;
			if (uid === undefined) return true;
			try {
				return statSync(dir).uid === uid;
			} catch {
				return false;
			}
		})
		.map((dir) => {
			const job = readSolJob(dir, jobsDir);
			if (job) return job;
			// Fail closed: malformed record is treated as an unknown active job.
			return { id: dir.replace(/^.*oracle-/, ""), status: "unknown", dir };
		})
		.filter((job) => ACTIVE_SOL_JOB_STATUSES.has(job.status) || job.status === "unknown")
		.filter((job) => job.provider !== "grok")
		.sort((a, b) => a.id.localeCompare(b.id));
}

export function formatSolJobSummary(job: SolJobSummary): string {
	const lines = [
		`job ${job.id}`,
		`status ${job.status}`,
		job.chatUrl ? `chat ${job.chatUrl}` : undefined,
		job.responsePath ? `response ${job.responsePath}` : "response (not saved yet)",
		job.error ? `error ${job.error}` : undefined,
	].filter(Boolean);
	if (job.responsePreview) {
		lines.push("", job.responsePreview);
	}
	return lines.join("\n");
}
