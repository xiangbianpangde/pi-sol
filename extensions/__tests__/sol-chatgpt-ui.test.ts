/**
 * ChatGPT Plus compact High / Power-slider UI used by /sol (pi-oracle 0.7.20).
 * Run: node --experimental-strip-types --test extensions/__tests__/sol-chatgpt-ui.test.ts
 *
 * These fixtures are trimmed from real 2026-08-18 oracle snapshots:
 * - closed High button → successful thinking_extended job 72bd9e38
 * - open High + Power slider → failed jobs that then hunted a missing effort dropdown
 * - composer without the High picker yet → failed job 63411a6d
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	classifyProviderBlockerEvidence,
	countChatGptCopyControls,
	effortSelectionVisible,
	sanitizeProviderBlockerSnapshot,
	snapshotCanSafelySkipModelConfiguration,
	snapshotHasChatGptComposerIdle,
	snapshotHasChatGptSendReady,
	snapshotHasChatGptStopControl,
	snapshotHasModelConfigurationUi,
	snapshotHasModelOpener,
	snapshotHasUsableComposerControls,
	snapshotStronglyMatchesRequestedModel,
} from "../lib/sol/vendor/chatgpt-ui-helpers.mjs";

const THINKING_EXTENDED = {
	modelFamily: "thinking" as const,
	effort: "extended" as const,
	autoSwitchToThinking: false,
};

const INSTANT = {
	modelFamily: "instant" as const,
	autoSwitchToThinking: false,
};

const HIGH_CLOSED = `
- heading "What's on your mind today?" [level=1, ref=e114]
- button "Add files and more" [expanded=false, ref=e116]
- textbox "Chat with ChatGPT" [ref=e117]
- button "High" [expanded=false, ref=e120]
- button "Start dictation" [ref=e118]
- button "Start Voice" [ref=e121]
`;

const HIGH_POWER_OPEN = `
- heading "Where should we begin?" [level=1, ref=e118]
- button "Add files and more" [expanded=false, ref=e120]
- textbox "Chat with ChatGPT" [ref=e121]
- button "High" [expanded=true, ref=e124]
- button "Start dictation" [ref=e122]
- button "Start Voice" [ref=e125]
- menu "High" [ref=e2] clickable [onclick]
  - menuitem "Power" [ref=e5]
  - menuitem "Show advanced options" [expanded=false, ref=e15]
`;

const INCOMPLETE_COMPOSER = `
- heading "Ready when you are." [level=1, ref=e86]
- button "Add files and more" [expanded=false, ref=e88]
- textbox "Chat with ChatGPT" [ref=e89]
- button "Send prompt" [disabled, ref=e90]
`;

const INSTANT_CLOSED = `
- button "Add files and more" [expanded=false, ref=e116]
- textbox "Chat with ChatGPT" [ref=e117]
- button "Instant" [expanded=false, ref=e120]
`;

const MEDIUM_POWER_OPEN = `
- button "Add files and more" [expanded=false, ref=e120]
- textbox "Chat with ChatGPT" [ref=e121]
- button "Medium" [expanded=true, ref=e124]
- menu "Medium" [ref=e2]
  - menuitem "Power" [ref=e5]
  - menuitem "Show advanced options" [expanded=false, ref=e15]
`;

describe("closed High composer pill", () => {
	it("is already GPT-5.6 Sol High / thinking_extended", () => {
		assert.equal(snapshotHasModelOpener(HIGH_CLOSED), true);
		assert.equal(snapshotStronglyMatchesRequestedModel(HIGH_CLOSED, THINKING_EXTENDED), true);
		assert.equal(snapshotCanSafelySkipModelConfiguration(HIGH_CLOSED, THINKING_EXTENDED), true);
		assert.equal(effortSelectionVisible(HIGH_CLOSED, "Extended"), true);
	});

	it("is not Instant", () => {
		assert.equal(snapshotCanSafelySkipModelConfiguration(HIGH_CLOSED, INSTANT), false);
	});
});

describe("open High + Power slider popover (2026 ChatGPT Plus UI)", () => {
	it("still counts as already-selected Sol High, not a legacy Instant/Thinking/Pro sheet", () => {
		assert.equal(snapshotHasUsableComposerControls(HIGH_POWER_OPEN), true);
		assert.equal(snapshotHasModelOpener(HIGH_POWER_OPEN), true);
		assert.equal(snapshotStronglyMatchesRequestedModel(HIGH_POWER_OPEN, THINKING_EXTENDED), true);
		assert.equal(snapshotCanSafelySkipModelConfiguration(HIGH_POWER_OPEN, THINKING_EXTENDED), true);
		assert.equal(effortSelectionVisible(HIGH_POWER_OPEN, "Extended"), true);
	});

	it("does not look like the old model-configuration sheet that needs an effort dropdown", () => {
		assert.equal(snapshotHasModelConfigurationUi(HIGH_POWER_OPEN), false);
	});

	it("does not match Instant", () => {
		assert.equal(snapshotStronglyMatchesRequestedModel(HIGH_POWER_OPEN, INSTANT), false);
	});
});

describe("real 2026-08-18 failure snapshots", () => {
	it("treats the Power-slider High popover as already-selected Sol High", async () => {
		const { existsSync } = await import("node:fs");
		const { readFile } = await import("node:fs/promises");
		const path = "/tmp/oracle-c7c715ed-df71-41c8-8e0a-aaf2f1cdaef7/logs/failure.snapshot.txt";
		if (!existsSync(path)) return;
		const snapshot = await readFile(path, "utf8");
		assert.equal(snapshotStronglyMatchesRequestedModel(snapshot, THINKING_EXTENDED), true);
		assert.equal(snapshotCanSafelySkipModelConfiguration(snapshot, THINKING_EXTENDED), true);
		assert.equal(snapshotHasModelConfigurationUi(snapshot), false);
		assert.equal(effortSelectionVisible(snapshot, "Extended"), true);
	});
});

describe("non-High Power-slider pills must not look like Sol High", () => {
	it("does not skip Instant or Medium for thinking_extended", () => {
		assert.equal(snapshotCanSafelySkipModelConfiguration(INSTANT_CLOSED, THINKING_EXTENDED), false);
		assert.equal(snapshotStronglyMatchesRequestedModel(INSTANT_CLOSED, THINKING_EXTENDED), false);
		assert.equal(snapshotCanSafelySkipModelConfiguration(MEDIUM_POWER_OPEN, THINKING_EXTENDED), false);
		assert.equal(snapshotStronglyMatchesRequestedModel(MEDIUM_POWER_OPEN, THINKING_EXTENDED), false);
		assert.equal(snapshotHasModelConfigurationUi(MEDIUM_POWER_OPEN), false);
	});
});

describe("send-accepted detection on the 2026 composer", () => {
	it("treats Stop answering as an in-flight Sol response", () => {
		const streaming = `
- button "Inspecting Uploaded Tar Archive" [ref=e205]
- button "Add files and more" [expanded=false, ref=e206]
- textbox "Chat with ChatGPT" [ref=e207]
- button "High" [expanded=false, ref=e247]
- button "Start dictation" [ref=e208]
- button "Stop answering" [ref=e209]
`;
		assert.equal(snapshotHasChatGptStopControl(streaming), true);
		assert.equal(snapshotHasChatGptStopControl(HIGH_CLOSED), false);
		assert.equal(snapshotHasChatGptStopControl('- button "Stop streaming" [ref=e1]'), true);
		assert.equal(snapshotHasChatGptStopControl('paragraph "Do not Stop answering in prose"'), false);
	});

	it("treats Send prompt enabled as the reply being done", () => {
		const idle = `
- button "Add files and more" [expanded=false, ref=e120]
- textbox "Chat with ChatGPT" [ref=e121]
- button "High" [expanded=false, ref=e124]
- button "Send prompt" [ref=e90]
`;
		assert.equal(snapshotHasChatGptSendReady(idle), true);
		assert.equal(snapshotHasChatGptSendReady(HIGH_CLOSED), false);
		assert.equal(countChatGptCopyControls('- button "Copy response" [ref=e1]\n- button "Copy message" [ref=e2]'), 2);
	});

	it("treats empty composer + Start Voice as idle after a finished reply", () => {
		const afterReply = `
- button "Copy response" [ref=e233]
- button "Add files and more" [expanded=false, ref=e250]
- textbox "Chat with ChatGPT" [ref=e251]
- button "High" [expanded=false, ref=e405]
- button "Start dictation" [ref=e252]
- button "Start Voice" [ref=e406]
`;
		assert.equal(snapshotHasChatGptComposerIdle(afterReply), true);
		assert.equal(snapshotHasChatGptSendReady(afterReply), false);
		assert.equal(snapshotHasChatGptStopControl(afterReply), false);
	});
});

describe("composer before the High picker hydrates", () => {
	it("is usable for auth but is not a configured High selection", () => {
		assert.equal(snapshotHasUsableComposerControls(INCOMPLETE_COMPOSER), true);
		assert.equal(snapshotHasModelOpener(INCOMPLETE_COMPOSER), false);
		assert.equal(snapshotHasModelConfigurationUi(INCOMPLETE_COMPOSER), false);
		assert.equal(snapshotCanSafelySkipModelConfiguration(INCOMPLETE_COMPOSER, THINKING_EXTENDED), false);
	});
});

describe("provider blocker snapshot sanitizer (P1-2/P1-3 regression)", () => {
	const labels = { composerLabel: "Chat with ChatGPT" };

	it("does not flag a composer value containing 'rate limit'", () => {
		const snapshot = `
- navigation "Chat history" [ref=e3]
  - link "旧对话" [ref=e26]
- heading "What's on your mind today?" [level=1, ref=e114]
- textbox "Chat with ChatGPT" [ref=e122]: 分析为什么这个 rate limit 是误报
- button "Send prompt" [ref=e119]
`;
		const out = sanitizeProviderBlockerSnapshot(snapshot, labels);
		assert.ok(!/rate limit/i.test(out), `composer text leaked: ${out}`);
		assert.ok(!/旧对话/.test(out), `sidebar leaked: ${out}`);
	});

	it("does not flag a multi-line composer value containing 'Too many requests'", () => {
		const snapshot = `
- navigation "Chat history" [ref=e3]
  - link "历史" [ref=e26]
- heading "What's on your mind today?" [level=1, ref=e114]
- textbox "Chat with ChatGPT" [ref=e122]: 第一行
  第二行包含 Too many requests
- button "Send prompt" [ref=e119]
`;
		const out = sanitizeProviderBlockerSnapshot(snapshot, labels);
		assert.ok(!/too many requests/i.test(out), `composer leaked: ${out}`);
	});

	it("does not flag a sidebar title containing 'rate limit'", () => {
		const snapshot = `
- navigation "Chat history" [ref=e3]
  - link "解释 rate limit 含义" [ref=e26]
  - link "Too many requests 分析" [ref=e27]
- textbox "Chat with ChatGPT" [ref=e122]
- button "Send prompt" [ref=e119]
`;
		const out = sanitizeProviderBlockerSnapshot(snapshot, labels);
		assert.ok(!/rate limit/i.test(out), `sidebar leaked: ${out}`);
		assert.ok(!/too many requests/i.test(out), `sidebar leaked: ${out}`);
	});

	it("does not flag a user message that re-entered main conversation after send", () => {
		const snapshot = `
- navigation "Chat history" [ref=e3]
  - link "历史" [ref=e26]
- generic "请审核 rate limit 的处理" [ref=e112]
- heading "Sol 回复正文" [level=2, ref=e133]
- textbox "Chat with ChatGPT" [ref=e122]
- button "Send prompt" [ref=e119]
`;
		const out = sanitizeProviderBlockerSnapshot(snapshot, labels);
		assert.ok(!/rate limit/i.test(out), `conversation leaked: ${out}`);
	});

	it("still detects a main provider banner 'Too many requests' when composer is present", () => {
		const snapshot = `
- navigation "Chat history" [ref=e3]
  - link "历史" [ref=e26]
- textbox "Chat with ChatGPT" [ref=e122]
- button "Send prompt" [ref=e119]
- alert "Too many requests in one hour" [ref=e210]
`;
		const out = sanitizeProviderBlockerSnapshot(snapshot, labels);
		assert.match(out, /Too many requests/);
	});

	it("still detects a provider banner when Send button is missing (limit page)", () => {
		const snapshot = `
- textbox "Chat with ChatGPT" [ref=e122]
- alert "You've hit your rate limit" [ref=e210]
`;
		const out = sanitizeProviderBlockerSnapshot(snapshot, labels);
		assert.match(out, /rate limit/);
	});

	it("falls back to the page when the composer is gone (full-page outage)", () => {
		const snapshot = `
- heading "Too many requests" [level=1, ref=e1]
- paragraph "Please try again later" [ref=e2]
`;
		// Strong (surfaces) is empty; the weak fallback carries the page text for
		// multi-frame confirmation by the worker.
		const out = sanitizeProviderBlockerSnapshot(snapshot, labels);
		assert.equal(out, "");
		const evidence = classifyProviderBlockerEvidence(snapshot, labels);
		assert.match(evidence.fallback, /Too many requests/);
	});
});

describe("provider blocker sanitizer — audit round 2 boundaries (P1-3)", () => {
	const labels = { composerLabel: "Chat with ChatGPT" };

	it("collects error-role subtree text (child paragraph carries the keyword)", () => {
		const snapshot = `
- textbox "Chat with ChatGPT" [ref=e1]
- alert "Usage warning" [ref=e2]
  - paragraph "Too many requests. Try again later." [ref=e3]
- button "Send prompt" [ref=e4]
`;
		const out = sanitizeProviderBlockerSnapshot(snapshot, labels);
		assert.match(out, /Too many requests/);
	});

	it("handles an unnamed error role whose child carries the blocker text", () => {
		const snapshot = `
- textbox "Chat with ChatGPT" [ref=e1]
- alert [ref=e2]
  - paragraph "You've hit your rate limit" [ref=e3]
`;
		const out = sanitizeProviderBlockerSnapshot(snapshot, labels);
		assert.match(out, /rate limit/);
	});

	it("collects dialog/banner/log subtrees too", () => {
		const snapshot = `
- textbox "Chat with ChatGPT" [ref=e1]
- dialog "Error" [ref=e2]
  - paragraph "Something went wrong: rate limit" [ref=e3]
- banner "notice" [ref=e4]
  - paragraph "Too many requests" [ref=e5]
`;
		const out = sanitizeProviderBlockerSnapshot(snapshot, labels);
		assert.match(out, /rate limit/);
		assert.match(out, /Too many requests/);
	});

	it("does not scan user conversation when the composer is temporarily absent (rerender)", () => {
		const snapshot = `
- generic "请审核 rate limit 的处理" [ref=e112]
- button "Copy message" [ref=e113]
- button "Stop answering" [ref=e209]
`;
		const out = sanitizeProviderBlockerSnapshot(snapshot, labels);
		assert.ok(!/rate limit/i.test(out), `user text leaked without composer: ${out}`);
	});

	it("still falls back to the page for a true full-page outage (no composer, no conversation chrome)", () => {
		const snapshot = `
- heading "Too many requests" [level=1, ref=e1]
- paragraph "Please try again later" [ref=e2]
`;
		const out = sanitizeProviderBlockerSnapshot(snapshot, labels);
		assert.equal(out, ""); // strong evidence is empty; fallback is weak signal
		const evidence = classifyProviderBlockerEvidence(snapshot, labels);
		assert.match(evidence.fallback, /Too many requests/);
	});
});

describe("provider blocker evidence — audit round 3 boundaries", () => {
	const labels = { composerLabel: "Chat with ChatGPT" };

	it("does not leak user text when composer and chrome are both transiently absent", () => {
		const snapshot = `
- generic "请审核 rate limit 的处理" [ref=e112]
- heading "Sol 正在生成" [ref=e133]
`;
		const evidence = classifyProviderBlockerEvidence(snapshot, labels);
		// Strong surfaces must be empty; the weak fallback must NOT be auto-trusted —
		// it is only returned for multi-frame confirmation, and the caller decides.
		assert.equal(evidence.surfaces, "");
		assert.ok(!/rate limit/i.test(evidence.surfaces));
	});

	it("detects a composer nested inside an error-role subtree (hasComposer must update)", () => {
		const snapshot = `
- dialog "shell" [ref=e1]
  - textbox "Chat with ChatGPT" [ref=e2]
- generic "请检查 rate limit 问题" [ref=e3]
`;
		const evidence = classifyProviderBlockerEvidence(snapshot, labels);
		assert.equal(evidence.hasComposer, true);
		// Because the composer exists, the weak fallback is disabled — user text
		// cannot re-enter detection through the fallback.
		assert.equal(evidence.fallback, "");
	});

	it("collects 3+ level descendant text inside an error role", () => {
		const snapshot = `
- alert "Usage warning" [ref=e1]
  - generic [ref=e2]
    - group [ref=e3]
      - paragraph "Too many requests. Try again later." [ref=e4]
- textbox "Chat with ChatGPT" [ref=e5]
`;
		const evidence = classifyProviderBlockerEvidence(snapshot, labels);
		assert.match(evidence.surfaces, /Too many requests/);
	});

	it("collects status and log role subtrees", () => {
		const snapshot = `
- textbox "Chat with ChatGPT" [ref=e1]
- status "notice" [ref=e2]
  - paragraph "rate limit approaching" [ref=e3]
- log "audit" [ref=e4]
  - paragraph "Too many requests logged" [ref=e5]
`;
		const evidence = classifyProviderBlockerEvidence(snapshot, labels);
		assert.match(evidence.surfaces, /rate limit/);
		assert.match(evidence.surfaces, /Too many requests/);
	});

	it("does not scan user text when the page is a normal conversation (strong surfaces only)", () => {
		const snapshot = `
- navigation "Chat history" [ref=e3]
  - link "rate limit 讨论" [ref=e26]
- generic "请审核 rate limit 的处理" [ref=e112]
- textbox "Chat with ChatGPT" [ref=e122]
- button "Send prompt" [ref=e119]
`;
		const evidence = classifyProviderBlockerEvidence(snapshot, labels);
		assert.equal(evidence.surfaces, "");
		assert.equal(evidence.fallback, ""); // composer present → fallback disabled
	});

	it("does NOT include composer value inside error-role subtree in strong surfaces (P1-4)", () => {
		const snapshot = `
- dialog "shell" [ref=e1]
  - textbox "Chat with ChatGPT" [ref=e2]: 请审核 rate limit 的处理
- generic "请检查" [ref=e3]
`;
		const evidence = classifyProviderBlockerEvidence(snapshot, labels);
		// The composer textbox inside the dialog must NOT leak its value into
		// strong surfaces. The user's "rate limit" text must never become a
		// strong provider blocker.
		assert.ok(!/rate limit/i.test(evidence.surfaces), `composer value leaked into surfaces: ${evidence.surfaces}`);
		assert.equal(evidence.hasComposer, true); // composer was still detected
	});

	it("does NOT include multi-line composer continuation inside error-role subtree (P1-4)", () => {
		const snapshot = `
- dialog "shell" [ref=e1]
  - textbox "Chat with ChatGPT" [ref=e2]
    - generic "请审核 rate limit 的处理" [ref=e3]
- generic "请检查" [ref=e4]
`;
		const evidence = classifyProviderBlockerEvidence(snapshot, labels);
		// A deeper-indented generic under a composer textbox is user input
		// content (agent-browser renders the composer value as a plain/generic
		// continuation), never provider error text.
		assert.ok(!/rate limit/i.test(evidence.surfaces), `composer continuation leaked: ${evidence.surfaces}`);
	});

	it("does NOT include generic user message inside a dialog in strong surfaces (P1-4)", () => {
		const snapshot = `
- dialog "shell" [ref=e1]
  - generic "请审核 rate limit 的处理" [ref=e2]
- textbox "Chat with ChatGPT" [ref=e3]
- button "Send prompt" [ref=e4]
`;
		const evidence = classifyProviderBlockerEvidence(snapshot, labels);
		assert.ok(!/rate limit/i.test(evidence.surfaces), `generic dialog child leaked into surfaces: ${evidence.surfaces}`);
	});

	it("does NOT treat markdown list text inside the composer as a dialog element (P1-4 audit round 6 regression)", () => {
		// Real failure: our own audit prompt contained the markdown list line
		// `- dialog → paragraph "Too many requests" ...` which the loose
		// role regex matched as a dialog element, leaking the whole prompt
		// text into STRONG surfaces → false rate-limit page verdict.
		const snapshot = `
  - textbox "Chat with ChatGPT" [ref=e122]: 请作为审核员，对仓库进行复核。
### P1-C: sanitizer 只收 paragraph / 嵌套 error-role

**本轮修复**：descendant 循环整棵子树内只保留 kind 为 paragraph 的行。

请验证反例是否消除：

- dialog → textbox → 多行 composer 续行（generic）→ 不进 surfaces；

- dialog → paragraph "Too many requests" → 仍进 surfaces（真 error 不丢）；

- sidebar 子树在 error-role 内 → 不进 surfaces；
`;
		const evidence = classifyProviderBlockerEvidence(snapshot, labels);
		// The prompt's own markdown bullets must never enter surfaces.
		assert.ok(!/Too many requests/i.test(evidence.surfaces), `prompt markdown leaked: ${evidence.surfaces}`);
		assert.ok(!/dialog →/i.test(evidence.surfaces), `prompt markdown bullet leaked: ${evidence.surfaces}`);
		assert.ok(evidence.hasComposer, "composer should be detected");
	});

	it("still detects a real provider alert at the same indent as the composer (sibling, not composer value)", () => {
		const snapshot = `
- textbox "Chat with ChatGPT" [ref=e122]
- button "Send prompt" [ref=e119]
- alert "Too many requests in one hour" [ref=e210]
`;
		const evidence = classifyProviderBlockerEvidence(snapshot, labels);
		assert.match(evidence.surfaces, /Too many requests/);
	});

	it("does NOT treat an exact role-shaped markdown line as a provider element (audit round 6 P1)", () => {
		// A /sol audit prompt literally documents the counterexample it wants
		// checked: `- dialog "Too many requests"` is valid accessibility-snapshot
		// syntax but it is USER text (the composer value), not a provider element.
		// It must never become STRONG evidence.
		const snapshot = `
  - textbox "Chat with ChatGPT" [ref=e122]: 请审核下面的例子
- dialog "Too many requests"
- alert "rate limit"
- status
`;
		const evidence = classifyProviderBlockerEvidence(snapshot, labels);
		assert.equal(evidence.surfaces, "");
		assert.equal(evidence.hasComposer, true);
	});

	it("does NOT treat an exact role-shaped markdown line WITH a fake ref as a provider element (audit round 6 P1)", () => {
		// The strongest counterexample: user text that includes a ref marker
		// lookalike (`- alert [ref=e999]`).  It is still the composer VALUE
		// continuation (bare line after the composer), not a real element.
		const snapshot = `
  - textbox "Chat with ChatGPT" [ref=e122]: 请审核下面的例子
- alert [ref=e999]
`;
		const evidence = classifyProviderBlockerEvidence(snapshot, labels);
		assert.equal(evidence.surfaces, "");
		assert.equal(evidence.hasComposer, true);
	});

	it("still detects a real provider alert in a sibling container's subtree (audit round 6 P2)", () => {
		// The composer region must end at the next REAL element line, so a real
		// alert nested inside a sibling container is still STRONG evidence.
		const snapshot = `
- textbox "Chat with ChatGPT" [ref=e122]
- generic "provider shell" [ref=e200]
  - alert "Too many requests" [ref=e210]
`;
		const evidence = classifyProviderBlockerEvidence(snapshot, labels);
		assert.match(evidence.surfaces, /Too many requests/);
	});

	it("ends the composer region at the next real element so later provider errors are still detected (audit round 6 P2)", () => {
		const snapshot = `
- textbox "Chat with ChatGPT" [ref=e122]: 请审核下面的例子
- dialog → paragraph "Too many requests" → 示例文本
- button "Send prompt" [ref=e119]
- alert "You've hit your rate limit" [ref=e210]
`;
		const evidence = classifyProviderBlockerEvidence(snapshot, labels);
		assert.ok(!/示例文本/.test(evidence.surfaces), `prompt text leaked: ${evidence.surfaces}`);
		assert.match(evidence.surfaces, /rate limit/);
	});
});
