import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, link, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectDelegatorConfig } from "../scripts/check-pi-delegator.mjs";
import { inspectConfig } from "../scripts/check-pi-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const expectedTools = {
	scout: ["read", "grep", "find", "ls"],
	reviewer: ["read", "grep", "find", "ls", "bash"],
	oracle: ["read", "grep", "find", "ls"],
	tester: ["read", "grep", "find", "ls", "bash"],
	worker: ["read", "grep", "find", "ls", "bash", "edit", "write"],
};
const profile = {
	description: "Independent advice",
	model: null,
	thinking: "high",
	prompt: "oracle.md",
	tools: ["read"],
	skills: [],
	extensions: [],
};

async function fixture(t, document = { profiles: { oracle: profile } }) {
	const directory = await mkdtemp(join(tmpdir(), "pi-delegator-config-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const configPath = join(directory, "pi-delegator.json");
	await writeFile(configPath, JSON.stringify(document));
	await writeFile(join(directory, "oracle.md"), "Advise without modifying files.\n");
	return { directory, configPath };
}

test("managed profiles retain standard capabilities and accept customized model/thinking settings", async () => {
	const config = JSON.parse(await readFile(join(root, ".pi/agent/pi-delegator.json"), "utf8"));
	const settings = JSON.parse(await readFile(join(root, ".pi/agent/settings.json"), "utf8"));
	assert.ok(settings.packages.includes("npm:@mostlyworks/pi-delegator@0.6.6"));
	assert.deepEqual(Object.keys(config.profiles), Object.keys(expectedTools));
	for (const [name, tools] of Object.entries(expectedTools)) {
		const entry = config.profiles[name];
		assert.ok(entry.model === null || typeof entry.model === "string", `${name} has a configurable model selector`);
		assert.ok(["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(entry.thinking));
		assert.equal(entry.deadlineMs, null);
		assert.deepEqual(entry.tools, tools);
		assert.deepEqual(entry.skills, []);
		assert.deepEqual(entry.extensions, ["delegator/qoder-provider.ts", `delegator/runtime/${name}.ts`]);
		assert.equal(entry.prompt, `delegator/${name}.md`);
		const prompt = await readFile(join(root, ".pi/agent", entry.prompt), "utf8");
		assert.match(prompt, new RegExp(`You are the ${name} delegate`));
		assert.match(prompt, /respect cancellation or any explicitly configured run deadline/);
		assert.match(prompt, /(?:launch nested agents|start long-lived services)/);
	}
	const license = await readFile(join(root, ".pi/agent/delegator/LICENSE"), "utf8");
	assert.match(license, /MIT License/);
	assert.match(license, /Ludwig Bäcklund/);
	const result = inspectDelegatorConfig();
	assert.deepEqual(result.errors, []);
	assert.equal(result.ok, true);
	assert.deepEqual(result.checks.enabledProfiles, Object.keys(expectedTools));
});

test("offline checks validate the optional failover sidecar without requiring provider packages", async (t) => {
	const { directory, configPath } = await fixture(t);
	assert.equal(inspectDelegatorConfig({ configPath }).ok, true);
	await mkdir(join(directory, "delegator"));
	const path = join(directory, "delegator/failover.json");
	for (const document of [{ version: 1, profiles: {} }, { version: 1, profiles: { oracle: { primary: null, fallback: "provider/fallback" } } }]) {
		await writeFile(path, JSON.stringify(document));
		assert.equal(inspectDelegatorConfig({ configPath }).ok, true);
	}
	for (const document of [{ profiles: {} }, { version: 2, profiles: {} }, { version: 1, profiles: { oracle: { fallback: "provider/fallback" } } }, { version: 1, profiles: { oracle: { primary: "provider/same", fallback: "provider/same" } } }, { version: 1, profiles: { oracle: { primary: null, fallback: "unqualified" } } }, { version: 1, profiles: { oracle: { primary: " spaced/model ", fallback: "provider/fallback" } } }, { version: 1, profiles: { oracle: { primary: null, fallback: "provider/*" } } }, { version: 1, profiles: { oracle: { primary: null, fallback: "provider/\u0000model" } } }]) {
		await writeFile(path, JSON.stringify(document));
		assert.equal(inspectDelegatorConfig({ configPath }).ok, false, JSON.stringify(document));
	}
	await writeFile(path, "bad JSON");
	assert.match(inspectDelegatorConfig({ configPath }).errors.join("\n"), /invalid bounded failover JSON/);
});

test("complete custom profiles and disabled entries are supported", async (t) => {
	const { directory, configPath } = await fixture(t, {
		profiles: {
			oracle: null,
			custom_advisor: { ...profile, model: "provider/model", displayName: "Advisor", thinking: "max", deadlineMs: 600000, skills: ["skill.md"], extensions: ["provider.ts"] },
		},
	});
	await writeFile(join(directory, "skill.md"), "# Skill\n");
	await writeFile(join(directory, "provider.ts"), "export default function () {}\n");
	const result = inspectDelegatorConfig({ configPath });
	assert.equal(result.ok, true, result.errors.join("\n"));
	assert.deepEqual(result.checks.enabledProfiles, ["custom_advisor"]);
	assert.deepEqual(result.checks.disabledProfiles, ["oracle"]);
});

const invalidProfiles = [
	["partial replacements", { model: null }, /missing required field/],
	["unknown fields", { ...profile, timeoutMs: 1000 }, /unknown field timeoutMs/],
	["blank models", { ...profile, model: " " }, /model must be null or a nonblank selector/],
	["unsupported thinking", { ...profile, thinking: "extreme" }, /unsupported thinking/],
	["blank display names", { ...profile, displayName: " " }, /displayName must be nonblank/],
	["zero deadlines", { ...profile, deadlineMs: 0 }, /deadlineMs must be null or an integer/],
	["oversized deadlines", { ...profile, deadlineMs: 2_147_483_648 }, /deadlineMs must be null or an integer/],
	["empty tool lists", { ...profile, tools: [] }, /tools must be a non-empty array/],
	["invalid tool names", { ...profile, tools: [42] }, /tools contains invalid names/],
	["duplicate tools", { ...profile, tools: ["read", "read"] }, /duplicate tools/],
	["nested delegation", { ...profile, tools: ["delegate"] }, /nested delegate calls are forbidden/],
	["nested background delegation", { ...profile, tools: ["delegate_start"] }, /nested delegate calls are forbidden/],
	["inline prompts", { ...profile, prompt: "Be helpful" }, /prompt must point to/],
	["missing prompts", { ...profile, prompt: "missing.md" }, /could not read prompt/],
	["remote capabilities", { ...profile, extensions: ["npm:provider"] }, /requires local filesystem paths/],
	["missing capabilities", { ...profile, skills: ["missing.md"] }, /is not readable/],
];
for (const [description, entry, expected] of invalidProfiles) {
	test(`offline checks reject ${description}`, async (t) => {
		const { configPath } = await fixture(t, { profiles: { oracle: entry } });
		const result = inspectDelegatorConfig({ configPath });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), expected);
	});
}

test("checks reject invalid roots, profile names, JSON and UTF-8 without throwing", async (t) => {
	const { configPath } = await fixture(t);
	for (const document of [null, [], { profiles: [] }, { profiles: {}, defaults: {} }, { profiles: { "Bad Name": null } }]) {
		await writeFile(configPath, JSON.stringify(document));
		assert.equal(inspectDelegatorConfig({ configPath }).ok, false);
	}
	for (const bytes of ["{", Buffer.from([0xff])]) {
		await writeFile(configPath, bytes);
		assert.equal(inspectDelegatorConfig({ configPath }).ok, false);
	}
	await rm(configPath);
	assert.equal(inspectDelegatorConfig({ configPath }).ok, false);
});

test("config and prompt size bounds are enforced and empty prompts are rejected", async (t) => {
	const { directory, configPath } = await fixture(t);
	await writeFile(configPath, " ".repeat(16 * 1024 + 1));
	assert.match(inspectDelegatorConfig({ configPath }).errors.join("\n"), /exceeds 16384/);
	await writeFile(configPath, JSON.stringify({ profiles: { oracle: profile } }));
	await writeFile(join(directory, "oracle.md"), "x".repeat(64 * 1024 + 1));
	assert.match(inspectDelegatorConfig({ configPath }).errors.join("\n"), /exceeds 65536/);
	await writeFile(join(directory, "oracle.md"), " \n");
	assert.match(inspectDelegatorConfig({ configPath }).errors.join("\n"), /prompt file is empty/);
});

test("capability duplicates and unsupported file types are rejected", async (t) => {
	const { directory, configPath } = await fixture(t, { profiles: { oracle: { ...profile, skills: ["skill.md", "./skill.md"], extensions: ["skill.md"] } } });
	await writeFile(join(directory, "skill.md"), "# Skill\n");
	const result = inspectDelegatorConfig({ configPath });
	assert.equal(result.ok, false);
	assert.match(result.errors.join("\n"), /duplicate skills/);
	assert.match(result.errors.join("\n"), /unsupported extensions path/);
});

test("explicit pi-delegator loading and its symlink/hardlink aliases are rejected", async (t) => {
	const { directory, configPath } = await fixture(t);
	const source = join(directory, "npm/node_modules/@mostlyworks/pi-delegator/src/index.ts");
	await mkdir(dirname(source), { recursive: true });
	await writeFile(source, "export default function () {}\n");
	const symlinkAlias = join(directory, "symlink.ts");
	const hardlinkAlias = join(directory, "hardlink.ts");
	await symlink(source, symlinkAlias);
	await link(source, hardlinkAlias);
	for (const extension of [source, symlinkAlias, hardlinkAlias]) {
		await writeFile(configPath, JSON.stringify({ profiles: { oracle: { ...profile, extensions: [extension] } } }));
		const result = inspectDelegatorConfig({ configPath });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /extensions may not load pi-delegator/);
	}
});

async function installerFixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "pi-delegator-install-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const checkout = join(directory, "checkout");
	const home = join(directory, "home");
	const assets = [
		"install.sh", "package.json", "herdr/config.toml", ".pi/web-search.json",
		".pi/agent/keybindings.json", ".pi/agent/custom-providers.json",
		".pi/agent/pi-searxng-suite.json", ".pi/agent/agents", ".pi/agents",
		".pi/agent/pi-delegator.json", ".pi/agent/delegator",
		"extensions/delegator-failover", "extensions/delegator-config/failover-config.ts",
		"scripts/check-pi-config.mjs", "scripts/check-pi-delegator.mjs",
	];
	for (const asset of assets) {
		await mkdir(dirname(join(checkout, asset)), { recursive: true });
		await cp(join(root, asset), join(checkout, asset), { recursive: true });
	}
	// Isolate installer behavior from the checkout's pre-existing failover-policy
	// drift. These routes are fixtures only and no provider is ever called.
	const settings = {
		packages: [
			{ source: "npm:pi-background-tasks@2.5.0", extensions: ["extensions/background-tasks.ts"] },
			"npm:@xynogen/pix-pretty@1.22.0", "npm:pi-multi-account@1.22.0",
			"npm:@mostlyworks/pi-delegator@0.6.6", "./pi-config",
		],
		defaultProvider: "openai-codex",
		defaultModel: "fixture",
		enabledModels: ["openai-codex/fixture"],
	};
	const failover = {
		enabled: true, includeOtherProviders: false, autoDiscoverModels: false,
		childProxy: false, debugLog: false,
		providerOrder: ["openai-codex"], providerPriority: ["openai-codex"],
		fallbacks: ["openai-codex/fixture"],
	};
	await writeFile(join(checkout, ".pi/agent/settings.json"), JSON.stringify(settings));
	await writeFile(join(checkout, ".pi/agent/provider-failover.json"), JSON.stringify(failover));
	const agentDir = join(home, ".pi/agent");
	const env = {
		...process.env, HOME: home,
		PI_CODING_AGENT_DIR: agentDir, PI_HOME_DIR: join(home, ".pi"),
		HERDR_CONFIG_DIR: join(home, ".config/herdr"), PI_CONFIG_SKIP_EXTERNAL_INSTALLS: "1",
	};
	return { checkout, home, agentDir, env };
}

