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
import { createHash } from "node:crypto";
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
	// Audit round 2026-09-01: oracle_recover tool + recovery job type
	"extensions/oracle/lib/tools.ts",
	"extensions/oracle/lib/jobs.ts",
];
const SYNTAX_CHECKED_FILES = [
	"extensions/oracle/worker/chatgpt-ui-helpers.mjs",
	"extensions/oracle/worker/run-job.mjs",
	"extensions/oracle/lib/tools.ts",
	"extensions/oracle/lib/jobs.ts",
];

// Exact expected upstream hashes for authority-sensitive vendor files.
// These MUST be updated when a new pi-oracle version is vendored.
// If the installed upstream hash does not match (same-version revendor),
// revendor fails closed instead of silently applying a stale patch to
// changed upstream code.
const VENDOR_EXPECTED_HASHES = {
	"extensions/oracle/lib/tools.ts": "9bc3c688b81a9738f173ba167ffe0cab10e4c27d36308862d74062cbfa974bb4",
	"extensions/oracle/lib/jobs.ts": "6d20ab1579bf3b1a7e201b8a3482c4042f5c76f5359a80ee3ebfb1d2e6b8c3ac",
	"extensions/oracle/worker/run-job.mjs": "74bad8e94beb38d15817b8f97138237a334820b8dbd6e37488356888b3088cfb",
	"extensions/oracle/worker/chatgpt-ui-helpers.mjs": "58e21f3bc3574f5500b140ea7ec709113588530d60b8161d6c97ce4e2e6e519f",
	"extensions/oracle/worker/chatgpt-ui-helpers.d.mts": "3428d3c58026a7ffb53a9eabc369f3852c7574c72c1c9bb89546ee53ac50d92c",
};

