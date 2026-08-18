import { CHATGPT_HOSTS } from "./limits.ts";

const HOST_RE = /https?:\/\/([^/\s"'?]+)/gi;

export function chatgptHostFromUrl(value: string): string | undefined {
	try {
		const host = new URL(value).hostname.toLowerCase();
		return CHATGPT_HOSTS.has(host) ? host : undefined;
	} catch {
		return undefined;
	}
}

export function collectStrings(value: unknown, into: string[] = [], depth = 0): string[] {
	if (depth > 8 || value == null) return into;
	if (typeof value === "string") {
		into.push(value);
		return into;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, into, depth + 1);
		return into;
	}
	if (typeof value === "object") {
		for (const item of Object.values(value as Record<string, unknown>)) {
			collectStrings(item, into, depth + 1);
		}
	}
	return into;
}

export function findChatGptUrl(value: unknown): string | undefined {
	for (const text of collectStrings(value)) {
		if (chatgptHostFromUrl(text)) return text;
		HOST_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = HOST_RE.exec(text))) {
			const url = match[0];
			if (chatgptHostFromUrl(url)) return url;
		}
	}
	return undefined;
}

export function agentBrowserTargetsChatGpt(input: unknown): string | undefined {
	return findChatGptUrl(input);
}