test("installer links portable delegate files, preserves local data, and is idempotent", async (t) => {
	const { checkout, home, agentDir, env } = await installerFixture(t);
	await mkdir(join(agentDir, "delegator"), { recursive: true });
	await writeFile(join(agentDir, "pi-delegator.json"), '{"profiles":{}}\n');
	await writeFile(join(agentDir, "delegator/local.md"), "Local prompt\n");
	await writeFile(join(agentDir, "auth.json"), "LOCAL_AUTH_SENTINEL\n");
	for (let run = 0; run < 2; run += 1) {
		const result = spawnSync("bash", [join(checkout, "install.sh")], { cwd: home, env, encoding: "utf8", timeout: 15000 });
		assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
		assert.equal(await readlink(join(agentDir, "pi-delegator.json")), join(checkout, ".pi/agent/pi-delegator.json"));
		assert.equal(await readlink(join(agentDir, "delegator")), join(checkout, ".pi/agent/delegator"));
		assert.equal(await readFile(join(agentDir, "auth.json"), "utf8"), "LOCAL_AUTH_SENTINEL\n");
		const report = inspectDelegatorConfig({ configPath: join(agentDir, "pi-delegator.json") });
		assert.equal(report.ok, true, report.errors.join("\n"));
		const entries = await readdir(agentDir);
		const configBackups = entries.filter((name) => name.startsWith("pi-delegator.json.pre-config."));
		const promptBackups = entries.filter((name) => name.startsWith("delegator.pre-config."));
		assert.equal(configBackups.length, 1);
		assert.equal(promptBackups.length, 1);
		assert.equal(await readFile(join(agentDir, configBackups[0]), "utf8"), '{"profiles":{}}\n');
		assert.equal(await readFile(join(agentDir, promptBackups[0], "local.md"), "utf8"), "Local prompt\n");
	}
});

test("full health check incorporates delegator errors and reports configured profiles", async (t) => {
	const { checkout } = await installerFixture(t);
	const options = {
		settingsPath: join(checkout, ".pi/agent/settings.json"),
		failoverPath: join(checkout, ".pi/agent/provider-failover.json"),
		agentsDir: join(checkout, ".pi/agents"),
	};
	const good = inspectConfig(options);
	assert.equal(good.ok, true, good.errors.join("\n"));
	assert.deepEqual(good.checks.delegator.enabledProfiles, Object.keys(expectedTools));
	assert.equal(good.checks.delegator.configured, true);
	await writeFile(join(checkout, ".pi/agent/pi-delegator.json"), '{"profiles":{"oracle":{"model":null}}}');
	const bad = inspectConfig(options);
	assert.equal(bad.ok, false);
	assert.match(bad.errors.join("\n"), /profile oracle: missing required field/);
});