export const SOL_PATCH_MARKERS = {
	helpers: [
		"function isPowerSliderCompactMenu",
		"function detectPowerSliderSelection",
		"LEGACY_COMPACT_INTELLIGENCE_MENU_PATTERN",
		"POWER_SLIDER_MENUITEM_PATTERN",
		"export function snapshotHasPowerSliderCompactMenu",
		// Audit round 6: role regex requires the element ref marker; old workers
		// without this marker must be redeployed even though all Power-slider
		// markers are present (a stale helper would re-open the composer
		// role-shaped-markdown false positive).
		"const ROLE_WITH_REF",
	],
	runJob: [
		"async function waitForChatGptModelPicker",
		"async function trySelectPowerSliderHigh",
		"Composer is ready but the model picker has not hydrated yet",
		"!assumedDefaultThinkingFallback",
		"visible compact selection is",
		"function sanitizeProviderBlockerSnapshot",
		"while the model is still streaming (Stop control visible)",
		// Audit round 2026-09-01 oracle_recover: old run-job.mjs workers without
		// the read-only recovery branch must be redeployed (a stale worker would
		// treat a recovery job as a normal submit and send a new turn).
		"async function waitForRecoveredAssistant",
		"Recovery job is missing its recoverySource anchor snapshot",
	],
	lib: [
		// Audit round 2026-09-01 oracle_recover: old lib files without the
		// recovery tool must be redeployed so the extension registers
		// oracle_recover and recovery job fields.
		"oracle_recover",
		"jobKind",
		"recoverySource",
	],
	jobs: [
		// Audit round 2026-09-01 oracle_recover: recovery job type fields.
		"jobKind",
		"recoverySource",
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

function computeVendorDigest(vendor) {
	// Digest of the authority-sensitive vendor files AND the vendored version
	// string, so tampering with ORACLE_VERSION cannot skip the revendor branch
	// or route an old vendor set onto a newer pi-oracle (audit P2-N2).
	const entries = { oracleVersion: readVendoredOracleVersion(vendor) };
	for (const name of ["tools.ts", "jobs.ts"]) {
		const path = join(vendor, name);
		if (!existsSync(path)) return undefined; // missing vendor authority file — fail closed at verify
		entries[name] = sha256File(path);
	}
	return entries;
}

function readVendorDigest(vendor) {
	const path = join(vendor, ".vendor-digest");
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function verifyVendorDigest(vendor) {
	const expected = computeVendorDigest(vendor);
	if (!expected) {
		return { ok: false, error: `vendor authority files missing under ${vendor}; refusing to trust an incomplete vendor set` };
	}
	const stored = readVendorDigest(vendor);
	if (!stored) return { ok: true, missing: true }; // pre-digest vendor — accepted, migration allowed
	for (const [name, hash] of Object.entries(expected)) {
		if (stored[name] !== hash) {
			return { ok: false, error: `vendor ${name} digest mismatch: expected ${stored[name] ?? "(missing)"}, got ${hash.slice(0, 12)}` };
		}
	}
	return { ok: true };
}

function ensureVendorDigest(vendor) {
	// One-time migration for pre-digest vendors: write the current digest so
	// future tampering is detectable. Never silently trusts a digest that is
	// present but mismatched.
	if (!readVendorDigest(vendor) && computeVendorDigest(vendor)) {
		writeFileSync(join(vendor, ".vendor-digest"), JSON.stringify(computeVendorDigest(vendor)), "utf8");
	}
}

function missingNeedles(path, needles) {
	if (!existsSync(path)) return [`missing file ${path}`];
	const text = readFileSync(path, "utf8");
	return needles.filter((needle) => !text.includes(needle));
}

function missingMarkers(root) {
	const helpers = join(root, "extensions/oracle/worker/chatgpt-ui-helpers.mjs");
	const runJob = join(root, "extensions/oracle/worker/run-job.mjs");
	const tools = join(root, "extensions/oracle/lib/tools.ts");
	const jobs = join(root, "extensions/oracle/lib/jobs.ts");
	return [
		...missingNeedles(helpers, SOL_PATCH_MARKERS.helpers).map((item) => `helpers: ${item}`),
		...missingNeedles(runJob, SOL_PATCH_MARKERS.runJob).map((item) => `run-job: ${item}`),
		...missingNeedles(tools, SOL_PATCH_MARKERS.lib).map((item) => `tools: ${item}`),
		...missingNeedles(jobs, SOL_PATCH_MARKERS.jobs).map((item) => `jobs: ${item}`),
	];
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Authority-sensitive vendor files: the oracle tool registry and job type
// definitions. These MUST NOT be re-vendored against an upstream whose
// pristine content has not been reviewed (exact-hash fail-closed, audit P1-5).
const AUTHORITY_RELATIVE_FILES = WORKER_RELATIVE_FILES.filter((rel) => rel.includes("/lib/"));

/**
 * Verify that the installed lib files exactly match the reviewed pristine
 * baseline recorded in VENDOR_EXPECTED_HASHES. Used whenever a revendor
 * would re-apply the patch to authority-sensitive code.
 * @returns {{ ok: true } | { ok: false; error: string }}
 */
function verifyUpstreamAuthorityHashes(root, vendor) {
	const mismatches = [];
	for (const rel of AUTHORITY_RELATIVE_FILES) {
		const source = join(root, rel);
		if (!existsSync(source)) {
			return { ok: false, error: `pi-oracle is missing ${rel}; cannot verify authority hash` };
		}
		const actual = sha256File(source);
		const expected = VENDOR_EXPECTED_HASHES[rel];
		if (!expected || actual !== expected) {
			mismatches.push(`${rel} (expected ${expected?.slice(0, 12) ?? "unset"}, got ${actual.slice(0, 12)})`);
		}
	}
	if (mismatches.length) {
		return {
			ok: false,
			error: `authority hash fail-closed: installed lib files differ from the reviewed pristine baseline: ${mismatches.join("; ")}. Review the new upstream, update VENDOR_EXPECTED_HASHES, then re-vendor.`,
		};
	}
	return { ok: true };
}

/**
 * Same-version restore accepts two known installed states for authority
 * files: the reviewed pristine hash OR the current vendor patched hash.
 * Any third hash is refused (audit P1-5 bypass A).
 * @returns {{ ok: true } | { ok: false; error: string }}
 */
function verifyAuthorityRestoreState(root, vendor) {
	for (const rel of AUTHORITY_RELATIVE_FILES) {
		const source = join(root, rel);
		if (!existsSync(source)) continue; // missing files are created by restore
		const actual = sha256File(source);
		const pristine = VENDOR_EXPECTED_HASHES[rel];
		const patched = sha256File(join(vendor, rel.split("/").pop()));
		if (actual !== pristine && actual !== patched) {
			return {
				ok: false,
				error: `authority hash fail-closed: installed ${rel} matches neither the reviewed pristine baseline nor the vendored patched copy (got ${actual.slice(0, 12)}). Refusing to overwrite.`,
			};
		}
	}
	return { ok: true };
}

function syntaxCheckErrors(files) {
	const errors = [];
	for (const file of files) {
		// .mjs files: plain Node --check (fast, no TS needed).
		// .ts files: use --experimental-strip-types so TypeScript type annotations
		// are stripped before parsing (audit P1-6: node --check alone does not
		// handle TS syntax in non-ESM contexts).
		const args = file.endsWith(".ts") ? ["--experimental-strip-types", "--check", file] : ["--check", file];
		const result = spawnSync(process.execPath, args, { encoding: "utf8" });
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

	// Vendor digest gate (audit P2-N2): a tampered ORACLE_VERSION string must
	// not skip the revendor branch. The digest binds the version claim to the
	// actual vendor file content.
	const digestCheck = verifyVendorDigest(vendor);
	if (!digestCheck.ok) {
		return { ok: false, revendored: false, error: digestCheck.error };
	}

	if (installedVersion === vendoredVersion && !options.force) {
		return { ok: true, revendored: false, version: installedVersion };
	}

	// Exact-hash fail-closed: when the installed version equals the vendored
	// version, the installed upstream files must exactly match the hashes the
	// vendor patch was built against. If a same-version install has modified
	// upstream files, we refuse to apply a stale patch to changed authority-
	// sensitive code (lib tools, job types, worker helpers).
	if (installedVersion === vendoredVersion) {
		const mismatches = [];
		for (const rel of WORKER_RELATIVE_FILES) {
			const source = join(root, rel);
			if (!existsSync(source)) {
				return { ok: false, revendored: false, error: `pi-oracle ${installedVersion} is missing ${rel}; cannot verify upstream hash` };
			}
			const actual = sha256File(source);
			const expected = VENDOR_EXPECTED_HASHES[rel];
			if (!expected || actual !== expected) {
				mismatches.push(`${rel} (expected ${expected?.slice(0, 12) ?? "unset"}, got ${actual.slice(0, 12)})`);
			}
		}
		if (mismatches.length) {
			return {
				ok: false,
				revendored: false,
				error: `exact-hash fail-closed: installed pi-oracle ${installedVersion} files differ from vendored baseline: ${mismatches.join("; ")}. Re-vendor with --revendor --force after confirming upstream.`,
			};
		}
	} else {
		// Version differs: for authority-sensitive lib files the pristine
		// content must still exactly match the reviewed baseline. A new
		// version that changed tools.ts/jobs.ts is refused until
		// VENDOR_EXPECTED_HASHES is updated after review (audit P1-5 bypass B).
		const authority = verifyUpstreamAuthorityHashes(root, vendor);
		if (!authority.ok) {
			return { ok: false, revendored: false, error: authority.error };
		}
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
		writeFileSync(join(vendor, ".vendor-digest"), JSON.stringify(computeVendorDigest(vendor)), "utf8");
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
	const tools = join(root, "extensions/oracle/lib/tools.ts");
	const jobs = join(root, "extensions/oracle/lib/jobs.ts");
	const vendorHelpers = join(vendor, "chatgpt-ui-helpers.mjs");
	const vendorHelpersDts = join(vendor, "chatgpt-ui-helpers.d.mts");
	const vendorRunJob = join(vendor, "run-job.mjs");
	const vendorTools = join(vendor, "tools.ts");
	const vendorJobs = join(vendor, "jobs.ts");

	const missing = missingMarkers(root);

	// Vendor digest gate (audit P2-N2): every path that trusts the vendor set
	// — fast-path, restore, revendor decision — verifies the digest binding
	// ORACLE_VERSION to the authority lib bytes BEFORE reading/trusting
	// vendoredVersion. Pre-digest vendors get a one-time migration write.
	const digestCheck = verifyVendorDigest(vendor);
	if (!digestCheck.ok) {
		return { ok: false, restored: false, missing, root, error: digestCheck.error };
	}
	if (digestCheck.missing) {
		ensureVendorDigest(vendor);
	}

	// Authority hash gate on the no-op fast path too (audit P1-N1): marker
	// presence alone is not authority. A marker-preserving third-hash mutation
	// of lib/tools.ts or lib/jobs.ts must fail closed, not silently pass.
	if (!options.force && missing.length === 0) {
		const authority = verifyAuthorityRestoreState(root, vendor);
		if (!authority.ok) {
			return { ok: false, restored: false, missing: [authority.error], root, error: authority.error };
		}
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

	// Same-version restore: refuse to overwrite authority lib files whose
	// installed content matches neither the reviewed pristine baseline nor
	// the current vendored patched copy (audit P1-5 bypass A).
	const authorityRestore = verifyAuthorityRestoreState(root, vendor);
	if (!authorityRestore.ok) {
		return { ok: false, restored: false, missing, root, error: authorityRestore.error };
	}

	const vendorFiles = [
		[vendorHelpers, helpers],
		[vendorHelpersDts, helpersDts],
		[vendorRunJob, runJob],
		[vendorTools, tools],
		[vendorJobs, jobs],
	];
	for (const [vendorPath] of vendorFiles) {
		if (!existsSync(vendorPath)) {
			return {
				ok: false,
				restored: false,
				missing,
				root,
				error: `vendor patch copy missing under ${vendor}: ${vendorPath.split("/").pop()}`,
			};
		}
	}

	try {
		for (const [vendorPath, dest] of vendorFiles) {
			copyFileSync(vendorPath, dest);
		}
	} catch (error) {
		return {
			ok: false,
			restored: false,
			missing,
			root,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const syntaxErrors = syntaxCheckErrors([helpers, runJob, tools, jobs]);
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
		...missingNeedles(helpers, SOL_PATCH_MARKERS.helpers).map((item) => `helpers: ${item}`),
		...missingNeedles(runJob, SOL_PATCH_MARKERS.runJob).map((item) => `run-job: ${item}`),
		...missingNeedles(tools, SOL_PATCH_MARKERS.lib).map((item) => `tools: ${item}`),
		...missingNeedles(jobs, SOL_PATCH_MARKERS.jobs).map((item) => `jobs: ${item}`),
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
