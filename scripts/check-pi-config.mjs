#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SETTINGS = join(REPO_ROOT, ".pi", "agent", "settings.json");
const DEFAULT_FAILOVER = join(REPO_ROOT, ".pi", "agent", "provider-failover.json");
const DEFAULT_AGENTS = join(REPO_ROOT, ".pi", "agents");
const ROLE_NAMES = ["scout", "researcher", "worker", "reviewer"];
const MANAGED_FAILOVER_GROUPS = new Set(["anthropic", "openai-codex", "kimi-coding", "cursor", "qwen", "ollama"]);
const ROLE_TOOL_REQUIREMENTS = {
	Scout: { required: ["read", "grep", "find", "ls"], forbidden: ["bash", "edit", "write", "web_search", "web_fetch"] },
	Researcher: { required: ["web_search", "web_fetch"], forbidden: ["read", "grep", "find", "ls", "bash", "edit", "write"] },
	Worker: { required: ["read", "grep", "find", "ls", "bash", "edit", "write"], forbidden: [] },
	Reviewer: { required: ["read", "grep", "find", "ls"], forbidden: ["bash", "edit", "write"] },
};
const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const REQUIRED_PACKAGE_VERSIONS = new Map([
	["pi-background-tasks", "2.5.0"],
	["@xynogen/pix-pretty", "1.22.0"],
	["pi-multi-account", "1.21.3"],
]);
const MARKER = "PI_CONFIG_HEALTH_OK";

function readJson(path, errors) {
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			errors.push(`${path}: JSON root must be an object`);
			return {};
		}
		return value;
	} catch (error) {
		errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
}

function arrayField(object, key, errors, path) {
	if (object[key] === undefined) return [];
	if (!Array.isArray(object[key])) {
		errors.push(`${path}: ${key} must be an array`);
		return [];
	}
	return object[key];
}

function stringArrayField(object, key, errors, path) {
	const value = arrayField(object, key, errors, path);
	const invalid = value.filter((item) => typeof item !== "string");
	if (invalid.length) errors.push(`${path}: ${key} must contain only strings`);
	return value.filter((item) => typeof item === "string");
}

function packageSource(entry) {
	return typeof entry === "string" ? entry : entry && typeof entry.source === "string" ? entry.source : undefined;
}

function rawNpmName(source) {
	if (typeof source !== "string" || !source.startsWith("npm:")) return undefined;
	const spec = source.slice(4);
	const versionAt = spec.lastIndexOf("@");
	return (versionAt > 0 ? spec.slice(0, versionAt) : spec) || undefined;
}

function parseNpmSpec(source) {
	const name = rawNpmName(source);
	if (!name || !NPM_NAME.test(name)) return undefined;
	const spec = source.slice(4);
	const versionAt = spec.lastIndexOf("@");
	if (versionAt <= 0) return undefined;
	const version = spec.slice(versionAt + 1);
	if (!EXACT_SEMVER.test(version)) return undefined;
	return { name, version };
}

function isPinnedNpm(source) {
	return !source?.startsWith("npm:") || parseNpmSpec(source) !== undefined;
}

function parseFrontmatter(text) {
	const match = text.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};
	const fields = {};
	for (const line of match[1].split("\n")) {
		const colon = line.indexOf(":");
		if (colon < 1) continue;
		fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, "");
	}
	return fields;
}

