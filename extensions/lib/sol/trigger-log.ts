/**
 * /sol trigger diagnostics — record-only JSONL log + sol-diag read/format.
 *
 * Writes one JSON line per observation to the default path
 *   ~/.pi/agent/logs/sol-trigger.jsonl
 * unless overridden: $PI_SOL_TRIGGER_LOG=<path> uses that path;
 * "off"/"0" disables writing. The default-path resolution is LAZY (homedir()
 * is read per call) so tests can isolate HOME and so that an unset variable
 * still writes the default file.
 *
 * Trust rules (Sol audit round):
 * - REDACT BEFORE TRUNCATE: masking must run on the full normalized text,
 *   then the 160-char preview is cut (truncating first leaks secret prefixes).
 * - Records carry schema_version + ruleset_version so old and new rule
 *   outputs are never mixed in a sample set.
 * - Private-by-default: dir 0700, file 0600. Write failures are surfaced
 *   (throttled) instead of silently dropping data.
 * - Reads take the LAST records (tail semantics), not the first 20k.
 * Writing is small and synchronous (single ~300B line per turn): durable
 * before the turn continues and no dangling async write on process exit.
 * Never throws: record-only instrumentation must not break a /sol turn.
 */
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { SolTriggerClassification } from "./trigger-detect.ts";
import { DETECTOR_RULESET } from "./trigger-detect.ts";

export const SOL_TRIGGER_SCHEMA_VERSION = 1;
const MAX_RECORDS_READ = 20000;
/** Tail-read window: when the file exceeds this, only the last bytes are read. */
const TAIL_READ_BYTES = 1024 * 1024;
const WRITE_ERROR_WARN_MS = 5 * 60 * 1000;

export function defaultSolTriggerLogPath(): string {
	return join(homedir(), ".pi/agent/logs/sol-trigger.jsonl");
}

export function resolveSolTriggerLogPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env.PI_SOL_TRIGGER_LOG;
	if (!value) return defaultSolTriggerLogPath();
	if (value === "off" || value === "0") return undefined;
	return value;
}

export type SolTriggerPhase =
	| "command"
	| "agent_start"
	| "oracle_preflight"
	| "oracle_auth"
	| "oracle_submit"
	| "oracle_read";

export type SolTriggerRecord = {
	ts: string;
	seq: number;
	session: string;
	/** Content fingerprint of the normalized text — correlation only, NOT a request id. */
	id: string;
	source: "slash" | "semantic" | "oracle";
	phase: SolTriggerPhase;
	command?: string;
	/** "error" when parseSolInput threw (recorded instead of dropping the observation). */
	parse_status?: "ok" | "error";
	candidate: boolean;
	near: boolean;
	needs_confirmation: boolean;
	matches: string[];
	suppressed: string[];
	confidence: number;
	score: number;
	char_count: number;
	preview: string;
	/** Set when a slash dispatch is produced by before_agent_start. */
	dispatch_id?: string;
	/**
	 * Same content id observed earlier in this session within ~5 minutes.
	 * This proves CONTENT MATCH ONLY — it is NOT evidence that the second
	 * observation is the same logical relay, nor proof of no duplicate/loss.
	 */
	content_match?: boolean;
	staged_files_count?: number;
	/** oracle_* tool observed in the agent loop (preflight/auth/submit/read). */
	oracle_phase?: string;
	/**
	 * How the oracle_* call was linked to a dispatch (same session, TTL-bounded):
	 * "request-hash" = oracle_submit prompt hash matched the CURRENT dispatch's
	 * normalized-request fingerprint; "session-last" = heuristic; never proof.
	 */
	assoc?: "request-hash" | "session-last";
	schema_version: number;
	ruleset_version: string;
};

let seq = 0;
let lastMkdir = "";
let lastWriteWarn = 0;

