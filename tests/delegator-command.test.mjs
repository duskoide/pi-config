import assert from "node:assert/strict";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import delegatorConfig, { delegateFallbackModelChoices, delegateModelChoices, getEditableProfiles, INHERIT_MODEL, NO_AUTO_FAILOVER, saveDelegateSelection, saveFailoverSelection, THINKING_LEVELS } from "../extensions/delegator-config/index.ts";
import { getFailoverConfigPath, readFailoverConfig } from "../extensions/delegator-config/failover-config.ts";

const PRIMARY_ACTION = "Primary model and thinking";
const FALLBACK_ACTION = "Initial fallback model";

const root = fileURLToPath(new URL("../", import.meta.url));
const models = [{ provider: "openai-codex", id: "test-model" }, { provider: "commandcode", id: "test-model" }];

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "pi-delegator-command-"));
	const targetDir = join(directory, "checkout/.pi/agent");
	const agentDir = join(directory, "agent");
	const cwd = join(directory, "project");
	await Promise.all([targetDir, agentDir, cwd].map((path) => mkdir(path, { recursive: true })));
	await cp(join(root, ".pi/agent/delegator"), join(targetDir, "delegator"), { recursive: true });
	const target = join(targetDir, "pi-delegator.json");
	const document = JSON.parse(await readFile(join(root, ".pi/agent/pi-delegator.json"), "utf8"));
	// Runtime settings are deliberately editable through the slash command.
	// Normalize only this disposable copy, never the user's managed JSON.
	for (const [name, profile] of Object.entries(document.profiles)) {
		if (profile) { profile.model = null; profile.thinking = name === "scout" ? "low" : "high"; profile.extensions = []; }
	}
	await writeFile(target, JSON.stringify(document, null, 2));
	await chmod(target, 0o600);
	const configPath = join(agentDir, "pi-delegator.json");
	await symlink(target, configPath);
	await symlink(join(targetDir, "delegator"), join(agentDir, "delegator"));
	const failoverPath = join(agentDir, "delegator/failover.json");
	const failoverTarget = join(targetDir, "delegator/failover.json");
	await writeFile(failoverTarget, '{"version":1,"profiles":{}}\n', { mode: 0o600 });
	const parentPaths = ["settings.json", "auth.json", "models.json", "provider-failover.json"].map((name) => join(agentDir, name));
	await Promise.all(parentPaths.map((path) => writeFile(path, '{"parent":"leave byte-identical"}\n')));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(directory, { recursive: true, force: true });
	});
	return {
		directory, targetDir, target, agentDir, configPath, cwd, failoverPath, failoverTarget, parentPaths,
		read: async () => JSON.parse(await readFile(configPath, "utf8")),
		write: async (document) => writeFile(target, JSON.stringify(document)),
	};
}

function harness(files, options = {}) {
	const commands = new Map();
	delegatorConfig({
		registerCommand(name, command) { commands.set(name, command); },
		setModel() { throw new Error("must not change the parent model"); },
		setThinkingLevel() { throw new Error("must not change parent thinking"); },
	});
	const calls = { selections: [], factories: [], pickers: [], confirmations: [], notifications: [], registry: 0 };
	const answers = [...(options.selects ?? [])];
	const ctx = {
		cwd: files.cwd, hasUI: options.hasUI ?? true, mode: options.mode ?? "tui",
		isProjectTrusted: () => options.trusted ?? false,
		modelRegistry: {
			getAvailable() {
				calls.registry += 1;
				if (options.registryError) throw new Error("registry unavailable");
				return options.models ?? models;
			},
			refresh() { throw new Error("must not refresh providers"); },
			getApiKey() { throw new Error("must not access credential values"); },
			streamSimple() { throw new Error("must not make provider requests"); },
		},
		ui: {
			async select(title, items) {
				calls.selections.push({ title, items });
				const answer = title.startsWith("Settings for ")
					? (Object.hasOwn(options, "action") ? options.action : PRIMARY_ACTION)
					: answers.length ? answers.shift() : items[0];
				return typeof answer === "function" ? answer(items) : answer;
			},
			async custom(factory) {
				calls.factories.push(factory);
				const component = await factory(
					{ requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text },
					{ matches: () => false }, () => {},
				);
				const rendered = component.render(1000);
				calls.pickers.push(rendered);
				return Object.hasOwn(options, "model") ? options.model : rendered[0].includes("initial fallback") ? NO_AUTO_FAILOVER : INHERIT_MODEL;
			},
			async confirm(title, message) {
				calls.confirmations.push({ title, message });
				if (options.onConfirm) await options.onConfirm();
				return options.confirm ?? true;
			},
			notify(message, type) { calls.notifications.push({ message, type }); },
		},
	};
	return { commands, calls, ctx, run: (args = "") => commands.get("delegator-config").handler(args, ctx) };
}

