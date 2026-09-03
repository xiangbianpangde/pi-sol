/**
 * /sol-open — open the oracle's isolated auth-seed Chrome so a human can fix it.
 *
 * pi-oracle gives no way to look inside its browser. When ChatGPT auth goes
 * stale, the model/power-slider state is wrong, or a job dies mid-flight, the
 * only real repair is to drive that profile by hand. This opens exactly the
 * profile every job clones from — headed, and with NO remote-debugging port, so
 * no automation (including an oracle worker) can attach to the manual window.
 *
 * Config comes off disk, mirroring jobs.ts / admission.ts: we never import
 * pi-oracle internals, because `pi update npm:pi-oracle` would silently drift
 * anything we duplicated. We therefore read only the keys we need and fall back
 * to pi-oracle's documented defaults.
 */
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	acquireSolOperationLease,
	getSolStateDir,
	releaseSolOperationLease,
	type SolOperationAdmission,
	type SolOperationLease,
} from "./admission.ts";
import { getOracleJobsDir, listActiveSolJobs, type SolJobSummary } from "./jobs.ts";

export const ORACLE_CONFIG_BASENAME = "oracle.json";
export const DEFAULT_AUTH_SEED_BASENAME = "oracle-auth-seed-profile";
/** pi-oracle appends this to the seed dir for the Grok provider. */
export const GROK_SEED_SUFFIX = "-grok";
export const DEFAULT_PROVIDER_URLS: Record<string, string> = {
	chatgpt: "https://chatgpt.com/",
	grok: "https://grok.com/",
};
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LINUX_CHROME_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "brave"];

export type SolOracleBrowserConfig = {
	/** Base seed dir (provider suffix is applied by seedProfileDir()). */
	authSeedProfileDir: string;
	executablePath?: string;
	configPath?: string;
};

export function oracleExtensionsDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.HOME ?? homedir(), ".pi", "agent", "extensions");
}

/**
 * Read the two browser keys /sol-open needs. `browser.profileDir` is honoured as
 * pi-oracle's legacy alias for the seed dir. Never throws: a missing or broken
 * config falls back to defaults, exactly like oracleMaxConcurrentJobs().
 */
export function readSolOracleBrowserConfig(env: NodeJS.ProcessEnv = process.env): SolOracleBrowserConfig {
	const dir = oracleExtensionsDir(env);
	const configPath = join(dir, ORACLE_CONFIG_BASENAME);
	const out: SolOracleBrowserConfig = { authSeedProfileDir: join(dir, DEFAULT_AUTH_SEED_BASENAME), configPath };
	try {
		if (existsSync(configPath)) {
			const cfg = JSON.parse(readFileSync(configPath, "utf8"));
			const seed = cfg?.browser?.authSeedProfileDir ?? cfg?.browser?.profileDir;
			if (typeof seed === "string" && seed.trim()) out.authSeedProfileDir = seed.trim();
			const exe = cfg?.browser?.executablePath;
			if (typeof exe === "string" && exe.trim()) out.executablePath = exe.trim();
		}
	} catch { /* fall back to the pi-oracle defaults */ }
	if (!out.executablePath) out.executablePath = detectChromeExecutablePath();
	return out;
}

