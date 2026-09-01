/**
 * /sol auto-restores pi-oracle High/Power-slider worker patches.
 * The human does not run this. Pi's /sol extension (and the in-Pi model) does.
 * Run: npx --yes tsx --test ~/.pi/agent/extensions/__tests__/sol-patches.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { ensureSolOraclePatches, SOL_PATCH_FILE, SOL_PATCH_MARKERS } from "../lib/sol/patches.ts";

const VENDOR = join(dirname(fileURLToPath(import.meta.url)), "../lib/sol/vendor");
const WORKER_FILES = ["chatgpt-ui-helpers.mjs", "chatgpt-ui-helpers.d.mts", "run-job.mjs", "tools.ts", "jobs.ts"];

function fakeOracleRoot(version = "0.7.20") {
	const root = mkdtempSync(join(tmpdir(), "sol-oracle-"));
	const worker = join(root, "extensions/oracle/worker");
	const lib = join(root, "extensions/oracle/lib");
	mkdirSync(worker, { recursive: true });
	mkdirSync(lib, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-oracle", version }));
	return { root, worker, lib };
}

/** Temp vendor dir seeded from the real vendor copies (patch file included). */
function fakeVendorDir() {
	const vendor = mkdtempSync(join(tmpdir(), "sol-vendor-"));
	for (const name of [...WORKER_FILES, "ORACLE_VERSION", SOL_PATCH_FILE]) {
		copyFileSync(join(VENDOR, name), join(vendor, name));
	}
	// Seed the digest too when the real vendor has one, so digest-gate tests
	// start from a trusted baseline and tampering actually trips the gate.
	if (existsSync(join(VENDOR, ".vendor-digest"))) {
		copyFileSync(join(VENDOR, ".vendor-digest"), join(vendor, ".vendor-digest"));
	}
	return vendor;
}

/** Worker files as pristine upstream: vendor content with the patch reversed. */
function writePristineWorker(root, worker, vendor, lib = join(root, "extensions/oracle/lib")) {
	for (const name of ["chatgpt-ui-helpers.mjs", "chatgpt-ui-helpers.d.mts", "run-job.mjs"]) {
		copyFileSync(join(vendor, name), join(worker, name));
	}
	for (const name of ["tools.ts", "jobs.ts"]) {
		copyFileSync(join(vendor, name), join(lib, name));
	}
	const reversed = spawnSync(
		"patch",
		["-R", "-p1", "-s", "-t", "--no-backup-if-mismatch", "-d", root, "-i", join(vendor, SOL_PATCH_FILE)],
		{ encoding: "utf8" },
	);
	assert.equal(reversed.status, 0, `patch -R failed: ${reversed.stderr}`);
}

