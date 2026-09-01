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
});