test("command is registered without tools, provider requests, or session changes", async (t) => {
	const files = await fixture(t);
	const { commands } = harness(files);
	assert.deepEqual([...commands.keys()], ["delegator-config"]);
	assert.match(commands.get("delegator-config").description, /restart Pi/);
});

test("model choices include inheritance, deduplicate models, and retain unavailable current routes", () => {
	const choices = delegateModelChoices([...models, models[0]], "offline/current");
	assert.equal(choices[0].value, INHERIT_MODEL);
	assert.equal(choices.filter((choice) => choice.value === "openai-codex/test-model").length, 1);
	assert.match(choices.find((choice) => choice.value === "offline/current").description, /keep unchanged/);
	assert.equal(delegateModelChoices([], null).length, 1);
	assert.equal(delegateModelChoices([{ provider: "test", id: "x".repeat(256) }], null).length, 1);
});

test("interactive wizard saves only model/thinking and preserves the symlink and permissions", async (t) => {
	const files = await fixture(t);
	const before = await files.read();
	const { run, calls } = harness(files, {
		selects: [(items) => items.find((item) => item.startsWith("oracle ·")), "xhigh"],
		model: "openai-codex/test-model",
	});
	await run();
	const expected = structuredClone(before);
	expected.profiles.oracle.model = "openai-codex/test-model";
	expected.profiles.oracle.thinking = "xhigh";
	assert.deepEqual(await files.read(), expected);
	assert.equal((await lstat(files.configPath)).isSymbolicLink(), true);
	assert.equal(await readlink(files.configPath), files.target);
	assert.equal((await stat(files.target)).mode & 0o777, 0o600);
	assert.equal(calls.factories.length, 1);
	assert.deepEqual(calls.selections[1].items, [PRIMARY_ACTION, FALLBACK_ACTION]);
	assert.match(calls.selections[1].title, /oracle \(global\)/);
	assert.deepEqual(new Set(calls.selections[2].items), new Set(THINKING_LEVELS));
	assert.match(calls.confirmations[0].message, /Provider extensions are not inherited/);
	assert.ok(calls.confirmations[0].message.includes(files.configPath));
	assert.match(calls.notifications.at(-1).message, /Restart Pi to apply/);
	assert.match(calls.notifications.at(-1).message, /parent model\/thinking were not changed/);
	assert.deepEqual((await readdir(files.targetDir)).filter((name) => name.startsWith(".pi-delegator-")), []);
});

test("a direct profile argument can restore parent inheritance with no available models", async (t) => {
	const files = await fixture(t);
	const initial = await files.read();
	initial.profiles.scout.model = "offline/old";
	await files.write(initial);
	const { run, calls } = harness(files, { models: [], selects: ["medium"] });
	await run(" scout ");
	const saved = await files.read();
	assert.equal(saved.profiles.scout.model, null);
	assert.equal(saved.profiles.scout.thinking, "medium");
	assert.equal(calls.selections.length, 2);
	assert.deepEqual(calls.selections[0].items, [PRIMARY_ACTION, FALLBACK_ACTION]);
});

test("keeping unchanged settings does not rewrite the file", async (t) => {
	const files = await fixture(t);
	const initial = await files.read();
	initial.profiles.oracle.model = "offline/current";
	await files.write(initial);
	const before = await readFile(files.target, "utf8");
	const { run, calls } = harness(files, { model: "offline/current" });
	await run("oracle");
	assert.equal(await readFile(files.target, "utf8"), before);
	assert.match(calls.notifications.at(-1).message, /No changes/);
});

