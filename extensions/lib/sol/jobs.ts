import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** Jobs that can still consume ChatGPT account/browser capacity. */
export function listActiveSolJobs(jobsDir = getOracleJobsDir()): SolJobSummary[] {
	if (!existsSync(jobsDir)) return [];
	return readdirSync(jobsDir)
		.filter((name) => name.startsWith("oracle-"))
		.map((name) => join(jobsDir, name))
		.filter((dir) => existsSync(join(dir, "job.json")))
		.map((dir) => readSolJob(dir, jobsDir))
		.filter((job): job is SolJobSummary => Boolean(job))
		.filter((job) => ACTIVE_SOL_JOB_STATUSES.has(job.status) && job.provider !== "grok")
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
