import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export const MAX_FAILOVER_CONFIG_BYTES = 16 * 1024;
export interface FailoverProfile { primary: string | null; fallback: string; }
export interface FailoverConfig { version: 1; profiles: Record<string, FailoverProfile>; }

export function getFailoverConfigPath(): string {
	return join(getAgentDir(), "delegator", "failover.json");
}

export function normalizePrimaryModel(model: string | null): string | null {
	return model === null ? null : model.trim();
}

/** Exact provider/id only: no inheritance, fuzzy selectors, or wildcard routes. */
export function isExplicitFallbackRoute(value: unknown): value is string {
	return typeof value === "string" && value === value.trim() && Buffer.byteLength(value, "utf8") <= 256
		&& /^[^/\s\x00-\x1f\x7f*?]+\/[^\s\x00-\x1f\x7f*?]+$/u.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Shared by the UI and child readers; this module installs no runtime hooks. */
export function parseFailoverConfigText(text: string): FailoverConfig {
	if (Buffer.byteLength(text, "utf8") > MAX_FAILOVER_CONFIG_BYTES) throw new Error(`Failover config exceeds ${MAX_FAILOVER_CONFIG_BYTES} UTF-8 bytes`);
	const document: unknown = JSON.parse(text);
	if (!isObject(document) || Object.keys(document).length !== 2 || document.version !== 1 || !isObject(document.profiles)) {
		throw new Error("Failover config must contain only version: 1 and a profiles object");
	}
	for (const [name, entry] of Object.entries(document.profiles)) {
		if (name !== name.trim() || !/^[a-z][a-z0-9_-]*$/.test(name) || Buffer.byteLength(name, "utf8") > 64) throw new Error(`Invalid failover profile name: ${name}`);
		if (!isObject(entry) || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, "primary") || !Object.hasOwn(entry, "fallback")) {
			throw new Error(`Failover profile ${name} must contain only primary and fallback`);
		}
		if (entry.primary !== null && (typeof entry.primary !== "string" || !entry.primary.trim()
			|| entry.primary !== normalizePrimaryModel(entry.primary) || /[\x00-\x1f\x7f]/u.test(entry.primary)
			|| Buffer.byteLength(entry.primary, "utf8") > 256)) {
			throw new Error(`Failover profile ${name}: primary must be null or a normalized selector of at most 256 UTF-8 bytes`);
		}
		if (!isExplicitFallbackRoute(entry.fallback)) throw new Error(`Failover profile ${name}: fallback must be an explicit provider/id route of at most 256 UTF-8 bytes`);
		if (entry.primary === entry.fallback) throw new Error(`Failover profile ${name}: fallback must differ from primary`);
	}
	return document as unknown as FailoverConfig;
}

/** Missing means disabled. Reject oversized, non-regular, or invalid UTF-8 files. */
export function readFailoverConfigText(path: string): string | undefined {
	let descriptor: number;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		if (!fstatSync(descriptor).isFile()) throw new Error("Failover config must be a regular file");
		const bytes = Buffer.alloc(MAX_FAILOVER_CONFIG_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(descriptor, bytes, length, bytes.length - length, null);
			if (count === 0) break;
			length += count;
		}
		if (length > MAX_FAILOVER_CONFIG_BYTES) throw new Error(`Failover config exceeds ${MAX_FAILOVER_CONFIG_BYTES} UTF-8 bytes`);
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
	} finally {
		closeSync(descriptor);
	}
}

export function readFailoverConfig(path: string): FailoverConfig {
	const text = readFailoverConfigText(path);
	return text === undefined ? { version: 1, profiles: {} } : parseFailoverConfigText(text);
}