for (const [stage, args, options] of [
	["profile", "", { selects: [undefined] }],
	["action", "oracle", { action: undefined }],
	["model", "oracle", { model: undefined }],
	["thinking", "oracle", { selects: [undefined], model: "openai-codex/test-model" }],
	["confirmation", "oracle", { selects: ["max"], model: "openai-codex/test-model", confirm: false }],
]) {
	test(`cancellation at ${stage} leaves configuration byte-identical`, async (t) => {
		const files = await fixture(t);
		const before = await readFile(files.target, "utf8");
		const { run, calls } = harness(files, options);
		await run(args);
		assert.equal(await readFile(files.target, "utf8"), before);
		assert.deepEqual(calls.notifications, []);
	});
}

test("trusted project replacements are edited in the project, not the global file", async (t) => {
	const files = await fixture(t);
	const before = await readFile(files.target, "utf8");
	const projectPath = join(files.cwd, ".pi/pi-delegator.json");
	await mkdir(join(files.cwd, ".pi"));
	const profile = (await files.read()).profiles.oracle;
	const project = { profiles: { oracle: { ...profile, prompt: join(files.agentDir, profile.prompt), thinking: "minimal" } } };
	await writeFile(projectPath, JSON.stringify(project));
	const { run, calls } = harness(files, { trusted: true, selects: ["max"], model: "openai-codex/test-model" });
	await run("oracle");
	assert.equal(await readFile(files.target, "utf8"), before);
	const expected = structuredClone(project);
	expected.profiles.oracle.model = "openai-codex/test-model";
	expected.profiles.oracle.thinking = "max";
	assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), expected);
	assert.ok(calls.confirmations[0].message.includes(projectPath));
	assert.match(calls.confirmations[0].message, /oracle \(project\)/);
});

test("untrusted project configuration is ignored even when invalid", async (t) => {
	const files = await fixture(t);
	await mkdir(join(files.cwd, ".pi"));
	const projectPath = join(files.cwd, ".pi/pi-delegator.json");
	await writeFile(projectPath, "not JSON and must never be read");
	const { run, calls } = harness(files, { selects: ["max"] });
	await run("oracle");
	assert.equal((await files.read()).profiles.oracle.thinking, "max");
	assert.equal(calls.notifications.at(-1).type, "info");
	assert.equal(await readFile(projectPath, "utf8"), "not JSON and must never be read");
});

test("disabled profiles and missing configs are not silently recreated", async (t) => {
	const files = await fixture(t);
	await mkdir(join(files.cwd, ".pi"));
	await writeFile(join(files.cwd, ".pi/pi-delegator.json"), '{"profiles":{"oracle":null}}');
	const disabled = harness(files, { trusted: true });
	await disabled.run("oracle");
	assert.match(disabled.calls.notifications.at(-1).message, /Unknown, disabled, or undeclared/);
	assert.equal(disabled.calls.factories.length, 0);
	await rm(files.configPath);
	const missing = harness(files);
	await missing.run();
	assert.match(missing.calls.notifications.at(-1).message, /No enabled complete profiles/);
	await assert.rejects(lstat(files.configPath), { code: "ENOENT" });
});

test("invalid configuration and registry errors do not overwrite data", async (t) => {
	const files = await fixture(t);
	const original = await readFile(files.target, "utf8");
	await writeFile(files.target, '{"profiles":{"oracle":{"model":null}}}');
	const invalid = harness(files);
	await invalid.run("oracle");
	assert.match(invalid.calls.notifications.at(-1).message, /missing required field/);
	assert.equal(invalid.calls.registry, 0);
	await writeFile(files.target, original);
	const unavailable = harness(files, { registryError: true });
	await unavailable.run("oracle");
	assert.match(unavailable.calls.notifications.at(-1).message, /registry unavailable/);
	assert.equal(await readFile(files.target, "utf8"), original);
});

test("headless and RPC calls are rejected before accessing the config or model registry", async (t) => {
	const files = await fixture(t);
	for (const options of [{ hasUI: false, mode: "print" }, { mode: "rpc" }]) {
		const { run, calls } = harness(files, options);
		await run("oracle");
		assert.equal(calls.registry, 0);
		assert.equal(calls.factories.length, 0);
		assert.match(calls.notifications.at(-1).message, /requires interactive Pi/);
	}
});

