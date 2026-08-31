#!/usr/bin/env node
/**
 * Restore ChatGPT Plus High / Power-slider patches into installed pi-oracle.
 * Called automatically by the /sol extension. The in-Pi model may run this
 * file if a submit still fails with the old effort-dropdown error. Humans
 * are not the operator.
 *
 *   node ~/.pi/agent/extensions/lib/sol/apply-sol-patches.mjs
 *   node ~/.pi/agent/extensions/lib/sol/apply-sol-patches.mjs --restore
 *   node ~/.pi/agent/extensions/lib/sol/apply-sol-patches.mjs --revendor
 *
 * Stability model:
 * - vendor/ holds full patched worker copies for one pi-oracle version
 *   (ORACLE_VERSION records which).
 * - vendor/sol-high-power-slider.patch is the unified diff pristine → patched.
 *   When `pi update npm:pi-oracle` installs a NEW version, ensure() re-applies
 *   that patch to the new pristine worker files (revendor) instead of
 *   overwriting new upstream code with stale copies. Rejects, marker gaps,
 *   or syntax errors fail loudly — never silently.
 * - After every copy, `node --check` validates the worker files so a
 *   truncated write can never reach a real /sol submit.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VENDORED_ORACLE_VERSION = "0.7.20";
export const SOL_PATCH_FILE = "sol-high-power-slider.patch";

const WORKER_RELATIVE_FILES = [
	"extensions/oracle/worker/chatgpt-ui-helpers.mjs",
	"extensions/oracle/worker/chatgpt-ui-helpers.d.mts",
	"extensions/oracle/worker/run-job.mjs",
];
const SYNTAX_CHECKED_FILES = [
	"extensions/oracle/worker/chatgpt-ui-helpers.mjs",
	"extensions/oracle/worker/run-job.mjs",
];

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
		"function sanitizeProviderBlockerSnapshot",
		"while the model is still streaming (Stop control visible)",
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

function missingMarkers(root) {
	const helpers = join(root, "extensions/oracle/worker/chatgpt-ui-helpers.mjs");
	const runJob = join(root, "extensions/oracle/worker/run-job.mjs");
	return [
		...missingNeedles(helpers, SOL_PATCH_MARKERS.helpers).map((item) => `helpers: ${item}`),
		...missingNeedles(runJob, SOL_PATCH_MARKERS.runJob).map((item) => `run-job: ${item}`),
	];
}

function syntaxCheckErrors(files) {
	const errors = [];
	for (const file of files) {
		const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
		if (result.status !== 0) {
			errors.push(`${file}: ${(result.stderr || result.stdout || `exit ${result.status}`).trim().split("\n")[0]}`);
		}
	}
	return errors;
}

/**
 * Re-apply vendor/sol-high-power-slider.patch to the installed (pristine,
 * new-version) worker files and refresh vendor copies. Only runs when the
 * installed pi-oracle version differs from the vendored one and the installed
 * files lost the patch markers. Fails loudly on any reject, missing marker,
 * or syntax error; previous vendor copies are kept under vendor/previous/.
 */