/** Mask obvious secrets. MUST run on full text before any truncation. */
export function redactPreview(text: string): string {
	let out = text;
	out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[PRIVATE KEY]");
	out = out.replace(/AKIA[0-9A-Z]{16}/g, "[AWS_KEY]");
	out = out.replace(/ASIA[0-9A-Z]{16}/g, "[AWS_KEY]");
	out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[JWT]");
	out = out.replace(/\bsk-(?:proj-|ant-api03-)?[A-Za-z0-9]{16,}\b/g, "[SECRET_KEY]");
	out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, "[GITHUB_PAT]");
	out = out.replace(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, "[EMAIL]");
	out = out.replace(/\b[0-9a-fA-F]{32,}\b/g, "[HEX]");
	out = out.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[BASE64]");
	out = out.replace(/(Authorization[:：]\s*(?:Bearer|Basic)\s+)[^\s,;]+/gi, "$1[REDACTED]");
	out = out.replace(/(["']?(?:[Pp]assword|[Pp]asswd|[Ss]ecret|[Tt]oken|[Aa]pi[_-]?[Kk]ey|access[_-]?key)["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g, "$1[REDACTED]");
	return out;
}

export async function logSolTrigger(
	record: Omit<SolTriggerRecord, "ts" | "seq" | "schema_version">,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const path = resolveSolTriggerLogPath(env);
	if (!path) return;
	const full: SolTriggerRecord = {
		ts: new Date().toISOString(),
		seq: ++seq,
		schema_version: SOL_TRIGGER_SCHEMA_VERSION,
		...record,
	};
	try {
		const dir = dirname(path);
		if (dir !== lastMkdir) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			lastMkdir = dir;
		} else {
			// Survive external deletion: retry mkdir once if the cached dir vanished.
			try {
				statSync(dir);
			} catch {
				mkdirSync(dir, { recursive: true, mode: 0o700 });
			}
		}
		// Tighten EXISTING dir/file BEFORE appending (mode args only apply on create;
		// existing-file chmod after append would leave a tiny 0644→0600 window).
		try {
			chmodSync(dir, 0o700);
		} catch {
			// best-effort
		}
		try {
			if (existsSync(path)) chmodSync(path, 0o600);
		} catch {
			// best-effort
		}
		appendFileSync(path, `${JSON.stringify(full)}\n`, { encoding: "utf8", mode: 0o600 });
		try {
			chmodSync(path, 0o600);
		} catch {
			// best-effort
		}
	} catch (error) {
		// Record-only: never break the turn — but do not fail silently either.
		lastMkdir = "";
		const now = Date.now();
		if (now - lastWriteWarn > WRITE_ERROR_WARN_MS) {
			lastWriteWarn = now;
			const detail = error instanceof Error ? error.message : String(error);
			console.error(`[sol-trigger] log write failed (${path}): ${detail}`);
		}
	}
}

export function recordFromClassification(
	c: SolTriggerClassification,
	extra: Omit<SolTriggerRecord, "ts" | "seq" | "id" | "source" | "command" | "candidate" | "near" | "needs_confirmation" | "matches" | "suppressed" | "confidence" | "score" | "char_count" | "preview" | "schema_version" | "ruleset_version">,
): Omit<SolTriggerRecord, "ts" | "seq" | "schema_version"> {
	return {
		id: c.id,
		source: c.source,
		command: c.command,
		candidate: c.candidate,
		near: c.near,
		needs_confirmation: c.needs_confirmation,
		matches: c.matches.map((m) => m.reason),
		suppressed: c.suppressed.map((s) => s.reason),
		confidence: c.confidence,
		score: c.score,
		char_count: c.charCount,
		// REDACT FIRST (full text), THEN truncate — never the other way around.
		preview: redactPreview(c.normalized).slice(0, 160),
		ruleset_version: c.ruleset,
		...extra,
	};
}

/**
 * Tail-style read: reads the last TAIL_READ_BYTES (1 MiB) when the file is
 * larger, parses whole lines within it, and returns up to MAX_RECORDS_READ
 * records. Actual semantics: "up to 20k records within the last 1 MiB" —
 * the sampling exporter must NOT batch on this reader; stream the full
 * sampling window instead.
 */
