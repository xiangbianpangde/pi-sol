/**
 * /sol trigger diagnostics — record-only classifier.
 *
 * This module NEVER changes /sol behavior. It only classifies a raw user
 * prompt into "would this deserve a Sol second opinion?" for the
 * diagnostics log (source=slash|semantic, matched_reason, suppressed_reason,
 * needs_confirmation, confidence) so real-world data can calibrate the
 * future detect → candidate → confirm → stage → submit chain.
 *
 * Design rules (from the trigger-mechanism review + Sol audit round):
 * - Do not just stack keywords. Separate positive signals (structure, ask
 *   intent, second-opinion intent) from suppressors (code, quotes, pasted
 *   errors, local-only lookups, explicit opt-outs, negation).
 * - Explicit intent beats heuristics: second_opinion / decision_ask are
 *   strong signals; quick_chat / opt-out / negation are hard vetoes; code
 *   and quotes are SHALLOW NEGATIVES (they can suppress weak signals but
 *   must NOT veto an explicit "让 Sol 复核 + 代码/材料").
 * - Conservative by default: precision over recall. `near` marks partial
 *   signal rows for human labeling; `candidate` is the future confirm gate.
 * - Bump DETECTOR_RULESET on every behavioral rule change: logged records
 *   must stay attributable to the rules that produced them (sampling).
 */
import { createHash } from "node:crypto";

import type { ParsedSolInput, SolCommandName } from "./parse.ts";

/** Bump whenever POSITIVE_SIGNALS / NEGATIVE_SIGNALS / VETO_RULES / thresholds change. */
export const DETECTOR_RULESET = "detect-v4";

export type SolDetectSignal = { reason: string; weight: number };
export type SolDetectVeto = { reason: string; weight: number };

export type SolTextNormalized = {
	/** Normalized analysis text: fences/blockquotes/inline code removed, whitespace collapsed. */
	text: string;
	/** Like text but keeps line breaks — for structure signals that need ^|\n anchors. */
	textWithBreaks: string;
	charCount: number;
	hadFencedCode: boolean;
	hadBlockquote: boolean;
};

export type SolTriggerClassification = {
	/** slash = explicit /sol... command; semantic = natural-language candidate analysis. */
	source: "slash" | "semantic";
	command?: SolCommandName;
	/** Would deserve a Sol candidate when semantic (needs user confirmation before any submit). */
	candidate: boolean;
	/** Partial signals worth a human label check (between none and candidate). */
	near: boolean;
	/** True when a semantic candidate would require explicit user confirmation. */
	needs_confirmation: boolean;
	matches: SolDetectSignal[];
	suppressed: SolDetectVeto[];
	/** Sum of positive weights. NOT a probability — a feature score. */
	confidence: number;
	/** Positive + negative weights. */
	score: number;
	normalized: string;
	preview: string;
	charCount: number;
	/** Content fingerprint (sha256, 12 hex) of the normalized text — correlation only, NOT a request id. */
	id: string;
	ruleset: string;
};

/** Thresholds: candidate ≥ 2.5 positive weight AND net score ≥ 1.0; near ≥ 1.0 positive. */
const CANDIDATE_CONFIDENCE = 2.5;
const CANDIDATE_MIN_SCORE = 1.0;
const NEAR_CONFIDENCE = 1.0;
/** Hard vetoes beat every positive signal (opt-out, negation, short chat…). */
const VETO_SCORE = -100;

