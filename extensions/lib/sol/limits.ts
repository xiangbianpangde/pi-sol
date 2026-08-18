/**
 * ChatGPT web upload / access limits used by /sol before handing files to pi-oracle.
 * Sources: OpenAI Help “File Uploads FAQ” (8555545) and “GPT-5.6 in ChatGPT” (20001354).
 */
/** Plus highest Sol tier is High. Extra High / Pro need a Pro plan. */
export const SOL_PRESET = "thinking_extended" as const;
export const SOL_PRESET_LABEL = "GPT-5.6 Sol High";
export const SOL_PROVIDER = "chatgpt" as const;

/** Paid ChatGPT rolling upload rate. Free is 3/day; we still cap a single /sol turn. */
export const MAX_FILES_PER_REQUEST = 10;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_SPREADSHEET_BYTES = 50 * 1024 * 1024;
/** Rough proxy for the 2M-token text/document cap. Spreadsheets are exempt. */
export const MAX_TEXT_BYTES = 20 * 1024 * 1024;
export const PAID_UPLOADS_PER_3H = 80;
export const FREE_UPLOADS_PER_DAY = 3;
export const USER_STORAGE_GB = 25;

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
export const SPREADSHEET_EXTENSIONS = new Set([".csv", ".tsv", ".xls", ".xlsx"]);
export const DOCUMENT_EXTENSIONS = new Set([
	".pdf",
	".txt",
	".md",
	".markdown",
	".rtf",
	".doc",
	".docx",
	".ppt",
	".pptx",
	".html",
	".htm",
	".json",
	".xml",
	".yaml",
	".yml",
	".toml",
	".csv",
	".tsv",
	".xls",
	".xlsx",
]);

/** ChatGPT web is for documents / images / text, not binaries or installers. */
export const BLOCKED_EXTENSIONS = new Set([
	".exe",
	".dll",
	".so",
	".dylib",
	".app",
	".dmg",
	".pkg",
	".bat",
	".cmd",
	".msi",
	".scr",
	".com",
	".pif",
	".jar",
	".apk",
	".ipa",
	".iso",
	".bin",
	".run",
	".deb",
	".rpm",
	".appimage",
]);

export const CHATGPT_HOSTS = new Set([
	"chatgpt.com",
	"www.chatgpt.com",
	"chat.openai.com",
	"chatgpt.openai.com",
	"auth.openai.com",
]);

export function extensionOf(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return "";
	return base.slice(dot).toLowerCase();
}

export function isImagePath(filePath: string): boolean {
	return IMAGE_EXTENSIONS.has(extensionOf(filePath));
}

export function isSpreadsheetPath(filePath: string): boolean {
	return SPREADSHEET_EXTENSIONS.has(extensionOf(filePath));
}

export function isBlockedPath(filePath: string): boolean {
	return BLOCKED_EXTENSIONS.has(extensionOf(filePath));
}

export function maxBytesForPath(filePath: string): number {
	if (isImagePath(filePath)) return MAX_IMAGE_BYTES;
	if (isSpreadsheetPath(filePath)) return MAX_SPREADSHEET_BYTES;
	if (DOCUMENT_EXTENSIONS.has(extensionOf(filePath)) || extensionOf(filePath) === "") {
		return Math.min(MAX_FILE_BYTES, MAX_TEXT_BYTES);
	}
	return MAX_FILE_BYTES;
}
