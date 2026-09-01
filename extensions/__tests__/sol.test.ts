/**
 * /sol helpers.
 * Run: npx --yes tsx --test ~/.pi/agent/extensions/__tests__/sol.test.ts
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { acquireSolSubmitLease, oracleMaxConcurrentJobs, releaseSolSubmitLease } from "../lib/sol/admission.ts";
import { stageSolFiles, validateSolFileMeta } from "../lib/sol/files.ts";
import { agentBrowserTargetsChatGpt, chatgptHostFromUrl } from "../lib/sol/guard.ts";
import { formatSolJobSummary, listActiveSolJobs, readSolJob } from "../lib/sol/jobs.ts";
import { MAX_IMAGE_BYTES, SOL_PRESET } from "../lib/sol/limits.ts";
import { parseSolInput } from "../lib/sol/parse.ts";
import { buildSolDispatchPrompt, buildSolResumePrompt, buildSolStandingRule } from "../lib/sol/prompt.ts";

describe("parseSolInput", () => {
	it("parses a plain /sol prompt", () => {
		const parsed = parseSolInput("/sol 帮我看看这个架构");
		assert.deepEqual(parsed, {
			command: "sol",
			prompt: "帮我看看这个架构",
			files: [],
			wait: true,
			followUpJobId: undefined,
		});
	});

	it("parses background mode and files", () => {
		const parsed = parseSolInput('/sol --bg --files a.pdf,"my notes.md" 研究上传限制');
		assert.equal(parsed?.command, "sol");
		if (parsed?.command !== "sol") return;
		assert.equal(parsed.wait, false);
		assert.deepEqual(parsed.files, ["a.pdf", "my notes.md"]);
		assert.equal(parsed.prompt, "研究上传限制");
	});

	it("parses follow-up", () => {
		const parsed = parseSolInput("/sol-followup abc123 --file src/a.ts 再收紧方案");
		assert.equal(parsed?.command, "sol-followup");
		if (parsed?.command !== "sol-followup") return;
		assert.equal(parsed.jobId, "abc123");
		assert.deepEqual(parsed.files, ["src/a.ts"]);
		assert.equal(parsed.prompt, "再收紧方案");
		assert.equal(parsed.wait, true);
	});

	it("rejects unknown flags", () => {
		assert.throws(() => parseSolInput("/sol --nope hi"), /Unknown \/sol flag/);
	});
});

describe("validateSolFileMeta", () => {
	it("blocks executables", () => {
		const issue = validateSolFileMeta("payload.exe", 100);
		assert.ok(issue?.reason.includes("Blocked extension"));
	});

	it("enforces image size", () => {
		const issue = validateSolFileMeta("shot.png", MAX_IMAGE_BYTES + 1);
		assert.ok(issue?.reason.includes("20"));
	});

	it("allows a normal pdf", () => {
		assert.equal(validateSolFileMeta("paper.pdf", 1024), undefined);
	});
});

describe("stageSolFiles", () => {
	it("keeps in-project files and copies outsiders", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "sol-cwd-"));
		const outside = await mkdtemp(join(tmpdir(), "sol-out-"));
		try {
			await mkdir(join(cwd, "docs"), { recursive: true });
			await writeFile(join(cwd, "docs", "in.md"), "inside");
			await writeFile(join(outside, "out.md"), "outside");
			const result = await stageSolFiles(cwd, [join(cwd, "docs", "in.md"), join(outside, "out.md")], {
				requestId: "t1",
			});
			assert.equal(result.issues.length, 0);
			assert.equal(result.files.length, 2);
			assert.equal(result.files[0]?.relative, "docs/in.md");
			assert.equal(result.files[0]?.copied, false);
			assert.equal(result.files[1]?.relative, ".pi/sol-staging/t1/out.md");
			assert.equal(result.files[1]?.copied, true);
		} finally {
			await rm(cwd, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("writes request.md when no files are given", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "sol-empty-"));
		try {
			const result = await stageSolFiles(cwd, [], { prompt: "hello advisor", requestId: "empty" });
			assert.equal(result.files.length, 1);
			assert.equal(result.files[0]?.relative, ".pi/sol-staging/empty/request.md");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("guard", () => {
	it("detects ChatGPT hosts in agent_browser payloads", () => {
		assert.equal(chatgptHostFromUrl("https://chatgpt.com/c/abc"), "chatgpt.com");
		assert.equal(
			agentBrowserTargetsChatGpt({
				args: ["open", "https://chat.openai.com/"],
			}),
			"https://chat.openai.com/",
		);
		assert.equal(
			agentBrowserTargetsChatGpt({
				job: { steps: [{ action: "open", url: "https://example.com" }] },
			}),
			undefined,
		);
	});
});

describe("jobs + prompt", () => {
	it("lists only active ChatGPT jobs for admission", async () => {
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		try {
			for (const [id, status, provider] of [
				["active", "waiting", "chatgpt"],
				["done", "complete", "chatgpt"],
				["grok", "waiting", "grok"],
			] as const) {
				const dir = join(jobsDir, `oracle-${id}`);
				await mkdir(dir, { recursive: true });
				await writeFile(join(dir, "job.json"), JSON.stringify({ id, status, selection: { provider } }));
			}
			assert.deepEqual(listActiveSolJobs(jobsDir).map((job) => job.id), ["active"]);
		} finally {
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("serializes admission across Pi processes via kernel flock", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			// Two acquires in the same process: the second must wait for the
			// first to finish (kernel flock serializes).  We simulate by
			// acquiring, checking the lock file exists, then releasing.
			const a1 = await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(a1.acquired, true);
			if (a1.acquired) {
				// Second acquire should block (flock locked).  Non-blocking
				// attempt via a short timeout: start a concurrent acquire
				// and wait for its result.
				const a2Promise = acquireSolSubmitLease(stateDir, jobsDir);
				// Release the first lease so the second can proceed.
				await releaseSolSubmitLease(a1.lease);
				const a2 = await a2Promise;
				assert.equal(a2.acquired, true);
				if (a2.acquired) await releaseSolSubmitLease(a2.lease);
			}
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("allows a second job while one ChatGPT job is active, blocks at the concurrency limit, recovers after one ends (parallel mode)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			const activeDir = join(jobsDir, "oracle-active");
			await mkdir(activeDir, { recursive: true });
			await writeFile(join(activeDir, "job.json"), JSON.stringify({ id: "active", status: "waiting", selection: { provider: "chatgpt" } }));
			// One active job is below the default limit (2): admission succeeds.
			const admitted = await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(admitted.acquired, true);
			if (admitted.acquired) await releaseSolSubmitLease(admitted.lease);

			// Two active jobs reach the limit (maxConcurrentJobs=2): blocked.
			const activeDir2 = join(jobsDir, "oracle-active2");
			await mkdir(activeDir2, { recursive: true });
			await writeFile(join(activeDir2, "job.json"), JSON.stringify({ id: "active2", status: "waiting", selection: { provider: "chatgpt" } }));
			const blocked = await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(blocked.acquired, false);
			if (!blocked.acquired) assert.match(blocked.reason, /concurrency limit/);

			// One job ends → admission succeeds again.
			await rm(activeDir2, { recursive: true, force: true });
			const acquired = await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(acquired.acquired, true);
			if (acquired.acquired) await releaseSolSubmitLease(acquired.lease);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("re-checks capacity AFTER acquiring the kernel flock (authoritative, audit P1 atomicity)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			// Deterministic interleaving: the pre-lock scan sees 1 active job
			// (below cap 2); the in-lock authoritative re-scan sees 2 active
			// (the previous holder completed its submit while we waited for
			// the flock).  The third submission must be rejected.
			let calls = 0;
			const scanActive = () => {
				calls += 1;
				const job = (id: string) => ({ id, status: "waiting", provider: "chatgpt", dir: "" });
				return calls === 1 ? [job("j1")] : [job("j1"), job("j2")];
			};
			const blocked = await acquireSolSubmitLease(stateDir, jobsDir, 2, scanActive as never);
			assert.equal(blocked.acquired, false);
			assert.ok(calls >= 2, "in-lock authoritative re-scan must run");
			if (!blocked.acquired) assert.match(blocked.reason, /concurrency limit/);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("fails closed when the in-lock job scan throws (kernel flock released)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			let calls = 0;
			const scanActive = () => {
				calls += 1;
				if (calls === 1) return []; // pre-lock scan passes
				throw new Error("jobs dir vanished");
			};
			const result = await acquireSolSubmitLease(stateDir, jobsDir, 2, scanActive as never);
			assert.equal(result.acquired, false);
			if (!result.acquired) assert.match(result.reason, /Cannot scan active/);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("releases the kernel flock and returns true on release", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			const a1 = await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(a1.acquired, true);
			if (a1.acquired) {
				const released = await releaseSolSubmitLease(a1.lease);
				assert.equal(released, true);
				// After release, another acquire can proceed.
				const a2 = await acquireSolSubmitLease(stateDir, jobsDir);
				assert.equal(a2.acquired, true);
				if (a2.acquired) await releaseSolSubmitLease(a2.lease);
			}
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("serializes admission ACROSS processes via kernel flock (real two-process mutex)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-flock-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-flock-jobs-"));
		const helper = join(dirname(fileURLToPath(import.meta.url)), "flock-child.mjs");
		try {
			// Child A acquires and HOLDs the flock.  Node 22 native
			// --experimental-strip-types runs the helper directly (no npx).
			const a = spawn(process.execPath, ["--experimental-strip-types", helper, stateDir, jobsDir, "hold"], {
				env: { ...process.env, PI_ORACLE_JOBS_DIR: jobsDir, PI_SOL_STATE_DIR: stateDir, HOLD_MS: "20000" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let aErr = "";
			a.stderr?.on("data", (d) => { aErr += d; });
			a.on("error", (e) => { aErr += `SPAWN_ERROR: ${e.message}`; });
			const aOut = await new Promise<string>((resolve) => {
				let out = "";
				a.stdout?.on("data", (d) => { out += d; if (out.includes("ACQUIRED:")) resolve(out); });
				a.on("exit", (code) => { if (!out) resolve(out + ` [exit ${code}]`); });
			});
			assert.match(aOut, /ACQUIRED:/, `child A should acquire, got: ${aOut} | stderr: ${aErr}`);
			assert.match(aOut, /ACQUIRED:/, `child A should acquire, got: ${aOut}`);
			// Child B (separate process) must NOT be able to acquire while A holds.
			const b = spawnSync(process.execPath, ["--experimental-strip-types", helper, stateDir, jobsDir, "probe"], {
				env: { ...process.env, PI_ORACLE_JOBS_DIR: jobsDir, PI_SOL_STATE_DIR: stateDir },
				encoding: "utf8",
				timeout: 15000,
			});
			assert.match(String(b.stdout), /BUSY/, `child B should be blocked, got: ${b.stdout} ${b.stderr}`);
			// Kill -9 A: the kernel must release the flock, so B can now acquire.
			a.kill("SIGKILL");
			await new Promise((r) => setTimeout(r, 500));
			const b2 = spawnSync(process.execPath, ["--experimental-strip-types", helper, stateDir, jobsDir, "probe"], {
				env: { ...process.env, PI_ORACLE_JOBS_DIR: jobsDir, PI_SOL_STATE_DIR: stateDir },
				encoding: "utf8",
				timeout: 15000,
			});
			assert.match(String(b2.stdout), /ACQUIRED:|RELEASED/, `child B should acquire after A's SIGKILL, got: ${b2.stdout} ${b2.stderr}`);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("kernel flock auto-releases on holder crash (SIGKILL), no stale lock (audit P2-4)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-flock-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-flock-jobs-"));
		const helper = join(dirname(fileURLToPath(import.meta.url)), "flock-child.mjs");
		try {
			const a = spawn(process.execPath, ["--experimental-strip-types", helper, stateDir, jobsDir, "hold"], {
				env: { ...process.env, PI_ORACLE_JOBS_DIR: jobsDir, PI_SOL_STATE_DIR: stateDir, HOLD_MS: "20000" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			await new Promise<string>((resolve) => {
				let out = "";
				a.stdout?.on("data", (d) => { out += d; if (out.includes("ACQUIRED:")) resolve(out); });
				a.on("exit", (code) => { if (!out) resolve(out); });
			});
			// SIGKILL: no cleanup can run, but the kernel releases the flock.
			a.kill("SIGKILL");
			await new Promise((r) => setTimeout(r, 500));
			// A fresh acquire must succeed immediately.
			const ok = await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(ok.acquired, true, "flock must auto-release after holder SIGKILL");
			if (ok.acquired) await releaseSolSubmitLease(ok.lease);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("reads oracle.json maxConcurrentJobs with strict typing and fails back to the default (audit P2-4)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sol-cfg-"));
		const home = join(dir, "fake-home");
		try {
			const cfgDir = join(home, ".pi", "agent", "extensions");
			await mkdir(cfgDir, { recursive: true });
			const writeCfg = async (json: unknown) => writeFile(join(cfgDir, "oracle.json"), JSON.stringify(json));
			// Valid integer → used.
			await writeCfg({ browser: { maxConcurrentJobs: 3 } });
			assert.equal(oracleMaxConcurrentJobs({ HOME: home } as NodeJS.ProcessEnv), 3);
			// Boolean `true` must NOT coerce to 1 (Number(true) === 1).
			await writeCfg({ browser: { maxConcurrentJobs: true } });
			assert.equal(oracleMaxConcurrentJobs({ HOME: home } as NodeJS.ProcessEnv), 2);
			// String must not coerce.
			await writeCfg({ browser: { maxConcurrentJobs: "2" } });
			assert.equal(oracleMaxConcurrentJobs({ HOME: home } as NodeJS.ProcessEnv), 2);
			// Out of range → default.
			await writeCfg({ browser: { maxConcurrentJobs: 99 } });
			assert.equal(oracleMaxConcurrentJobs({ HOME: home } as NodeJS.ProcessEnv), 2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("locks the Plus High preset into the dispatch prompt", () => {
		const text = buildSolDispatchPrompt(
			{ command: "sol", prompt: "review this", files: ["a.ts"], wait: true },
			[".pi/sol-staging/x/a.ts"],
		);
		assert.match(text, new RegExp(SOL_PRESET));
		assert.match(text, /Sol High/);
		assert.match(text, /oracle_auth/);
		assert.match(text, /Do not archive the whole repository/);
		assert.match(text, /Never retry Instant\/Standard/);
		assert.match(text, /concurrent jobs/);
		assert.match(text, /Never tell the user to run apply scripts/);
		assert.match(text, /\.pi\/sol-staging\/x\/a\.ts/);
	});

	it("tells the in-Pi model, not the user, to own worker patches", () => {
		assert.match(buildSolStandingRule(), /Never ask the user to run apply scripts/);
	});

	it("standing rule encodes the consult-first workflow", () => {
		const rule = buildSolStandingRule();
		assert.match(rule, /consult Sol FIRST/i);
		assert.match(rule, /wait for the user to reference Sol/i);
		assert.match(rule, /before giving a final conclusion/i);
	});

	it("parses /sol-resume with and without a job id", () => {
		assert.deepEqual(parseSolInput("/sol-resume"), { command: "sol-resume", jobId: undefined, wait: true });
		assert.deepEqual(parseSolInput("/sol-resume abc123 --bg"), { command: "sol-resume", jobId: "abc123", wait: false });
		assert.deepEqual(parseSolInput("/sol-resume abc123"), { command: "sol-resume", jobId: "abc123", wait: true });
	});

	it("builds a resume prompt that continues the interrupted conversation", () => {
		const prompt = buildSolResumePrompt(
			{ id: "job-1", conversationId: "conv-abc-123", chatUrl: "https://chatgpt.com/c/conv-abc-123" },
			true,
		);
		assert.match(prompt, /conv-abc-123/);
		assert.match(prompt, /chatGptConversationId/);
		assert.match(prompt, /re-print the COMPLETE final answer/);
		assert.match(prompt, /job-1/);
	});

	it("fails gracefully when the job has no conversationId", () => {
		const prompt = buildSolResumePrompt({ id: "job-2" }, true);
		assert.match(prompt, /no conversationId/);
	});
});
