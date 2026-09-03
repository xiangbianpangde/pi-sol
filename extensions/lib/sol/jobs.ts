import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

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

/** pi-oracle creates every durable job with crypto.randomUUID() (UUID v4). */
export const CANONICAL_ORACLE_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCanonicalSolJobId(value: unknown): value is string {
	return typeof value === "string" && CANONICAL_ORACLE_JOB_ID.test(value);
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
	const boundary = relative(rootPath, candidatePath);
	return boundary === "" || (!boundary.startsWith(`..${sep}`) && boundary !== ".." && !isAbsolute(boundary));
}

function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function ownedByCurrentUser(path: string): boolean {
	const uid = currentUid();
	if (uid === undefined) return true;
	try {
		return statSync(path).uid === uid;
	} catch {
		return false;
	}
}

/**
 * Trust only a direct child job directory under the configured jobs root. The
 * realpath checks reject symlink escapes, and the owner check prevents a
 * different local user from supplying a readable-looking job record in /tmp.
 */
function isTrustedJobDir(dir: string, jobsDir: string): boolean {
	try {
		const realRoot = realpathSync(jobsDir);
		const realDir = realpathSync(dir);
		if (!isPathInside(realRoot, realDir)) return false;
		if (realpathSync(join(realDir, "..")) !== realRoot) return false;
		if (!basename(realDir).startsWith("oracle-")) return false;
		if (!ownedByCurrentUser(realDir)) return false;
		const jobPath = realpathSync(join(realDir, "job.json"));
		return isPathInside(realDir, jobPath) && ownedByCurrentUser(jobPath);
	} catch {
		return false;
	}
}

function trustedResponsePath(dir: string, responsePath: string | undefined): string | undefined {
	if (!responsePath) return undefined;
	try {
		const realDir = realpathSync(dir);
		const realResponse = realpathSync(resolve(dir, responsePath));
		if (!isPathInside(realDir, realResponse)) return undefined;
		if (!statSync(realResponse).isFile() || !ownedByCurrentUser(realResponse)) return undefined;
		return realResponse;
	} catch {
		return undefined;
	}
}

export function getSolJobDir(jobId: string, jobsDir = getOracleJobsDir()): string {
	if (!isCanonicalSolJobId(jobId)) {
		throw new Error(`Invalid oracle job ID ${JSON.stringify(jobId)}; expected a canonical UUID v4`);
	}
	return join(jobsDir, `oracle-${jobId}`);
}

export function readSolJob(jobIdOrDir: string, jobsDir = getOracleJobsDir()): SolJobSummary | undefined {
	const directDir = existsSync(join(jobIdOrDir, "job.json"));
	const dir = directDir ? jobIdOrDir : (isCanonicalSolJobId(jobIdOrDir) ? getSolJobDir(jobIdOrDir, jobsDir) : undefined);
	if (!dir || !isTrustedJobDir(dir, jobsDir)) return undefined;
	const jobPath = join(dir, "job.json");
	const requestedId = directDir ? undefined : jobIdOrDir;
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
		// An explicit /sol-read ID must agree with the durable record; do not
		// turn an arbitrary job.json into a response for another UUID.
		if (requestedId && raw.id !== requestedId) return undefined;
		const responsePath = trustedResponsePath(dir, raw.responsePath);
		let responsePreview: string | undefined;
		if (responsePath) {
			try {
				responsePreview = readFileSync(responsePath, "utf8").slice(0, 8000);
			} catch {
				responsePreview = undefined;
			}
		}
		return {
			id: raw.id ?? (requestedId ?? basename(dir).slice("oracle-".length)),
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
		.filter((name) => name.startsWith("oracle-") && isCanonicalSolJobId(name.slice("oracle-".length)))
		.map((name) => join(jobsDir, name))
		.filter((dir) => existsSync(join(dir, "job.json")) && isTrustedJobDir(dir, jobsDir))
		.sort()
		.reverse()
		.slice(0, limit)
		.map((dir) => basename(dir).slice("oracle-".length));
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
export function listActiveSolJobs(jobsDir = getOracleJobsDir(), options?: { provider?: string }): SolJobSummary[] {
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
		.filter((job) => {
			// The default is the ChatGPT view used by /sol admission. An explicit
			// provider view is used by /sol-open so ChatGPT and Grok seeds do not
			// block one another. Unknown provider records block either view.
			if (!options?.provider) return job.provider !== "grok";
			return !job.provider || job.provider === options.provider;
		})
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