test("a concurrent selected-profile change reports a conflict instead of clobbering it", async (t) => {
	const files = await fixture(t);
	const { run, calls } = harness(files, {
		selects: ["max"], model: "openai-codex/test-model",
		onConfirm: async () => {
			const document = await files.read();
			document.profiles.oracle.model = "other/newer-model";
			await files.write(document);
		},
	});
	await run("oracle");
	assert.equal((await files.read()).profiles.oracle.model, "other/newer-model");
	assert.match(calls.notifications.at(-1).message, /changed while the dialog was open/);
	assert.equal(calls.notifications.at(-1).type, "error");
});

test("unrelated concurrent changes and the selected profile's capabilities are preserved", async (t) => {
	const files = await fixture(t);
	const { run } = harness(files, {
		selects: ["max"], model: "openai-codex/test-model",
		onConfirm: async () => {
			const document = await files.read();
			document.profiles.scout.thinking = "off";
			document.profiles.oracle.tools = ["read"];
			await files.write(document);
		},
	});
	await run("oracle");
	const document = await files.read();
	assert.equal(document.profiles.scout.thinking, "off");
	assert.deepEqual(document.profiles.oracle.tools, ["read"]);
	assert.equal(document.profiles.oracle.model, "openai-codex/test-model");
});

test("queued saves for different profiles preserve both selections through symlink aliases", async (t) => {
	const files = await fixture(t);
	const sources = getEditableProfiles(harness(files).ctx);
	const scout = sources.find((source) => source.name === "scout");
	const oracle = sources.find((source) => source.name === "oracle");
	await Promise.all([
		saveDelegateSelection(scout, "openai-codex/test-model", "medium"),
		saveDelegateSelection({ ...oracle, configPath: files.target }, "commandcode/test-model", "max"),
	]);
	const document = await files.read();
	assert.equal(document.profiles.scout.thinking, "medium");
	assert.equal(document.profiles.oracle.thinking, "max");
});

test("formatted size bounds and invalid picker results fail without saving", async (t) => {
	const files = await fixture(t);
	const document = await files.read();
	document.profiles.oracle.tools = Array.from({ length: 1000 }, (_, index) => `tool${index}`);
	await files.write(document);
	const before = await readFile(files.target, "utf8");
	assert.ok(Buffer.byteLength(before) < 16 * 1024);
	const large = harness(files, { selects: ["max"], model: "openai-codex/test-model" });
	await large.run("oracle");
	assert.match(large.calls.notifications.at(-1).message, /Formatted config exceeds/);
	assert.equal(await readFile(files.target, "utf8"), before);
	for (const options of [{ model: "bogus/unknown" }, { selects: ["invalid-thinking"] }]) {
		const { run, calls } = harness(files, options);
		await run("oracle");
		assert.equal(calls.notifications.at(-1).type, "error");
		assert.equal(await readFile(files.target, "utf8"), before);
	}
});

async function untouchedBytes(files) {
	return Promise.all([files.configPath, ...files.parentPaths].map((path) => readFile(path)));
}

async function writePolicy(files, profiles) {
	await writeFile(files.failoverTarget, JSON.stringify({ version: 1, profiles }));
}

test("fallback choices lead with disabled, never inherit, and retain unavailable current routes", () => {
	const choices = delegateFallbackModelChoices([...models, models[0]], "offline/unavailable");
	assert.equal(choices[0].value, NO_AUTO_FAILOVER);
	assert.equal(choices[0].label, "No automatic failover");
	assert.equal(choices.some((choice) => choice.value === INHERIT_MODEL), false);
	assert.match(choices.find((choice) => choice.value === "offline/unavailable").description, /keep unchanged/);
	assert.equal(choices.filter((choice) => choice.value === "openai-codex/test-model").length, 1);
	assert.deepEqual(delegateFallbackModelChoices([], null).map((choice) => choice.value), [NO_AUTO_FAILOVER]);
	assert.equal(delegateFallbackModelChoices([{ provider: "provider", id: "x".repeat(256) }, { provider: "provider", id: "*" }], null).length, 1);
});

