/**
 * /sol helpers.
 * Run: npx --yes tsx --test ~/.pi/agent/extensions/__tests__/sol.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { acquireSolSubmitLease, releaseSolSubmitLease } from "../lib/sol/admission.ts";
import { stageSolFiles, validateSolFileMeta } from "../lib/sol/files.ts";
import { agentBrowserTargetsChatGpt, chatgptHostFromUrl } from "../lib/sol/guard.ts";
import { formatSolJobSummary, listActiveSolJobs, readSolJob } from "../lib/sol/jobs.ts";
import { MAX_IMAGE_BYTES, SOL_PRESET } from "../lib/sol/limits.ts";
import { parseSolInput } from "../lib/sol/parse.ts";
import { buildSolDispatchPrompt, buildSolStandingRule } from "../lib/sol/prompt.ts";

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

	it("allows only one simultaneous admission across Pi processes", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			const results = await Promise.all([acquireSolSubmitLease(stateDir, jobsDir), acquireSolSubmitLease(stateDir, jobsDir)]);
			assert.equal(results.filter((result) => result.acquired).length, 1);
			for (const result of results) {
				if (result.acquired) await releaseSolSubmitLease(result.lease);
			}
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("blocks admission while another ChatGPT job is active and recovers after it ends", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			const activeDir = join(jobsDir, "oracle-active");
			await mkdir(activeDir, { recursive: true });
			await writeFile(join(activeDir, "job.json"), JSON.stringify({ id: "active", status: "waiting", selection: { provider: "chatgpt" } }));
			const blocked = await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(blocked.acquired, false);
			if (!blocked.acquired) assert.match(blocked.reason, /active/);

			await rm(activeDir, { recursive: true, force: true });
			const acquired = await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(acquired.acquired, true);
			if (acquired.acquired) await releaseSolSubmitLease(acquired.lease);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("reads a fake oracle job", async () => {
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			const dir = join(jobsDir, "oracle-abc");
			const response = join(jobsDir, "response.md");
			await mkdir(dir, { recursive: true });
			await writeFile(response, "advisor says hi");
			await writeFile(
				join(dir, "job.json"),
				JSON.stringify({ id: "abc", status: "completed", responsePath: response }),
			);
			const job = readSolJob("abc", jobsDir);
			assert.equal(job?.status, "completed");
			assert.match(formatSolJobSummary(job!), /advisor says hi/);
		} finally {
			await rm(jobsDir, { recursive: true, force: true });
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
		assert.match(text, /submissions are serialized across local Pi sessions/);
		assert.match(text, /Never tell the user to run apply scripts/);
		assert.match(text, /\.pi\/sol-staging\/x\/a\.ts/);
	});

	it("tells the in-Pi model, not the user, to own worker patches", () => {
		assert.match(buildSolStandingRule(), /Never ask the user to run apply scripts/);
	});
});
