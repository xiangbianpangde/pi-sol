/**
 * ChatGPT Plus compact High / Power-slider UI used by /sol (pi-oracle 0.7.20).
 * Run: npx --yes tsx --test ~/.pi/agent/extensions/__tests__/sol-chatgpt-ui.test.ts
 *
 * These fixtures are trimmed from real 2026-08-18 oracle snapshots:
 * - closed High button → successful thinking_extended job 72bd9e38
 * - open High + Power slider → failed jobs that then hunted a missing effort dropdown
 * - composer without the High picker yet → failed job 63411a6d
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	effortSelectionVisible,
	snapshotCanSafelySkipModelConfiguration,
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
