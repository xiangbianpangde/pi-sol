/**
 * /sol — thin ChatGPT web GPT-5.6 Sol High (Plus max) wrapper over pi-oracle.
 *
 * User-facing:
 *   /sol [--bg] [--follow <job-id>] [--files a,b] <prompt>
 *   /sol-followup <job-id> [--bg] [--files a,b] <prompt>
 *   /sol-read [job-id]
 *   /sol-auth
 *
 * Browser work stays inside pi-oracle's isolated worker. This extension
 * only relays, validates files, auto-auths, and blocks agent_browser
 * from opening ChatGPT.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { stageSolFiles } from "./lib/sol/files.ts";
import { agentBrowserTargetsChatGpt } from "./lib/sol/guard.ts";
import { formatSolJobSummary, listRecentSolJobIds, readSolJob } from "./lib/sol/jobs.ts";
import { SOL_PRESET_LABEL } from "./lib/sol/limits.ts";
import {
	formatSolUserCommand,
	parseSolArgs,
	parseSolInput,
	type ParsedSolInput,
} from "./lib/sol/parse.ts";
import { ensureSolOraclePatches, formatSolPatchNote } from "./lib/sol/patches.ts";
import { buildSolAuthPrompt, buildSolDispatchPrompt, buildSolStandingRule, SOL_SKILL_NAME } from "./lib/sol/prompt.ts";

const SOL_USAGE = "Usage: /sol [--bg] [--follow <job-id>] [--files a,b] <prompt>";

function emit(pi: ExtensionAPI, ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.mode === "print") {
		process.stdout.write(`${message}\n`);
		return;
	}
	if (ctx.hasUI && message.length < 1200) {
		ctx.ui.notify(message, level);
		return;
	}
	pi.sendMessage({
		customType: "sol-command-output",
		content: message,
		display: true,
		details: { level },
	});
}

async function stageAndDispatch(cwd: string, input: Extract<ParsedSolInput, { command: "sol" } | { command: "sol-followup" }>) {
	const staged = await stageSolFiles(cwd, input.files, { prompt: input.prompt });
	const issueText = staged.issues.map((issue) => `${issue.path}: ${issue.reason}`).join("\n");
	const files = staged.files.map((file) => file.relative);
	const content = [
		issueText ? `File staging issues (stop if any are fatal):\n${issueText}\n` : "",
		buildSolDispatchPrompt(input, files),
	]
		.filter(Boolean)
		.join("\n");
	return {
		message: {
			customType: "sol-dispatch-request",
			content,
			display: false,
			details: {
				command: input.command,
				wait: input.wait,
				files,
				issues: staged.issues,
			},
		},
	};
}

function applyWorkerPatches(systemPrompt: string): string {
	const note = formatSolPatchNote(ensureSolOraclePatches());
	return note ? `${systemPrompt}${note}` : systemPrompt;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		ensureSolOraclePatches();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const standing = `\n\n---\n${buildSolStandingRule()}\nSkill: /skill:${SOL_SKILL_NAME}\n---`;
		let parsed: ParsedSolInput | undefined;
		try {
			parsed = parseSolInput(event.prompt ?? "");
		} catch {
			return { systemPrompt: applyWorkerPatches(`${event.systemPrompt}${standing}`) };
		}
		if (parsed?.command === "sol-auth") {
			return {
				systemPrompt: applyWorkerPatches(`${event.systemPrompt}${standing}`),
				message: {
					customType: "sol-auth-request",
					content: buildSolAuthPrompt(),
					display: false,
				},
			};
		}
		if (parsed?.command === "sol" || parsed?.command === "sol-followup") {
			const dispatch = await stageAndDispatch(ctx.cwd, parsed);
			return {
				systemPrompt: applyWorkerPatches(`${event.systemPrompt}${standing}`),
				...dispatch,
			};
		}
		return { systemPrompt: applyWorkerPatches(`${event.systemPrompt}${standing}`) };
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "agent_browser") return;
		const url = agentBrowserTargetsChatGpt(event.input);
		if (!url) return;
		return {
			block: true,
			reason: `Do not open ChatGPT in agent_browser (${url}). Use /sol or oracle_* so the isolated oracle worker owns that session.`,
		};
	});

	pi.registerCommand("sol", {
		description: `Ask web ${SOL_PRESET_LABEL} via pi-oracle. Default waits; --bg returns a job id`,
		handler: async (args, ctx) => {
			try {
				const input = parseSolArgs(args, "sol");
				emit(pi, ctx, input.wait ? `Consulting ${SOL_PRESET_LABEL}…` : "Dispatching background /sol job…");
				await pi.sendUserMessage(formatSolUserCommand(input));
			} catch (error) {
				emit(pi, ctx, error instanceof Error ? error.message : SOL_USAGE, "warning");
			}
		},
	});

	pi.registerCommand("sol-followup", {
		description: "Continue an earlier /sol ChatGPT thread",
		handler: async (args, ctx) => {
			try {
				const input = parseSolArgs(args, "sol-followup");
				emit(pi, ctx, input.wait ? `Continuing ${SOL_PRESET_LABEL}…` : "Dispatching background /sol follow-up…");
				await pi.sendUserMessage(formatSolUserCommand(input));
			} catch (error) {
				emit(pi, ctx, error instanceof Error ? error.message : "Usage: /sol-followup <job-id> [--bg] [--files a,b] <prompt>", "warning");
			}
		},
	});

	pi.registerCommand("sol-read", {
		description: "Read a /sol or oracle job result",
		handler: async (args, ctx) => {
			const explicit = args.trim();
			const jobId = explicit || listRecentSolJobIds()[0];
			if (!jobId) {
				emit(pi, ctx, "No /sol jobs found. Run /sol first.", "info");
				return;
			}
			const job = readSolJob(jobId);
			if (!job) {
				emit(pi, ctx, `Job ${jobId} not found. Recent: ${listRecentSolJobIds().join(", ") || "(none)"}`, "warning");
				return;
			}
			emit(pi, ctx, formatSolJobSummary(job));
		},
	});

	pi.registerCommand("sol-auth", {
		description: "Sync ChatGPT cookies from local Chrome into the isolated oracle seed",
		handler: async (_args, ctx) => {
			emit(pi, ctx, "Syncing ChatGPT cookies from local Chrome…");
			await pi.sendUserMessage("/sol-auth", { deliverAs: "followUp" });
		},
	});
}
