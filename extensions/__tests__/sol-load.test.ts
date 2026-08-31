/**
 * /sol extension load + dispatch shape.
 * Run: npx --yes tsx --test ~/.pi/agent/extensions/__tests__/sol-load.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Keep record-only /sol trigger diagnostics inert during this load test.
process.env.PI_SOL_TRIGGER_LOG = "off";

import solExtension from "../sol.ts";

type StartHandler = (
	event: { prompt: string; systemPrompt: string },
	ctx: { cwd: string },
) => Promise<{ systemPrompt?: string; message?: { content?: string; display?: boolean; customType?: string } } | undefined>;

type ToolHandler = (event: { toolCallId?: string; toolName: string; input: unknown }) => Promise<{ block?: boolean; reason?: string } | undefined>;

function loadSol() {
	const commands = new Map<string, { description: string; handler: Function }>();
	const handlers = new Map<string, Function>();
	solExtension({
		registerCommand(name: string, spec: { description: string; handler: Function }) {
			commands.set(name, spec);
		},
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		sendMessage() {},
		sendUserMessage() {},
	} as never);
	return { commands, handlers };
}

describe("sol extension registration", () => {
	it("registers /sol family and the ChatGPT guard", () => {
		const { commands, handlers } = loadSol();
		assert.ok(commands.has("sol"));
		assert.ok(commands.has("sol-read"));
		assert.ok(commands.has("sol-auth"));
		assert.ok(commands.has("sol-followup"));
		assert.ok(handlers.has("before_agent_start"));
		assert.ok(handlers.has("session_start"));
		assert.ok(handlers.has("tool_call"));
	});

	it("injects Plus High dispatch for /sol", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "sol-load-"));
		try {
			await writeFile(join(cwd, "note.md"), "hello");
			const { handlers } = loadSol();
			const start = handlers.get("before_agent_start") as StartHandler;
			const result = await start({ prompt: "/sol --files note.md 帮我看看", systemPrompt: "BASE" }, { cwd });
			assert.ok(result?.systemPrompt?.includes("GPT-5.6 Sol"));
			assert.equal(result?.message?.display, false);
			assert.equal(result?.message?.customType, "sol-dispatch-request");
			assert.match(String(result?.message?.content), /thinking_extended/);
			assert.match(String(result?.message?.content), /note\.md/);
			assert.match(String(result?.message?.content), /oracle_auth/);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("restores stripped pi-oracle worker files on /sol before submit", async () => {
		const root = mkdtempSync(join(tmpdir(), "sol-auto-patch-"));
		const worker = join(root, "extensions/oracle/worker");
		mkdirSync(worker, { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-oracle", version: "0.7.20" }));
		writeFileSync(join(worker, "chatgpt-ui-helpers.mjs"), "export {}\n");
		writeFileSync(join(worker, "chatgpt-ui-helpers.d.mts"), "export {}\n");
		writeFileSync(join(worker, "run-job.mjs"), "export {}\n");
		const previous = process.env.PI_ORACLE_ROOT;
		process.env.PI_ORACLE_ROOT = root;
		const cwd = await mkdtemp(join(tmpdir(), "sol-load-"));
		try {
			const { handlers } = loadSol();
			const start = handlers.get("before_agent_start") as StartHandler;
			await start({ prompt: "/sol ping", systemPrompt: "BASE" }, { cwd });
			assert.match(readFileSync(join(worker, "run-job.mjs"), "utf8"), /trySelectPowerSliderHigh/);
			assert.match(readFileSync(join(worker, "chatgpt-ui-helpers.mjs"), "utf8"), /isPowerSliderCompactMenu/);
		} finally {
			if (previous === undefined) delete process.env.PI_ORACLE_ROOT;
			else process.env.PI_ORACLE_ROOT = previous;
			await rm(cwd, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		}
	});

	it("allows a second ChatGPT submission while one Pi session is active; blocks only at the concurrency limit", async () => {
		const jobsDir = await mkdtemp(join(tmpdir(), "sol-active-jobs-"));
		const stateDir = await mkdtemp(join(tmpdir(), "sol-active-state-"));
		const previousJobsDir = process.env.PI_ORACLE_JOBS_DIR;
		const previousStateDir = process.env.PI_SOL_STATE_DIR;
		process.env.PI_ORACLE_JOBS_DIR = jobsDir;
		process.env.PI_SOL_STATE_DIR = stateDir;
		try {
			const activeDir = join(jobsDir, "oracle-active");
			await mkdir(activeDir, { recursive: true });
			await writeFile(
				join(activeDir, "job.json"),
				JSON.stringify({ id: "active", status: "waiting", selection: { provider: "chatgpt" } }),
			);
			const { handlers } = loadSol();
			const toolCall = handlers.get("tool_call") as ToolHandler;
			// One active job is below the default limit (2): admission succeeds.
			const admitted = await toolCall({
				toolCallId: "call-2",
				toolName: "oracle_submit",
				input: { provider: "chatgpt", prompt: "second" },
			});
			assert.notEqual(admitted?.block, true);
			// Second active job reaches the limit: now it must block fail-fast.
			const activeDir2 = join(jobsDir, "oracle-active2");
			await mkdir(activeDir2, { recursive: true });
			await writeFile(
				join(activeDir2, "job.json"),
				JSON.stringify({ id: "active2", status: "waiting", selection: { provider: "chatgpt" } }),
			);
			const blocked = await toolCall({
				toolCallId: "call-3",
				toolName: "oracle_submit",
				input: { provider: "chatgpt", prompt: "third" },
			});
			assert.equal(blocked?.block, true);
			assert.match(String(blocked?.reason), /concurrency limit/i);
		} finally {
			if (previousJobsDir === undefined) delete process.env.PI_ORACLE_JOBS_DIR;
			else process.env.PI_ORACLE_JOBS_DIR = previousJobsDir;
			if (previousStateDir === undefined) delete process.env.PI_SOL_STATE_DIR;
			else process.env.PI_SOL_STATE_DIR = previousStateDir;
			await rm(jobsDir, { recursive: true, force: true });
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	it("blocks agent_browser from opening ChatGPT", async () => {
		const { handlers } = loadSol();
		const toolCall = handlers.get("tool_call") as ToolHandler;
		const blocked = await toolCall({
			toolCallId: "browser-1",
			toolName: "agent_browser",
			input: { args: ["open", "https://chatgpt.com/"] },
		});
		assert.equal(blocked?.block, true);
		assert.match(String(blocked?.reason), /oracle_/);
		const allowed = await toolCall({
			toolName: "agent_browser",
			input: { args: ["open", "https://example.com"] },
		});
		assert.equal(allowed, undefined);
	});
});