test("all fallback defaults are disabled; primary saves do not touch the sidecar", async (t) => {
	const files = await fixture(t);
	assert.equal(getFailoverConfigPath(), files.failoverPath);
	assert.deepEqual(readFailoverConfig(files.failoverPath), { version: 1, profiles: {} });
	const sidecar = await readFile(files.failoverPath);
	const { run } = harness(files, { selects: ["max"], model: "openai-codex/test-model" });
	await run("scout");
	assert.deepEqual(await readFile(files.failoverPath), sidecar);
});

test("fallback wizard writes only sidecar policy bound to the selected primary", async (t) => {
	const files = await fixture(t);
	const document = await files.read();
	document.profiles.scout.model = "  primary/model  ";
	await files.write(document);
	const before = await untouchedBytes(files);
	const { run, calls } = harness(files, {
		selects: [(items) => items.find((item) => item.startsWith("scout ·"))],
		action: FALLBACK_ACTION, model: "commandcode/test-model",
	});
	await run();
	assert.deepEqual(readFailoverConfig(files.failoverPath), {
		version: 1, profiles: { scout: { primary: "primary/model", fallback: "commandcode/test-model" } },
	});
	assert.deepEqual(await untouchedBytes(files), before);
	assert.equal(calls.registry, 1);
	assert.equal(calls.selections.length, 2, "no thinking dialog for fallback");
	assert.deepEqual(calls.selections[1].items, [PRIMARY_ACTION, FALLBACK_ACTION]);
	assert.ok(calls.pickers[0].includes("No automatic failover"));
	assert.equal(calls.pickers[0].includes("Inherit parent model"), false);
	assert.match(calls.confirmations[0].message, /One provider fallback.*INITIAL failures before any output or tool use/);
	assert.match(calls.confirmations[0].message, /Child-only policy.*foreground and background/);
	assert.match(calls.confirmations[0].message, /primary model and thinking stay unchanged/);
	assert.ok(calls.confirmations[0].message.includes(files.failoverPath));
	assert.match(calls.notifications.at(-1).message, /Restart Pi.*parent model\/thinking were not changed/);
});

test("direct fallback arguments support independent policies for every managed global profile", async (t) => {
	const files = await fixture(t);
	const before = await untouchedBytes(files);
	const sources = getEditableProfiles(harness(files).ctx);
	for (const source of sources) {
		const { run, calls } = harness(files, { model: "openai-codex/test-model" });
		await run(` ${source.name} fallback `);
		assert.equal(calls.selections.length, 0);
		assert.equal(calls.factories.length, 1);
		assert.equal(calls.confirmations.length, 1);
		assert.equal(calls.notifications.at(-1).type, "info");
	}
	assert.deepEqual(Object.keys(readFailoverConfig(files.failoverPath).profiles), sources.map((source) => source.name));
	for (const entry of Object.values(readFailoverConfig(files.failoverPath).profiles)) assert.deepEqual(entry, { primary: null, fallback: "openai-codex/test-model" });
	assert.deepEqual(await untouchedBytes(files), before);
});

test("disabling removes only the selected fallback entry", async (t) => {
	const files = await fixture(t);
	const other = { primary: "other/primary", fallback: "offline/other" };
	await writePolicy(files, { scout: { primary: null, fallback: "offline/scout" }, oracle: other });
	const before = await untouchedBytes(files);
	const { run, calls } = harness(files, { model: NO_AUTO_FAILOVER });
	await run("scout fallback");
	assert.deepEqual(readFailoverConfig(files.failoverPath), { version: 1, profiles: { oracle: other } });
	assert.deepEqual(await untouchedBytes(files), before);
	assert.match(calls.confirmations[0].message, /No automatic failover/);
});

for (const [stage, options] of [
	["picker", { model: undefined }],
	["confirmation", { model: "commandcode/test-model", confirm: false }],
]) {
	test(`fallback cancellation at ${stage} preserves all bytes`, async (t) => {
		const files = await fixture(t);
		await writePolicy(files, { scout: { primary: null, fallback: "offline/current" } });
		const sidecar = await readFile(files.failoverPath);
		const before = await untouchedBytes(files);
		const { run, calls } = harness(files, options);
		await run("scout fallback");
		assert.deepEqual(await readFile(files.failoverPath), sidecar);
		assert.deepEqual(await untouchedBytes(files), before);
		assert.deepEqual(calls.notifications, []);
	});
}

