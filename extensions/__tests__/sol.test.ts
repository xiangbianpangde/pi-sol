/**
 * /sol helpers.
 * Run: npx --yes tsx --test ~/.pi/agent/extensions/__tests__/sol.test.ts
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { acquireSolSubmitLease, moveReclaimCandidate, oracleMaxConcurrentJobs, releaseSolSubmitLease, releaseTokenGeneration, restoreMovedGeneration } from "../lib/sol/admission.ts";
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

	it("reclaims a stale lock whose owner PID is dead and TTL elapsed", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			const lock = join(stateDir, "pi-sol-submit.lock");
			await mkdir(lock, { recursive: true });
			await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "dead-token", pid: 999999, createdAt: new Date().toISOString() }));
			// Backdate the lock dir mtime beyond the 15-minute TTL.
			const old = new Date(Date.now() - 16 * 60 * 1000);
			await utimes(lock, old, old);
			const acquired = await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(acquired.acquired, true);
			if (acquired.acquired) await releaseSolSubmitLease(acquired.lease);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("never reclaims a lock whose owner PID is still alive even past TTL", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			const lock = join(stateDir, "pi-sol-submit.lock");
			await mkdir(lock, { recursive: true });
			await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "live-token", pid: process.pid, createdAt: new Date().toISOString() }));
			const old = new Date(Date.now() - 16 * 60 * 1000);
			await utimes(lock, old, old);
			const blocked = await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(blocked.acquired, false);
			// The live owner's lock must survive untouched.
			const owner = JSON.parse(await (await import("node:fs/promises")).readFile(join(lock, "owner.json"), "utf8"));
			assert.equal(owner.token, "live-token");
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("does not release a newer generation when given an old token", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			const lock = join(stateDir, "pi-sol-submit.lock");
			await mkdir(lock, { recursive: true });
			await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "gen-b", pid: process.pid, createdAt: new Date().toISOString() }));
			// A stale release carrying an old token must NOT remove the live generation B.
			await releaseSolSubmitLease({ path: lock, token: "gen-a" });
			const owner = JSON.parse(await (await import("node:fs/promises")).readFile(join(lock, "owner.json"), "utf8"));
			assert.equal(owner.token, "gen-b");
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("concurrent releases of the same lease are generation-safe", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			const lock = join(stateDir, "pi-sol-submit.lock");
			await mkdir(lock, { recursive: true });
			await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "gen-b", pid: process.pid, createdAt: new Date().toISOString() }));
			const lease = { path: lock, token: "gen-b" };
			await Promise.all([releaseSolSubmitLease(lease), releaseSolSubmitLease(lease)]);
			// After both releases, a fresh acquire must succeed (no residue).
			const acquired = await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(acquired.acquired, true);
			if (acquired.acquired) await releaseSolSubmitLease(acquired.lease);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("a stale reclaim cannot delete a live generation that appeared after staleness check", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			// Simulate the audit race: R1 and R2 both observe stale A, R2 reclaims A
			// and creates live B. R1 must NOT be able to rename+delete B.
			// Under the new protocol the reclaim token serializes mutations, so a
			// second acquire sees live B and returns busy.
			const lock = join(stateDir, "pi-sol-submit.lock");
			await mkdir(lock, { recursive: true });
			await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "dead-a", pid: 999999, createdAt: new Date().toISOString() }));
			const old = new Date(Date.now() - 16 * 60 * 1000);
			await utimes(lock, old, old);
			// R2 wins the first acquire: reclaims A, creates live B.
			const r2 = await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(r2.acquired, true);
			// Now live B exists. R1 (another acquire) must be blocked and B must survive.
			const r1 = await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(r1.acquired, false);
			if (r2.acquired) await releaseSolSubmitLease(r2.lease);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("release is serialized with stale reclaim (no double-holder window)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			const lock = join(stateDir, "pi-sol-submit.lock");
			await mkdir(lock, { recursive: true });
			await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "gen-b", pid: process.pid, createdAt: new Date().toISOString() }));
			// Simulate the audit race: a stale reclaimer has already moved B and
			// created live C while a late release(B) runs. Release must NOT
			// remove C (token mismatch check), and C must survive.
			const lease = { path: lock, token: "gen-b" };
			await Promise.all([
				releaseSolSubmitLease(lease),
				(async () => {
					// Reclaimer wins the token, moves the path, then recreates C.
					await rm(lock, { recursive: true, force: true });
					await mkdir(lock, { recursive: true });
					await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "gen-c", pid: process.pid, createdAt: new Date().toISOString() }));
				})(),
			]);
			const owner = JSON.parse(await (await import("node:fs/promises")).readFile(join(lock, "owner.json"), "utf8"));
			assert.equal(owner.token, "gen-c");
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("release does NOT remove the lock when it cannot acquire the reclaim token (P1-1)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			const lock = join(stateDir, "pi-sol-submit.lock");
			await mkdir(lock, { recursive: true });
			await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "gen-a", pid: process.pid, createdAt: new Date().toISOString() }));
			// Hold the reclaim token with a LIVE owner so release can never get it.
			const token = join(stateDir, "pi-sol-submit.reclaim-token");
			await mkdir(token, { recursive: true });
			await writeFile(join(token, "owner.json"), JSON.stringify({ token: "tok", pid: process.pid, createdAt: new Date().toISOString() }));
			// release must NOT bare-rm the fixed path while another process holds
			// the token (that was the P1-1 generation race). It retries then gives up.
			await releaseSolSubmitLease({ path: lock, token: "gen-a" });
			const owner = JSON.parse(await (await import("node:fs/promises")).readFile(join(lock, "owner.json"), "utf8"));
			assert.equal(owner.token, "gen-a"); // lock still intact
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("reclaims a reclaim-token whose owner is provably dead (atomic-publish crash case)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			// A crashed holder leaves a FULLY-INITIALIZED token (owner.json
			// present — atomic publish has no ownerless intermediate state).
			// Dead owner PID → reclaimable.
			const token = join(stateDir, "pi-sol-submit.reclaim-token");
			await mkdir(token, { recursive: true });
			await writeFile(join(token, "owner.json"), JSON.stringify({ token: "dead-token", pid: 999999, createdAt: new Date().toISOString() }));
			// Also place a stale submit lock so acquire goes through the
			// reclaim path (and therefore exercises acquireReclaimToken).
			const lock = join(stateDir, "pi-sol-submit.lock");
			await mkdir(lock, { recursive: true });
			await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "dead-lock", pid: 999999, createdAt: new Date().toISOString() }));
			const old = new Date(Date.now() - 16 * 60 * 1000);
			await utimes(lock, old, old);
			const acquired = await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(acquired.acquired, true);
			if (acquired.acquired) await releaseSolSubmitLease(acquired.lease);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("binds reclaim to the observed generation: a stale proof cannot delete a newer live token (audit round 6 P1-2)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		try {
			// R1 and R2 both read dead token A; R2 renames A away and publishes
			// live token B. R1's stale proof for A must NOT be able to delete B.
			const tokenPath = join(stateDir, "pi-sol-submit.reclaim-token");
			await mkdir(tokenPath, { recursive: true });
			await writeFile(join(tokenPath, "owner.json"), JSON.stringify({ token: "A", pid: 999999, createdAt: new Date().toISOString() }));
			// R1 already read A (observed=dead A). R2 now moves it away and
			// publishes live B.
			const r2 = await moveReclaimCandidate(tokenPath, { token: "A" });
			assert.equal(r2.moved, true);
			assert.equal(r2.keep, true); // matched the observed dead generation
			await mkdir(tokenPath, { recursive: true });
			await writeFile(join(tokenPath, "owner.json"), JSON.stringify({ token: "B", pid: process.pid, createdAt: new Date().toISOString() }));
			// R1 resumes with its stale proof for A; the fixed path now holds B.
			// Pre-rename verification (audit round P1) re-reads the current owner
			// and sees B (live) — it aborts WITHOUT moving anything, so B is
			// never displaced at all.
			const r1 = await moveReclaimCandidate(tokenPath, { token: "A" });
			assert.equal(r1.moved, false, "stale proof must not even move a newer live generation");
			assert.equal(r1.keep, false); // must not claim
			// The live generation B must still be in place, and its
			// owner file intact.
			const after = JSON.parse(await (await import("node:fs/promises")).readFile(join(tokenPath, "owner.json"), "utf8"));
			assert.equal(after.token, "B");
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	it("releases only its own generation: an old holder cannot delete a newer live token (audit round 6 P1-2)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		try {
			const tokenPath = join(stateDir, "pi-sol-submit.reclaim-token");
			await mkdir(tokenPath, { recursive: true });
			// Old holder's release closure runs while a NEWER live token B
			// occupies the path.
			await writeFile(join(tokenPath, "owner.json"), JSON.stringify({ token: "B", pid: process.pid, createdAt: new Date().toISOString() }));
			await releaseTokenGeneration(tokenPath, { token: "old", pid: process.pid, createdAt: new Date().toISOString() });
			const after = JSON.parse(await (await import("node:fs/promises")).readFile(join(tokenPath, "owner.json"), "utf8"));
			assert.equal(after.token, "B", "newer live token must survive an old holder's release");
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	it("keeps a live token in trash when the restore is pre-empted, never deletes it (audit round 7)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		try {
			const tokenPath = join(stateDir, "pi-sol-submit.reclaim-token");
			// Simulate: R1 (stale proof for A) moved live B into trash; before
			// R1 can restore, third party C re-occupies the fixed path.
			const trashPath = join(stateDir, "pi-sol-submit.reclaim-token.trash.pid.1");
			await mkdir(trashPath, { recursive: true });
			await writeFile(join(trashPath, "owner.json"), JSON.stringify({ token: "B", pid: process.pid, createdAt: new Date().toISOString() }));
			await mkdir(tokenPath, { recursive: true });
			await writeFile(join(tokenPath, "owner.json"), JSON.stringify({ token: "C", pid: process.pid, createdAt: new Date().toISOString() }));
			// restore fails (path occupied) → the moved live dir (B) must NOT
			// be deleted; it stays as trash so a later sweep can reap it.
			const restored = await restoreMovedGeneration(tokenPath, trashPath);
			assert.equal(restored, false);
			const movedOwner = JSON.parse(await (await import("node:fs/promises")).readFile(join(trashPath, "owner.json"), "utf8"));
			assert.equal(movedOwner.token, "B", "live token B must survive in trash, not be destroyed");
			// And the path still belongs to C (not clobbered by the restore).
			const pathOwner = JSON.parse(await (await import("node:fs/promises")).readFile(join(tokenPath, "owner.json"), "utf8"));
			assert.equal(pathOwner.token, "C");
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	it("sweeps stale trash dirs including displaced live-holder dirs (audit round 7)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			// A trash dir left by a failed restore must be reaped by
			// sweepStaleStaging when it goes stale (invoked via acquire).
			const trashPath = join(stateDir, "pi-sol-submit.reclaim-token.trash.pid.1");
			await mkdir(trashPath, { recursive: true });
			await writeFile(join(trashPath, "owner.json"), JSON.stringify({ token: "B", pid: process.pid, createdAt: new Date().toISOString() }));
			const old = new Date(Date.now() - 120 * 1000);
			await utimes(trashPath, old, old);
			// acquire triggers sweepStaleStaging.
			const acquired = await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(acquired.acquired, true);
			const { readdir } = await import("node:fs/promises");
			const after = await readdir(stateDir);
			assert.ok(!after.some((n) => n.includes(".trash.")), `stale trash not swept: ${after.join(", ")}`);
			if (acquired.acquired) await releaseSolSubmitLease(acquired.lease);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("never leaves an ownerless reclaim-token visible (atomic publish invariant)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			// The token path must NEVER exist without owner.json: atomic publish
			// renames a fully-initialized staging dir onto the fixed path, so an
			// ownerless token cannot be created by the protocol itself.
			const acquired = await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(acquired.acquired, true);
			if (acquired.acquired) {
				const token = join(stateDir, "pi-sol-submit.reclaim-token");
				if (existsSync(token)) {
					assert.ok(existsSync(join(token, "owner.json")), "token must carry owner.json when it exists");
				}
				await releaseSolSubmitLease(acquired.lease);
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

	it("re-checks capacity AFTER acquiring the coordination lock and cleans its own lock (audit P1 atomicity)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			// Deterministic interleaving: the pre-lock scan sees 1 active job
			// (below cap 2); between the pre-lock scan and the in-lock
			// authoritative re-scan, the previous holder completes its submit
			// and a SECOND job becomes durable (J1+J2 = 2 active).  The
			// in-lock re-scan must reject the third submission and must not
			// leave the freshly-published coordination lock behind.
			let calls = 0;
			const scanActive = () => {
				calls += 1;
				const job = (id: string) => ({ id, status: "waiting", provider: "chatgpt", dir: "" });
				return calls === 1 ? [job("j1")] : [job("j1"), job("j2")];
			};
			const blocked = await acquireSolSubmitLease(stateDir, jobsDir, 2, scanActive as never);
			assert.equal(blocked.acquired, false);
			assert.ok(calls >= 2, `in-lock authoritative re-scan must run, got ${calls} scan(s)`);
			if (!blocked.acquired) assert.match(blocked.reason, /concurrency limit/);
			const lock = join(stateDir, "pi-sol-submit.lock");
			assert.equal(existsSync(lock), false, "coordination lock must not linger after an in-lock capacity rejection");
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("fails closed and cleans its own lock when the in-lock job scan throws (audit P2-C2-1)", async () => {
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
			const lock = join(stateDir, "pi-sol-submit.lock");
			assert.equal(existsSync(lock), false, "no live-PID lock may linger after an in-lock scan failure");
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("preserves lease ownership via pendingLease when post-publish cleanup fails (audit round P2)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			// scanActive throws AFTER the fresh lock is published; before
			// throwing it removes write permission on the state dir so the
			// cleanup rm() fails → the lease must come back as pendingLease
			// (ownership preserved for retry), never silently dropped.
			const { chmodSync } = await import("node:fs");
			let calls = 0;
			const scanActive = () => {
				calls += 1;
				if (calls === 1) return []; // pre-lock fast scan passes
				// In-lock authoritative scan: throw AFTER removing write
				// permission so the cleanup rm() fails.
				chmodSync(stateDir, 0o500); // lock dir now unwritable
				throw new Error("jobs dir vanished");
			};
			const result = await acquireSolSubmitLease(stateDir, jobsDir, 2, scanActive as never);
			assert.equal(result.acquired, false);
			if (!result.acquired) {
				assert.match(result.reason, /Cannot scan active/);
				assert.ok(result.pendingLease, "cleanup failure must return pendingLease, not drop ownership");
				assert.equal(result.pendingLease?.path, join(stateDir, "pi-sol-submit.lock"));
			}
			// Restore permissions so the finally cleanup can remove the dir.
			const { chmod } = await import("node:fs/promises");
			await chmod(stateDir, 0o700);
			const lock = join(stateDir, "pi-sol-submit.lock");
			assert.equal(existsSync(lock), true, "lock should still exist (rm failed) so pendingLease has something to clean");
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("removes a matching lock via atomic rename-to-trash and leaves no fixed-path remnant (audit round P2)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			// Release removes a matching-token lock through atomic
			// rename-to-trash (not non-atomic rm), so the fixed path never
			// carries a partial-rm ownerless remnant that readOwner would
			// misjudge as "not ours".
			const lock = join(stateDir, "pi-sol-submit.lock");
			await mkdir(lock, { recursive: true });
			await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "ours", pid: process.pid, createdAt: new Date().toISOString() }));
			const released = await releaseSolSubmitLease({ path: lock, token: "ours" });
			assert.equal(released, true);
			assert.equal(existsSync(lock), false, "matching lock must be gone after release");
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("does NOT sweep other modules' .trash. dirs in the shared state dir (audit round P2)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			// A non-pi-sol component placed a .trash. dir in the shared state
			// dir. sweepStaleStaging must NOT remove it (only pi-sol's own
			// prefixes are swept).
			const foreign = join(stateDir, "another-component.trash.backup");
			await mkdir(foreign, { recursive: true });
			await writeFile(join(foreign, "important.txt"), "keep me");
			const old = new Date(Date.now() - 120 * 1000);
			await utimes(foreign, old, old);
			await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(existsSync(join(foreign, "important.txt")), true, "foreign .trash. dir must not be swept");
		} finally {
			await rm(stateDir, { recursive: true, force: true });
			await rm(jobsDir, { recursive: true, force: true });
		}
	});

	it("still sweeps pi-sol's own trash dirs in the shared state dir (audit round P2)", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "sol-admission-"));
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-jobs-"));
		try {
			const own = join(stateDir, "pi-sol-submit.lock.trash.1234.uuid");
			await mkdir(own, { recursive: true });
			const old = new Date(Date.now() - 120 * 1000);
			await utimes(own, old, old);
			await acquireSolSubmitLease(stateDir, jobsDir);
			assert.equal(existsSync(own), false, "pi-sol's own stale trash must be swept");
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
});
