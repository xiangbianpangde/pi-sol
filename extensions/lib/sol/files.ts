import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
	BLOCKED_EXTENSIONS,
	MAX_FILES_PER_REQUEST,
	extensionOf,
	isBlockedPath,
	maxBytesForPath,
} from "./limits.ts";

export type SolFileIssue = {
	path: string;
	reason: string;
};

export type SolStagedFile = {
	source: string;
	relative: string;
	bytes: number;
	copied: boolean;
};

export type SolStageResult = {
	files: SolStagedFile[];
	stagingDir?: string;
	issues: SolFileIssue[];
};

function posixRel(from: string, to: string): string {
	return relative(from, to).split(sep).join("/");
}

function isInside(cwd: string, target: string): boolean {
	const rel = posixRel(cwd, target);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Pick a collision-safe basename for an outside-project file. Keep the first
 * basename readable, then add a stable source-path digest (and, if needed, a
 * numeric suffix). A request-id directory is normally fresh, but checking the
 * filesystem also prevents a reused request id from overwriting an old stage.
 */
async function collisionSafeStagingName(stagingDir: string, source: string, usedNames: Set<string>): Promise<string> {
	const original = basename(source);
	const extension = extname(original);
	const stem = extension && extension !== original ? original.slice(0, -extension.length) : original;
	const digest = createHash("sha256").update(source).digest("hex").slice(0, 12);
	let candidate = original;
	let suffix = 0;
	while (usedNames.has(candidate) || await pathExists(join(stagingDir, candidate))) {
		suffix += 1;
		candidate = suffix === 1
			? `${stem}--${digest}${extension}`
			: `${stem}--${digest}-${suffix}${extension}`;
	}
	usedNames.add(candidate);
	return candidate;
}

export function validateSolFileMeta(filePath: string, bytes: number): SolFileIssue | undefined {
	if (isBlockedPath(filePath)) {
		return {
			path: filePath,
			reason: `Blocked extension ${extensionOf(filePath) || "(none)"} — ChatGPT web rejects executables/installers (${[...BLOCKED_EXTENSIONS].slice(0, 8).join(", ")}…)`,
		};
	}
	const limit = maxBytesForPath(filePath);
	if (bytes > limit) {
		return {
			path: filePath,
			reason: `File is ${(bytes / (1024 * 1024)).toFixed(1)} MiB; ChatGPT web cap for this type is ${(limit / (1024 * 1024)).toFixed(0)} MiB`,
		};
	}
	return undefined;
}

export async function stageSolFiles(
	cwd: string,
	requested: string[],
	options?: { prompt?: string; requestId?: string },
): Promise<SolStageResult> {
	const issues: SolFileIssue[] = [];
	if (requested.length > MAX_FILES_PER_REQUEST) {
		issues.push({
			path: "*",
			reason: `At most ${MAX_FILES_PER_REQUEST} files per /sol turn (ChatGPT custom-GPT lifetime cap is 10; paid rolling cap is 80 / 3h; Free is 3 / day)`,
		});
		return { files: [], issues };
	}

	const requestId = options?.requestId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const stagingDir = join(cwd, ".pi", "sol-staging", requestId);
	const staged: SolStagedFile[] = [];
	const usedStagingNames = new Set<string>();
	let usedStaging = false;

	for (const raw of requested) {
		const source = isAbsolute(raw) ? raw : resolve(cwd, raw);
		try {
			const info = await stat(source);
			if (!info.isFile()) {
				issues.push({ path: raw, reason: "Not a regular file (directories must be expanded by the caller)" });
				continue;
			}
			const metaIssue = validateSolFileMeta(source, info.size);
			if (metaIssue) {
				issues.push({ ...metaIssue, path: raw });
				continue;
			}
			if (isInside(cwd, source)) {
				staged.push({ source, relative: posixRel(cwd, source), bytes: info.size, copied: false });
				continue;
			}
			usedStaging = true;
			await mkdir(stagingDir, { recursive: true });
			const name = await collisionSafeStagingName(stagingDir, source, usedStagingNames);
			const dest = join(stagingDir, name);
			await copyFile(source, dest, fsConstants.COPYFILE_EXCL);
			staged.push({ source, relative: posixRel(cwd, dest), bytes: info.size, copied: true });
		} catch (error) {
			issues.push({
				path: raw,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (staged.length === 0 && options?.prompt) {
		usedStaging = true;
		await mkdir(stagingDir, { recursive: true });
		const dest = join(stagingDir, "request.md");
		const body = `# /sol request\n\n${options.prompt}\n`;
		await writeFile(dest, body, "utf8");
		staged.push({
			source: dest,
			relative: posixRel(cwd, dest),
			bytes: Buffer.byteLength(body),
			copied: true,
		});
	}

	return {
		files: staged,
		stagingDir: usedStaging ? stagingDir : undefined,
		issues,
	};
}