test("keeping an unavailable current fallback is byte-identical and not silently disabled", async (t) => {
	const files = await fixture(t);
	await writePolicy(files, { scout: { primary: null, fallback: "offline/unavailable" } });
	const before = await readFile(files.failoverPath);
	const inode = (await stat(files.failoverPath)).ino;
	const { run, calls } = harness(files, { models: [], model: "offline/unavailable" });
	await run("scout fallback");
	assert.ok(calls.pickers[0].includes("offline/unavailable"));
	assert.deepEqual(await readFile(files.failoverPath), before);
	assert.equal((await stat(files.failoverPath)).ino, inode, "no-op must not replace the file");
	assert.match(calls.notifications.at(-1).message, /No changes/);
});

test("missing sidecar is created only after confirmation with private permissions", async (t) => {
	const files = await fixture(t);
	await rm(files.failoverPath);
	const before = await untouchedBytes(files);
	const { run, calls } = harness(files, {
		model: "commandcode/test-model",
		onConfirm: async () => {
			await assert.rejects(lstat(files.failoverPath), { code: "ENOENT" });
			assert.deepEqual(await untouchedBytes(files), before);
		},
	});
	await run("scout fallback");
	assert.equal(calls.confirmations.length, 1);
	assert.equal((await stat(files.failoverPath)).mode & 0o777, 0o600);
	assert.equal((await lstat(join(files.agentDir, "delegator"))).isSymbolicLink(), true);
	assert.equal(await readlink(join(files.agentDir, "delegator")), join(files.targetDir, "delegator"));
	assert.deepEqual(readFailoverConfig(files.failoverPath).profiles.scout, { primary: null, fallback: "commandcode/test-model" });
	assert.deepEqual(await untouchedBytes(files), before);
});

test("missing sidecar stays missing on cancel, disabled no-op, or invalid picker results", async (t) => {
	const files = await fixture(t);
	await rm(files.failoverPath);
	const before = await untouchedBytes(files);
	for (const options of [{ model: undefined }, { model: "commandcode/test-model", confirm: false }, { model: NO_AUTO_FAILOVER }, { model: INHERIT_MODEL }]) {
		const { run, calls } = harness(files, options);
		await run("scout fallback");
		await assert.rejects(lstat(files.failoverPath), { code: "ENOENT" });
		if (options.model === NO_AUTO_FAILOVER) assert.match(calls.notifications.at(-1).message, /No changes/);
		if (options.model === INHERIT_MODEL) assert.match(calls.notifications.at(-1).message, /Invalid fallback model selection/);
	}
	assert.deepEqual(await untouchedBytes(files), before);
});

test("fallback cannot activate the normalized primary route", async (t) => {
	const files = await fixture(t);
	const document = await files.read();
	document.profiles.scout.model = " openai-codex/test-model ";
	await files.write(document);
	const before = await readFile(files.failoverPath);
	const unchanged = await untouchedBytes(files);
	const { run, calls } = harness(files, { model: "openai-codex/test-model" });
	await run("scout fallback");
	assert.equal(calls.confirmations.length, 0);
	assert.match(calls.notifications.at(-1).message, /must differ/);
	assert.deepEqual(await readFile(files.failoverPath), before);
	assert.deepEqual(await untouchedBytes(files), unchanged);
});

test("project-scoped fallback fails closed before the picker or global policy access", async (t) => {
	const files = await fixture(t);
	await mkdir(join(files.cwd, ".pi"));
	const profile = (await files.read()).profiles.scout;
	const projectPath = join(files.cwd, ".pi/pi-delegator.json");
	const project = JSON.stringify({ profiles: { scout: { ...profile, prompt: join(files.agentDir, profile.prompt) } } });
	await writeFile(projectPath, project);
	await rm(files.failoverPath);
	for (const [args, options] of [["scout fallback", {}], ["scout", { action: FALLBACK_ACTION }]]) {
		const { run, calls } = harness(files, { ...options, trusted: true, model: "commandcode/test-model" });
		await run(args);
		assert.equal(calls.registry, 0);
		assert.equal(calls.factories.length, 0);
		assert.equal(calls.confirmations.length, 0);
		assert.match(calls.notifications.at(-1).message, /Project-specific overrides are not owned/);
		await assert.rejects(lstat(files.failoverPath), { code: "ENOENT" });
		assert.equal(await readFile(projectPath, "utf8"), project);
	}
});

