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

import { acquireSolSubmitLease, releaseSolSubmitLease, type SolSubmitLease } from "./lib/sol/admission.ts";
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
import { classifySolTrigger, DETECTOR_RULESET, hashSolText, normalizeSolText } from "./lib/sol/trigger-detect.ts";
import {
	defaultSolTriggerLogPath,
	formatSolDiagRecent,
	formatSolDiagStats,
	logSolTrigger,
	readSolTriggerLog,
	recordFromClassification,
	resolveSolTriggerLogPath,
	type SolTriggerPhase,
} from "./lib/sol/trigger-log.ts";

const SOL_USAGE = "Usage: /sol [--bg] [--follow <job-id>] [--files a,b] <prompt>";

// ---- record-only trigger diagnostics (does not change /sol behavior) ----
const lastDispatch = new Map<string, { dispatchId: string; id: string; requestHash: string; ts: number }>();
const seenCommandIds = new Map<string, { session: string; ts: number }>();
const RELAY_WINDOW_MS = 5 * 60 * 1000;
/** Oracle→dispatch association is only meaningful within this window. */
const DISPATCH_TTL_MS = 30 * 60 * 1000;

function sessionOf(ctx: { sessionManager?: { getSessionId?: () => string } }): string {
	try {
		return ctx.sessionManager?.getSessionId?.() ?? "nosession";
	} catch {
		return "nosession";
	}
}