function inspectConfig({
	settingsPath = DEFAULT_SETTINGS,
	failoverPath = DEFAULT_FAILOVER,
	agentsDir = DEFAULT_AGENTS,
} = {}) {
	const errors = [];
	const warnings = [];
	const settings = readJson(settingsPath, errors);
	const failover = readJson(failoverPath, errors);
	const packages = arrayField(settings, "packages", errors, settingsPath);
	const enabledModels = stringArrayField(settings, "enabledModels", errors, settingsPath);
	const defaultProvider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : "";
	const defaultModel = typeof settings.defaultModel === "string" ? settings.defaultModel : "";
	const defaultRoute = defaultProvider && defaultModel ? `${defaultProvider}/${defaultModel}` : "";
	const failoverOrder = stringArrayField(failover, "providerOrder", errors, failoverPath);
	const providerPriority = stringArrayField(failover, "providerPriority", errors, failoverPath);
	const fallbacks = stringArrayField(failover, "fallbacks", errors, failoverPath);
	if (settings.defaultProvider !== undefined && typeof settings.defaultProvider !== "string") {
		errors.push(`${settingsPath}: defaultProvider must be a string`);
	}
	if (settings.defaultModel !== undefined && typeof settings.defaultModel !== "string") {
		errors.push(`${settingsPath}: defaultModel must be a string`);
	}
	if (settings.defaultThinkingLevel !== undefined && typeof settings.defaultThinkingLevel !== "string") {
		errors.push(`${settingsPath}: defaultThinkingLevel must be a string`);
	}
	if (settings.defaultProjectTrust !== undefined && typeof settings.defaultProjectTrust !== "string") {
		errors.push(`${settingsPath}: defaultProjectTrust must be a string`);
	}
	for (const key of ["enabled", "autoContinue", "autoDiscover", "autoDiscoverModels", "includeQwen", "includeOllama", "includeCursor", "includeOtherProviders", "childProxy", "debugLog"]) {
		if (failover[key] !== undefined && typeof failover[key] !== "boolean") {
			errors.push(`${failoverPath}: ${key} must be a boolean`);
		}
	}
	if (failover.maxAutoContinuesPerPrompt !== undefined && (!Number.isInteger(failover.maxAutoContinuesPerPrompt) || failover.maxAutoContinuesPerPrompt < 1 || failover.maxAutoContinuesPerPrompt > 2)) {
		errors.push(`${failoverPath}: maxAutoContinuesPerPrompt must be an integer from 1 through 2`);
	}
	const failoverConsumerConfigured = packages.some((entry) => parseNpmSpec(packageSource(entry))?.name === "pi-multi-account");
	if (settings.subagents !== undefined && (!settings.subagents || typeof settings.subagents !== "object" || Array.isArray(settings.subagents))) {
		errors.push(`${settingsPath}: subagents must be an object`);
	}
	const agentOverrides = settings.subagents?.agentOverrides;
	if (agentOverrides !== undefined && (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides))) {
		errors.push(`${settingsPath}: subagents.agentOverrides must be an object`);
	}
	const namedOverrides = Object.keys(agentOverrides && typeof agentOverrides === "object" ? agentOverrides : {}).filter((name) =>
		ROLE_NAMES.includes(name.toLowerCase()),
	);

	if (!defaultRoute) errors.push("defaultProvider and defaultModel must both be set");
	if (defaultRoute && !enabledModels.includes(defaultRoute)) {
		errors.push(`default route ${defaultRoute} is not present in enabledModels`);
	}
	const duplicateFallbacks = fallbacks.filter((target, index) => fallbacks.indexOf(target) !== index);
	if (duplicateFallbacks.length) errors.push(`duplicate failover fallback routes: ${[...new Set(duplicateFallbacks)].join(", ")}`);
	for (const target of fallbacks) {
		const slash = target.indexOf("/");
		if (slash <= 0 || slash === target.length - 1) {
			errors.push(`failover fallback route is malformed: ${target}`);
		} else if (!enabledModels.includes(target)) {
			errors.push(`failover fallback route ${target} is not present in enabledModels`);
		}
	}
	// These three are reported as warnings, not failures: they encode deliberate local choices
	// (see README). They still surface, so drift stays visible without hiding real errors.
	const projectTrust = settings.defaultProjectTrust ?? "ask";
	if (projectTrust === "always") {
		warnings.push('defaultProjectTrust is "always"; project-local settings, packages, and extensions load without a trust prompt');
	}
	if (settings.httpIdleTimeoutMs !== undefined && settings.httpIdleTimeoutMs !== 0) {
		if (!Number.isFinite(settings.httpIdleTimeoutMs) || settings.httpIdleTimeoutMs < 0) {
			warnings.push("httpIdleTimeoutMs must be a finite positive number, or 0 to disable the idle timeout");
		}
	} else if (settings.httpIdleTimeoutMs === 0) {
		warnings.push("httpIdleTimeoutMs is 0; the provider HTTP idle timeout is disabled");
	}

	const malformedPackageEntries = packages.filter((entry) => !packageSource(entry));
	if (malformedPackageEntries.length) errors.push(`package entries must be strings or objects with a string source (found ${malformedPackageEntries.length})`);
	const packageSources = packages.map(packageSource).filter(Boolean);
	const floatingPackages = packageSources.filter((source) => source.startsWith("npm:") && !isPinnedNpm(source));
	if (floatingPackages.length) warnings.push(`unpinned npm packages: ${floatingPackages.join(", ")}`);
	const parsedPackages = packageSources.map(parseNpmSpec).filter(Boolean);
	const packageCounts = new Map();
	for (const spec of parsedPackages) packageCounts.set(spec.name, (packageCounts.get(spec.name) ?? 0) + 1);
	for (const [name, count] of packageCounts) {
		if (count > 1) errors.push(`duplicate npm package entries: ${name} (${count})`);
	}
	for (const [name, version] of REQUIRED_PACKAGE_VERSIONS) {
		const matches = parsedPackages.filter((spec) => spec.name === name);
		if (matches.length === 0) errors.push(`required package is missing: npm:${name}@${version}`);
		else if (matches.some((spec) => spec.version !== version)) errors.push(`${name} must be pinned to ${version}`);
	}

	const backgroundPackages = packages.filter((entry) => parseNpmSpec(packageSource(entry))?.name === "pi-background-tasks");
	const backgroundAttributionPackages = packages.filter((entry) =>
		rawNpmName(packageSource(entry)) === "pi-background-tasks"
			&& Array.isArray(entry?.extensions)
			&& entry.extensions.includes("extensions/anthropic-attribution.ts"),
	);
	if (backgroundAttributionPackages.length) {
		errors.push("Anthropic attribution must stay excluded for the configured API-key mode");
	}
	const backgroundPackage = backgroundPackages[0];
	const backgroundExtensions = backgroundPackage && Array.isArray(backgroundPackage.extensions)
		? backgroundPackage.extensions
		: undefined;
	if (backgroundPackages.length !== 1) {
		errors.push(`exactly one pinned pi-background-tasks package is required (found ${backgroundPackages.length})`);
	} else {
		if (!Array.isArray(backgroundPackage.extensions)) {
			errors.push("pi-background-tasks extensions must be an array");
		} else if (backgroundExtensions.length !== 1 || backgroundExtensions[0] !== "extensions/background-tasks.ts") {
			errors.push("pi-background-tasks must load only extensions/background-tasks.ts");
		}
	}

	if (!failover.enabled) warnings.push("provider failover is disabled");
	if (failover.includeOtherProviders !== false) {
		errors.push("includeOtherProviders must be false to keep automatic failover from spending undisclosed API-key providers");
	}
	if (failover.autoDiscoverModels !== false) errors.push("autoDiscoverModels must be false; use the checked-in model catalog unless explicitly re-enabled");
	if (failover.childProxy !== false) errors.push("childProxy must be false to avoid loopback auth shadowing for extension-free children");
	if (failover.debugLog !== false) errors.push("debugLog must be false to avoid persistent provider-failover logs by default");
	if (!failoverConsumerConfigured) errors.push("pinned pi-multi-account failover consumer is missing");
	if (defaultProvider && !providerPriority.includes(defaultProvider)) {
		if (failover.includeOtherProviders === false && !MANAGED_FAILOVER_GROUPS.has(defaultProvider)) {
			warnings.push(`default provider ${defaultProvider} is outside managed failover discovery; only explicit fallback routes cover cross-provider recovery`);
		} else {
			errors.push(`failover providerPriority omits default provider ${defaultProvider}`);
		}
	}
	const openaiIndex = providerPriority.indexOf("openai");
	const codexIndex = providerPriority.indexOf("openai-codex");
	if (openaiIndex >= 0 && codexIndex >= 0 && openaiIndex < codexIndex) {
		errors.push("unverified openai must not precede proven openai-codex in providerPriority");
	}
	const invalidManagedGroups = failoverOrder.filter((provider) => !MANAGED_FAILOVER_GROUPS.has(provider));
	if (invalidManagedGroups.length) {
		errors.push(`failover providerOrder contains unmanaged groups: ${invalidManagedGroups.join(", ")}`);
	}
	if (failover.includeOtherProviders !== false) {
		for (const provider of ["deepseek", "tokenharbor", "openai-codex"]) {
			if (!providerPriority.includes(provider)) warnings.push(`failover providerPriority omits proven route ${provider}`);
		}
	}
	if (fallbacks.length === 0) {
		if (failoverConsumerConfigured) warnings.push("explicit fallbacks is empty; pi-multi-account uses its dynamic account/model rotation");
		else warnings.push("failover fallbacks is empty; runtime fallback behavior still requires a verified consumer");
	}
	if (namedOverrides.length) {
		errors.push(`stale named subagent overrides remain: ${namedOverrides.join(", ")}`);
	}

	const roles = {};
	for (const role of ["Scout", "Researcher", "Worker", "Reviewer"]) {
		const path = join(agentsDir, `${role}.md`);
		if (!existsSync(path)) {
			errors.push(`missing role file ${path}`);
			continue;
		}
		let text;
		try {
			text = readFileSync(path, "utf8");
		} catch (error) {
			errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const frontmatter = parseFrontmatter(text);
		const tools = (frontmatter.tools ?? "").split(",").map((tool) => tool.trim()).filter(Boolean);
		roles[role] = { model: frontmatter.model ?? "", tools: frontmatter.tools ?? "" };
		if (!frontmatter.model) errors.push(`${path}: model is missing`);
		const requirements = ROLE_TOOL_REQUIREMENTS[role];
		for (const tool of requirements.required) {
			if (!tools.includes(tool)) errors.push(`${path}: ${role} requires tool ${tool}`);
		}
		for (const tool of requirements.forbidden) {
			if (tools.includes(tool)) errors.push(`${path}: ${role} must not request tool ${tool}`);
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		warnings,
		checks: {
			defaultRoute,
			defaultThinkingLevel: settings.defaultThinkingLevel ?? null,
			httpIdleTimeoutMs: settings.httpIdleTimeoutMs ?? null,
			defaultProjectTrust: settings.defaultProjectTrust ?? null,
			packageCount: packages.length,
			floatingPackages,
			failoverConsumerConfigured,
			failoverOrder,
			providerPriority,
			fallbackCount: fallbacks.length,
			fallbacks,
			failoverPolicy: {
				includeOtherProviders: failover.includeOtherProviders ?? null,
				autoDiscoverModels: failover.autoDiscoverModels ?? null,
				childProxy: failover.childProxy ?? null,
				debugLog: failover.debugLog ?? null,
			},
			roles,
		},
	};
}

export function parseLiveOutput(output, { provider, model, marker = MARKER } = {}) {
	const events = [];
	let parseErrors = 0;
	for (const line of String(output ?? "").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			parseErrors += 1;
		}
	}
	const assistantEnds = events
		.filter((event) => event?.type === "message_end" && event.message?.role === "assistant")
		.map((event) => event.message);
	const final = assistantEnds.at(-1);
	const content = Array.isArray(final?.content) ? final.content : [];
	const text = content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("");
	const hasToolCalls = Boolean(final && (
		(Array.isArray(final.toolCalls) && final.toolCalls.length > 0) ||
		content.some((block) => block?.type === "toolCall" || block?.type === "tool_use")
	));
	const stopped = final?.stopReason === "stop";
	const markerMatched = text === marker;
	const providerMatched = final?.provider === provider;
	const modelMatched = final?.model === model;
	let reason;
	if (parseErrors) reason = `unparseable JSON lines: ${parseErrors}`;
	else if (!final) reason = "no assistant response";
	else if (!stopped) reason = `last assistant response stopped with ${final.stopReason ?? "missing reason"}`;
	else if (hasToolCalls) reason = "last assistant response included tool calls";
	else if (!providerMatched) reason = `response provider was ${final.provider ?? "missing"}`;
	else if (!modelMatched) reason = `response model was ${final.model ?? "missing"}`;
	else if (!markerMatched) reason = "final assistant text did not exactly match the marker";
	return {
		ok: Boolean(final) && parseErrors === 0 && stopped && !hasToolCalls && providerMatched && modelMatched && markerMatched,
		eventCount: events.length,
		parseErrors,
		responseProvider: final?.provider,
		responseModel: final?.model,
		providerMatched,
		modelMatched,
		markerMatched,
		hasToolCalls,
		reason,
	};
}