function writePristineLib(root, lib, vendor) {
	for (const name of ["tools.ts", "jobs.ts"]) {
		copyFileSync(join(vendor, name), join(lib, name));
	}
	// Reverse the patch on a temp tree containing all WORKER_RELATIVE_FILES
	// (lib files matter, worker files are stubs so patch -R succeeds).
	const tmp = mkdtempSync(join(tmpdir(), "sol-pristine-lib-"));
	try {
		mkdirSync(join(tmp, "extensions/oracle/lib"), { recursive: true });
		mkdirSync(join(tmp, "extensions/oracle/worker"), { recursive: true });
		copyFileSync(join(vendor, "tools.ts"), join(tmp, "extensions/oracle/lib/tools.ts"));
		copyFileSync(join(vendor, "jobs.ts"), join(tmp, "extensions/oracle/lib/jobs.ts"));
		// Worker file stubs: any content is fine since lib's hash is what we
		// care about — patch -R will reverse the worker hunks too.
		for (const name of ["chatgpt-ui-helpers.mjs", "chatgpt-ui-helpers.d.mts", "run-job.mjs"]) {
			copyFileSync(join(vendor, name), join(tmp, "extensions/oracle/worker", name));
		}
		const reversed = spawnSync("patch", ["-R", "-p1", "-s", "-t", "--no-backup-if-mismatch", "-d", tmp, "-i", join(vendor, SOL_PATCH_FILE)], { encoding: "utf8" });
		assert.equal(reversed.status, 0, `patch -R (lib) failed: ${reversed.stderr}`);
		copyFileSync(join(tmp, "extensions/oracle/lib/tools.ts"), join(lib, "tools.ts"));
		copyFileSync(join(tmp, "extensions/oracle/lib/jobs.ts"), join(lib, "jobs.ts"));
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

describe("ensureSolOraclePatches", () => {
	it("is a no-op when High/Power-slider markers are already present", () => {
		const { root, worker, lib } = fakeOracleRoot();
		try {
			copyFileSync(join(VENDOR, "chatgpt-ui-helpers.mjs"), join(worker, "chatgpt-ui-helpers.mjs"));
			copyFileSync(join(VENDOR, "chatgpt-ui-helpers.d.mts"), join(worker, "chatgpt-ui-helpers.d.mts"));
			copyFileSync(join(VENDOR, "run-job.mjs"), join(worker, "run-job.mjs"));
			copyFileSync(join(VENDOR, "tools.ts"), join(lib, "tools.ts"));
			copyFileSync(join(VENDOR, "jobs.ts"), join(lib, "jobs.ts"));
			const result = ensureSolOraclePatches({ root });
			assert.equal(result.ok, true);
			assert.equal(result.restored, false);
			assert.deepEqual(result.missing, []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("restores vendor worker files after a simulated pi-oracle update", () => {
		const { root, worker } = fakeOracleRoot();
		try {
			writeFileSync(join(worker, "chatgpt-ui-helpers.mjs"), "export function detectCompactIntelligenceSelection() {}\n");
			writeFileSync(join(worker, "chatgpt-ui-helpers.d.mts"), "export {};\n");
			writeFileSync(join(worker, "run-job.mjs"), "async function configureModel() { throw new Error('Could not open effort dropdown'); }\n");
			const result = ensureSolOraclePatches({ root });
			assert.equal(result.ok, true);
			assert.equal(result.restored, true);
			assert.ok(result.missing.length > 0);
			const helpers = readFileSync(join(worker, "chatgpt-ui-helpers.mjs"), "utf8");
			const runJob = readFileSync(join(worker, "run-job.mjs"), "utf8");
			for (const needle of SOL_PATCH_MARKERS.helpers) {
				assert.match(helpers, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			}
			for (const needle of SOL_PATCH_MARKERS.runJob) {
				assert.match(runJob, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses to overwrite a newer pi-oracle with 0.7.20 vendor files", () => {
		const { root, worker, lib } = fakeOracleRoot("0.8.0");
		const vendor = fakeVendorDir();
		try {
			// Write worker files with upstream 0.8.0 content (patch will fail)
			writeFileSync(join(worker, "chatgpt-ui-helpers.mjs"), "export {}\n");
			writeFileSync(join(worker, "chatgpt-ui-helpers.d.mts"), "export {}\n");
			writeFileSync(join(worker, "run-job.mjs"), "UPSTREAM_0_8_0\n");
			// lib files must be pristine upstream so the authority hash gate
			// passes and the patch application becomes the failure point.
			writePristineLib(root, lib, vendor);
			const result = ensureSolOraclePatches({ root, vendor });
			assert.equal(result.ok, false);
			assert.equal(result.restored, false);
			assert.match(String(result.error), /0\.8\.0/);
			assert.match(String(result.error), /patch/i);
			assert.match(readFileSync(join(worker, "run-job.mjs"), "utf8"), /UPSTREAM_0_8_0/);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(vendor, { recursive: true, force: true });
		}
	});

	it("fails closed when vendor copies are missing", () => {
		const { root, worker } = fakeOracleRoot();
		const vendor = mkdtempSync(join(tmpdir(), "sol-vendor-missing-"));
		try {
			writeFileSync(join(worker, "run-job.mjs"), "export {}\n");
			writeFileSync(join(worker, "chatgpt-ui-helpers.mjs"), "export {}\n");
			writeFileSync(join(worker, "chatgpt-ui-helpers.d.mts"), "export {}\n");
			const result = ensureSolOraclePatches({ root, vendor });
			assert.equal(result.ok, false);
			assert.match(String(result.error), /vendor/);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(vendor, { recursive: true, force: true });
		}
	});

	it("ships vendor copies next to the extension", () => {
		assert.equal(existsSync(join(VENDOR, "run-job.mjs")), true);
		assert.equal(existsSync(join(VENDOR, "chatgpt-ui-helpers.mjs")), true);
		assert.equal(existsSync(join(VENDOR, "tools.ts")), true);
		assert.equal(existsSync(join(VENDOR, "jobs.ts")), true);
		assert.equal(existsSync(join(VENDOR, SOL_PATCH_FILE)), true);
	});

	it("carries a marker for the completion streaming guard so old workers redeploy (P1-3)", () => {
		// The hard guard ("while the model is still streaming (Stop control
		// visible)") must be part of the marker set: an eddf08b worker that has
		// every older marker but lacks this one must fail missingMarkers() and
		// get the new vendor worker copied back by ensureSolOraclePatches().
		assert.ok(SOL_PATCH_MARKERS.runJob.some((m) => m.includes("still streaming")), "completion guard marker missing from SOL_PATCH_MARKERS.runJob");
		assert.match(readFileSync(join(VENDOR, "run-job.mjs"), "utf8"), /while the model is still streaming \(Stop control visible\)/);
	});

	it("re-applies the patch to a newer pristine pi-oracle instead of overwriting it", () => {
		const { root, worker } = fakeOracleRoot("0.8.0");
		const vendor = fakeVendorDir();
		try {
			writePristineWorker(root, worker, vendor);
			const result = ensureSolOraclePatches({ root, vendor });
			assert.equal(result.ok, true);
			assert.equal(result.restored, true);
			assert.equal(result.revendored, true);
			assert.equal(readFileSync(join(vendor, "ORACLE_VERSION"), "utf8").trim(), "0.8.0");
			assert.equal(readFileSync(join(vendor, "previous", "ORACLE_VERSION"), "utf8").trim(), "0.7.20");
			for (const needle of SOL_PATCH_MARKERS.runJob) {
				assert.match(readFileSync(join(worker, "run-job.mjs"), "utf8"), new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(vendor, { recursive: true, force: true });
		}
	});

	it("fails loudly when the patch does not apply to a newer pi-oracle", () => {
		const { root, worker, lib } = fakeOracleRoot("0.8.0");
		const vendor = fakeVendorDir();
		try {
			writeFileSync(join(worker, "chatgpt-ui-helpers.mjs"), "export {}\n");
			writeFileSync(join(worker, "chatgpt-ui-helpers.d.mts"), "export {}\n");
			writeFileSync(join(worker, "run-job.mjs"), "UPSTREAM_0_8_0\n");
			// lib files must be pristine upstream so the authority hash gate
			// passes and the patch application becomes the failure point.
			writePristineLib(root, lib, vendor);
			const result = ensureSolOraclePatches({ root, vendor });
			assert.equal(result.ok, false);
			assert.equal(result.restored, false);
			assert.match(String(result.error), /0\.8\.0/);
			assert.match(String(result.error), /patch/i);
			assert.match(readFileSync(join(worker, "run-job.mjs"), "utf8"), /UPSTREAM_0_8_0/);
			assert.equal(readFileSync(join(vendor, "ORACLE_VERSION"), "utf8").trim(), "0.7.20");
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(vendor, { recursive: true, force: true });
		}
	});

	it("rejects restored worker files that fail node --check", () => {
		const { root, worker } = fakeOracleRoot();
		const vendor = fakeVendorDir();
		try {
			writeFileSync(join(worker, "chatgpt-ui-helpers.mjs"), "export {}\n");
			writeFileSync(join(worker, "chatgpt-ui-helpers.d.mts"), "export {}\n");
			writeFileSync(join(worker, "run-job.mjs"), "export {}\n");
			// Vendor copy carries all markers but is syntactically broken.
			const broken = `${SOL_PATCH_MARKERS.runJob.join("\n")}\nasync function broken( {\n`;
			writeFileSync(join(vendor, "run-job.mjs"), broken);
			const result = ensureSolOraclePatches({ root, vendor });
			assert.equal(result.ok, false);
			assert.match(String(result.error), /node --check/);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(vendor, { recursive: true, force: true });
		}
	});

	it("carries a marker for the audit round 6 sanitizer fix so old workers redeploy (P1-3)", () => {
		// The ROLE_WITH_REF constant must be a helper marker: a round-5 worker
		// that has every older marker but lacks ROLE_WITH_REF must fail
		// missingMarkers() and get the new vendor worker copied back.
		assert.ok(SOL_PATCH_MARKERS.helpers.some((m) => m.includes("ROLE_WITH_REF")), "ROLE_WITH_REF missing from SOL_PATCH_MARKERS.helpers");
		assert.match(readFileSync(join(VENDOR, "chatgpt-ui-helpers.mjs"), "utf8"), /ROLE_WITH_REF/);
	});

	it("detects that a round-5 helper (no ROLE_WITH_REF) is missing the audit round 6 marker", () => {
		const { root, worker, lib } = fakeOracleRoot();
		const vendor = fakeVendorDir();
		try {
			// Seed the worker with current vendor copies (as an installed,
			// previously-patched worker would have), then strip ROLE_WITH_REF to
			// simulate a round-5 helper. run-job keeps all markers so only the
			// missing helper marker can drive redeploy.
			for (const name of ["chatgpt-ui-helpers.mjs", "chatgpt-ui-helpers.d.mts", "run-job.mjs"]) copyFileSync(join(vendor, name), join(worker, name));
			copyFileSync(join(vendor, "tools.ts"), join(lib, "tools.ts"));
			copyFileSync(join(vendor, "jobs.ts"), join(lib, "jobs.ts"));
			const fullHelpers = readFileSync(join(worker, "chatgpt-ui-helpers.mjs"), "utf8");
			const oldHelpers = fullHelpers.replace(/const ROLE_WITH_REF[^;]+;/, "");
			assert.notEqual(oldHelpers, fullHelpers, "fixture must actually strip ROLE_WITH_REF");
			writeFileSync(join(worker, "chatgpt-ui-helpers.mjs"), oldHelpers);
			const result = ensureSolOraclePatches({ root, vendor });
			// The old worker must be detected as missing the marker and restored
			// with the vendored helper (copy back), not accepted as-is.
			assert.equal(result.ok, true);
			assert.equal(result.restored, true);
			assert.match(readFileSync(join(worker, "chatgpt-ui-helpers.mjs"), "utf8"), /ROLE_WITH_REF/);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(vendor, { recursive: true, force: true });
		}
	});

	it("rejects a same-version restore when installed lib files match neither pristine nor patched hash (P1-5 bypass A)", () => {
		// Same version as vendored: the restore path copies vendor → installed
		// directly. It must refuse to overwrite authority lib files whose
		// installed content is an unknown third hash (not pristine, not
		// already-patched).
		const { root, worker, lib } = fakeOracleRoot(); // 0.7.20 == vendored
		const vendor = fakeVendorDir();
		try {
			// Worker files missing markers so restore is attempted
			writeFileSync(join(worker, "chatgpt-ui-helpers.mjs"), "export {}\n");
			writeFileSync(join(worker, "chatgpt-ui-helpers.d.mts"), "export {}\n");
			writeFileSync(join(worker, "run-job.mjs"), "export {}\n");
			// Authority lib files carry an unknown third hash
			writeFileSync(join(lib, "tools.ts"), "export const UNKNOWN = true;\n");
			writeFileSync(join(lib, "jobs.ts"), "export const UNKNOWN = true;\n");
			const result = ensureSolOraclePatches({ root, vendor });
			assert.equal(result.ok, false);
			assert.equal(result.restored, false);
			assert.match(String(result.error), /authority hash fail-closed/);
			// The unknown lib content must NOT have been overwritten
			assert.match(readFileSync(join(lib, "tools.ts"), "utf8"), /UNKNOWN/);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(vendor, { recursive: true, force: true });
		}
	});

	it("rejects a version-mismatch revendor when lib files are not the reviewed pristine content (P1-5 bypass B)", () => {
		// A new pi-oracle version legitimately differs from vendored; revendor
		// re-applies the patch. Authority lib files must still match the
		// reviewed pristine baseline — an already-patched (or third) lib hash
		// must fail closed instead of silently re-patching changed authority
		// code.
		const { root, worker, lib } = fakeOracleRoot("0.8.0");
		const vendor = fakeVendorDir();
		try {
			// Worker files missing markers so revendor is attempted
			writeFileSync(join(worker, "chatgpt-ui-helpers.mjs"), "export {}\n");
			writeFileSync(join(worker, "chatgpt-ui-helpers.d.mts"), "export {}\n");
			writeFileSync(join(worker, "run-job.mjs"), "UPSTREAM_0_8_0\n");
			// Authority lib files are the ALREADY-PATCHED copies (patched hash,
			// not pristine) — must be rejected by the authority hash gate.
			copyFileSync(join(vendor, "tools.ts"), join(lib, "tools.ts"));
			copyFileSync(join(vendor, "jobs.ts"), join(lib, "jobs.ts"));
			const result = ensureSolOraclePatches({ root, vendor });
			assert.equal(result.ok, false);
			assert.equal(result.restored, false);
			assert.match(String(result.error), /authority hash fail-closed/);
			// The already-patched lib content must NOT have been overwritten
			assert.equal(readFileSync(join(lib, "tools.ts"), "utf8"), readFileSync(join(vendor, "tools.ts"), "utf8"));
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(vendor, { recursive: true, force: true });
		}
	});

	it("accepts a same-version restore when installed lib files are already-patched vendor copies (P1-5 restore states)", () => {
		// Same version, worker markers missing, lib files already hold the
		// vendored patched copies (patched hash): restore is allowed.
		const { root, worker, lib } = fakeOracleRoot();
		const vendor = fakeVendorDir();
		try {
			writeFileSync(join(worker, "chatgpt-ui-helpers.mjs"), "export {}\n");
			writeFileSync(join(worker, "chatgpt-ui-helpers.d.mts"), "export {}\n");
			writeFileSync(join(worker, "run-job.mjs"), "export {}\n");
			copyFileSync(join(vendor, "tools.ts"), join(lib, "tools.ts"));
			copyFileSync(join(vendor, "jobs.ts"), join(lib, "jobs.ts"));
			const result = ensureSolOraclePatches({ root, vendor });
			assert.equal(result.ok, true);
			assert.equal(result.restored, true);
			for (const needle of SOL_PATCH_MARKERS.runJob) {
				assert.match(readFileSync(join(worker, "run-job.mjs"), "utf8"), new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(vendor, { recursive: true, force: true });
		}
	});
});

describe("vendor digest + authority gates (audit round 4)", () => {
	it("rejects a marker-preserving third-hash mutation of installed lib on the no-op fast path (P1-N1)", () => {
		// All markers present (fast-path), but installed tools.ts is a third
		// hash that still contains the marker strings. Must fail closed.
		const { root, worker, lib } = fakeOracleRoot();
		const vendor = fakeVendorDir();
		try {
			// Full markers present: worker files are the vendored patched copies.
			copyFileSync(join(vendor, "chatgpt-ui-helpers.mjs"), join(worker, "chatgpt-ui-helpers.mjs"));
			copyFileSync(join(vendor, "chatgpt-ui-helpers.d.mts"), join(worker, "chatgpt-ui-helpers.d.mts"));
			copyFileSync(join(vendor, "run-job.mjs"), join(worker, "run-job.mjs"));
			// Installed lib is a marker-preserving third hash.
			const patchedTools = readFileSync(join(vendor, "tools.ts"), "utf8");
			const mutated = patchedTools.replace("oracle_recover", "oracle_recover_mutated");
			writeFileSync(join(lib, "tools.ts"), mutated);
			copyFileSync(join(vendor, "jobs.ts"), join(lib, "jobs.ts"));
			const result = ensureSolOraclePatches({ root, vendor });
			assert.equal(result.ok, false);
			assert.match(String(result.error), /authority hash fail-closed/);
			// The mutated lib must NOT have been touched/restored-over.
			assert.match(readFileSync(join(lib, "tools.ts"), "utf8"), /oracle_recover_mutated/);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(vendor, { recursive: true, force: true });
		}
	});

	it("rejects a tampered vendor ORACLE_VERSION that would skip the revendor branch (P2-N2)", () => {
		// installed package version claims 9.9.9; vendor ORACLE_VERSION tampered
		// to 9.9.9 so the version-mismatch revendor branch is skipped. The
		// vendor digest binds ORACLE_VERSION to the vendor bytes, so the digest
		// gate must fail closed before any restore/revendor decision.
		const { root, worker, lib } = fakeOracleRoot("9.9.9");
		const vendor = fakeVendorDir();
		try {
			// Tamper the vendored version to match the installed one.
			writeFileSync(join(vendor, "ORACLE_VERSION"), "9.9.9\n");
			// Worker markers missing so a restore would otherwise run.
			writeFileSync(join(worker, "chatgpt-ui-helpers.mjs"), "export {}\n");
			writeFileSync(join(worker, "chatgpt-ui-helpers.d.mts"), "export {}\n");
			writeFileSync(join(worker, "run-job.mjs"), "export {}\n");
			copyFileSync(join(vendor, "tools.ts"), join(lib, "tools.ts"));
			copyFileSync(join(vendor, "jobs.ts"), join(lib, "jobs.ts"));
			const result = ensureSolOraclePatches({ root, vendor });
			assert.equal(result.ok, false);
			assert.match(String(result.error), /digest mismatch/);
			// Nothing must have been copied into the installed tree.
			assert.match(readFileSync(join(worker, "run-job.mjs"), "utf8"), /export \{\}/);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(vendor, { recursive: true, force: true });
		}
	});

	it("migrates a pre-digest vendor by writing .vendor-digest once (P2-N2 compatibility)", () => {
		const { root, worker, lib } = fakeOracleRoot();
		const vendor = fakeVendorDir();
		try {
			// Remove any digest (pre-digest vendor state).
			rmSync(join(vendor, ".vendor-digest"), { force: true });
			writeFileSync(join(worker, "chatgpt-ui-helpers.mjs"), "export {}\n");
			writeFileSync(join(worker, "chatgpt-ui-helpers.d.mts"), "export {}\n");
			writeFileSync(join(worker, "run-job.mjs"), "export {}\n");
			copyFileSync(join(vendor, "tools.ts"), join(lib, "tools.ts"));
			copyFileSync(join(vendor, "jobs.ts"), join(lib, "jobs.ts"));
			const result = ensureSolOraclePatches({ root, vendor });
			assert.equal(result.ok, true);
			assert.equal(result.restored, true);
			// Digest should now exist and be valid.
			const digest = JSON.parse(readFileSync(join(vendor, ".vendor-digest"), "utf8"));
			assert.equal(typeof digest.oracleVersion, "string");
			assert.equal(typeof digest["tools.ts"], "string");
			assert.equal(typeof digest["jobs.ts"], "string");
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(vendor, { recursive: true, force: true });
		}
	});

	it("rejects a vendor whose authority lib bytes changed after the digest was written (P2-N2)", () => {
		const { root, worker, lib } = fakeOracleRoot();
		const vendor = fakeVendorDir();
		try {
			// Tamper a vendor lib file AFTER the digest was recorded.
			const toolsPath = join(vendor, "tools.ts");
			writeFileSync(toolsPath, readFileSync(toolsPath, "utf8") + "\n// tampered\n");
			writeFileSync(join(worker, "chatgpt-ui-helpers.mjs"), "export {}\n");
			writeFileSync(join(worker, "chatgpt-ui-helpers.d.mts"), "export {}\n");
			writeFileSync(join(worker, "run-job.mjs"), "export {}\n");
			copyFileSync(join(vendor, "tools.ts"), join(lib, "tools.ts"));
			copyFileSync(join(vendor, "jobs.ts"), join(lib, "jobs.ts"));
			const result = ensureSolOraclePatches({ root, vendor });
			assert.equal(result.ok, false);
			assert.match(String(result.error), /digest mismatch/);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(vendor, { recursive: true, force: true });
		}
	});
});

describe("canonical parser redeploy markers (audit round 6/7)", () => {
	it("ships the canonical closest-merge parser marker in the vendored worker", () => {
		const runJob = readFileSync(join(VENDOR, "run-job.mjs"), "utf8");
		// The canonical logical-turn parser revision must be distinguishable by
		// marker so an already-installed round-5 worker gets redeployed (P1-R6-NEW-1).
		assert.match(runJob, /const roleContainer = node\.closest\('\[data-message-author-role\]'\)/);
		assert.match(runJob, /ownId = roleContainer\.getAttribute\('data-message-id'\).*\|\| '';/);
		assert.match(runJob, /no unambiguous user predecessor/);
		assert.match(runJob, /closest\(\) role merge/);
	});

	it("rejects a worker that only has the old recovery markers but lacks the canonical parser marker (P1-R6-NEW-1)", () => {
		const { root, worker, lib } = fakeOracleRoot();
		const vendor = fakeVendorDir();
		try {
			// Simulate an installed round-5 worker: has waitForRecoveredAssistant
			// but NOT the canonical closest-merge parser body.
			const round5runJob = readFileSync(join(vendor, "run-job.mjs"), "utf8").replace(/const roleContainer = node\.closest\('\[data-message-author-role\]'\)/, "const roleContainer = node;");
			writeFileSync(join(worker, "run-job.mjs"), round5runJob);
			copyFileSync(join(vendor, "chatgpt-ui-helpers.mjs"), join(worker, "chatgpt-ui-helpers.mjs"));
			copyFileSync(join(vendor, "chatgpt-ui-helpers.d.mts"), join(worker, "chatgpt-ui-helpers.d.mts"));
			copyFileSync(join(vendor, "tools.ts"), join(lib, "tools.ts"));
			copyFileSync(join(vendor, "jobs.ts"), join(lib, "jobs.ts"));
			const result = ensureSolOraclePatches({ root, vendor });
			assert.equal(result.ok, true);
			assert.equal(result.restored, true);
			// The restored worker must contain the canonical parser marker again.
			assert.match(readFileSync(join(worker, "run-job.mjs"), "utf8"), /const roleContainer = node\.closest\('\[data-message-author-role\]'\)/);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(vendor, { recursive: true, force: true });
		}
	});
});

describe("canonical prompt domain (audit round 9, P1-R8-NEW-1)", () => {
	it("uses canonicalPromptText on both the source-side hash and the recovery-side check", () => {
		const runJob = readFileSync(join(VENDOR, "run-job.mjs"), "utf8");
		// Source-side (Phase-1 anchor) and recovery-side (prompt proof) must
		// both normalize through canonicalPromptText so multi-paragraph
		// prompts (blank lines, trailing newline) hash consistently.
		assert.match(runJob, /submittedPromptHash: hashText\(canonicalPromptText\(promptText\)\)/);
		assert.match(runJob, /hashText\(canonicalPromptText\(promptProbe\.text\)\) !== anchor\.submittedPromptHash/);
		// The user-turn body extraction excludes attachment preview / UI
		// chrome so the hash domain is the prompt text, not the whole bubble.
		assert.match(runJob, /\.user-message-bubble-color \.whitespace-pre-wrap/);
	});

	it("canonicalizes multi-paragraph prompts the same way on both ends", () => {
		const runJob = readFileSync(join(VENDOR, "run-job.mjs"), "utf8");
		// Lossless canonicalization (audit P1-R9-NEW-1): must NOT filter blank
		// lines or 'Thought for' lines, must NOT trimEnd each line — those
		// would merge distinct prompts into the same hash (identity loss).
		const fnStart = runJob.indexOf("function canonicalPromptText(text)");
		assert.ok(fnStart >= 0, "canonicalPromptText not found");
		const fnChunk = runJob.slice(fnStart, fnStart + 1200);
		assert.ok(fnChunk.includes("charCodeAt(0) === 0xfeff"), "BOM strip expected");
		assert.ok(fnChunk.includes(".replace(/\\r") || fnChunk.includes("\\r\\n"), "CRLF->LF expected");
		// No lossy filter inside canonicalPromptText (no .filter, no trimEnd)
		assert.ok(!fnChunk.includes(".filter("), "canonicalPromptText must not filter lines");
		assert.ok(!fnChunk.includes(".trimEnd()"), "canonicalPromptText must not trimEnd per line");
	});
});