function makeDispatchId(session: string, normalized: string): string {
	return `d${hashSolText(session).slice(0, 4)}${hashSolText(normalized).slice(0, 8)}${Date.now().toString(36)}`;
}

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
			// Malformed /sol is a valuable observation too — record, never drop.
			const failedClassification = classifySolTrigger(event.prompt ?? "");
			logSolTrigger(recordFromClassification(failedClassification, {
				session: sessionOf(ctx),
				phase: "agent_start",
				parse_status: "error",
			}));
			return { systemPrompt: applyWorkerPatches(`${event.systemPrompt}${standing}`) };
		}

		const session = sessionOf(ctx);

		// Record-only diagnostics: classify every prompt, log it, never alter behavior.
		const classification = classifySolTrigger(event.prompt ?? "", parsed);
		let contentMatch: boolean | undefined;
		if (parsed) {
			const seen = seenCommandIds.get(`${session}\u0000${classification.id}`);
			// Same content id seen earlier — content match ONLY, not proof of relay.
			contentMatch = Boolean(seen && Date.now() - seen.ts < RELAY_WINDOW_MS);
		}

		if (parsed?.command === "sol-auth") {
			logSolTrigger(recordFromClassification(classification, {
				session,
				phase: "agent_start",
				content_match: contentMatch,
			}));
			return {
				systemPrompt: applyWorkerPatches(`${event.systemPrompt}${standing}`),
				message: {
					customType: "sol-auth-request",
					content: buildSolAuthPrompt(),
					display: false,
				},
			};
		}
		if (parsed && (parsed.command === "sol" || parsed.command === "sol-followup")) {
			const dispatch = await stageAndDispatch(ctx.cwd, parsed);
			const dispatchId = makeDispatchId(session, classification.normalized);
			const requestHash = hashSolText(normalizeSolText(parsed.prompt).text);
			lastDispatch.set(session, { dispatchId, id: classification.id, requestHash, ts: Date.now() });
			logSolTrigger(recordFromClassification(classification, {
				session,
				phase: "agent_start",
				dispatch_id: dispatchId,
				staged_files_count: dispatch.message.details.files.length,
				content_match: contentMatch,
			}));
			return {
				systemPrompt: applyWorkerPatches(`${event.systemPrompt}${standing}`),
				...dispatch,
			};
		}

		logSolTrigger(recordFromClassification(classification, {
			session,
			phase: "agent_start",
		}));
		return { systemPrompt: applyWorkerPatches(`${event.systemPrompt}${standing}`) };
	});

	const submitLeases = new Map<string, SolSubmitLease>();

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "agent_browser") {
			// Record-only oracle phase observer. Association is honest: matched by
			// oracle_submit prompt request-hash when possible, else session-last.
			const phase = event.toolName.match(/^oracle_(preflight|auth|submit|read)$/)?.[1];
			if (phase) {
				const session = sessionOf(ctx);
				let admissionBlockReason: string | undefined;
				if (phase === "submit") {
					const provider = (event.input as { provider?: unknown } | undefined)?.provider;
					// /sol always uses ChatGPT. Leave Grok's independent admission
					// policy untouched when an agent explicitly invokes it.
					if (typeof provider !== "string" || provider.toLowerCase() !== "grok") {
						const admission = await acquireSolSubmitLease();
						if (admission.acquired) {
							submitLeases.set(event.toolCallId, admission.lease);
						} else {
							admissionBlockReason = admission.reason;
						}
					}
				}
				let assoc: "request-hash" | "session-last" | undefined;
				// Same-session + TTL only; never search other sessions' dispatches.
				let dispatch = lastDispatch.get(session) ?? undefined;
				if (dispatch && Date.now() - dispatch.ts > DISPATCH_TTL_MS) dispatch = undefined;
				if (phase === "submit") {
					const rawPrompt = (event.input as { prompt?: unknown } | undefined)?.prompt;
					if (typeof rawPrompt === "string" && dispatch) {
						const promptHash = hashSolText(normalizeSolText(rawPrompt).text);
						if (dispatch.requestHash === promptHash) {
							assoc = "request-hash";
						}
					}
				}
				if (!assoc && dispatch) assoc = "session-last";
				logSolTrigger({
					session,
					id: dispatch?.id ?? `oracle-${hashSolText(JSON.stringify(event.input ?? {})).slice(0, 8)}`,
					source: dispatch ? "slash" : "oracle",
					phase: `oracle_${phase}` as SolTriggerPhase,
					candidate: false,
					near: false,
					needs_confirmation: false,
					matches: [],
					suppressed: admissionBlockReason ? ["chatgpt-submit-admission-busy"] : [],
					confidence: 0,
					score: 0,
					char_count: 0,
					ruleset_version: DETECTOR_RULESET,
					preview: `oracle_${phase} ${admissionBlockReason ? "blocked-admission" : assoc ?? (dispatch ? "in-dispatch" : "manual")}`,
					dispatch_id: dispatch?.dispatchId,
					oracle_phase: phase,
					assoc,
				});
				if (admissionBlockReason) return { block: true, reason: admissionBlockReason };
			}
			return;
		}
		const url = agentBrowserTargetsChatGpt(event.input);
		if (!url) return;
		return {
			block: true,
			reason: `Do not open ChatGPT in agent_browser (${url}). Use /sol or oracle_* so the isolated oracle worker owns that session.`,
		};
	});

	const releaseSubmitLeaseFor = async (toolCallId: string): Promise<void> => {
		const lease = submitLeases.get(toolCallId);
		if (!lease) return;
		// If release cannot acquire the reclaim token (another process is
		// mid-mutation), it returns false — KEEP the lease so a later event
		// (tool_execution_end / session_shutdown) retries instead of wedging.
		const released = await releaseSolSubmitLease(lease);
		if (released) submitLeases.delete(toolCallId);
	};

	// Release the cross-session admission lease as soon as oracle_submit
	// finishes. The durable job.json active-state check still protects the
	// handoff after this point and also recovers leases from crashed Pi runs.
	pi.on("tool_result", async (event) => {
		if (event.toolName === "oracle_submit") await releaseSubmitLeaseFor(event.toolCallId);
	});
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName === "oracle_submit") await releaseSubmitLeaseFor(event.toolCallId);
	});
	pi.on("session_shutdown", async () => {
		// Longer retry budget on shutdown, and only drop leases that were
		// actually released so we never forget a still-held lock.
		for (const lease of [...submitLeases.values()]) {
			const released = await releaseSolSubmitLease(lease, { maxAttempts: 100, retryMs: 100 });
			if (released) submitLeases.delete(lease);
		}
	});

	pi.registerCommand("sol", {
		description: `Ask web ${SOL_PRESET_LABEL} via pi-oracle. Default waits; --bg returns a job id`,
		handler: async (args, ctx) => {
			try {
				const input = parseSolArgs(args, "sol");
				const formatted = formatSolUserCommand(input);
				const classification = classifySolTrigger(formatted, input);
				const session = sessionOf(ctx);
				seenCommandIds.set(`${session}\u0000${classification.id}`, { session, ts: Date.now() });
				logSolTrigger(recordFromClassification(classification, { session, phase: "command" }));
				emit(pi, ctx, input.wait ? `Consulting ${SOL_PRESET_LABEL}…` : "Dispatching background /sol job…");
				await pi.sendUserMessage(formatted);
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
				const formatted = formatSolUserCommand(input);
				const classification = classifySolTrigger(formatted, input);
				const session = sessionOf(ctx);
				seenCommandIds.set(`${session}\u0000${classification.id}`, { session, ts: Date.now() });
				logSolTrigger(recordFromClassification(classification, { session, phase: "command" }));
				emit(pi, ctx, input.wait ? `Continuing ${SOL_PRESET_LABEL}…` : "Dispatching background /sol follow-up…");
				await pi.sendUserMessage(formatted);
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
			const classification = classifySolTrigger("/sol-auth", { command: "sol-auth" });
			const session = sessionOf(ctx);
			seenCommandIds.set(`${session}\u0000${classification.id}`, { session, ts: Date.now() });
			logSolTrigger(recordFromClassification(classification, { session, phase: "command" }));
			emit(pi, ctx, "Syncing ChatGPT cookies from local Chrome…");
			await pi.sendUserMessage("/sol-auth", { deliverAs: "followUp" });
		},
	});

	pi.registerCommand("sol-diag", {
		description: "Read the record-only /sol trigger diagnostics log (--last N, --candidates)",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			let last = 20;
			let candidatesOnly = false;
			for (let i = 0; i < tokens.length; i++) {
				if (tokens[i] === "--last" && tokens[i + 1]) {
					const n = Number.parseInt(tokens[++i]!, 10);
					if (Number.isFinite(n) && n > 0) last = Math.min(n, 100);
					continue;
				}
				if (tokens[i] === "--candidates") {
					candidatesOnly = true;
				}
			}
			const path = resolveSolTriggerLogPath() ?? defaultSolTriggerLogPath();
			const loggingDisabled = resolveSolTriggerLogPath() === undefined;
			const records = await readSolTriggerLog(path);
			const filtered = candidatesOnly ? records.filter((r) => r.candidate && r.source === "semantic" && r.parse_status !== "error" && r.ruleset_version === DETECTOR_RULESET) : records;
			emit(pi, ctx, [formatSolDiagStats(records, path, loggingDisabled, DETECTOR_RULESET), formatSolDiagRecent(filtered, last)].join("\n\n"));
		},
	});
}
