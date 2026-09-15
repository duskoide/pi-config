import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachLiveCheck, inspectConfig, isPinnedNpm, parseLiveOutput, parseNpmSpec } from "../scripts/check-pi-config.mjs";

const roleModels = {
	Scout: "openai-codex/gpt-5.6-luna",
	Researcher: "commandcode/z-ai/glm-5.3-flash",
	Worker: "openai-codex/gpt-5.6-luna",
	Reviewer: "openai-codex/gpt-5.6-luna",
};

const roleTools = {
	Scout: "read, grep, find, ls",
	Researcher: "web_search, web_fetch",
	Worker: "read, grep, find, ls, bash, edit, write",
	Reviewer: "read, grep, find, ls",
};

async function makeFixture(settings, failover) {
	const root = await mkdtemp(join(tmpdir(), "pi-config-health-"));
	const agents = join(root, "agents");
	await mkdir(agents, { recursive: true });
	await writeFile(join(root, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
	await writeFile(join(root, "failover.json"), `${JSON.stringify(failover, null, 2)}\n`);
	for (const [name, model] of Object.entries(roleModels)) {
		await writeFile(join(agents, `${name}.md`), `---\ndescription: ${name} role\nmodel: ${model}\ntools: ${roleTools[name]}\n---\n`);
	}
	return {
		root,
		settingsPath: join(root, "settings.json"),
		failoverPath: join(root, "failover.json"),
		agentsDir: agents,
	};
}

const healthySettings = {
	packages: [
		{
			source: "npm:pi-background-tasks@2.5.0",
			extensions: ["extensions/background-tasks.ts"],
		},
		"npm:@xynogen/pix-pretty@1.22.0",
		"npm:pi-multi-account@1.21.3",
		"./pi-config",
	],
	defaultProvider: "commandcode",
	defaultModel: "deepseek/deepseek-v4.1-flash",
	defaultThinkingLevel: "max",
	defaultProjectTrust: "ask",
	httpIdleTimeoutMs: 300000,
	enabledModels: [
		"commandcode/deepseek/deepseek-v4.1-flash",
		"deepseek/deepseek-flash",
		"tokenharbor/deepseek-v4-flash",
	],
	subagents: { agentOverrides: { oracle: { model: "openai-codex/gpt-5.6-sol" } } },
};

const healthyFailover = {
	enabled: true,
	autoDiscoverModels: false,
	includeOtherProviders: false,
	childProxy: false,
	debugLog: false,
	providerOrder: ["openai-codex"],
	providerPriority: ["deepseek", "tokenharbor"],
	fallbacks: ["deepseek/deepseek-flash", "tokenharbor/deepseek-v4-flash"],
	maxAutoContinuesPerPrompt: 2,
};

test("pinned npm detection accepts only exact semver package specs", () => {
	assert.equal(isPinnedNpm("npm:pi-background-tasks@2.5.0"), true);
	assert.equal(isPinnedNpm("npm:@xynogen/pix-pretty@1.22.0"), true);
	assert.equal(isPinnedNpm("npm:pi-background-tasks@1.2.3-beta.1"), true);
	assert.equal(isPinnedNpm("npm:pi-background-tasks"), false);
	assert.equal(isPinnedNpm("npm:pi-background-tasks@latest"), false);
	assert.equal(isPinnedNpm("npm:pi-background-tasks@^2.5.0"), false);
	assert.equal(isPinnedNpm("npm:pi-background-tasks@2.5"), false);
	assert.equal(isPinnedNpm("npm:pi-background-tasks@2.5.0x"), false);
	assert.equal(isPinnedNpm("npm:pi-background-tasks@2.5.0/extra"), false);
	assert.equal(isPinnedNpm("npm:@xynogen/pi-background-tasks@2.5.0"), true);
	assert.equal(isPinnedNpm("npm:@xynogen/pi-background-tasks"), false);
	assert.equal(isPinnedNpm("npm:pi-background-tasks-extra@2.5.0"), true);
	assert.deepEqual(parseNpmSpec("npm:@xynogen/pi-background-tasks@2.5.0"), {
		name: "@xynogen/pi-background-tasks",
		version: "2.5.0",
	});
	assert.equal(isPinnedNpm("./pi-config"), true);
});

test("live parser rejects prompt echoes and accepts the exact routed response", () => {
	const promptEcho = `${JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "PI_CONFIG_HEALTH_OK" }] } })}\n`;
	assert.equal(parseLiveOutput(promptEcho, { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" }).ok, false);

	const response = `${JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			provider: "commandcode",
			model: "deepseek/deepseek-v4.1-flash",
			content: [{ type: "text", text: "PI_CONFIG_HEALTH_OK" }],
			stopReason: "stop",
		},
	})}\n`;
	const parsed = parseLiveOutput(response, { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" });
	assert.equal(parsed.ok, true);
	assert.equal(parsed.providerMatched, true);
	assert.equal(parsed.modelMatched, true);
	assert.equal(parsed.markerMatched, true);

	const wrongRoute = parseLiveOutput(response, { provider: "deepseek", model: "deepseek-flash" });
	assert.equal(wrongRoute.ok, false);
	assert.match(wrongRoute.reason, /provider/);

	const wrongModel = response.replace("deepseek/deepseek-v4.1-flash", "prefix/deepseek/deepseek-v4.1-flash");
	const wrongModelResult = parseLiveOutput(wrongModel, { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" });
	assert.equal(wrongModelResult.ok, false);
	assert.match(wrongModelResult.reason, /model/);

	const trailingError = `${response}${JSON.stringify({
		type: "message_end",
		message: { role: "assistant", provider: "commandcode", model: "deepseek/deepseek-v4.1-flash", content: [], stopReason: "error" },
	})}\n`;
	const trailingErrorResult = parseLiveOutput(trailingError, { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" });
	assert.equal(trailingErrorResult.ok, false);
	assert.match(trailingErrorResult.reason, /last assistant response stopped/);

	const toolResponse = `${JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			provider: "commandcode",
			model: "deepseek/deepseek-v4.1-flash",
			content: [{ type: "text", text: "PI_CONFIG_HEALTH_OK" }, { type: "toolCall", name: "bash" }],
			stopReason: "stop",
		},
	})}\n`;
	const toolResult = parseLiveOutput(toolResponse, { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash" });
	assert.equal(toolResult.ok, false);
	assert.match(toolResult.reason, /tool calls/);
});

test("provider priority keeps proven Codex ahead of unverified OpenAI", async () => {	const fixture = await makeFixture(healthySettings, {
		...healthyFailover,
		providerPriority: ["commandcode", "deepseek", "tokenharbor", "openai", "openai-codex"],
	});
	try {
		const report = inspectConfig(fixture);
		assert.equal(report.ok, false);
		assert.match(report.errors.join("\\n"), /unverified openai must not precede proven openai-codex/);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("lookalike package names do not satisfy required package checks", async () => {
	const fixture = await makeFixture({
		...healthySettings,
		packages: healthySettings.packages.filter((entry) => !String(typeof entry === "string" ? entry : entry.source).includes("pi-background-tasks"))
			.concat("npm:pi-background-tasks-extra@2.5.0"),
	}, healthyFailover);
	try {
		const report = inspectConfig(fixture);
		assert.equal(report.ok, false);
		assert.match(report.errors.join("\\n"), /required package is missing: npm:pi-background-tasks@2.5.0/);
		assert.match(report.errors.join("\\n"), /exactly one pinned pi-background-tasks package is required/);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("malformed roots and field types fail without throwing and skip live probes", async () => {
	const fixture = await makeFixture(healthySettings, healthyFailover);
	try {
		await writeFile(fixture.settingsPath, "null\n");
		await writeFile(fixture.failoverPath, "[]\n");
		const malformed = inspectConfig(fixture);
		assert.equal(malformed.ok, false);
		assert.match(malformed.errors.join("\\n"), /JSON root must be an object/);
		const skipped = await attachLiveCheck(malformed, true);
		assert.equal(skipped.liveDefault.skipped, true);
		assert.equal(skipped.liveDefault.reason, "static checks failed");

		await writeFile(fixture.settingsPath, JSON.stringify({ ...healthySettings, packages: "not-an-array" }));
		await writeFile(fixture.failoverPath, JSON.stringify({ ...healthyFailover, providerPriority: "not-an-array", fallbacks: ["not-a-route"], maxAutoContinuesPerPrompt: 8 }));
		const typed = inspectConfig(fixture);
		assert.equal(typed.ok, false);
		assert.match(typed.errors.join("\\n"), /packages must be an array/);
		assert.match(typed.errors.join("\\n"), /providerPriority must be an array/);
		assert.match(typed.errors.join("\\n"), /failover fallback route is malformed/);
		assert.match(typed.errors.join("\\n"), /maxAutoContinuesPerPrompt must be an integer/);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("healthy configuration passes static checks with a managed-only rotation warning", async () => {
	const fixture = await makeFixture(healthySettings, healthyFailover);
	try {
		const report = inspectConfig(fixture);
		assert.equal(report.ok, true);
		assert.deepEqual(report.errors, []);
		assert.doesNotMatch(report.warnings.join("\n"), /explicit fallbacks is empty/);
		assert.match(report.warnings.join("\n"), /default provider commandcode is outside managed failover discovery/);
		assert.equal(report.checks.fallbackCount, 2);
		assert.equal(report.checks.defaultRoute, "commandcode/deepseek/deepseek-v4.1-flash");
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("repository failover routes deprioritize Codex and target the DeepSeek-family routes", () => {
	const report = inspectConfig();
	// providerOrder is only a sequence preference: pi-multi-account re-appends every unlisted
	// managed family, so it cannot exclude openai-codex. providerPriority is the ordered ladder
	// that actually decides cross-provider selection, and unlisted providers sort last.
	assert.deepEqual(report.checks.providerPriority, ["deepseek", "tokenharbor"]);
	assert.ok(
		!report.checks.providerPriority.includes("openai-codex"),
		"providerPriority must not rank openai-codex, whose family auto-selects the sol flagship",
	);
	assert.ok(
		!report.checks.providerPriority.includes("anthropic"),
		"providerPriority must not rank anthropic, which has no credential",
	);
	assert.deepEqual(report.checks.fallbacks, ["tokenharbor/deepseek-v4-flash", "commandcode/Qwen/Qwen3.8-27B"]);
	assert.equal(report.checks.failoverPolicy.includeOtherProviders, false);
});

test("unsafe or drifting configuration fails with actionable errors", async () => {
	const fixture = await makeFixture(
		{
			packages: [
				{ source: "npm:pi-background-tasks", extensions: ["extensions/anthropic-attribution.ts"] },
				"npm:@xynogen/pix-pretty",
			],
			defaultProvider: "commandcode",
			defaultModel: "missing/model",
			defaultProjectTrust: "always",
			httpIdleTimeoutMs: 0,
			enabledModels: [],
			subagents: { agentOverrides: { scout: { model: "llama.cpp/tiel-coder-35b" } } },
		},
		{ enabled: true, providerOrder: ["deepseek"], fallbacks: [] },
	);
	try {
		await writeFile(join(fixture.agentsDir, "Reviewer.md"), "---\ndescription: Reviewer role\nmodel: openai-codex/gpt-5.6-luna\ntools: read, grep, find\n---\n");
		const report = inspectConfig(fixture);
		assert.equal(report.ok, false);
		const errors = report.errors.join("\n");
		assert.match(errors, /default route/);
		assert.match(errors, /Anthropic attribution/);
		assert.match(errors, /stale named subagent overrides/);
		assert.match(errors, /Reviewer requires tool ls/);
		// Deliberate local choices surface as warnings so they cannot mask real errors.
		const warnings = report.warnings.join("\n");
		assert.match(warnings, /defaultProjectTrust is "always"/);
		assert.match(warnings, /httpIdleTimeoutMs is 0/);
		assert.match(warnings, /unpinned npm packages/);
		assert.doesNotMatch(errors, /defaultProjectTrust|httpIdleTimeoutMs|unpinned npm packages/);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});
