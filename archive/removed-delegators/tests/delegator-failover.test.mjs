import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { eligibleProviderFailure, registerChildFailover } from "../extensions/delegator-failover/child.ts";

async function setup(t, options = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pi-child-failover-"));
	const path = join(directory, "failover.json");
	await writeFile(path, JSON.stringify({ version: 1, profiles: options.disabled ? {} : { scout: { primary: "qoder/test", fallback: "fallback/test" } } }));
	const previous = process.env.PI_DELEGATOR_CHILD;
	if (options.parent) delete process.env.PI_DELEGATOR_CHILD;
	else process.env.PI_DELEGATOR_CHILD = "1";
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_DELEGATOR_CHILD;
		else process.env.PI_DELEGATOR_CHILD = previous;
		await rm(directory, { recursive: true, force: true });
	});
	const handlers = new Map();
	const models = [], thinking = [];
	const controller = new AbortController();
	const ctx = { mode: "json", model: { provider: "qoder", id: "test" }, signal: controller.signal,
		modelRegistry: { find: () => options.missing ? undefined : { provider: "fallback", id: "test", api: options.virtual ? "pi-virtual" : "test-api" } } };
	registerChildFailover({
		on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
		getThinkingLevel: () => "high",
		setThinkingLevel: level => thinking.push(level),
		async setModel(model) { models.push(model); if (options.onSwitch) await options.onSwitch(controller); if (options.authThrow) throw new Error("no credentials"); if (options.noAuth) return false; ctx.model = model; return true; },
	}, "scout", path);
	const emit = async (name, event = {}) => {
		let result;
		for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }, ctx);
		return result;
	};
	const error = async (message = "Qoder API request failed: 429 quota exhausted", content = []) => emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: message, content } });
	const settle = (event = {}) => emit("agent_before_settle", { outcome: "error", entries: [], continue: false, context: { pendingMessages: [] }, ...event });
	await emit("session_start");
	return { ctx, handlers, models, thinking, controller, emit, error, settle };
}

test("only explicit remote provider errors are allowlisted; setup, overflow, protocol and model errors fail closed", () => {
	for (const status of [401, 403, 408, 425, 429, 500, 502, 503, 504, 529]) {
		assert.equal(eligibleProviderFailure(`Qoder API request failed: ${status} remote failure`), true);
		assert.equal(eligibleProviderFailure(`Upstream status ${status}: remote failure`), true);
		assert.equal(eligibleProviderFailure("remote failure", status), true);
	}
	assert.equal(eligibleProviderFailure("Qoder API request failed: 402 insufficient balance"), true);
	assert.equal(eligibleProviderFailure('429: {"message":"quota"}'), true);
	assert.equal(eligibleProviderFailure("401: unauthorized"), true);
	for (const message of ["400: bad request", "404: model_not_found", "429: context_length_exceeded"]) assert.equal(eligibleProviderFailure(message), false);
	for (const message of ["429 rate limit", "timeout", "server error", "missing api key", "Qoder API request failed: 400 invalid request", "Upstream status 429: context length exceeded", "Qoder API request failed: 503 unknown model", "Qoder API request failed: 503 invalid JSON", "Qoder API request failed: 429 cancelled", "Qoder API request failed: 402 unrelated"]) assert.equal(eligibleProviderFailure(message), false, message);
});

test("one child switch appends a hidden runnable entry and preserves session-only thinking", async (t) => {
	const h = await setup(t);
	await h.error();
	const result = await h.settle();
	assert.equal(result.continue, true);
	assert.equal(result.entries[0].type, "custom_message");
	assert.equal(result.entries[0].display, false);
	assert.match(result.entries[0].content, /no tool actions/);
	assert.deepEqual(h.thinking, ["high"]);
	assert.equal(h.models.length, 1);
	await h.error("Qoder API request failed: 503 remote failure");
	assert.equal(await h.settle(), undefined);
	assert.equal(h.models.length, 1);
	const final = await h.emit("message_end", { message: { role: "assistant", provider: "fallback", model: "test", stopReason: "stop", content: [{ type: "text", text: "done" }], usage: { totalTokens: 9 } } });
	assert.match(final.message.content[0].text, /qoder\/test → fallback\/test/);
	assert.equal(final.message.usage.totalTokens, 9);
});