export function revendorSolOraclePatches(options = {}) {
	const root = options.root ?? defaultOracleRoot();
	const vendor = options.vendor ?? defaultVendorDir();
	const installedVersion = readInstalledOracleVersion(root);
	const vendoredVersion = readVendoredOracleVersion(vendor);
	const patchPath = join(vendor, SOL_PATCH_FILE);

	if (!installedVersion) {
		return { ok: false, revendored: false, error: `cannot read pi-oracle version under ${root}` };
	}
	if (installedVersion === vendoredVersion && !options.force) {
		return { ok: true, revendored: false, version: installedVersion };
	}
	if (!existsSync(patchPath)) {
		return {
			ok: false,
			revendored: false,
			error: `pi-oracle ${installedVersion} is not vendored ${vendoredVersion} and ${SOL_PATCH_FILE} is missing; refusing to overwrite worker files. Re-vendor High/Power-slider patches for this version. Do not ask the user to run apply scripts.`,
		};
	}

	const staging = mkdtempSync(join(tmpdir(), "sol-revendor-"));
	try {
		for (const rel of WORKER_RELATIVE_FILES) {
			const source = join(root, rel);
			if (!existsSync(source)) {
				return { ok: false, revendored: false, error: `pi-oracle ${installedVersion} is missing ${rel}; cannot re-apply /sol patches` };
			}
			const dest = join(staging, rel);
			mkdirSync(dirname(dest), { recursive: true });
			copyFileSync(source, dest);
		}

		const rejectPath = join(staging, "sol.rej");
		const applied = spawnSync(
			"patch",
			["-p1", "-s", "-t", "-N", "--no-backup-if-mismatch", "-r", rejectPath, "-d", staging, "-i", patchPath],
			{ encoding: "utf8" },
		);
		if (applied.error) {
			return { ok: false, revendored: false, error: `cannot run patch(1): ${applied.error.message}` };
		}
		if (applied.status !== 0 || existsSync(rejectPath)) {
			const rejects = existsSync(rejectPath) ? readFileSync(rejectPath, "utf8").trim().split("\n").slice(0, 6).join("\n") : "";
			return {
				ok: false,
				revendored: false,
				error: `/sol patch does not apply cleanly to pi-oracle ${installedVersion} (patch exit ${applied.status}). Upstream worker changed; re-vendor manually from ${patchPath}.\n${rejects}`,
			};
		}

		const markerGaps = missingMarkers(staging);
		if (markerGaps.length) {
			return { ok: false, revendored: false, error: `patched pi-oracle ${installedVersion} worker is missing markers: ${markerGaps.join(", ")}` };
		}
		const syntaxErrors = syntaxCheckErrors(SYNTAX_CHECKED_FILES.map((rel) => join(staging, rel)));
		if (syntaxErrors.length) {
			return { ok: false, revendored: false, error: `patched pi-oracle ${installedVersion} worker fails node --check: ${syntaxErrors.join("; ")}` };
		}

		// Keep the previous vendor set for rollback; ~/.pi/agent is not a git repo.
		const previous = join(vendor, "previous");
		mkdirSync(previous, { recursive: true });
		for (const name of [...WORKER_RELATIVE_FILES.map((rel) => rel.split("/").pop()), "ORACLE_VERSION"]) {
			const from = join(vendor, name);
			if (existsSync(from)) copyFileSync(from, join(previous, name));
		}

		for (const rel of WORKER_RELATIVE_FILES) {
			copyFileSync(join(staging, rel), join(vendor, rel.split("/").pop()));
		}
		writeFileSync(join(vendor, "ORACLE_VERSION"), `${installedVersion}\n`, "utf8");
		return { ok: true, revendored: true, version: installedVersion, previousVersion: vendoredVersion };
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
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

	const missing = missingMarkers(root);

	if (!options.force && missing.length === 0) {
		return { ok: true, restored: false, missing: [], root };
	}

	const installedVersion = readInstalledOracleVersion(root);
	let vendoredVersion = readVendoredOracleVersion(vendor);
	let revendored = false;
	if (installedVersion !== vendoredVersion) {
		const revendor = revendorSolOraclePatches({ root, vendor });
		if (!revendor.ok) {
			return { ok: false, restored: false, missing, root, error: revendor.error };
		}
		revendored = revendor.revendored;
		vendoredVersion = readVendoredOracleVersion(vendor);
		if (installedVersion !== vendoredVersion) {
			return {
				ok: false,
				restored: false,
				missing,
				root,
				error: `pi-oracle ${installedVersion ?? "unknown"} is not vendored ${vendoredVersion}; refusing to overwrite worker files. Do not ask the user to run apply scripts.`,
			};
		}
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

	const syntaxErrors = syntaxCheckErrors([helpers, runJob]);
	if (syntaxErrors.length) {
		return {
			ok: false,
			restored: true,
			missing,
			root,
			error: `restored worker files fail node --check: ${syntaxErrors.join("; ")}`,
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

	return { ok: true, restored: true, revendored, missing, root };
}

export function formatSolPatchNote(result) {
	if (!result.ok) {
		return ` /sol worker patches missing (${result.error ?? result.missing.join(", ")}). Do not ask the user to run scripts. Report this blocker and retry /sol after vendor copies exist.`;
	}
	if (result.revendored) {
		return " pi-oracle updated; /sol re-applied the High/Power-slider patch to the new worker and refreshed vendor copies. Continue with oracle_submit preset thinking_extended. Never tell the user to run apply scripts.";
	}
	if (result.restored) {
		return " Restored ChatGPT Plus High/Power-slider worker patches after a pi-oracle update. Continue with oracle_submit preset thinking_extended. Never tell the user to run apply scripts.";
	}
	return undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
	const argv = process.argv.slice(2);
	if (argv.includes("--revendor")) {
		const result = revendorSolOraclePatches({ force: argv.includes("--force") });
		if (!result.ok) {
			console.error(result.error);
			process.exit(1);
		}
		console.log(result.revendored ? `revendored /sol patches for pi-oracle ${result.version}` : `ok: vendor already matches pi-oracle ${result.version}`);
		process.exit(0);
	}
	const result = ensureSolOraclePatches({ force: argv.includes("--restore") });
	if (!result.ok) {
		console.error(result.error ?? result.missing.join("\n"));
		process.exit(1);
	}
	if (result.revendored) console.log("revendored patched worker files for the installed pi-oracle version");
	if (result.restored) console.log("restored patched worker files from lib/sol/vendor");
	console.log("ok: /sol ChatGPT Plus High + Power-slider patches are present");
}
