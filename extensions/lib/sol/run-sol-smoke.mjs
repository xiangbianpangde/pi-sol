#!/usr/bin/env node
/**
 * Live /sol smoke: spawn pi-oracle worker with thinking_extended on the isolated ChatGPT seed.
 * Usage: node ~/.pi/agent/extensions/lib/sol/run-sol-smoke.mjs [--timeout-ms 480000]
 *
 * Self-contained: prefers the newest real oracle job as a config/archive template;
 * when no template exists (fresh machine, cleaned /tmp) it builds a minimal job and
 * a tiny tar.zst archive from scratch. Never depends on a hardcoded job id.
 */
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = process.env.HOME;
// Must match the worker's resolution: $PI_ORACLE_JOBS_DIR || "/tmp" (literal).
const JOBS_DIR = process.env.PI_ORACLE_JOBS_DIR?.trim() || "/tmp";
const worker = join(HOME, ".pi/agent/npm/node_modules/pi-oracle/extensions/oracle/worker/run-job.mjs");
const prompt = "Reply with exactly this token and nothing else: SOL_SMOKE_OK";
const timeoutMs = Number(process.argv[process.argv.indexOf("--timeout-ms") + 1]) || 8 * 60 * 1000;
const headed = process.argv.includes("--headed");

if (!existsSync(worker)) throw new Error(`missing worker ${worker}`);

/** Newest real oracle job with a readable config + context archive, if any. */
function findTemplate() {
	let entries;
	try {
		entries = readdirSync(JOBS_DIR);
	} catch {
		return undefined;
	}
	const candidates = [];
	for (const entry of entries) {
		if (!entry.startsWith("oracle-")) continue;
		const dir = join(JOBS_DIR, entry);
		const jobPath = join(dir, "job.json");
		if (!existsSync(jobPath)) continue;
		try {
			const job = JSON.parse(readFileSync(jobPath, "utf8"));
			if (!job.config?.browser?.authSeedProfileDir) continue;
			if (!existsSync(job.archivePath)) continue;
			candidates.push({ job, mtime: statSync(jobPath).mtimeMs });
		} catch {
			// not a parseable job dir; skip
		}
	}
	candidates.sort((a, b) => b.mtime - a.mtime);
	return candidates[0]?.job;
}

function defaultConfig() {
	const executablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	return {
		defaults: { provider: "chatgpt", preset: "thinking_extended", grokMode: "heavy" },
		browser: {
			sessionPrefix: "oracle",
			authSeedProfileDir: join(HOME, ".pi/agent/extensions/oracle-auth-seed-profile"),
			runtimeProfilesDir: join(HOME, ".pi/agent/extensions/oracle-runtime-profiles"),
			maxConcurrentJobs: 2,
			cloneStrategy: "apfs-clone",
			chatUrl: "https://chatgpt.com/",
			authUrl: "https://chatgpt.com/auth/login",
			runMode: "headless",
			executablePath: existsSync(executablePath) ? executablePath : undefined,
			args: ["--disable-blink-features=AutomationControlled"],
		},
		auth: { pollMs: 1000, bootstrapTimeoutMs: 10 * 60 * 1000, chromeProfile: "Profile 1" },
		worker: { pollMs: 5000, completionTimeoutMs: 90 * 60 * 1000 },
		poller: { intervalMs: 5000 },
		artifacts: { capture: true },
		cleanup: { completeJobRetentionMs: 14 * 24 * 60 * 60 * 1000, failedJobRetentionMs: 30 * 24 * 60 * 60 * 1000 },
	};
}

