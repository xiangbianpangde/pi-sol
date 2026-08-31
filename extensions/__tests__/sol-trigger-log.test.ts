/**
 * /sol trigger-log: default-path resolution, default write, redaction.
 * Run: npx --yes tsx --test ~/.pi/agent/extensions/__tests__/sol-trigger-log.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { classifySolTrigger } from "../lib/sol/trigger-detect.ts";
import {
	defaultSolTriggerLogPath,
	formatSolDiagStats,
	logSolTrigger,
	readSolTriggerLog,
	recordFromClassification,
	redactPreview,
	resolveSolTriggerLogPath,
} from "../lib/sol/trigger-log.ts";

const ORIGINAL_PI_SOL_TRIGGER_LOG = process.env.PI_SOL_TRIGGER_LOG;
after(() => {
	if (ORIGINAL_PI_SOL_TRIGGER_LOG === undefined) delete process.env.PI_SOL_TRIGGER_LOG;
	else process.env.PI_SOL_TRIGGER_LOG = ORIGINAL_PI_SOL_TRIGGER_LOG;
});

describe("resolveSolTriggerLogPath", () => {
	it("unset env falls back to the DEFAULT path (this is what the sampler needs)", () => {
		const path = resolveSolTriggerLogPath({});
		assert.equal(path, defaultSolTriggerLogPath());
		assert.match(path, /sol-trigger\.jsonl$/);
	});

	it('"off" / "0" disable logging', () => {
		assert.equal(resolveSolTriggerLogPath({ PI_SOL_TRIGGER_LOG: "off" }), undefined);
		assert.equal(resolveSolTriggerLogPath({ PI_SOL_TRIGGER_LOG: "0" }), undefined);
	});

	it("custom env path wins", () => {
		assert.equal(resolveSolTriggerLogPath({ PI_SOL_TRIGGER_LOG: "/tmp/custom-sol-trigger.jsonl" }), "/tmp/custom-sol-trigger.jsonl");
	});
});

describe("logSolTrigger default-path write (isolated HOME)", () => {
	it("writes to the default path when the env var is NOT set", async () => {
		const home = await mkdtemp(join(tmpdir(), "sol-home-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		delete process.env.PI_SOL_TRIGGER_LOG;
		try {
			const classification = classifySolTrigger("让 Sol 复核一下这个方案");
			await logSolTrigger(recordFromClassification(classification, { session: "test", phase: "agent_start" }), {});
			const expected = join(home, ".pi/agent/logs/sol-trigger.jsonl");
			const raw = await readFile(expected, "utf8");
			const records = await readSolTriggerLog(expected);
			assert.equal(records.length, 1);
			assert.equal(records[0]!.source, "semantic");
			assert.equal(records[0]!.candidate, true);
			assert.equal(records[0]!.schema_version, 1);
			assert.match(records[0]!.ruleset_version, /^detect-v\d+$/);
			assert.match(raw, /"session":"test"/);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			await rm(home, { recursive: true, force: true });
		}
	});

	it('"off" writes nothing', async () => {
		const home = await mkdtemp(join(tmpdir(), "sol-home-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		process.env.PI_SOL_TRIGGER_LOG = "off";
		try {
			await logSolTrigger({ id: "x", source: "slash", phase: "command", command: "sol", candidate: true, near: false, needs_confirmation: false, matches: [], suppressed: [], confidence: 0, score: 0, char_count: 0, preview: "x", session: "test", ruleset_version: "detect-v2" }, { PI_SOL_TRIGGER_LOG: "off" });
			await assert.rejects(readFile(join(home, ".pi/agent/logs/sol-trigger.jsonl"), "utf8"));
		} finally {
			delete process.env.PI_SOL_TRIGGER_LOG;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("redactPreview", () => {
	it("masks private keys, AWS keys, JWTs, emails, secrets and long tokens", () => {
		const dirty = [
			"-----BEGIN PRIVATE KEY-----\nabcdef\n-----END PRIVATE KEY-----",
			["AK", "IAIOSFODNN7EXAMPLE"].join(""),
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnopqrstuvwxyz0123456789",
			"联系 me@example.com 或 bob@corp.co",
			["s", "k-abcdef1234567890abcdef12"].join(""),
			"deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb",
			"password=hunter2 secret=xyz token=abcd",
		].join(" ");
		const out = redactPreview(dirty);
		assert.ok(!out.includes("hunter2"));
		assert.ok(!out.includes("me@example.com"));
		assert.ok(!out.includes("AKIAIOSFODNN7"));
		assert.ok(!out.includes("PRIVATE KEY-----\nabcdef"));
		assert.ok(out.includes("[EMAIL]") || out.includes("[REDACTED]"));
		assert.ok(out.includes("[AWS_KEY]"));
		assert.match(out, /\[JWT\]/);
	});

	it("recordFromClassification redacts the preview before logging", () => {
		const classification = classifySolTrigger("联系 me@example.com，让 Sol 复核这个方案");
		const record = recordFromClassification(classification, { session: "s", phase: "agent_start" });
		assert.ok(!record.preview.includes("me@example.com"));
		assert.ok(record.preview.includes("[EMAIL]"));
	});

	it("redacts BEFORE truncating: secret starting near char 155 is fully masked", () => {
		const classification = classifySolTrigger("让 Sol 复核。" + "甲".repeat(150) + " token=" + ["s", "k-abcdef1234567890abcdef12"].join(""));
		const record = recordFromClassification(classification, { session: "s", phase: "agent_start" });
		assert.ok(!record.preview.includes("sk-"));
		assert.ok(!record.preview.includes("abcdef"));
		assert.ok(record.preview.length <= 160);
	});

	it("masks sk-proj / github_pat / Authorization Bearer / quoted multi-word secrets", () => {
		const dirty = [
			["sk", "-proj-AbCdEfGh1234567890AbCdEfGh12345678"].join(""),
			["github", "_pat_ABC1234567890abcdef_12"].join(""),
			"Authorization: Bearer eyJhbGc.xxx.zzz",
			"password=\"two words secret\"",
		].join(" ");
		const out = redactPreview(dirty);
		assert.ok(!out.includes("sk-proj-"));
		assert.ok(!out.includes("github_pat_"));
		assert.ok(!out.includes("Bearer eyJ"));
		assert.ok(!out.includes("two words secret"));
		assert.ok(out.includes("[SECRET_KEY]") || out.includes("[GITHUB_PAT]"));
	});

	it("log dir and file are private-by-default (0700/0600)", async () => {
		const home = await mkdtemp(join(tmpdir(), "sol-home-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		delete process.env.PI_SOL_TRIGGER_LOG;
		try {
			const classification = classifySolTrigger("让 Sol 复核一下这个方案");
			await logSolTrigger(recordFromClassification(classification, { session: "s", phase: "agent_start" }), {});
			const dirMode = statSync(join(home, ".pi/agent/logs")).mode & 0o777;
			const fileMode = statSync(join(home, ".pi/agent/logs/sol-trigger.jsonl")).mode & 0o777;
			assert.equal(dirMode, 0o700);
			assert.equal(fileMode, 0o600);
		} finally {
			delete process.env.PI_SOL_TRIGGER_LOG;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			await rm(home, { recursive: true, force: true });
		}
	});

	it("tightens EXISTING 0755 dir / 0644 file to 0700/0600 (upgrade path)", async () => {
		const home = await mkdtemp(join(tmpdir(), "sol-home-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		delete process.env.PI_SOL_TRIGGER_LOG;
		try {
			const dir = join(home, ".pi/agent/logs");
			mkdirSync(dir, { recursive: true, mode: 0o755 });
			const file = join(dir, "sol-trigger.jsonl");
			writeFileSync(file, "", { mode: 0o644 });
			const classification = classifySolTrigger("让 Sol 复核一下这个方案");
			await logSolTrigger(recordFromClassification(classification, { session: "s", phase: "agent_start" }), {});
			assert.equal(statSync(dir).mode & 0o777, 0o700);
			assert.equal(statSync(file).mode & 0o777, 0o600);
		} finally {
			delete process.env.PI_SOL_TRIGGER_LOG;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			await rm(home, { recursive: true, force: true });
		}
	});

	it("diag stats isolate the current ruleset and warn about other rulesets", async () => {
		const home = await mkdtemp(join(tmpdir(), "sol-home-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		delete process.env.PI_SOL_TRIGGER_LOG;
		try {
			const c = classifySolTrigger("让 Sol 复核一下这个方案");
			await logSolTrigger(recordFromClassification(c, { session: "s", phase: "agent_start" }), {});
			const expected = join(home, ".pi/agent/logs/sol-trigger.jsonl");
			await appendFile(expected, JSON.stringify({ ts: "2026-08-30T00:00:00.000Z", seq: 0, session: "old", id: "old", source: "semantic", phase: "agent_start", candidate: true, near: false, needs_confirmation: false, matches: [], suppressed: [], confidence: 0, score: 0, char_count: 0, preview: "old row", schema_version: 1, ruleset_version: "detect-v1" }) + "\n");
			const records = await readSolTriggerLog(expected);
			const stats = formatSolDiagStats(records, expected, false, c.ruleset);
			assert.match(stats, /rows=1/);
			assert.match(stats, /other-ruleset rows=1/);
		} finally {
			delete process.env.PI_SOL_TRIGGER_LOG;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			await rm(home, { recursive: true, force: true });
		}
	});

	it("self-heals when the logs dir is deleted between writes", async () => {
		const home = await mkdtemp(join(tmpdir(), "sol-home-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		delete process.env.PI_SOL_TRIGGER_LOG;
		try {
			const c = classifySolTrigger("让 Sol 复核一下这个方案");
			await logSolTrigger(recordFromClassification(c, { session: "s", phase: "agent_start" }), {});
			const expected = join(home, ".pi/agent/logs/sol-trigger.jsonl");
			await rm(join(home, ".pi/agent"), { recursive: true, force: true });
			await logSolTrigger(recordFromClassification(c, { session: "s", phase: "agent_start" }), {});
			const records = await readSolTriggerLog(expected);
			assert.equal(records.length, 1);
		} finally {
			delete process.env.PI_SOL_TRIGGER_LOG;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			await rm(home, { recursive: true, force: true });
		}
	});

	it("leaves ordinary prose intact", () => {
		const out = redactPreview("让 Sol 复核一下这个设计方案");
		assert.equal(out, "让 Sol 复核一下这个设计方案");
	});
});