function killProcessTree(child, signal) {
	if (process.platform !== "win32" && child.pid) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Fall through to the direct child when the process group is already gone.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// The child may have exited between the timeout and this cleanup attempt.
	}
}

function runBounded(command, args, { cwd, env, input, timeoutMs = 120_000, maxBuffer = 1_000_000 } = {}) {
	return new Promise((resolveRun) => {
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let outputLimit = false;
		let spawnError;
		let terminationStarted = false;
		let termTimer;
		const append = (target, chunk) => {
			const text = String(chunk);
			if (target === "stdout") {
				if (stdout.length < maxBuffer) stdout += text.slice(0, maxBuffer - stdout.length);
				if (stdout.length >= maxBuffer) outputLimit = true;
			} else {
				if (stderr.length < maxBuffer) stderr += text.slice(0, maxBuffer - stderr.length);
				if (stderr.length >= maxBuffer) outputLimit = true;
			}
			if (outputLimit && !terminationStarted) terminate();
		};
		const terminate = () => {
			if (terminationStarted) return;
			terminationStarted = true;
			killProcessTree(child, "SIGTERM");
			termTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000);
		};
		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => append("stdout", chunk));
		child.stderr?.on("data", (chunk) => append("stderr", chunk));
		child.once("error", (error) => {
			spawnError = error;
		});
		child.once("close", (status, signal) => {
			clearTimeout(timeoutTimer);
			if (termTimer) clearTimeout(termTimer);
			resolveRun({
				status,
				signal,
				stdout,
				stderr,
				timedOut,
				outputLimit,
				error: spawnError,
			});
		});
		if (input !== undefined) child.stdin?.end(input);
		else child.stdin?.end();
	});
}

