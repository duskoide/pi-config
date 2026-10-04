import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { CHILD_MARKER, loadDelegateBackend } from "../extensions/delegator-background/backend.ts";
import { registerBackgroundDelegation } from "../extensions/delegator-background/index.ts";
import { backgroundRenderers, terminalSafe } from "../extensions/delegator-background/renderers.ts";

const base = { description: "Read only", model: null, thinking: "high", tools: ["read"], skills: [], extensions: [], systemPrompt: "Inspect only", timeoutMs: null };
const profiles = { scout: { ...base, name: "scout", thinking: "low" }, oracle: { ...base, name: "oracle" }, worker: { ...base, name: "worker", tools: ["read", "write"] } };
const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 } };
const cleanup = { forced: true, termSent: true, killSent: false, processExited: true, pipesClosed: true };
const success = { ok: true, text: "Report", durationMs: 1, nativeUsage: usage, cleanup, truncated: false };

async function setup(t, options = {}) {
	const directory = await mkdtemp(join(tmpdir(), "bg-delegator-tools-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const handlers = new Map();
	const tools = new Map();
	const messages = [];
	const warnings = [];
	const statuses = [];
	const widgets = new Map();
	let widgetRenders = 0;
	const runs = [];
	const loads = [];
	const activeProfiles = structuredClone(options.profiles ?? profiles);
	const backend = {
		loadProfiles(path, lower) { loads.push({ path, lower }); return path ? options.projectProfiles ?? lower : activeProfiles; },
		projectConfigPath: (cwd) => join(cwd, ".pi/pi-delegator.json"),
		normalizeModel(value) {
			if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 256) throw new Error("invalid model");
			return value.trim();
		},
		isSupportedPlatform: () => options.supported ?? true,
		run: (args) => new Promise((resolve, reject) => {
			const cancelled = () => resolve({ ok: false, code: "cancelled", message: "cancelled", durationMs: 1, nativeUsage: usage, cleanup });
			runs.push({ args, resolve, reject, finishCancel: cancelled });
			const cancel = () => { if (!options.delayedCleanup) cancelled(); };
			args.signal.addEventListener("abort", cancel, { once: true });
			if (args.signal.aborted) cancel();
		}),
	};
	const pi = {
		on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
		registerTool(tool) { tools.set(tool.name, tool); },
		sendMessage(message, delivery) { messages.push({ message, delivery }); },
	};
	registerBackgroundDelegation(pi, backend);
	const ctx = {
		cwd: directory, model: { provider: "parent", id: "initial" },
		isProjectTrusted: () => options.trusted ?? false,
		ui: {
			setStatus(key, text) { statuses.push({ key, text }); },
			setWidget(key, content, options) {
				if (content === undefined) widgets.delete(key);
				else widgets.set(key, { component: content({ requestRender() { widgetRenders += 1; } }, { fg: (_color, text) => text }), options });
			},
			notify(message, type) { warnings.push({ message, type }); },
		},
	};
	const emit = async (name, event = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
	};
	t.after(() => emit("session_shutdown", { reason: "quit" }));
	await emit("session_start");
	let counter = 0;
	const call = async (name, params, { signal, ack = true } = {}) => {
		const callId = `call-${counter++}`;
		const result = await tools.get(name).execute(callId, params, signal, undefined, ctx);
		if (ack) await emit("tool_result", { toolName: name, toolCallId: callId, isError: false, input: params, details: result.details });
		return { ...result, callId };
	};
	return { tools, messages, warnings, statuses, widgets, runs, loads, ctx, emit, call, activeProfiles, directory,
		agentRow: (width = 80) => widgets.get("delegators")?.component.render(width).join("\n") ?? "",
		widgetRenderRequests: () => widgetRenders,
	};
}

test("registers only background tools and launches two jobs without waiting for their results", async (t) => {
	const h = await setup(t);
	assert.deepEqual([...h.tools.keys()], ["delegate_start", "delegate_result", "delegate_cancel"]);
	const guidance = h.tools.get("delegate_start").promptGuidelines.join("\n");
	assert.match(guidance, /multiple background agents in parallel/);
	assert.match(guidance, /several delegate_start calls in one turn/);
	assert.match(guidance, /taskId immediately without waiting/);
	assert.match(guidance, /up to 8 jobs may run concurrently/);
	assert.match(guidance, /answer is needed before continuing/);
	assert.match(guidance, /independent subtasks/);
	assert.match(guidance, /respect requests not to delegate/);
	const a = await h.call("delegate_start", { agent: "scout", task: "Read A" });
	const b = await h.call("delegate_start", { agent: "oracle", task: "Review B" });
	assert.equal(a.details.ready, false);
	assert.equal(b.details.ready, false);
	h.ctx.model = { provider: "parent", id: "changed" };
	await setImmediate();
	assert.equal(h.runs.length, 2);
	assert.equal(h.runs[0].args.model, "parent/initial");
	assert.equal(h.runs[0].args.profile.thinking, "low");
	assert.equal(h.runs[1].args.profile.thinking, "high");
	assert.equal(h.runs[0].args.profile.timeoutMs, null);
	assert.ok(h.agentRow().includes("scout:...") && h.agentRow().includes("oracle:..."));
	assert.equal(h.widgets.get("delegators").options.placement, "belowEditor");
	h.runs[0].args.onProgress({ type: "tool_start", toolName: "read" });
	assert.ok(h.agentRow().includes("scout:read"));
	assert.ok(h.widgetRenderRequests() > 0);
	const listing = await h.call("delegate_result", {});
	assert.equal(listing.details.jobs.length, 2);
	assert.equal(listing.usage, undefined);
	const pending = await h.call("delegate_result", { taskId: a.details.taskId });
	assert.equal(pending.details.ready, false);
	assert.match(pending.content[0].text, /did not wait/);
});

test("profile model and explicit override precede parent; cwd is captured relative to parent", async (t) => {
	const configured = structuredClone(profiles);
	configured.scout.model = "profile/model";
	const h = await setup(t, { profiles: configured });
	await h.call("delegate_start", { agent: "scout", task: "A", cwd: "." });
	await h.call("delegate_start", { agent: "oracle", task: "B", model: " explicit/model " });
	await setImmediate();
	assert.equal(h.runs[0].args.model, "profile/model");
	assert.equal(h.runs[1].args.model, "explicit/model");
	assert.equal(h.runs[0].args.cwd, h.directory);
});

test("completion follow-up is sent once with a deliberately retrieved result and usage", async (t) => {
	const h = await setup(t);
	const receipt = await h.call("delegate_start", { agent: "oracle", task: "Review", triggerOnCompletion: true });
	await setImmediate();
	h.runs[0].resolve(success);
	await setImmediate();
	assert.equal(h.messages.length, 1);
	assert.deepEqual(h.messages[0].delivery, { deliverAs: "followUp", triggerTurn: true });
	assert.equal(h.messages[0].message.details.taskId, receipt.details.taskId);
	assert.equal(h.messages[0].message.display, false, "completion stays in model context but not the visible feed");
	assert.match(h.messages[0].message.content, /do not poll/);
	const first = await h.call("delegate_result", { taskId: receipt.details.taskId });
	assert.deepEqual(first.usage, usage);
	assert.match(first.content[0].text, /"forced": true/);
	assert.match(first.content[0].text, /Report/);
	assert.equal((await h.call("delegate_result", { taskId: receipt.details.taskId })).usage, undefined);
	assert.equal(h.messages.length, 1);
});

test("notification-only and silent modes preserve result retrieval without forced wake", async (t) => {
	const h = await setup(t);
	const a = await h.call("delegate_start", { agent: "scout", task: "A", triggerOnCompletion: false });
	const b = await h.call("delegate_start", { agent: "scout", task: "B", notifyOnCompletion: false });
	await setImmediate();
	for (const run of h.runs) run.resolve(success);
	await setImmediate();
	assert.equal(h.messages.length, 1);
	assert.equal(h.messages[0].delivery.triggerTurn, false);
	assert.equal((await h.call("delegate_result", { taskId: b.details.taskId })).details.ready, true);
	assert.equal((await h.call("delegate_result", { taskId: a.details.taskId })).details.ready, true);
});

test("launch ownership transfers at the successful tool result boundary", async (t) => {
	const h = await setup(t);
	const controller = new AbortController();
	const a = await h.call("delegate_start", { agent: "scout", task: "A" }, { signal: controller.signal, ack: false });
	await setImmediate();
	controller.abort();
	await h.emit("tool_result", { toolName: "delegate_start", toolCallId: a.callId, isError: false });
	await setImmediate();
	assert.equal((await h.call("delegate_result", { taskId: a.details.taskId })).details.status, "cancelled");
	assert.equal(h.messages.length, 0);
	const later = new AbortController();
	await h.call("delegate_start", { agent: "scout", task: "B" }, { signal: later.signal });
	await setImmediate();
	later.abort();
	assert.equal(h.runs[1].args.signal.aborted, false);
});

test("cancellation requests return immediately and failure diagnostics are model-visible", async (t) => {
	const h = await setup(t);
	const a = await h.call("delegate_start", { agent: "oracle", task: "A" });
	const b = await h.call("delegate_start", { agent: "oracle", task: "B" });
	await setImmediate();
	const cancel = await h.call("delegate_cancel", { taskId: a.details.taskId });
	assert.equal(cancel.details.cancellationRequested, true);
	assert.equal(cancel.details.status, "cancelling");
	h.runs[1].resolve({ ok: false, code: "cleanup_failed", message: "failure", stderr: "diagnostic", durationMs: 1, nativeUsage: usage, cleanup: { ...cleanup, diagnostic: "unverified process group" } });
	await setImmediate();
	const failed = await h.call("delegate_result", { taskId: b.details.taskId });
	assert.equal(failed.details.status, "failed");
	assert.match(failed.content[0].text, /cleanup_failed/);
	assert.match(failed.content[0].text, /unverified process group/);
	assert.match(failed.content[0].text, /diagnostic/);
	assert.deepEqual(failed.usage, usage);
	assert.equal((await h.call("delegate_result", { taskId: a.details.taskId })).details.status, "cancelled");
});

for (const [description, params] of [
	["blank task", { agent: "scout", task: " " }],
	["oversized UTF-8 task", { agent: "scout", task: "🙂".repeat(10000) }],
	["unknown agent", { agent: "missing", task: "A" }],
	["unknown fields", { agent: "scout", task: "A", thinking: "max" }],
	["bad model", { agent: "scout", task: "A", model: " " }],
	["blank cwd", { agent: "scout", task: "A", cwd: " " }],
	["nonboolean flags", { agent: "scout", task: "A", notifyOnCompletion: "yes" }],
	["wake without notification", { agent: "scout", task: "A", notifyOnCompletion: false, triggerOnCompletion: true }],
]) {
	test(`rejects ${description} without starting a child`, async (t) => {
		const h = await setup(t);
		await assert.rejects(h.call("delegate_start", params));
		assert.equal(h.runs.length, 0);
		assert.equal((await h.call("delegate_result", {})).details.jobs.length, 0);
	});
}

test("missing cwd, pre-cancelled calls, unsupported platforms and absent models fail before launch", async (t) => {
	const h = await setup(t);
	await assert.rejects(h.call("delegate_start", { agent: "scout", task: "A", cwd: "missing" }));
	const aborted = new AbortController(); aborted.abort();
	await assert.rejects(h.call("delegate_start", { agent: "scout", task: "A" }, { signal: aborted.signal }), /cancelled/);
	h.ctx.model = undefined;
	await assert.rejects(h.call("delegate_start", { agent: "scout", task: "A" }), /Choose a model/);
	assert.equal(h.runs.length, 0);
	const unsupported = await setup(t, { supported: false });
	await assert.rejects(unsupported.call("delegate_start", { agent: "scout", task: "A" }), /Linux\/macOS/);
});

test("unknown/malformed IDs are safe errors, never partial matches", async (t) => {
	const h = await setup(t);
	await assert.rejects(h.call("delegate_result", { taskId: "del-short" }), /full background delegate taskId/);
	await assert.rejects(h.call("delegate_cancel", { taskId: "del-00000000-0000-0000-0000-000000000000" }), /Unknown background/);
	await assert.rejects(h.call("delegate_result", { taskId: "x", wait: true }), /Unknown field/);
});

test("trusted project profiles resolve once from parent, never the requested child cwd", async (t) => {
	const project = structuredClone(profiles);
	project.oracle.thinking = "max";
	const h = await setup(t, { trusted: true, projectProfiles: project });
	await h.call("delegate_start", { agent: "oracle", task: "A", cwd: tmpdir() });
	await setImmediate();
	assert.equal(h.runs[0].args.profile.thinking, "max");
	assert.equal(h.loads.length, 2);
	assert.equal(h.loads[1].path, join(h.directory, ".pi/pi-delegator.json"));
});

test("untrusted project definitions are not loaded and all-disabled profiles hide start", async (t) => {
	const h = await setup(t, { trusted: false, projectProfiles: {} });
	assert.equal(h.loads.length, 1);
	const disabled = await setup(t, { profiles: {} });
	assert.equal(disabled.tools.get("delegate_start").exposure, "hidden");
	await assert.rejects(disabled.call("delegate_start", { agent: "scout", task: "A" }), /Unknown or disabled/);
});

for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
	test(`${reason} drains background work, suppresses follow-ups, and invalidates old tools`, async (t) => {
		const h = await setup(t);
		const receipt = await h.call("delegate_start", { agent: "worker", task: "A" });
		await setImmediate();
		const oldResult = h.tools.get("delegate_result");
		await h.emit("session_shutdown", { reason });
		assert.equal(h.runs[0].args.signal.aborted, true);
		assert.equal(h.messages.length, 0);
		assert.deepEqual(h.statuses.at(-1), { key: "delegators", text: undefined });
		assert.equal(h.widgets.size, 0, "shutdown removes the owned statusline widget");
		await assert.rejects(oldResult.execute("old", { taskId: receipt.details.taskId }), /closed session/);
		await h.emit("session_start");
		await assert.rejects(h.call("delegate_result", { taskId: receipt.details.taskId }), /Unknown background/);
	});
}

