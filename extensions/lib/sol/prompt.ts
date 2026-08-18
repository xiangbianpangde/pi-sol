import {
	FREE_UPLOADS_PER_DAY,
	MAX_FILE_BYTES,
	MAX_FILES_PER_REQUEST,
	MAX_IMAGE_BYTES,
	MAX_SPREADSHEET_BYTES,
	PAID_UPLOADS_PER_3H,
	SOL_PRESET,
	SOL_PRESET_LABEL,
	SOL_PROVIDER,
	USER_STORAGE_GB,
} from "./limits.ts";
import type { ParsedSolInput, SolRequest } from "./parse.ts";

export const SOL_SKILL_NAME = "sol";

export function buildSolStandingRule(): string {
	return [
		"ChatGPT web / GPT-5.6 Sol is only available through /sol and the oracle_* tools.",
		"Never open chatgpt.com, chat.openai.com, or auth.openai.com with agent_browser.",
		`Default advisor model is ${SOL_PRESET_LABEL} via oracle_submit preset \`${SOL_PRESET}\`.`,
		"High/Power-slider worker patches are auto-restored by /sol. Never ask the user to run apply scripts or pi update.",
	].join(" ");
}

function fileLines(files: string[]): string {
	if (files.length === 0) {
		return "No user files. Use the staged request.md path from this turn as the only archive input. Do not archive the whole repo.";
	}
	return `Exact archive files (already validated / staged, project-relative):\n${files.map((file) => `- ${file}`).join("\n")}`;
}

function waitRules(wait: boolean): string {
	if (!wait) {
		return [
			"Mode: background.",
			"After a successful or queued oracle_submit, stop. Give only the job id and say the user can run /sol-read <job-id>.",
			"Do not poll.",
		].join("\n");
	}
	return [
		"Mode: synchronous (default).",
		"After oracle_submit, poll oracle_read until the job is terminal (completed / failed / cancelled).",
		"Sleep between polls; do not busy-loop. When complete, present the full saved answer as the advisor reply.",
		"If the job is still running after a long wait, report the job id and /sol-read instructions instead of inventing an answer.",
	].join("\n");
}

export function buildSolDispatchPrompt(input: Extract<ParsedSolInput, SolRequest | { command: "sol-followup" }>, stagedFiles: string[]): string {
	const followUpJobId = input.command === "sol-followup" ? input.jobId : input.followUpJobId;
	const isFollowUp = Boolean(followUpJobId);

	return `You are the local relay for /sol — a thin wrapper over pi-oracle that talks to ChatGPT web GPT-5.6 Sol.

Do not answer the user's request yourself. Relay it to web GPT-5.6 Sol and bring the answer back.

Hard requirements:
- Provider: \`${SOL_PROVIDER}\`. Never route /sol to Grok.
- Preset: \`${SOL_PRESET}\` (${SOL_PRESET_LABEL}). This is the highest GPT-5.6 Sol intensity on ChatGPT Plus. Do not switch to Extra High, Pro, Instant, Medium, or \`thinking_standard\`. If thinking_extended fails, stop and report the job error. Never retry Instant/Standard as a silent fallback.
- Do not use agent_browser on ChatGPT. The isolated oracle worker owns that browser session. Regular agent_browser is only for non-ChatGPT pages.
- Do not archive the whole repository. Only the exact file list below.
- If a required tool is unavailable, stop and report that blocker. Do not fabricate a Sol answer.
- Worker High/Power-slider patches are restored automatically before this turn. Never tell the user to run apply scripts. If a job still fails with "effort dropdown" or "model family control", restore once via \`node ~/.pi/agent/extensions/lib/sol/apply-sol-patches.mjs --restore\` yourself, then retry the same thinking_extended submit once. Do not ask the user to do that.

ChatGPT web upload / 封控 (already prechecked when files were staged; still honor them):
- Max ${MAX_FILES_PER_REQUEST} files per turn; paid ~${PAID_UPLOADS_PER_3H}/3h; Free ${FREE_UPLOADS_PER_DAY}/day.
- 512 MiB/file hard cap, images ${MAX_IMAGE_BYTES / (1024 * 1024)} MiB, spreadsheets ~${MAX_SPREADSHEET_BYTES / (1024 * 1024)} MiB, text/docs ~2M tokens.
- User storage ${USER_STORAGE_GB} GB. Executables/installers are rejected.
- Content-policy / login / challenge failures are terminal: report them, do not bypass.

Required workflow:
1. Call oracle_preflight with provider \`${SOL_PROVIDER}\`${isFollowUp ? ` and followUpJobId \`${followUpJobId}\`` : ""}.
2. If preflight says auth is missing/stale, call oracle_auth with provider \`${SOL_PROVIDER}\` immediately, then re-run oracle_preflight. This is intentional: /sol auto-syncs Chrome cookies. If Chrome's cookie DB is locked, tell the user to quit Chrome once and rerun /sol-auth.
3. If still not ready, stop and report the blocker.
4. Call oracle_submit with:
   - prompt: the user request below
   - files: the exact staged list
   - provider: \`${SOL_PROVIDER}\`
   - preset: \`${SOL_PRESET}\`
   ${isFollowUp ? `- followUpJobId: \`${followUpJobId}\`` : "- omit followUpJobId and chatGptConversationId unless the user explicitly gave a chatgpt.com/c/... URL"}
5. ${waitRules(input.wait)}

${fileLines(stagedFiles)}

User request:
${input.prompt}
`;
}

export function buildSolAuthPrompt(): string {
	return `The user ran /sol-auth.

Call oracle_auth with provider \`${SOL_PROVIDER}\` now so pi-oracle can copy ChatGPT cookies from the local Chrome profile into the isolated oracle seed.

Then call oracle_preflight with provider \`${SOL_PROVIDER}\` and report ready / not ready in a few lines.

Do not open chatgpt.com with agent_browser. If Chrome has the cookie DB locked, tell the user to fully quit Chrome and rerun /sol-auth.`;
}