test("a project override introduced during confirmation cannot write global policy", async (t) => {
	const files = await fixture(t);
	const before = await readFile(files.failoverPath);
	const { run, calls } = harness(files, {
		trusted: true, model: "commandcode/test-model",
		onConfirm: async () => {
			await mkdir(join(files.cwd, ".pi"));
			const profile = (await files.read()).profiles.scout;
			await writeFile(join(files.cwd, ".pi/pi-delegator.json"), JSON.stringify({ profiles: { scout: { ...profile, prompt: join(files.agentDir, profile.prompt) } } }));
		},
	});
	await run("scout fallback");
	assert.match(calls.notifications.at(-1).message, /Profile scope changed/);
	assert.deepEqual(await readFile(files.failoverPath), before);
});

for (const fallback of ["commandcode/test-model", NO_AUTO_FAILOVER]) {
	test(`selected fallback conflict is detected when ${fallback === NO_AUTO_FAILOVER ? "disabling" : "saving"}`, async (t) => {
		const files = await fixture(t);
		await writePolicy(files, { scout: { primary: null, fallback: "offline/old" } });
		const before = await untouchedBytes(files);
		const concurrent = { primary: null, fallback: "offline/concurrent" };
		const { run, calls } = harness(files, {
			model: fallback,
			onConfirm: async () => writePolicy(files, { scout: concurrent }),
		});
		await run("scout fallback");
		assert.match(calls.notifications.at(-1).message, /fallback changed while the dialog was open/);
		assert.deepEqual(readFailoverConfig(files.failoverPath).profiles.scout, concurrent);
		assert.deepEqual(await untouchedBytes(files), before);
	});
}

test("selected primary changes conflict without writing fallback policy", async (t) => {
	const files = await fixture(t);
	const before = await readFile(files.failoverPath);
	const { run, calls } = harness(files, {
		model: "commandcode/test-model",
		onConfirm: async () => {
			const document = await files.read();
			document.profiles.scout.model = "other/new-primary";
			await files.write(document);
		},
	});
	await run("scout fallback");
	assert.match(calls.notifications.at(-1).message, /primary changed while the dialog was open/);
	assert.equal((await files.read()).profiles.scout.model, "other/new-primary");
	assert.deepEqual(await readFile(files.failoverPath), before);
});

test("other concurrent fallback entries and profile capability/thinking changes survive", async (t) => {
	const files = await fixture(t);
	const other = { primary: null, fallback: "offline/other" };
	let concurrentProfileBytes;
	const { run, calls } = harness(files, {
		model: "commandcode/test-model",
		onConfirm: async () => {
			await writePolicy(files, { oracle: other });
			const document = await files.read();
			document.profiles.scout.thinking = "max";
			document.profiles.scout.tools = ["read"];
			await files.write(document);
			concurrentProfileBytes = await untouchedBytes(files);
		},
	});
	await run("scout fallback");
	assert.equal(calls.notifications.at(-1).type, "info");
	assert.deepEqual(readFailoverConfig(files.failoverPath).profiles, { oracle: other, scout: { primary: null, fallback: "commandcode/test-model" } });
	assert.deepEqual(await untouchedBytes(files), concurrentProfileBytes);
});

test("reconfiguring a stale primary binding updates only the sidecar", async (t) => {
	const files = await fixture(t);
	await writePolicy(files, { scout: { primary: "previous/primary", fallback: "offline/current" } });
	const before = await untouchedBytes(files);
	const { run } = harness(files, { models: [], model: "offline/current" });
	await run("scout fallback");
	assert.deepEqual(readFailoverConfig(files.failoverPath).profiles.scout, { primary: null, fallback: "offline/current" });
	assert.deepEqual(await untouchedBytes(files), before);
});