/** Minimal valid archive: one small markdown file, tar | zstd. */
function createArchive(archivePath) {
	const staging = mkdtempSync(join(tmpdir(), "sol-smoke-archive-"));
	writeFileSync(join(staging, "request.md"), `# /sol smoke\n\n${prompt}\n`, "utf8");
	const tarPath = join(staging, "context.tar");
	const tar = spawnSync("tar", ["-cf", tarPath, "-C", staging, "request.md"], { encoding: "utf8" });
	if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr.trim()}`);
	const zstd = spawnSync("zstd", ["-19", "-T0", "-f", tarPath, "-o", archivePath], { encoding: "utf8" });
	if (zstd.error?.code === "ENOENT") throw new Error("zstd not found on PATH; cannot build smoke archive");
	if (zstd.status !== 0) throw new Error(`zstd failed: ${zstd.stderr.trim()}`);
}

const jobId = randomUUID();
const runtimeId = randomUUID();
const jobDir = join(JOBS_DIR, `oracle-${jobId}`);
const archivePath = join(jobDir, `context-${jobId}.tar.zst`);

const template = findTemplate();
const config = template?.config ?? defaultConfig();
if (headed) config.browser = { ...config.browser, runMode: "headed" };
mkdirSync(jobDir, { recursive: true });
if (template) {
	copyFileSync(template.archivePath, archivePath);
	console.log(`template ${template.id} (config + archive reused)`);
} else {
	createArchive(archivePath);
	console.log("template none (minimal config + archive built from scratch)");
}

mkdirSync(join(jobDir, "logs"), { recursive: true });
mkdirSync(join(jobDir, "artifacts"), { recursive: true });
writeFileSync(join(jobDir, "prompt.md"), prompt, "utf8");

const now = new Date().toISOString();
const job = {
	id: jobId,
	status: "submitted",
	phase: "submitted",
	phaseAt: now,
	createdAt: now,
	submittedAt: now,
	cwd: process.cwd(),
	requestSource: "sol-smoke",
	selection: {
		provider: "chatgpt",
		preset: "thinking_extended",
		modelFamily: "thinking",
		effort: "extended",
		autoSwitchToThinking: false,
	},
	responseFormat: "text/plain",
	artifactPaths: [],
	archivePath,
	archiveDeletedAfterUpload: false,
	promptPath: join(jobDir, "prompt.md"),
	responsePath: join(jobDir, "response.md"),
	reasoningPath: join(jobDir, "reasoning.md"),
	artifactsManifestPath: join(jobDir, "artifacts.json"),
	logsDir: join(jobDir, "logs"),
	workerLogPath: join(jobDir, "logs", "worker.log"),
	runtimeId,
	runtimeSessionName: `oracle-${runtimeId}`,
	runtimeProfileDir: join(HOME, ".pi/agent/extensions/oracle-runtime-profiles", runtimeId),
	config,
	lifecycleEvents: [{
		at: now,
		source: "sol-smoke",
		kind: "created",
		message: "Smoke job created for /sol thinking_extended.",
		status: "submitted",
		phase: "submitted",
	}],
	error: undefined,
	completedAt: undefined,
	chatUrl: undefined,
	conversationId: undefined,
	workerPid: undefined,
	workerNonce: randomUUID(),
	heartbeatAt: now,
	cleanupPending: false,
};

writeFileSync(join(jobDir, "job.json"), JSON.stringify(job, null, 2));
console.log(`job ${jobId}`);
console.log(`dir ${jobDir}`);

const child = spawn(process.execPath, [worker, jobId], {
	stdio: "inherit",
	env: process.env,
});

const timeout = setTimeout(() => {
	console.error("smoke timeout; sending SIGTERM");
	child.kill("SIGTERM");
}, timeoutMs);

child.on("exit", (code) => {
	clearTimeout(timeout);
	const latest = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8"));
	console.log(`status ${latest.status}`);
	console.log(`phase ${latest.phase}`);
	if (latest.error) console.log(`error ${latest.error}`);
	if (existsSync(latest.responsePath)) {
		console.log("--- response ---");
		console.log(readFileSync(latest.responsePath, "utf8").slice(0, 2000));
	}
	process.exit(latest.status === "complete" ? 0 : (code || 1));
});