const POSITIVE_SIGNALS: ReadonlyArray<SolDetectSignal & { re: RegExp; useBreaks?: boolean }> = [
	{ reason: "sol_consult_first", weight: 2.5, re: /(?:优先|先).{0,8}(?:问|咨询|找|征求|询问|给|请教).{0,8}(?:[Ss]ol|[Gg][Pp][Tt]|[Cc]hat[Gg][Pp][Tt]|外部|外部意见)|(?:先参考|参考).{0,20}(?:建议|意见).{0,20}再(?:下|给出|做|给|决定)|(?:ask|consult).{0,20}(?:[Ss]ol|[Gg][Pp][Tt]).{0,20}(?:first|before|先|再)|(?:征求|征询|求).{0,8}(?:[Ss]ol|[Gg][Pp][Tt]|[Cc]hat[Gg][Pp][Tt]|外部|外部意见).{0,8}(?:建议|意见|看法)/i },
	{ reason: "second_opinion", weight: 2.5, re: /(?:第二意见|second\s*opinion)|(?:让|叫|请|问问?)\s*(?:[Ss]ol|[Gg][Pp][Tt]|[Cc]hat[Gg][Pp][Tt])\b/ },
	{ reason: "advisory_ask", weight: 1.5, re: /(?:复核|评估|评审|审查|论证|权衡|给(?:个|点|我)?建议|你怎么看|怎么看|如何抉择|抉择|选型|要不要|该不该|哪个更好|如何取舍|利弊|pros\s*and\s*cons|trade[- ]?offs?|weigh\b|advise|evaluate|review\b)/i },
	{ reason: "decision_ask", weight: 1.5, re: /(?:应该|该选|推荐|更合适|选哪个|哪个更好|compare\b|vs\.?|versus|choose\b|which (?:should|is better)|should (?:we|i)\b|recommend\b|哪种|哪条|权衡.*(?:方案|路线|选择)|(?:方案|路线|选择).*权衡)/i },
	{ reason: "design_planning", weight: 1.0, re: /(?:架构|系统设计|方案设计|机制设计|协议设计|模块划分|接口设计|触发机制|可扩展|扩展性|可维护性|重构方案|roadmap|路线图|整体方案|体系|分层设计|设计方案)/i },
	{ reason: "risk_analysis", weight: 1.5, re: /(?:风险分析|失败模式|替代方案|风险与|弊端|trade[- ]?offs?|failure modes?|alternatives?|migration path|演进路线)/i },
	{ reason: "research_request", weight: 1.5, re: /(?:调研|研究|查一下|最新|现状|对比|benchmark|best\s*practice|最佳实践|资料|论文|文献|业界|行业|趋势|\bresearch\b|\bsurvey\b|\blook into\b|\bcompare\b|\bversus\b|sources?)/i },
	// Detected against code-stripped text WITH line breaks preserved:
	// the collapsed text would kill ^|\n anchors, and raw would scan fenced code.
	{ reason: "structured_list", weight: 1.0, re: /(?:^|\n)\s*(\d+[.、)）]|[-*•])\s/, useBreaks: true },
	{ reason: "comparison", weight: 0.5, re: /(?:或者|还是|相比之下|另一(?:个|种|条|条路)|alternatively|on the other hand)/i },
	{ reason: "question_mark", weight: 0.5, re: /[?？]/ },
];

const NEGATIVE_SIGNALS: ReadonlyArray<SolDetectSignal & { re: RegExp }> = [
	{ reason: "pasted_error", weight: -2, re: /(?:Traceback|^ERROR[:：]|npm error|TypeError|ReferenceError|SyntaxError|cannot find module|exit code|stack trace)/im },
	{ reason: "local_action", weight: -1, re: /(?:帮我改|改成|修改这个|实现这个|写代码|把这个|修复|报错|debug|跑一下|执行|运行|编译)/i },
	{ reason: "local_only_lookup", weight: -1.5, re: /(?:本地|本仓库|当前项目|这个项目|工作区).{0,40}(?:搜|找|查|看看|grep|搜索)/i },
	// Code/quotes are shallow negatives (applied manually below), NOT vetoes: an
	// explicit "让 Sol 复核 + 代码/材料" must still be able to reach candidate.
];

/** Hard vetoes: beat every positive signal. */
const VETO_RULES: ReadonlyArray<{ reason: string; test: (n: SolTextNormalized, hasSignals: boolean) => boolean }> = [
	{
		reason: "empty_text",
		test: (n) => n.charCount === 0,
	},
	{
		// Short acknowledgments are not candidate questions; a short prompt WITH
		// design signals (e.g. "帮我看看这个架构") stays analyzable (near).
		reason: "quick_chat",
		test: (n, hasSignals) => n.charCount <= 12 && !hasSignals,
	},
	{
		// Explicit opt-out always wins over complexity signals.
		reason: "explicit_optout",
		test: (n) =>
			/(?:不用|不需要|别|不必|无需|不要|别麻烦)(?:问|找|叫|请|麻烦|转|联系)?\s*(?:[Ss]ol|[Gg][Pp][Tt]|[Cc]hat[Gg][Pp][Tt]|外部|外部模型|外部意见|第二意见)|(?:只用|只靠|就用|用)本地(?:模型)?(?:就)?(?:够|处理|解决|搞定)?|无需(?:第二意见|外部)|不需要(?:第二意见|外部)|不要转给外部|不(?:要|用)麻烦外部|本地(?:模型)?处理(?:就)?(?:行|够了?)|\bdon'?t\s+(?:ask|consult)\b|no\s+need\s+to\s+consult/i.test(n.text),
	},
	{
		// Negation blindness guard: "并不是在请求第二意见" must not fire second_opinion.
		reason: "negation_veto",
		test: (n) =>
			/(?:并不|并非|不是|不是要|没在|没有)(?:在)?(?:请求|征求|需要|寻求|要)(?:第二意见|外部意见|外部|[Ss]ol|[Gg][Pp][Tt])|(?:不是在|并非)(?:请求|征求)(?:第二意见|外部意见)/i.test(n.text),
	},
];