test("fallback saves preserve both directory and file symlinks and exact existing mode", async (t) => {
	const files = await fixture(t);
	const external = join(files.directory, "actual-policy.json");
	await writeFile(external, '{"version":1,"profiles":{}}');
	await chmod(external, 0o664);
	await rm(files.failoverTarget);
	await symlink(external, files.failoverTarget);
	const before = await untouchedBytes(files);
	const { run, calls } = harness(files, { model: "commandcode/test-model" });
	await run("scout fallback");
	assert.equal(calls.notifications.at(-1).type, "info");
	assert.equal((await lstat(files.failoverTarget)).isSymbolicLink(), true);
	assert.equal(await readlink(files.failoverTarget), external);
	assert.equal((await lstat(join(files.agentDir, "delegator"))).isSymbolicLink(), true);
	assert.equal((await stat(external)).mode & 0o777, 0o664);
	assert.deepEqual(readFailoverConfig(external).profiles.scout, { primary: null, fallback: "commandcode/test-model" });
	assert.deepEqual(await untouchedBytes(files), before);
	assert.deepEqual((await readdir(files.directory)).filter((name) => name.startsWith(".delegator-failover-")), []);
});

for (const missing of [false, true]) {
	test(`queued distinct fallback entries survive symlink aliases (${missing ? "new" : "existing"} sidecar)`, async (t) => {
		const files = await fixture(t);
		if (missing) await rm(files.failoverPath);
		const before = await untouchedBytes(files);
		const sources = getEditableProfiles(harness(files).ctx);
		const results = await Promise.all([
			saveFailoverSelection(sources.find((source) => source.name === "scout"), "openai-codex/test-model", undefined, files.failoverPath),
			saveFailoverSelection(sources.find((source) => source.name === "oracle"), "commandcode/test-model", undefined, files.failoverTarget),
		]);
		assert.deepEqual(results, [true, true]);
		assert.deepEqual(readFailoverConfig(files.failoverPath).profiles, {
			scout: { primary: null, fallback: "openai-codex/test-model" },
			oracle: { primary: null, fallback: "commandcode/test-model" },
		});
		assert.deepEqual(await untouchedBytes(files), before);
		assert.deepEqual((await readdir(join(files.targetDir, "delegator"))).filter((name) => name.startsWith(".delegator-failover-")), []);
	});
}

test("queued writes to the same fallback entry conflict rather than silently clobber", async (t) => {
	const files = await fixture(t);
	const source = getEditableProfiles(harness(files).ctx).find((source) => source.name === "scout");
	const results = await Promise.allSettled([
		saveFailoverSelection(source, "openai-codex/test-model", undefined, files.failoverPath),
		saveFailoverSelection(source, "commandcode/test-model", undefined, files.failoverTarget),
	]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.match(results.find((result) => result.status === "rejected").reason.message, /fallback changed/);
});

test("dangling sidecar symlinks are not replaced or silently repaired", async (t) => {
	const files = await fixture(t);
	await rm(files.failoverPath);
	const missingTarget = join(files.directory, "missing-policy.json");
	await symlink(missingTarget, files.failoverTarget);
	const { run, calls } = harness(files, { model: "commandcode/test-model" });
	await run("scout fallback");
	assert.match(calls.notifications.at(-1).message, /dangling symlink/);
	assert.equal(await readlink(files.failoverTarget), missingTarget);
	await assert.rejects(lstat(missingTarget), { code: "ENOENT" });
});

test("invalid sidecars and formatted size overflow fail without changing any files", async (t) => {
	const files = await fixture(t);
	const before = await untouchedBytes(files);
	for (const text of ['{"version":2,"profiles":{}}', "{", Buffer.from([0xff])]) {
		await writeFile(files.failoverPath, text);
		const sidecar = await readFile(files.failoverPath);
		const { run, calls } = harness(files, { model: "commandcode/test-model" });
		await run("scout fallback");
		assert.equal(calls.registry, 0);
		assert.equal(calls.notifications.at(-1).type, "error");
		assert.deepEqual(await readFile(files.failoverPath), sidecar);
	}
	const profiles = Object.fromEntries(Array.from({ length: 220 }, (_, index) => [`p${index}`, { primary: null, fallback: "provider/model" }]));
	await writePolicy(files, profiles);
	const sidecar = await readFile(files.failoverPath);
	assert.ok(sidecar.byteLength < 16 * 1024);
	const { run, calls } = harness(files, { model: "commandcode/test-model" });
	await run("scout fallback");
	assert.match(calls.notifications.at(-1).message, /exceeds 16384 UTF-8 bytes/);
	assert.deepEqual(await readFile(files.failoverPath), sidecar);
	assert.deepEqual(await untouchedBytes(files), before);
});