test("main session and disabled/default policies never change models", async (t) => {
	for (const options of [{ parent: true }, { disabled: true }]) {
		const h = await setup(t, options);
		await h.error();
		assert.equal(await h.settle(), undefined);
		assert.equal(h.models.length, 0);
		if (options.parent) assert.equal(h.handlers.size, 0);
	}
});

for (const [name, event, data] of [
	["text", "message_update", { message: { content: [{ type: "text", text: "started" }] }, assistantMessageEvent: { type: "text_delta" } }],
	["thinking", "message_update", { message: { content: [] }, assistantMessageEvent: { partial: { content: [{ type: "thinking", thinking: "plan" }] } } }],
	["tool-call content", "message_update", { message: { content: [{ type: "toolCall", arguments: {} }] }, assistantMessageEvent: { type: "toolcall_start" } }],
	["tool call", "tool_call", {}], ["tool execution", "tool_execution_start", {}], ["tool result", "tool_result", {}],
	["tool-result message", "message_start", { message: { role: "toolResult" } }],
	["successful response", "message_end", { message: { role: "assistant", stopReason: "stop", content: [] } }],
]) {
	test(`permanently disarms after ${name}; never replays a task`, async (t) => {
		const h = await setup(t);
		await h.emit(event, data);
		await h.error();
		assert.equal(await h.settle(), undefined);
		assert.equal(h.models.length, 0);
	});
}

test("status observation enables native providers without trusting generic error strings", async (t) => {
	const h = await setup(t);
	await h.emit("after_provider_response", { status: 429 });
	await h.error("429 rate limit");
	assert.equal((await h.settle()).continue, true);
});

test("generic status prefixes require request provenance, not a setup-error message", async (t) => {
	const absent = await setup(t);
	await absent.error('429: {"message":"quota"}');
	assert.equal(await absent.settle(), undefined);
	const observed = await setup(t);
	await observed.emit("before_provider_request");
	await observed.error('429: {"message":"quota"}');
	assert.equal((await observed.settle()).continue, true);
});

test("missing optional update payload cannot bypass output disarming", async (t) => {
	const h = await setup(t);
	await h.emit("message_update", { message: { content: [] } });
	await h.emit("message_update", { message: { content: [{ type: "thinking", thinking: "began" }] } });
	await h.error();
	assert.equal(await h.settle(), undefined);
	assert.equal(h.models.length, 0);
});

for (const options of [{ missing: true }, { virtual: true }, { noAuth: true }, { authThrow: true }]) {
	test(`missing/unsupported/auth fallback is terminal: ${JSON.stringify(options)}`, async (t) => {
		const h = await setup(t, options);
		await h.error();
		assert.equal(await h.settle(), undefined);
		assert.equal(await h.settle(), undefined);
		assert.ok(h.models.length <= 1);
	});
}

test("abort before/during switching and shutdown never request continuation", async (t) => {
	for (const mode of ["before", "during", "shutdown"]) {
		const h = await setup(t, mode === "during" ? { onSwitch: controller => controller.abort() } : {});
		await h.error();
		if (mode === "before") h.controller.abort();
		if (mode === "shutdown") await h.emit("session_shutdown");
		assert.equal(await h.settle(), undefined);
	}
});

test("pending work, another boundary continuation, changed primary and non-error settlement do not switch", async (t) => {
	for (const event of [{ outcome: "aborted" }, { outcome: "completed" }, { continue: true }, { entries: [{}] }, { context: { pendingMessages: [{}] } }]) {
		const h = await setup(t);
		await h.error();
		assert.equal(await h.settle(event), undefined);
		assert.equal(h.models.length, 0);
	}
	const h = await setup(t);
	await h.error();
	h.ctx.model = { provider: "other", id: "override" };
	assert.equal(await h.settle(), undefined);
});