function installedConfigMatches() {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
	if (!agentDir) return false;
	for (const [installed, source] of [[join(agentDir, "settings.json"), DEFAULT_SETTINGS], [join(agentDir, "provider-failover.json"), DEFAULT_FAILOVER]]) {
		try {
			if (readFileSync(installed, "utf8") !== readFileSync(source, "utf8")) return false;
		} catch {
			return false;
		}
	}
	return true;
}

async function liveDefaultCheck(route, thinking) {
	const slash = route.indexOf("/");
	if (slash <= 0 || slash === route.length - 1) {
		return { ok: false, exitCode: null, timedOut: false, reason: "default route is malformed" };
	}
	const provider = route.slice(0, slash);
	const model = route.slice(slash + 1);
	const args = [
		"--mode",
		"json",
		"--no-tools",
		"--no-session",
		"--no-context-files",
		"--no-skills",
		"--offline",
		"--provider",
		provider,
		"--model",
		model,
		"--thinking",
		thinking || "off",
		"-p",
		`Reply with exactly ${MARKER} and nothing else.`,
	];
	if (!installedConfigMatches()) {
		return { ok: false, exitCode: null, timedOut: false, skipped: true, reason: "installed Pi settings/failover do not match this checkout" };
	}
	const cwd = mkdtempSync(join(tmpdir(), "pi-config-health-live-"));
	try {
		// Keep sessions and generated files out of the checkout, while using the installed agent
		// directory for the exact settings/failover files and machine-local auth/catalog state.
		const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
		const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
		const result = await runBounded("pi", args, {
			cwd,
			env,
			maxBuffer: 1_000_000,
		});
		const parsed = parseLiveOutput(result.stdout, { provider, model });
		return {
			ok: result.status === 0 && !result.error && !result.timedOut && !result.outputLimit && parsed.ok,
			exitCode: result.status,
			timedOut: result.timedOut,
			outputLimit: result.outputLimit,
			responseProvider: parsed.responseProvider,
			responseModel: parsed.responseModel,
			markerMatched: parsed.markerMatched,
			reason: result.error
				? `could not start pi: ${result.error.code ?? "spawn error"}`
				: parsed.reason ?? (result.status === 0 ? undefined : "pi exited unsuccessfully"),
		};
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

export async function attachLiveCheck(report, live) {
	if (!live) return report;
	report.liveDefault = report.ok
		? await liveDefaultCheck(report.checks.defaultRoute, report.checks.defaultThinkingLevel)
		: { ok: false, skipped: true, reason: "static checks failed" };
	return report;
}

async function main(argv) {
	const json = argv.includes("--json");
	const live = argv.includes("--live");
	const report = await attachLiveCheck(inspectConfig(), live);
	if (json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(`Pi config health: ${report.ok && (!live || report.liveDefault.ok) ? "PASS" : "FAIL"}`);
		console.log(`  default: ${report.checks.defaultRoute} (${report.checks.defaultThinkingLevel ?? "unspecified"})`);
		console.log(`  packages: ${report.checks.packageCount}; floating: ${report.checks.floatingPackages.length}`);
		console.log(`  failover consumer (configured): ${report.checks.failoverConsumerConfigured ? "pi-multi-account" : "missing"}`);
		console.log(`  failover order: ${report.checks.failoverOrder.join(" -> ") || "none"}`);
		console.log(`  explicit fallbacks: ${report.checks.fallbacks.join(" -> ") || "none"}`);
		console.log(`  provider priority: ${report.checks.providerPriority.join(" -> ") || "none"}`);
		console.log(`  failover policy: managed-only=${report.checks.failoverPolicy.includeOtherProviders === false ? "yes" : "no"}; catalog discovery=${report.checks.failoverPolicy.autoDiscoverModels === false ? "off" : "on"}; child proxy=${report.checks.failoverPolicy.childProxy === false ? "off" : "on"}; debug log=${report.checks.failoverPolicy.debugLog === false ? "off" : "on"}`);
		for (const [role, details] of Object.entries(report.checks.roles)) console.log(`  ${role}: ${details.model}`);
		for (const warning of report.warnings) console.log(`WARN: ${warning}`);
		for (const error of report.errors) console.log(`ERROR: ${error}`);
		if (live) {
			const liveStatus = report.liveDefault.skipped ? "SKIPPED" : report.liveDefault.ok ? "PASS" : "FAIL";
			const route = report.liveDefault.responseProvider && report.liveDefault.responseModel
				? ` (${report.liveDefault.responseProvider}/${report.liveDefault.responseModel})`
				: "";
			console.log(`  live default: ${liveStatus}${route}`);
		}
	}
	return report.ok && (!live || report.liveDefault.ok) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	process.exitCode = await main(process.argv.slice(2));
}

export { inspectConfig, isPinnedNpm, parseFrontmatter, parseNpmSpec };