test("overlapping shutdown callbacks all await the same delayed cleanup drain", async (t) => {
	const h = await setup(t, { delayedCleanup: true });
	await h.call("delegate_start", { agent: "worker", task: "A" });
	await setImmediate();
	let reloadFinished = false;
	let quitFinished = false;
	const reload = h.emit("session_shutdown", { reason: "reload" }).then(() => { reloadFinished = true; });
	const quit = h.emit("session_shutdown", { reason: "quit" }).then(() => { quitFinished = true; });
	await setImmediate();
	assert.equal(reloadFinished, false);
	assert.equal(quitFinished, false);
	assert.equal(h.runs[0].args.signal.aborted, true);
	h.runs[0].finishCancel();
	await Promise.all([reload, quit]);
	assert.equal(reloadFinished, true);
	assert.equal(quitFinished, true);
	assert.equal(h.messages.length, 0);
});

test("self-loading and nested-tool profiles are rejected and child marker disables registration", async (t) => {
	const nested = structuredClone(profiles); nested.scout.tools.push("delegate_start");
	await assert.rejects(setup(t, { profiles: nested }), /nested delegation/);
	const source = fileURLToPath(new URL("../extensions/delegator-background/index.ts", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "bg-delegator-self-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const alias = join(directory, "alias.ts");
	await symlink(source, alias);
	const self = structuredClone(profiles); self.scout.extensions.push(alias);
	await assert.rejects(setup(t, { profiles: self }), /may not load/);
	const old = process.env[CHILD_MARKER];
	process.env[CHILD_MARKER] = "1";
	try {
		registerBackgroundDelegation({ on() { throw new Error("must not register child hooks"); } }, { loadProfiles() { throw new Error("must not read child profiles"); } });
	} finally {
		if (old === undefined) delete process.env[CHILD_MARKER]; else process.env[CHILD_MARKER] = old;
	}
});

test("native bridge rejects unreviewed package versions before importing runner code", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "bg-delegator-version-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const packageRoot = join(directory, "npm/node_modules/@mostlyworks/pi-delegator");
		await mkdir(packageRoot, { recursive: true });
		await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@mostlyworks/pi-delegator", version: "0.7.0" }));
		await assert.rejects(loadDelegateBackend(), /require @mostlyworks\/pi-delegator@0.6.6/);
	} finally {
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
	}
});

test("terminal renderers strip control/bidi sequences and collapse only the UI preview", () => {
	const original = "\x1b[31mAnswer\x1b[0m\x1b]0;bad title\x07\u202e\rnext\n" + "x".repeat(4000);
	const safe = terminalSafe(original);
	assert.ok(!safe.includes("\x1b"));
	assert.ok(!safe.includes("\u202e"));
	assert.ok(!safe.includes("\r"));
	const renderers = backgroundRenderers("Result");
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const result = { content: [{ type: "text", text: original }] };
	const collapsed = renderers.renderResult(result, { expanded: false }, theme).render(10000).join("\n");
	assert.match(collapsed, /expand/);
	assert.equal(collapsed.split("\n").length, 1);
	const expanded = renderers.renderResult(result, { expanded: true }, theme).render(10000).join("\n");
	assert.equal(expanded, safe);
	assert.equal(result.content[0].text, original);
});
