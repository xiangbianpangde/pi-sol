/**
 * /sol record-only trigger classifier.
 * Run: npx --yes tsx --test ~/.pi/agent/extensions/__tests__/sol-trigger.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSolInput } from "../lib/sol/parse.ts";
import { classifySolTrigger, hashSolText, normalizeSolText } from "../lib/sol/trigger-detect.ts";

describe("normalizeSolText", () => {
	it("strips fenced code and reports it", () => {
		const n = normalizeSolText("看看\n```ts\nconst x = 1;\n```\n");
		assert.equal(n.hadFencedCode, true);
		assert.equal(n.charCount, 2);
	});

	it("strips inline code spans and blockquotes", () => {
		const n = normalizeSolText("> 引用原文\n问我 `foo()` 怎么改");
		assert.equal(n.hadBlockquote, true);
		assert.ok(!n.text.includes("foo()"));
		assert.ok(n.text.includes("问我"));
	});

	it("collapses whitespace and trims", () => {
		const n = normalizeSolText("  \n  帮我看看  架构  \n");
		assert.equal(n.text, "帮我看看 架构");
	});

	it("keeps line breaks in textWithBreaks after code/quote stripping", () => {
		const n = normalizeSolText("请评审：\n1. 架构\n```x\n1. 代码内\n```");
		assert.ok(n.textWithBreaks.includes("\n1. 架构"));
		assert.ok(!n.textWithBreaks.includes("代码内"));
	});
});

describe("classifySolTrigger — slash source", () => {
	it("explicit /sol is always candidate and never needs confirmation", () => {
		const parsed = parseSolInput("/sol 帮我看看");
		const c = classifySolTrigger("/sol 帮我看看", parsed);
		assert.equal(c.source, "slash");
		assert.equal(c.command, "sol");
		assert.equal(c.candidate, true);
		assert.equal(c.needs_confirmation, false);
	});

	it("natural language /sol mention is semantic, not slash", () => {
		const c = classifySolTrigger("让 Sol 复核一下这个方案", undefined);
		assert.equal(c.source, "semantic");
		assert.equal(c.command, undefined);
	});
});

describe("classifySolTrigger — semantic candidates", () => {
	it("second-opinion + design + comparison is a candidate with confirmation", () => {
		const prompt = "让 Sol 复核一下这个设计方案，我考虑了两条路线：A 方案用事件驱动，B 方案用轮询，帮我权衡利弊。";
		const c = classifySolTrigger(prompt);
		assert.equal(c.source, "semantic");
		assert.equal(c.candidate, true);
		assert.equal(c.needs_confirmation, true);
		assert.ok(c.matches.some((m) => m.reason === "second_opinion"));
		assert.ok(c.matches.some((m) => m.reason === "design_planning"));
	});

	it("architecture question with ask words is a candidate", () => {
		const prompt = "我打算重构我们这个项目的触发机制，把 detect/confirm/stage/submit 拆开，想权衡事件驱动和轮询两条路线，你怎么看？";
		const c = classifySolTrigger(prompt);
		assert.equal(c.candidate, true);
		assert.equal(c.near, false);
	});

	it("short prompt with a design signal is near, not candidate", () => {
		const c = classifySolTrigger("帮我看看这个架构");
		assert.equal(c.candidate, false);
		assert.equal(c.near, true);
	});

	it("multiline numbered lists still count as structured_list (raw newlines)", () => {
		const c = classifySolTrigger("请评审：\n1. 架构\n2. 风险\n3. 路线图");
		assert.ok(c.matches.some((m) => m.reason === "structured_list"));
	});

	it("structured_list must NOT scan fenced code (detect-v3)", () => {
		const c = classifySolTrigger("这是评审记录：\n```text\n1. 架构完成\n2. 风险完成\n```");
		assert.ok(!c.matches.some((m) => m.reason === "structured_list"));
	});

	it("explicit 让 Sol 复核 + code/quote is NOT vetoed (shallow negative only)", () => {
		const code = classifySolTrigger("让 Sol 复核这段代码：\n```ts\nconst password = \"x\";\n```");
		assert.equal(code.candidate, true);
		assert.ok(code.suppressed.some((s) => s.reason === "code_heavy"));
		const quote = classifySolTrigger("> 方案A：事件驱动\n> 方案B：轮询\n请 Sol 复核");
		assert.equal(quote.candidate, true);
		assert.ok(quote.suppressed.some((s) => s.reason === "quote_heavy"));
	});

	it("decision words (应该/compare/vs) reach candidate", () => {
		assert.equal(classifySolTrigger("应该采用事件溯源还是状态快照？").candidate, true);
		assert.equal(classifySolTrigger("Compare Postgres vs ClickHouse for this workload.").candidate, true);
		assert.equal(classifySolTrigger("A 和 B 对比一下哪个更合适").candidate, true);
	});

	it("risk / failure-mode analysis reaches candidate", () => {
		const c = classifySolTrigger("分析这套架构的主要风险、失败模式和替代方案");
		assert.equal(c.candidate, true);
		assert.ok(c.matches.some((m) => m.reason === "risk_analysis"));
	});
});

describe("classifySolTrigger — suppressors", () => {
	it("greetings are vetoed as quick_chat", () => {
		const c = classifySolTrigger("好的");
		assert.equal(c.candidate, false);
		assert.equal(c.near, false);
		assert.ok(c.suppressed.some((s) => s.reason === "quick_chat"));
	});

	it("code-only messages are suppressed (code_heavy, not veto)", () => {
		const c = classifySolTrigger("```json\n{\"a\": 1}\n```");
		assert.equal(c.candidate, false);
		assert.ok(c.suppressed.some((s) => s.reason === "code_heavy"));
	});

	it("pasted errors are suppressed", () => {
		const c = classifySolTrigger("报错了：TypeError: x is not a function");
		assert.equal(c.candidate, false);
		assert.ok(c.suppressed.some((s) => s.reason === "pasted_error"));
	});

	it("explicit opt-out never becomes a candidate", () => {
		const c = classifySolTrigger("不用问 Sol 了，直接帮我改");
		assert.equal(c.candidate, false);
		assert.ok(c.suppressed.some((s) => s.reason === "explicit_optout"));
	});

	it("opt-out beats many positive signals (veto, not -3)", () => {
		const c = classifySolTrigger("不用问 Sol。请评审这个系统设计，调研业界最佳实践，并给我建议……");
		assert.equal(c.candidate, false);
		assert.ok(c.suppressed.some((s) => s.reason === "explicit_optout"));
	});

	it("negation is vetoed — 并不是在请求第二意见 must not fire second_opinion", () => {
		const c = classifySolTrigger("这是我们当前架构评审记录和行业现状，资料如下……并不是在请求第二意见……你收到吗？");
		assert.equal(c.candidate, false);
		assert.ok(c.suppressed.some((s) => s.reason === "negation_veto"));
	});

	it("local-only lookups are suppressed", () => {
		const c = classifySolTrigger("在本地仓库里搜一下这个函数叫什么");
		assert.equal(c.candidate, false);
		assert.ok(c.suppressed.some((s) => s.reason === "local_only_lookup"));
	});
});

describe("classifySolTrigger — stability", () => {
	it("same prompt yields same id", () => {
		const a = classifySolTrigger("让 Sol 复核一下这个方案");
		const b = classifySolTrigger("让 Sol 复核一下这个方案");
		assert.equal(a.id, b.id);
		assert.equal(a.id, hashSolText(a.normalized));
	});
});
