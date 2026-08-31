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

import { acquireSolSubmitLease, moveReclaimCandidate, releaseSolSubmitLease, releaseTokenGeneration, restoreMovedGeneration } from "../lib/sol/admission.ts";
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
			const r1 = await moveReclaimCandidate(tokenPath, { token: "A" });
			assert.equal(r1.moved, true);
			assert.equal(r1.keep, false); // generation mismatch — must not claim
			// The live generation B must still be in place (restored), and its
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
