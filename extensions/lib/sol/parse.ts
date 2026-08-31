export type SolCommandName = "sol" | "sol-read" | "sol-auth" | "sol-followup" | "sol-resume";

export type SolRequest = {
	command: "sol";
	prompt: string;
	files: string[];
	wait: boolean;
	followUpJobId?: string;
};

export type ParsedSolInput =
	| SolRequest
	| { command: "sol-read"; jobId?: string }
	| { command: "sol-auth" }
	| { command: "sol-followup"; jobId: string; prompt: string; files: string[]; wait: boolean }
	| { command: "sol-resume"; jobId?: string; wait: boolean };

const FLAG_ERROR = (message: string) => {
	const error = new Error(message);
	error.name = "SolParseError";
	return error;
};

export function parseSolSlash(text: string): { command: SolCommandName; args: string } | undefined {
	const match = text.match(/^\/(sol(?:-read|-auth|-followup|-resume)?)(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;
	return { command: match[1] as SolCommandName, args: (match[2] ?? "").trim() };
}

export function splitArgs(raw: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]!;
		if (quote) {
			if (ch === quote) {
				quote = null;
				continue;
			}
			if (ch === "\\" && quote === '"' && i + 1 < raw.length) {
				current += raw[++i];
				continue;
			}
			current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (quote) throw FLAG_ERROR("Unclosed quote in /sol arguments");
	if (current) tokens.push(current);
	return tokens;
}

function takeValue(tokens: string[], index: number, flag: string): { value: string; next: number } {
	const value = tokens[index + 1];
	if (!value || value.startsWith("-")) throw FLAG_ERROR(`${flag} requires a value`);
	return { value, next: index + 2 };
}

function parseFileList(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

export function parseSolArgs(args: string, command: "sol" | "sol-followup" = "sol"): SolRequest | Extract<ParsedSolInput, { command: "sol-followup" }> {
	const tokens = splitArgs(args);
	const files: string[] = [];
	let wait = true;
	let followUpJobId: string | undefined;
	const promptParts: string[] = [];

	for (let i = 0; i < tokens.length; ) {
		const token = tokens[i]!;
		if (token === "--") {
			promptParts.push(...tokens.slice(i + 1));
			break;
		}
		if (token === "--bg" || token === "--async") {
			wait = false;
			i += 1;
			continue;
		}
		if (token === "--wait" || token === "--sync") {
			wait = true;
			i += 1;
			continue;
		}
		if (token === "--follow" || token === "--follow-up" || token === "--job") {
			const taken = takeValue(tokens, i, token);
			followUpJobId = taken.value;
			i = taken.next;
			continue;
		}
		if (token === "--files" || token === "--file") {
			const taken = takeValue(tokens, i, token);
			files.push(...parseFileList(taken.value));
			i = taken.next;
			continue;
		}
		if (token.startsWith("--files=") || token.startsWith("--file=")) {
			files.push(...parseFileList(token.slice(token.indexOf("=") + 1)));
			i += 1;
			continue;
		}
		if (token.startsWith("-") && token !== "-") {
			throw FLAG_ERROR(`Unknown /sol flag: ${token}`);
		}
		promptParts.push(token);
		i += 1;
	}

	if (command === "sol-followup") {
		const jobId = followUpJobId ?? promptParts.shift();
		const prompt = promptParts.join(" ").trim();
		if (!jobId || !prompt) throw FLAG_ERROR("Usage: /sol-followup <job-id> [--bg] [--files a,b] <prompt>");
		return { command: "sol-followup", jobId, prompt, files, wait };
	}

	const prompt = promptParts.join(" ").trim();
	if (!prompt) throw FLAG_ERROR("Usage: /sol [--bg] [--follow <job-id>] [--files a,b] <prompt>");
	return { command: "sol", prompt, files, wait, followUpJobId };
}

export function parseSolInput(text: string): ParsedSolInput | undefined {
	const parsed = parseSolSlash(text);
	if (!parsed) return undefined;
	if (parsed.command === "sol-auth") return { command: "sol-auth" };
	if (parsed.command === "sol-read") return { command: "sol-read", jobId: parsed.args || undefined };
	if (parsed.command === "sol-followup") return parseSolArgs(parsed.args, "sol-followup");
	if (parsed.command === "sol-resume") {
		// /sol-resume [job-id] [--bg]
		const tokens = splitArgs(parsed.args);
		let wait = true;
		let jobId: string | undefined;
		for (const token of tokens) {
			if (token === "--bg" || token === "--async") wait = false;
			else if (token === "--wait" || token === "--sync") wait = true;
			else if (!jobId && !token.startsWith("-")) jobId = token;
			else throw FLAG_ERROR(`Unknown /sol-resume flag: ${token}`);
		}
		return { command: "sol-resume", jobId, wait };
	}
	return parseSolArgs(parsed.args, "sol");
}

export function formatSolUserCommand(input: ParsedSolInput): string {
	if (input.command === "sol-auth") return "/sol-auth";
	if (input.command === "sol-read") return input.jobId ? `/sol-read ${input.jobId}` : "/sol-read";
	if (input.command === "sol-followup") {
		const flags = [
			input.wait ? "" : "--bg",
			input.files.length ? `--files ${input.files.join(",")}` : "",
		]
			.filter(Boolean)
			.join(" ");
		return `/sol-followup ${input.jobId}${flags ? ` ${flags}` : ""} ${input.prompt}`;
	}
	if (input.command === "sol-resume") {
		return `/sol-resume${input.jobId ? ` ${input.jobId}` : ""}${input.wait ? "" : " --bg"}`;
	}
	const flags = [
		input.wait ? "" : "--bg",
		input.followUpJobId ? `--follow ${input.followUpJobId}` : "",
		input.files.length ? `--files ${input.files.join(",")}` : "",
	]
		.filter(Boolean)
		.join(" ");
	return `/sol${flags ? ` ${flags}` : ""} ${input.prompt}`;
}
