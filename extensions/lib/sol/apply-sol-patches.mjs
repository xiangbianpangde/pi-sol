#!/usr/bin/env node
/**
 * Restore ChatGPT Plus High / Power-slider patches into installed pi-oracle.
 * Called automatically by the /sol extension. The in-Pi model may run this
 * file if a submit still fails with the old effort-dropdown error. Humans
 * are not the operator.
 *
 *   node ~/.pi/agent/extensions/lib/sol/apply-sol-patches.mjs
 *   node ~/.pi/agent/extensions/lib/sol/apply-sol-patches.mjs --restore
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VENDORED_ORACLE_VERSION = "0.7.20";

export const SOL_PATCH_MARKERS = {
	helpers: [
		"function isPowerSliderCompactMenu",
		"function detectPowerSliderSelection",
		"LEGACY_COMPACT_INTELLIGENCE_MENU_PATTERN",
		"POWER_SLIDER_MENUITEM_PATTERN",
		"export function snapshotHasPowerSliderCompactMenu",
	],
	runJob: [
		"async function waitForChatGptModelPicker",
		"async function trySelectPowerSliderHigh",
		"Composer is ready but the model picker has not hydrated yet",
		"!assumedDefaultThinkingFallback",
		"visible compact selection is",
	],
};

export function defaultOracleRoot(env = process.env) {
	return env.PI_ORACLE_ROOT?.trim() || join(env.HOME ?? "", ".pi/agent/npm/node_modules/pi-oracle");
}

export function defaultVendorDir() {
	return join(dirname(fileURLToPath(import.meta.url)), "vendor");
}

function readInstalledOracleVersion(root) {
	const packagePath = join(root, "package.json");
	if (!existsSync(packagePath)) return undefined;
	try {
		const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
		return typeof pkg.version === "string" ? pkg.version : undefined;
	} catch {
		return undefined;
	}
}

function readVendoredOracleVersion(vendor) {
	const path = join(vendor, "ORACLE_VERSION");
	if (!existsSync(path)) return VENDORED_ORACLE_VERSION;
	const value = readFileSync(path, "utf8").trim();
	return value || VENDORED_ORACLE_VERSION;
}

function missingNeedles(path, needles) {
	if (!existsSync(path)) return [`missing file ${path}`];
	const text = readFileSync(path, "utf8");
	return needles.filter((needle) => !text.includes(needle));
}

export function ensureSolOraclePatches(options = {}) {
	const root = options.root ?? defaultOracleRoot();
	const vendor = options.vendor ?? defaultVendorDir();
	const helpers = join(root, "extensions/oracle/worker/chatgpt-ui-helpers.mjs");
	const helpersDts = join(root, "extensions/oracle/worker/chatgpt-ui-helpers.d.mts");
	const runJob = join(root, "extensions/oracle/worker/run-job.mjs");
	const vendorHelpers = join(vendor, "chatgpt-ui-helpers.mjs");
	const vendorHelpersDts = join(vendor, "chatgpt-ui-helpers.d.mts");
	const vendorRunJob = join(vendor, "run-job.mjs");

	const missing = [
		...missingNeedles(helpers, SOL_PATCH_MARKERS.helpers).map((item) => `helpers: ${item}`),
		...missingNeedles(runJob, SOL_PATCH_MARKERS.runJob).map((item) => `run-job: ${item}`),
	];

	if (!options.force && missing.length === 0) {
		return { ok: true, restored: false, missing: [], root };
	}

	const installedVersion = readInstalledOracleVersion(root);
	const vendoredVersion = readVendoredOracleVersion(vendor);
	if (installedVersion !== vendoredVersion) {
		return {
			ok: false,
			restored: false,
			missing,
			root,
			error: `pi-oracle ${installedVersion ?? "unknown"} is not vendored ${vendoredVersion}; refusing to overwrite worker files. Re-vendor High/Power-slider patches for this version. Do not ask the user to run apply scripts.`,
		};
	}

	if (!existsSync(vendorHelpers) || !existsSync(vendorRunJob) || !existsSync(vendorHelpersDts)) {
		return {
			ok: false,
			restored: false,
			missing,
			root,
			error: `vendor High/Power-slider copies missing under ${vendor}`,
		};
	}

	try {
		copyFileSync(vendorHelpers, helpers);
		copyFileSync(vendorHelpersDts, helpersDts);
		copyFileSync(vendorRunJob, runJob);
	} catch (error) {
		return {
			ok: false,
			restored: false,
			missing,
			root,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const leftover = [
		...missingNeedles(helpers, SOL_PATCH_MARKERS.helpers),
		...missingNeedles(runJob, SOL_PATCH_MARKERS.runJob),
	];
	if (leftover.length) {
		return {
			ok: false,
			restored: true,
			missing: leftover,
			root,
			error: `vendor restore did not apply: ${leftover.join(", ")}`,
		};
	}

	return { ok: true, restored: true, missing, root };
}

export function formatSolPatchNote(result) {
	if (!result.ok) {
		return ` /sol worker patches missing (${result.error ?? result.missing.join(", ")}). Do not ask the user to run scripts. Report this blocker and retry /sol after vendor copies exist.`;
	}
	if (result.restored) {
		return " Restored ChatGPT Plus High/Power-slider worker patches after a pi-oracle update. Continue with oracle_submit preset thinking_extended. Never tell the user to run apply scripts.";
	}
	return undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
	const result = ensureSolOraclePatches({ force: process.argv.includes("--restore") });
	if (!result.ok) {
		console.error(result.error ?? result.missing.join("\n"));
		process.exit(1);
	}
	if (result.restored) console.log("restored patched worker files from lib/sol/vendor");
	console.log("ok: /sol ChatGPT Plus High + Power-slider patches are present");
}