export async function readSolTriggerLog(path: string): Promise<SolTriggerRecord[]> {
	let rawTail: string;
	try {
		const size = statSync(path).size;
		if (size > TAIL_READ_BYTES) {
			const fd = openSync(path, "r");
			try {
				const buf = Buffer.alloc(TAIL_READ_BYTES);
				const read = readSync(fd, buf, 0, TAIL_READ_BYTES, size - TAIL_READ_BYTES);
				rawTail = buf.slice(0, read).toString("utf8");
			} finally {
				closeSync(fd);
			}
			const firstBreak = rawTail.indexOf("\n");
			if (firstBreak !== -1) rawTail = rawTail.slice(firstBreak + 1);
		} else {
			rawTail = readFileSync(path, "utf8");
		}
	} catch {
		return [];
	}
	const records: SolTriggerRecord[] = [];
	for (const line of rawTail.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as SolTriggerRecord;
			if (typeof parsed.ts !== "string") continue;
			records.push(parsed);
		} catch {
			// skip malformed line
		}
	}
	return records.slice(-MAX_RECORDS_READ);
}

function countBy(records: SolTriggerRecord[], key: (r: SolTriggerRecord) => string | undefined): Map<string, number> {
	const counts = new Map<string, number>();
	for (const r of records) {
		const k = key(r);
		if (!k) continue;
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	return counts;
}

function fmtCounts(counts: Map<string, number>, top = 8): string {
	const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
	return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(", ") : "(none)";
}

export function formatSolDiagStats(records: SolTriggerRecord[], path: string, loggingDisabled = false, currentRuleset = ""): string {
	const current = currentRuleset ? records.filter((r) => r.ruleset_version === currentRuleset) : records;
	const other = currentRuleset ? records.filter((r) => r.ruleset_version !== currentRuleset) : [];
	const semantic = current.filter((r) => r.source === "semantic");
	const lines = [
		`sol trigger diag — ${path}`,
		...loggingDisabled ? ["NOTE: PI_SOL_TRIGGER_LOG=off — writing disabled; showing historical default log."] : [],
		`rules=${currentRuleset || "(all)"} rows=${current.length} (slash=${current.filter((r) => r.source === "slash").length} semantic=${semantic.length} oracle=${current.filter((r) => r.source === "oracle").length})${other.length ? ` [other-ruleset rows=${other.length} — not counted; rotate the log or filter by ruleset]` : ""}`,
	];
	if (semantic.length) {
		lines.push(
			`semantic: candidate=${semantic.filter((r) => r.candidate).length} near=${semantic.filter((r) => r.near).length} none=${semantic.filter((r) => !r.candidate && !r.near).length}`,
			`matched: ${fmtCounts(countBy(semantic, (r) => r.matches[0]), 6)} (top first-signal)`,
			`suppressed: ${fmtCounts(countBy(semantic, (r) => r.suppressed[0]), 6)} (top first-suppressor)`,
		);
	}
	return lines.join("\n");
}

export function formatSolDiagRecent(records: SolTriggerRecord[], limit = 20): string {
	const recent = records.slice(-limit).reverse();
	if (!recent.length) return "(no records)";
	const lines: string[] = [];
	recent.forEach((r, i) => {
		const tags = [
			r.source,
			r.phase,
			r.command ? `/${r.command}` : undefined,
			r.parse_status === "error" ? "parse-error" : undefined,
			r.dispatch_id ? `dispatch=${r.dispatch_id}` : undefined,
			r.content_match ? "content-match" : undefined,
			r.assoc ? `assoc=${r.assoc}` : undefined,
			r.candidate ? "CAND" : r.near ? "near" : undefined,
			r.matches.length ? `+${r.matches.join("+")}` : undefined,
			r.suppressed.length ? `-${r.suppressed.join("-")}` : undefined,
		].filter(Boolean);
		lines.push(`#${i + 1} ${r.ts} ${tags.join(" ")}`);
		lines.push(`   ${r.preview}`);
	});
	return lines.join("\n");
}