/** PATH-based discovery, mirroring pi-oracle's Linux fallback. */
export function detectChromeExecutablePath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (platform === "darwin") return existsSync(MAC_CHROME) ? MAC_CHROME : undefined;
	if (platform !== "linux") return undefined;
	const paths = (env.PATH ?? "").split(":").filter(Boolean);
	for (const name of LINUX_CHROME_NAMES) {
		for (const base of paths) {
			const candidate = join(base, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

export function seedProfileDirForProvider(provider: string, config: SolOracleBrowserConfig): string {
	const base = config.authSeedProfileDir;
	return provider === "grok" ? `${base}${GROK_SEED_SUFFIX}` : base;
}

/**
 * Chrome's Chromium singleton lock is a symlink named `SingletonLock` whose
 * target is `<hostname>-<pid>`. Hostnames may contain hyphens, so only the
 * trailing segment is the PID. Returns undefined when there is no lock, the
 * lock is stale (dead PID), or it cannot be parsed — a stale lock is exactly
 * what pi-oracle's own clone path strips, so it must not block an open.
 */
export function singletonOwnerPid(profileDir: string, readlink: (p: string) => string = readlinkSync, isAlive: (pid: number) => boolean = pidIsAlive): number | undefined {
	let target: string;
	try {
		target = readlink(join(profileDir, "SingletonLock"));
	} catch {
		return undefined;
	}
	const match = /-(\d+)$/.exec(target.trim());
	if (!match) return undefined;
	const pid = Number.parseInt(match[1]!, 10);
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	return isAlive(pid) ? pid : undefined;
}

export function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A synchronous preflight used only for the real Chrome launch path. */
export function isExecutableFile(path: string): boolean {
	try {
		return statSync(path).isFile() && (accessSync(path, fsConstants.X_OK), true);
	} catch {
		return false;
	}
}

export type SolSeedLock = {
	profileDir: string;
	pid: number;
};

/** Return the live manual-browser owner for a provider's auth seed, if any. */
export function liveSolSeedLock(provider = "chatgpt", env: NodeJS.ProcessEnv = process.env): SolSeedLock | undefined {
	const normalizedProvider = provider.toLowerCase() === "grok" ? "grok" : "chatgpt";
	const config = readSolOracleBrowserConfig(env);
	const profileDir = seedProfileDirForProvider(normalizedProvider, config);
	const pid = singletonOwnerPid(profileDir);
	return pid === undefined ? undefined : { profileDir, pid };
}

/**
 * The manual launch arg set. Deliberately NOT the worker's set:
 *   - no --remote-debugging-port / --remote-allow-origins → no CDP surface, and
 *     an oracle worker session can never attach to this window (the guard that
 *     keeps /sol from colliding with a human driving the same profile);
 *   - no --headless=new / --hide-scrollbars → the whole point is a visible window;
 *   - --use-mock-keychain + --password-store=basic are KEPT, because the seed's
 *     cookies were written under exactly those flags; dropping them would make
 *     the profile look logged-out on macOS.
 *   - --disable-backgrounding-occluded-windows is kept so the tab is not
 *     throttled while the user is back in the pi terminal.
 */
export function solOpenBrowserArgs(profileDir: string, url: string): string[] {
	return [
		`--user-data-dir=${profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--disable-backgrounding-occluded-windows",
		"--disable-component-update",
		"--disable-default-apps",
		"--disable-hang-monitor",
		"--disable-sync",
		"--disable-features=Translate",
		"--metrics-recording-only",
		"--password-store=basic",
		"--use-mock-keychain",
		"--window-size=1280,900",
		url,
	];
}

/** Only HTTPS start URLs; never put an authenticated seed on plain HTTP. */
export function normalizeSolOpenUrl(raw: string | undefined, provider: string): string {
	const fallback = DEFAULT_PROVIDER_URLS[provider] ?? DEFAULT_PROVIDER_URLS.chatgpt!;
	if (!raw) return fallback;
	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		throw new Error(`Invalid --url ${JSON.stringify(raw)}: expected an absolute https URL`);
	}
	if (parsed.protocol !== "https:") {
		throw new Error(`Invalid --url protocol ${parsed.protocol}: only https may be opened`);
	}
	return parsed.toString();
}

export type SolOpenResult =
	| { ok: true; launched: true; pid: number; profileDir: string; url: string; executablePath: string }
	| { ok: true; launched: false; alreadyOpenPid: number; profileDir: string }
	| { ok: false; reason: "no-profile" | "no-chrome" | "active-jobs" | "operation-busy"; profileDir: string; message: string };

type SolOpenChild = {
	pid?: number;
	unref?: () => void;
	on?: (event: "error" | "exit" | "close", listener: (...args: any[]) => void) => unknown;
};

export type SolOpenDeps = {
	env?: NodeJS.ProcessEnv;
	config?: SolOracleBrowserConfig;
	provider?: string;
	url?: string;
	profileDir?: string;
	executablePath?: string;
	spawnFn?: (exe: string, args: string[]) => SolOpenChild;
	executableReadyFn?: (path: string) => boolean;
	/** Injectable for tests; production scans durable jobs before opening a seed. */
	activeJobsFn?: (provider: string) => SolJobSummary[];
	/** Injectable shared seed-operation lease; production uses the admission flock. */
	acquireOperationLeaseFn?: (stateDir: string) => Promise<SolOperationAdmission> | SolOperationAdmission;
	releaseOperationLeaseFn?: (lease: SolOperationLease) => Promise<boolean> | boolean;
	onSpawnError?: (error: Error) => void;
	existsFn?: (p: string) => boolean;
	singletonPid?: (profileDir: string) => number | undefined;
};

/**
 * Open (or report the already-open) oracle browser. The shared operation lease
 * is held from the final singleton/job checks through spawn and remains held
 * until the launched child exits or reports an error. This closes the startup
 * window where Chrome has not created SingletonLock yet.
 *
 * Every side effect is injectable so the ordering and lease lifetime are
 * directly testable without launching a real browser.
 */
export async function openSolOracleBrowser(deps: SolOpenDeps = {}): Promise<SolOpenResult> {
	const env = deps.env ?? process.env;
	const config = deps.config ?? readSolOracleBrowserConfig(env);
	const provider = deps.provider?.toLowerCase() === "grok" ? "grok" : "chatgpt";
	// Validate the caller's URL before touching the filesystem or probing the
	// Chromium singleton, so a malformed command always reports the usage error
	// instead of being masked by an "already open" short-circuit.
	const url = normalizeSolOpenUrl(deps.url, provider);
	const profileDir = deps.profileDir ?? seedProfileDirForProvider(provider, config);
	const exists = deps.existsFn ?? existsSync;
	const singletonPid = deps.singletonPid ?? singletonOwnerPid;
	// Fast path for a window that is already open. The authoritative re-check
	// runs after the shared lease is acquired below, closing the check/spawn race.
	const initialLivePid = singletonPid(profileDir);
	if (initialLivePid !== undefined) return { ok: true, launched: false, alreadyOpenPid: initialLivePid, profileDir };
	if (!exists(profileDir)) {
		return {
			ok: false,
			reason: "no-profile",
			profileDir,
			message: `Oracle ${provider} auth seed not found at ${profileDir}. Run /sol-auth first to create it.`,
		};
	}

	const acquireLease = deps.acquireOperationLeaseFn ?? ((stateDir: string) => acquireSolOperationLease(stateDir));
	let operation: SolOperationAdmission;
	try {
		operation = await acquireLease(getSolStateDir(env));
	} catch (error) {
		return {
			ok: false,
			reason: "operation-busy",
			profileDir,
			message: `Cannot acquire the shared /sol seed-operation lock before opening ${profileDir}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (!operation.acquired) {
		return {
			ok: false,
			reason: "operation-busy",
			profileDir,
			message: `Cannot open oracle ${provider} auth seed while another /sol seed operation is active: ${operation.reason}`,
		};
	}

	const lease = operation.lease;
	const releaseOperationLease = deps.releaseOperationLeaseFn ?? releaseSolOperationLease;
	let leaseReleased = false;
	const releaseHeldLease = (): void => {
		if (leaseReleased) return;
		leaseReleased = true;
		try {
			void Promise.resolve(releaseOperationLease(lease)).catch(() => { /* kernel close remains best-effort */ });
		} catch { /* a release diagnostic must not escape a child event */ }
	};
	let retainLease = false;
	try {
		// Re-check every observation under the same lock. A submit/recover that
		// acquired the lock first has now completed its handoff; an open that won
		// first keeps the lock through the browser startup lifecycle below.
		const livePid = singletonPid(profileDir);
		if (livePid !== undefined) return { ok: true, launched: false, alreadyOpenPid: livePid, profileDir };
		if (!exists(profileDir)) {
			return {
				ok: false,
				reason: "no-profile",
				profileDir,
				message: `Oracle ${provider} auth seed not found at ${profileDir}. Run /sol-auth first to create it.`,
			};
		}

		let activeJobs: SolJobSummary[];
		try {
			activeJobs = (deps.activeJobsFn ?? ((selectedProvider) => listActiveSolJobs(getOracleJobsDir(env), { provider: selectedProvider })))(provider);
		} catch (error) {
			return {
				ok: false,
				reason: "active-jobs",
				profileDir,
				message: `Cannot verify active oracle jobs before opening ${profileDir}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (activeJobs.length > 0) {
			const shown = activeJobs.slice(0, 3).map((job) => `${job.id} (${job.status})`).join(", ");
			const suffix = activeJobs.length > 3 ? `, +${activeJobs.length - 3} more` : "";
			return {
				ok: false,
				reason: "active-jobs",
				profileDir,
				message: `Cannot open oracle ${provider} auth seed while jobs are active: ${shown}${suffix}. Wait for them to finish before changing the seed.`,
			};
		}

		const executablePath = deps.executablePath ?? config.executablePath;
		if (!executablePath) {
			return {
				ok: false,
				reason: "no-chrome",
				profileDir,
				message: "No Chrome executable found. Set browser.executablePath in ~/.pi/agent/extensions/oracle.json.",
			};
		}
		// A real spawn failure is delivered asynchronously by ChildProcess. Do a
		// synchronous file/access preflight first, while still installing an error
		// listener below for races (permission changes, mount failures, etc.). A
		// custom spawnFn is a test seam and supplies its own readiness decision.
		const executableReady = deps.executableReadyFn ?? (deps.spawnFn ? (() => true) : isExecutableFile);
		if (!executableReady(executablePath)) {
			return {
				ok: false,
				reason: "no-chrome",
				profileDir,
				message: `Chrome executable is missing or not executable: ${executablePath}. Fix browser.executablePath in ~/.pi/agent/extensions/oracle.json.`,
			};
		}
		const spawnFn = deps.spawnFn ?? ((exe, args) => spawn(exe, args, { detached: true, stdio: "ignore" }));
		const child = spawnFn(executablePath, solOpenBrowserArgs(profileDir, url));
		const childHasLifecycle = typeof child.on === "function";
		child.on?.("error", (rawError) => {
			const error = rawError instanceof Error ? rawError : new Error(String(rawError));
			// Always consume the EventEmitter error so a stale executable can never
			// terminate Pi. The command handler supplies the user-facing callback.
			try { deps.onSpawnError?.(error); } catch { /* a diagnostic callback must not escape */ }
			releaseHeldLease();
		});
		// Keep the shared lease until the detached browser child exits. If Chrome
		// has handed off to a separate singleton process, the submit gate still
		// observes SingletonLock after this release; while startup is in progress
		// this lease is the atomic reservation that SingletonLock cannot provide.
		child.on?.("exit", () => releaseHeldLease());
		child.on?.("close", () => releaseHeldLease());
		child.unref?.();
		const pid = child.pid;
		if (typeof pid !== "number") {
			return { ok: false, reason: "no-chrome", profileDir, message: `Failed to launch ${executablePath}; it exited before reporting a pid.` };
		}
		retainLease = childHasLifecycle;
		return { ok: true, launched: true, pid, profileDir, url, executablePath };
	} finally {
		if (!retainLease) releaseHeldLease();
	}
}

/** Human-readable outcome for ctx.ui.notify. */
export function formatSolOpenResult(result: SolOpenResult): string {
	if (!result.ok) return result.message;
	if (!result.launched) {
		return `Oracle browser is already open (PID ${result.alreadyOpenPid}) on ${result.profileDir}. Close that window first to reopen it.`;
	}
	return [
		`Opened oracle ${result.url} (PID ${result.pid})`,
		`Profile: ${result.profileDir}`,
		"No debug port is exposed, so no agent can attach to this window.",
		"Close the window before running /sol: every job clones this seed profile.",
	].join("\n");
}
