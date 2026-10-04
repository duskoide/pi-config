#!/usr/bin/env node

import { accessSync, closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG = fileURLToPath(new URL("../.pi/agent/pi-delegator.json", import.meta.url));
export const MAX_CONFIG_BYTES = 16 * 1024;
const REQUIRED_FIELDS = ["description", "model", "thinking", "prompt", "tools", "skills", "extensions"];
const PROFILE_FIELDS = new Set([...REQUIRED_FIELDS, "displayName", "deadlineMs"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const EXTENSION_SUFFIXES = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const MAX_DEADLINE_MS = 2_147_483_647;

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value, maxBytes = Infinity) {
	return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function readText(path, maxBytes) {
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		if (!fstatSync(descriptor).isFile()) throw new Error("must be a regular file");
		const bytes = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(descriptor, bytes, length, bytes.length - length, null);
			if (count === 0) break;
			length += count;
		}
		if (length > maxBytes) throw new Error(`exceeds ${maxBytes} UTF-8 bytes`);
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
	} finally {
		closeSync(descriptor);
	}
}

export function readDelegatorConfigText(configPath) {
	return readText(configPath, MAX_CONFIG_BYTES);
}

function delegatorIdentities(configPath) {
	const agentDir = process.env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi/agent");
	const candidates = [dirname(configPath), agentDir].map((directory) => resolve(directory, "npm/node_modules/@mostlyworks/pi-delegator/src/index.ts"));
	candidates.push(fileURLToPath(new URL("../extensions/delegator-background/index.ts", import.meta.url)));
	return candidates.flatMap((candidate) => {
		try {
			const path = realpathSync(candidate);
			const info = statSync(path);
			return [{ path, dev: info.dev, ino: info.ino }];
		} catch {
			// No installed package is required for the portable defaults/checks.
			return [];
		}
	});
}

function checkCapabilities(paths, field, configPath, label, errors, delegators = []) {
	if (!Array.isArray(paths)) {
		errors.push(`${label}: ${field} must be an array of explicit local paths`);
		return;
	}
	const seen = new Set();
	for (const path of paths) {
		if (!isString(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path.trim())) {
			errors.push(`${label}: ${field} requires local filesystem paths, not remote sources`);
			continue;
		}
		try {
			const canonical = realpathSync(resolve(dirname(configPath), path.trim()));
			accessSync(canonical, constants.R_OK);
			const info = statSync(canonical);
			const suffix = extname(canonical).toLowerCase();
			const supported = field === "skills"
				? info.isDirectory() || (info.isFile() && suffix === ".md")
				: info.isFile() && EXTENSION_SUFFIXES.has(suffix);
			if (!supported) errors.push(`${label}: unsupported ${field} path ${path}`);
			if (field === "extensions" && delegators.some((source) => canonical === source.path || (info.dev === source.dev && info.ino === source.ino))) {
				errors.push(`${label}: extensions may not load pi-delegator or its background runner because nested delegation is forbidden`);
			}
			if (seen.has(canonical)) errors.push(`${label}: duplicate ${field} path ${path}`);
			seen.add(canonical);
		} catch (error) {
			errors.push(`${label}: ${field} path ${path} is not readable (${error.message})`);
		}
	}
}

function checkFailoverSidecar(configPath, errors, checks) {
	const path = resolve(dirname(configPath), "delegator/failover.json");
	let document;
	try { document = JSON.parse(readText(path, MAX_CONFIG_BYTES)); }
	catch (error) {
		if (error.code !== "ENOENT") errors.push(`${path}: invalid bounded failover JSON (${error.message})`);
		return;
	}
	checks.failover = { configured: true, enabledProfiles: [] };
	if (!isObject(document) || document.version !== 1 || !isObject(document.profiles) || Object.keys(document).some(key => !["version", "profiles"].includes(key))) {
		errors.push(`${path}: expected version 1 and a profiles map`);
		return;
	}
	for (const [name, policy] of Object.entries(document.profiles)) {
		if (!/^[a-z][a-z0-9_-]*$/.test(name) || Buffer.byteLength(name, "utf8") > 64 || !isObject(policy) || Object.keys(policy).length !== 2 ||
			!Object.hasOwn(policy, "primary") || !Object.hasOwn(policy, "fallback") ||
			(policy.primary !== null && (!isString(policy.primary, 256) || policy.primary !== policy.primary.trim() || /[\x00-\x1f\x7f]/u.test(policy.primary))) ||
			!isString(policy.fallback, 256) || !/^[^/\s\x00-\x1f\x7f*?]+\/[^\s\x00-\x1f\x7f*?]+$/u.test(policy.fallback)) {
			errors.push(`${path}: profile ${name} requires primary (null or selector) and explicit provider/model fallback`);
			continue;
		}
		if (policy.primary === policy.fallback) errors.push(`${path}: profile ${name} fallback must differ from primary`);
		checks.failover.enabledProfiles.push(name);
	}
}

/** Offline schema/path checks; the installed extension remains the runtime authority. */
export function inspectDelegatorDocument(document, { configPath = DEFAULT_CONFIG } = {}) {
	const errors = [];
	const checks = { enabledProfiles: [], disabledProfiles: [] };
	const delegators = delegatorIdentities(configPath);
	const report = () => ({ ok: errors.length === 0, errors, checks });
	if (!isObject(document) || Object.keys(document).length !== 1 || !isObject(document.profiles)) {
		errors.push(`${configPath}: expected only a top-level profiles object`);
		return report();
	}
	for (const [name, profile] of Object.entries(document.profiles)) {
		const label = `${configPath}: profile ${name}`;
		if (!/^[a-z][a-z0-9_-]*$/.test(name) || Buffer.byteLength(name, "utf8") > 64) {
			errors.push(`${label}: invalid profile name`);
		}
		if (profile === null) {
			checks.disabledProfiles.push(name);
			continue;
		}
		if (!isObject(profile)) {
			errors.push(`${label}: must be null or a complete profile object`);
			continue;
		}
		checks.enabledProfiles.push(name);
		for (const field of REQUIRED_FIELDS) {
			if (!Object.hasOwn(profile, field)) errors.push(`${label}: missing required field ${field}`);
		}
		for (const field of Object.keys(profile)) {
			if (!PROFILE_FIELDS.has(field)) errors.push(`${label}: unknown field ${field}`);
		}
		if (!isString(profile.description, 512)) errors.push(`${label}: description must be nonblank and at most 512 UTF-8 bytes`);
		if (Object.hasOwn(profile, "displayName") && !isString(profile.displayName, 256)) {
			errors.push(`${label}: displayName must be nonblank and at most 256 UTF-8 bytes`);
		}
		if (profile.model !== null && !isString(profile.model, 256)) {
			errors.push(`${label}: model must be null or a nonblank selector of at most 256 UTF-8 bytes`);
		}
		if (!THINKING_LEVELS.has(profile.thinking)) errors.push(`${label}: unsupported thinking level`);
		if (profile.deadlineMs != null && (!Number.isInteger(profile.deadlineMs) || profile.deadlineMs < 1 || profile.deadlineMs > MAX_DEADLINE_MS)) {
			errors.push(`${label}: deadlineMs must be null or an integer from 1 through ${MAX_DEADLINE_MS}`);
		}
		if (!Array.isArray(profile.tools) || profile.tools.length === 0) {
			errors.push(`${label}: tools must be a non-empty array`);
		} else {
			const valid = profile.tools.every((tool) => typeof tool === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(tool) && Buffer.byteLength(tool, "utf8") <= 64);
			if (!valid) errors.push(`${label}: tools contains invalid names`);
			if (new Set(profile.tools).size !== profile.tools.length) errors.push(`${label}: duplicate tools`);
			if (profile.tools.some((tool) => ["delegate", "delegate_start", "delegate_result", "delegate_cancel"].includes(tool))) errors.push(`${label}: nested delegate calls are forbidden`);
		}
		if (!isString(profile.prompt) || extname(profile.prompt.trim()).toLowerCase() !== ".md") {
			errors.push(`${label}: prompt must point to a non-empty Markdown file`);
		} else {
			try {
				const prompt = readText(resolve(dirname(configPath), profile.prompt.trim()), 64 * 1024);
				if (!prompt.trim()) errors.push(`${label}: prompt file is empty`);
			} catch (error) {
				errors.push(`${label}: could not read prompt ${profile.prompt} (${error.message})`);
			}
		}
		checkCapabilities(profile.skills, "skills", configPath, label, errors);
		checkCapabilities(profile.extensions, "extensions", configPath, label, errors, delegators);
	}
	checkFailoverSidecar(configPath, errors, checks);
	return report();
}

export function inspectDelegatorConfig({ configPath = DEFAULT_CONFIG } = {}) {
	try {
		return inspectDelegatorDocument(JSON.parse(readDelegatorConfigText(configPath)), { configPath });
	} catch (error) {
		return {
			ok: false,
			errors: [`${configPath}: could not read bounded UTF-8 JSON (${error.message})`],
			checks: { enabledProfiles: [], disabledProfiles: [] },
		};
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const configPath = args.find((arg) => arg !== "--json");
	const result = inspectDelegatorConfig(configPath ? { configPath: resolve(configPath) } : {});
	if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
	else {
		console.log(`Pi delegator config: ${result.ok ? "PASS" : "FAIL"}`);
		console.log(`  configured profiles: ${result.checks.enabledProfiles.join(", ") || "none"}`);
		for (const error of result.errors) console.log(`ERROR: ${error}`);
	}
	process.exitCode = result.ok ? 0 : 1;
}