function lengthSignal(charCount: number): SolDetectSignal | undefined {
	if (charCount >= 150) return { reason: "long_prompt", weight: 0.5 };
	if (charCount >= 60) return { reason: "medium_prompt", weight: 0.2 };
	return undefined;
}

export function normalizeSolText(raw: string): SolTextNormalized {
	let text = raw.trim();
	const hadFencedCode = /```[\s\S]*?```/.test(text);
	const hadBlockquote = /^[ \t]*>/m.test(text);
	text = text.replace(/```[\s\S]*?```/g, " ");
	text = text.replace(/`[^`\n]*`/g, " ");
	text = text.replace(/^[ \t]*>[^\n]*(?:\n|$)/gm, " ");
	// Keep line breaks for structure detection (but strips code/quote content).
	const textWithBreaks = text.replace(/[ \t\u3000]+/g, " ").replace(/\n{2,}/g, "\n").replace(/^\s+|\s+$/g, "");
	const collapsed = textWithBreaks.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
	return { text: collapsed, textWithBreaks, charCount: collapsed.length, hadFencedCode, hadBlockquote };
}

export function hashSolText(normalized: string): string {
	return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12);
}

/**
 * Classify one user prompt. `parsed` is the output of parseSolInput (if any):
 * a slash command is never "semantic" — it is an explicit trigger.
 */
export function classifySolTrigger(raw: string, parsed?: ParsedSolInput): SolTriggerClassification {
	const n = normalizeSolText(raw);
	const id = hashSolText(n.text);
	const matches: SolDetectSignal[] = [];
	const suppressed: SolDetectVeto[] = [];

	const length = lengthSignal(n.charCount);
	if (length) matches.push(length);
	for (const signal of POSITIVE_SIGNALS) {
		const haystack = signal.useBreaks ? n.textWithBreaks : n.text;
		if (signal.re.test(haystack)) {
			if (signal.reason === "comparison" && matches.some((m) => m.reason === "structured_list")) continue;
			matches.push({ reason: signal.reason, weight: signal.weight });
		}
	}
	for (const veto of VETO_RULES) {
		if (veto.test(n, matches.length > 0)) suppressed.push({ reason: veto.reason, weight: VETO_SCORE });
	}
	if (n.hadFencedCode && n.charCount < 20) suppressed.push({ reason: "code_heavy", weight: -1.5 });
	if (n.hadBlockquote && n.charCount < 20) suppressed.push({ reason: "quote_heavy", weight: -1.5 });
	for (const signal of NEGATIVE_SIGNALS) {
		if (signal.re.test(n.text)) {
			suppressed.push({ reason: signal.reason, weight: signal.weight });
		}
	}

	const confidence = matches.reduce((sum, m) => sum + m.weight, 0);
	const score = confidence + suppressed.reduce((sum, s) => sum + s.weight, 0);
	const hasVeto = suppressed.some((s) => s.weight === VETO_SCORE);

	const candidate = Boolean(parsed) || (!hasVeto && confidence >= CANDIDATE_CONFIDENCE && score >= CANDIDATE_MIN_SCORE);
	const near = !candidate && !hasVeto && confidence >= NEAR_CONFIDENCE && !parsed;

	return {
		source: parsed ? "slash" : "semantic",
		command: parsed?.command,
		candidate,
		near,
		needs_confirmation: !parsed && candidate,
		matches,
		suppressed,
		confidence,
		score,
		normalized: n.text,
		preview: n.text.slice(0, 160),
		charCount: n.charCount,
		id,
		ruleset: DETECTOR_RULESET,
	};
}
