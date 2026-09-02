/**
 * /sol-open — open the oracle auth-seed Chrome for manual repair.
 * Run: node --experimental-strip-types --test extensions/__tests__/sol-open.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
	detectChromeExecutablePath,
	formatSolOpenResult,
	normalizeSolOpenUrl,
	openSolOracleBrowser,
	readSolOracleBrowserConfig,
	seedProfileDirForProvider,
	singletonOwnerPid,
	solOpenBrowserArgs,
} from "../lib/sol/open-browser.ts";

function tempHome(): { home: string; extDir: string; cleanup: () => void } {
	const home = mkdtempSync(join(tmpdir(), "sol-open-home-"));
	const extDir = join(home, ".pi", "agent", "extensions");
	mkdirSync(extDir, { recursive: true });
	return { home, extDir, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function writeConfig(extDir: string, body: string): string {
	const path = join(extDir, "oracle.json");
	writeFileSync(path, body);
	return path;
}

describe("readSolOracleBrowserConfig", () => {
	it("falls back to the documented pi-oracle defaults when no config exists", () => {
		const { home, extDir, cleanup } = tempHome();
		try {
			const cfg = readSolOracleBrowserConfig({ HOME: home });
			assert.equal(cfg.authSeedProfileDir, join(extDir, "oracle-auth-seed-profile"));
			assert.equal(cfg.configPath, join(extDir, "oracle.json"));
		} finally {
			cleanup();
		}
	});

	it("honours browser.authSeedProfileDir and browser.executablePath", () => {
		const { home, extDir, cleanup } = tempHome();
		try {
			writeConfig(extDir, JSON.stringify({ browser: { authSeedProfileDir: "/tmp/custom-seed", executablePath: "/tmp/custom-chrome" } }));
			const cfg = readSolOracleBrowserConfig({ HOME: home });
			assert.equal(cfg.authSeedProfileDir, "/tmp/custom-seed");
			assert.equal(cfg.executablePath, "/tmp/custom-chrome");
		} finally {
			cleanup();
		}
	});

	it("accepts browser.profileDir as pi-oracle's legacy seed alias", () => {
		const { home, extDir, cleanup } = tempHome();
		try {
			writeConfig(extDir, JSON.stringify({ browser: { profileDir: "/tmp/legacy-seed" } }));
			assert.equal(readSolOracleBrowserConfig({ HOME: home }).authSeedProfileDir, "/tmp/legacy-seed");
		} finally {
			cleanup();
		}
	});

	it("prefers the modern key when both keys are present", () => {
		const { home, extDir, cleanup } = tempHome();
		try {
			writeConfig(extDir, JSON.stringify({ browser: { profileDir: "/tmp/legacy", authSeedProfileDir: "/tmp/modern" } }));
			assert.equal(readSolOracleBrowserConfig({ HOME: home }).authSeedProfileDir, "/tmp/modern");
		} finally {
			cleanup();
		}
	});

	it("fails soft on malformed JSON instead of throwing at command time", () => {
		const { home, extDir, cleanup } = tempHome();
		try {
			writeConfig(extDir, "{ this is not json");
			const cfg = readSolOracleBrowserConfig({ HOME: home });
			assert.ok(cfg.authSeedProfileDir.endsWith("oracle-auth-seed-profile"));
		} finally {
			cleanup();
		}
	});

	it("rejects a non-string seed value rather than coercing it", () => {
		const { home, extDir, cleanup } = tempHome();
		try {
			writeConfig(extDir, JSON.stringify({ browser: { authSeedProfileDir: true } }));
			assert.ok(readSolOracleBrowserConfig({ HOME: home }).authSeedProfileDir.endsWith("oracle-auth-seed-profile"));
		} finally {
			cleanup();
		}
	});
});

describe("seedProfileDirForProvider", () => {
	it("uses the base seed for chatgpt and the -grok sibling for grok", () => {
		const cfg = { authSeedProfileDir: "/ext/oracle-auth-seed-profile" };
		assert.equal(seedProfileDirForProvider("chatgpt", cfg), "/ext/oracle-auth-seed-profile");
		assert.equal(seedProfileDirForProvider("grok", cfg), "/ext/oracle-auth-seed-profile-grok");
	});
});

describe("detectChromeExecutablePath", () => {
	it("returns undefined on an unsupported platform", () => {
		assert.equal(detectChromeExecutablePath("win32", {}), undefined);
	});

	it("scans PATH for the linux candidate list", () => {
		const { home, cleanup } = (() => {
			const h = mkdtempSync(join(tmpdir(), "sol-open-bin-"));
			return { home: h, cleanup: () => rmSync(h, { recursive: true, force: true }) };
		})();
		try {
			writeFileSync(join(home, "chromium"), "");
			const found = detectChromeExecutablePath("linux", { PATH: `/nonexistent:${home}` });
			assert.equal(found, join(home, "chromium"));
		} finally {
			cleanup();
		}
	});

	it("returns undefined when no candidate exists on PATH", () => {
		assert.equal(detectChromeExecutablePath("linux", { PATH: "/definitely-not-a-bin-dir" }), undefined);
	});
});

describe("singletonOwnerPid", () => {
	it("reads the live pid from a <hostname>-<pid> symlink", () => {
		const pid = singletonOwnerPid("/profile", (p) => {
			assert.equal(p, join("/profile", "SingletonLock"));
			return "MacBook-Pro-4242";
		}, () => true);
		assert.equal(pid, 4242);
	});

	it("treats a hostname containing hyphens correctly (only the tail is the pid)", () => {
		assert.equal(singletonOwnerPid("/p", () => "my-host-name-991", () => true), 991);
	});

	it("reports no owner when the lock is stale (dead pid)", () => {
		assert.equal(singletonOwnerPid("/p", () => "Mac-1234", () => false), undefined);
	});

	it("reports no owner when there is no lock at all", () => {
		assert.equal(singletonOwnerPid("/p", () => { throw new Error("ENOENT"); }, () => true), undefined);
	});

	it("ignores an unparseable lock target", () => {
		assert.equal(singletonOwnerPid("/p", () => "not-a-pid", () => true), undefined);
		assert.equal(singletonOwnerPid("/p", () => "Mac-0", () => true), undefined);
	});
});

describe("solOpenBrowserArgs", () => {
	const args = solOpenBrowserArgs("/profile/seed", "https://chatgpt.com/");

	it("points Chrome at the requested profile and opens the url last", () => {
		assert.ok(args.includes("--user-data-dir=/profile/seed"));
		assert.equal(args[args.length - 1], "https://chatgpt.com/");
	});

	it("exposes no CDP surface so no agent can attach to the manual window", () => {
		for (const arg of args) {
			assert.ok(!arg.startsWith("--remote-debugging"), `unexpected debug flag ${arg}`);
			assert.ok(!arg.startsWith("--remote-allow-origins"), `unexpected origin flag ${arg}`);
		}
	});

	it("is headed: no headless or scrollbar-hiding flags leak in from the worker set", () => {
		for (const arg of args) {
			assert.ok(!arg.startsWith("--headless"), `unexpected headless flag ${arg}`);
			assert.notEqual(arg, "--hide-scrollbars");
		}
	});

	it("keeps the cookie-decryption parity flags pi-oracle writes the seed with", () => {
		assert.ok(args.includes("--use-mock-keychain"));
		assert.ok(args.includes("--password-store=basic"));
	});

	it("keeps the tab unthrottled while the user is back in the terminal", () => {
		assert.ok(args.includes("--disable-backgrounding-occluded-windows"));
	});
});

describe("normalizeSolOpenUrl", () => {
	it("defaults per provider", () => {
		assert.equal(normalizeSolOpenUrl(undefined, "chatgpt"), "https://chatgpt.com/");
		assert.equal(normalizeSolOpenUrl(undefined, "grok"), "https://grok.com/");
	});

	it("accepts an explicit https url", () => {
		assert.equal(normalizeSolOpenUrl("https://chatgpt.com/c/abc", "chatgpt"), "https://chatgpt.com/c/abc");
	});

	it("rejects javascript: and file: starts", () => {
		assert.throws(() => normalizeSolOpenUrl("javascript:alert(1)", "chatgpt"), /only http\(s\)/);
		assert.throws(() => normalizeSolOpenUrl("file:///etc/passwd", "chatgpt"), /only http\(s\)/);
	});

	it("rejects a relative or unparseable url", () => {
		assert.throws(() => normalizeSolOpenUrl("chatgpt.com", "chatgpt"), /expected an absolute http\(s\) URL/);
	});
});

describe("openSolOracleBrowser", () => {
	it("short-circuits when the profile is already open and never spawns twice", () => {
		let spawned = 0;
		const result = openSolOracleBrowser({
			profileDir: "/seed",
			singletonPid: () => 777,
			spawnFn: () => { spawned += 1; return { pid: 1 }; },
		});
		assert.equal(spawned, 0);
		assert.equal(result.ok, true);
		assert.equal(result.launched, false);
		assert.equal(result.alreadyOpenPid, 777);
	});

	it("tells the user to run /sol-auth when the seed does not exist", () => {
		const result = openSolOracleBrowser({
			profileDir: "/missing-seed",
			singletonPid: () => undefined,
			existsFn: () => false,
			executablePath: "/chrome",
			spawnFn: () => ({ pid: 1 }),
		});
		assert.equal(result.ok, false);
		assert.equal(result.reason, "no-profile");
		assert.match(result.message, /Run \/sol-auth first/);
	});

	it("reports a clear blocker when no Chrome was detected", () => {
		const result = openSolOracleBrowser({
			profileDir: "/seed",
			singletonPid: () => undefined,
			existsFn: () => true,
			executablePath: undefined,
			config: { authSeedProfileDir: "/seed" },
		});
		assert.equal(result.ok, false);
		assert.equal(result.reason, "no-chrome");
		assert.match(result.message, /browser\.executablePath/);
	});

	it("launches detached, unrefs the child, and reports the pid", () => {
		let unrefed = 0;
		const seen: { exe: string; args: string[] }[] = [];
		const result = openSolOracleBrowser({
			provider: "grok",
			profileDir: "/seed-grok",
			singletonPid: () => undefined,
			existsFn: () => true,
			executablePath: "/chrome",
			spawnFn: (exe, args) => { seen.push({ exe, args }); return { pid: 4321, unref: () => { unrefed += 1; } }; },
		});
		assert.equal(result.ok, true);
		assert.equal(result.launched, true);
		assert.equal(result.pid, 4321);
		assert.equal(result.url, "https://grok.com/");
		assert.equal(seen.length, 1);
		assert.equal(seen[0]!.exe, "/chrome");
		assert.ok(seen[0]!.args.includes("--user-data-dir=/seed-grok"));
		assert.equal(unrefed, 1, "child must be unref'd so closing pi never kills the window");
	});

	it("surfaces an invalid --url instead of launching anything", () => {
		let spawned = 0;
		assert.throws(() => openSolOracleBrowser({
			profileDir: "/seed",
			singletonPid: () => undefined,
			existsFn: () => true,
			executablePath: "/chrome",
			url: "file:///etc/passwd",
			spawnFn: () => { spawned += 1; return { pid: 1 }; },
		}), /only http\(s\)/);
		assert.equal(spawned, 0);
	});

	it("validates --url before probing the singleton, so an open browser cannot mask a bad command", () => {
		// Regression guard: with a live owner the call used to short-circuit to
		// "already open" and never report the malformed URL.
		assert.throws(() => openSolOracleBrowser({
			profileDir: "/seed",
			singletonPid: () => 999,
			existsFn: () => true,
			executablePath: "/chrome",
			url: "javascript:alert(1)",
			spawnFn: () => ({ pid: 1 }),
		}), /only http\(s\)/);
	});

	it("fails when the child dies before reporting a pid", () => {
		const result = openSolOracleBrowser({
			profileDir: "/seed",
			singletonPid: () => undefined,
			existsFn: () => true,
			executablePath: "/chrome",
			spawnFn: () => ({}),
		});
		assert.equal(result.ok, false);
		assert.match(result.message, /exited before reporting a pid/);
	});
});

describe("formatSolOpenResult", () => {
	it("warns to close the window before the next /sol job", () => {
		const text = formatSolOpenResult({ ok: true, launched: true, pid: 5, profileDir: "/seed", url: "https://chatgpt.com/", executablePath: "/chrome" });
		assert.match(text, /PID 5/);
		assert.match(text, /Close the window before running \/sol/);
		assert.match(text, /No debug port/);
	});

	it("names the live pid when already open", () => {
		assert.match(formatSolOpenResult({ ok: true, launched: false, alreadyOpenPid: 42, profileDir: "/seed" }), /already open \(PID 42\)/);
	});
});
