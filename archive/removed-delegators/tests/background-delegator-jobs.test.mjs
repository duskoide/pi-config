import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { boundedText, DelegateJobs, MAX_ACTIVE_DELEGATES, MAX_RETAINED_DELEGATES } from "../extensions/delegator-background/jobs.ts";

const profile = { name: "scout", description: "Read only", model: null, thinking: "low", tools: ["read"], skills: [], extensions: [], systemPrompt: "Inspect only", timeoutMs: null };
const usage = { input: 11, output: 4, cacheRead: 3, cacheWrite: 2, cacheWrite1h: 1, reasoning: 2, totalTokens: 20, cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.01, total: 0.32 } };
const cleanup = { forced: false, termSent: false, killSent: false, processExited: true, pipesClosed: true };
const success = { ok: true, text: "Answer", durationMs: 1, nativeUsage: usage, cleanup, truncated: false };
function input(callId, options = {}) {
	return { callId, profile, task: "Inspect this task", cwd: process.cwd(), model: "provider/parent", notifyOnCompletion: true, triggerOnCompletion: true, ...options };
}
function controlled(observers = {}) {
	const calls = [];
	const notices = [];
	const jobs = new DelegateJobs((options) => new Promise((resolve) => {
		calls.push({ options, resolve });
		const cancel = () => resolve({ ok: false, code: "cancelled", message: "cancelled", durationMs: 1, nativeUsage: usage, cleanup });
		options.signal.addEventListener("abort", cancel, { once: true });
		if (options.signal.aborted) cancel();
	}), { onComplete: (notice) => notices.push(notice), ...observers });
	return { calls, notices, jobs };
}

test("launch returns before either delegate resolves; immutable settings and independent jobs", async () => {
	const { jobs, calls } = controlled();
	const mutable = structuredClone(profile);
	const a = jobs.start(input("a", { profile: mutable }));
	const b = jobs.start(input("b", { model: "provider/override" }));
	mutable.thinking = "max";
	mutable.tools.push("write");
	jobs.acknowledge("a", true);
	jobs.acknowledge("b", true);
	assert.equal(a.ready, false);
	assert.notEqual(a.taskId, b.taskId);
	await setImmediate();
	assert.equal(calls.length, 2);
	assert.equal(calls[0].options.profile.thinking, "low");
	assert.deepEqual(calls[0].options.profile.tools, ["read"]);
	assert.equal(calls[1].options.model, "provider/override");
	assert.equal(jobs.result(a.taskId).ready, false);
	calls[1].resolve(success);
	await setImmediate();
	assert.equal(jobs.result(b.taskId).outcome.text, "Answer");
	assert.equal(jobs.result(a.taskId).ready, false);
	await jobs.close();
});

test("fast completion notifies only after launch receipt and never twice", async () => {
	const { jobs, calls, notices } = controlled();
	const receipt = jobs.start(input("start"));
	await setImmediate();
	calls[0].resolve(success);
	await setImmediate();
	assert.equal(notices.length, 0);
	jobs.acknowledge("start", true);
	jobs.acknowledge("start", true);
	assert.equal(notices.length, 1);
	assert.equal(notices[0].taskId, receipt.taskId);
	assert.equal(notices[0].status, "completed");
	await jobs.close();
});

test("parent abort cancels only before ownership transfer, and suppresses aborted-launch wake", async () => {
	const { jobs, notices } = controlled();
	const early = new AbortController();
	const a = jobs.start(input("early"), early.signal);
	early.abort();
	jobs.acknowledge("early", true);
	const later = new AbortController();
	const b = jobs.start(input("later"), later.signal);
	jobs.acknowledge("later", true);
	later.abort();
	await setImmediate();
	assert.equal(jobs.result(a.taskId).status, "cancelled");
	assert.equal(jobs.result(b.taskId).status, "running");
	assert.equal(notices.length, 0);
	await jobs.close();
});

test("failed launch receipt cancels its job without follow-up notification", async () => {
	const { jobs, notices } = controlled();
	const receipt = jobs.start(input("bad-receipt"));
	jobs.acknowledge("bad-receipt", false);
	await setImmediate();
	assert.equal(jobs.result(receipt.taskId).status, "cancelled");
	assert.equal(notices.length, 0);
	await jobs.close();
});

test("notification options are respected and observer failures cannot change terminal outcome", async () => {
	const { jobs, calls, notices } = controlled();
	const a = jobs.start(input("silent", { notifyOnCompletion: false, triggerOnCompletion: false }));
	jobs.acknowledge("silent", true);
	await setImmediate();
	calls[0].resolve(success);
	await setImmediate();
	assert.equal(notices.length, 0);
	assert.equal(jobs.result(a.taskId).status, "completed");
	await jobs.close();
	const broken = controlled({ onChange: () => { throw new Error("UI failed"); }, onComplete: () => { throw new Error("sender failed"); } });
	const receipt = broken.jobs.start(input("notify"));
	broken.jobs.acknowledge("notify", true);
	await setImmediate();
	broken.calls[0].resolve(success);
	await setImmediate();
	const result = broken.jobs.result(receipt.taskId);
	assert.equal(result.status, "completed");
	assert.match(result.notificationError, /sender failed/);
	assert.equal(result.outcome.text, "Answer");
	await broken.jobs.close();
});

test("usage is returned once for each terminal answer, including failure and cancellation", async () => {
	const { jobs, calls } = controlled();
	const a = jobs.start(input("success"));
	const b = jobs.start(input("failure"));
	const c = jobs.start(input("cancel"));
	for (const id of ["success", "failure", "cancel"]) jobs.acknowledge(id, true);
	assert.equal(jobs.result(a.taskId).usage, undefined);
	await setImmediate();
	calls[0].resolve(success);
	calls[1].resolve({ ok: false, code: "child_error", message: "bad provider", durationMs: 1, nativeUsage: usage, cleanup });
	jobs.cancel(c.taskId);
	await setImmediate();
	for (const receipt of [a, b, c]) {
		assert.deepEqual(jobs.result(receipt.taskId).usage, usage);
		assert.equal(jobs.result(receipt.taskId).usage, undefined);
	}
	await jobs.close();
});

test("cancellation is per-job and completed jobs remain unchanged", async () => {
	const { jobs, calls } = controlled();
	const a = jobs.start(input("cancel"));
	const b = jobs.start(input("survive"));
	jobs.acknowledge("cancel", true);
	jobs.acknowledge("survive", true);
	await setImmediate();
	const cancellation = jobs.cancel(a.taskId);
	assert.equal(cancellation.status, "cancelling");
	assert.equal(cancellation.cancellationRequested, true);
	assert.equal(jobs.cancel(a.taskId).cancellationRequested, false);
	await setImmediate();
	assert.equal(calls[0].options.signal.aborted, true);
	assert.equal(calls[1].options.signal.aborted, false);
	calls[1].resolve(success);
	await setImmediate();
	assert.equal(jobs.cancel(b.taskId).cancellationRequested, false);
	assert.equal(jobs.result(b.taskId).outcome.text, "Answer");
	await jobs.close();
});

test("shutdown aborts and drains all jobs, suppresses messages, and closes access", async () => {
	const { jobs, calls, notices } = controlled();
	const a = jobs.start(input("one"));
	jobs.start(input("two"));
	jobs.acknowledge("one", true);
	jobs.acknowledge("two", true);
	await setImmediate();
	await Promise.all([jobs.close(), jobs.close()]);
	assert.ok(calls.every((call) => call.options.signal.aborted));
	assert.ok(jobs.list().every((job) => job.status === "cancelled" && job.ready));
	assert.equal(notices.length, 0);
	assert.throws(() => jobs.start(input("late")), /shutting down/);
	assert.throws(() => jobs.result(a.taskId), /closed session/);
});

test("concurrency includes startup/cleanup and rejects extra paid launches", async () => {
	const { jobs, calls } = controlled();
	for (let index = 0; index < MAX_ACTIVE_DELEGATES; index += 1) jobs.start(input(`call-${index}`));
	assert.throws(() => jobs.start(input("overflow")), /concurrently/);
	await setImmediate();
	assert.equal(calls.length, MAX_ACTIVE_DELEGATES);
	await jobs.close();
});

test("bounded retention never evicts unread results, but reclaims retrieved terminal entries", async () => {
	const jobs = new DelegateJobs(async () => success);
	const ids = [];
	for (let index = 0; index < MAX_RETAINED_DELEGATES; index += 1) {
		const receipt = jobs.start(input(`call-${index}`));
		jobs.acknowledge(`call-${index}`, true);
		ids.push(receipt.taskId);
		await setImmediate();
	}
	assert.throws(() => jobs.start(input("overflow")), /buffer is full/);
	assert.equal(jobs.list().length, MAX_RETAINED_DELEGATES);
	jobs.result(ids[0]);
	const next = jobs.start(input("next"));
	jobs.acknowledge("next", true);
	assert.equal(jobs.list().length, MAX_RETAINED_DELEGATES);
	assert.throws(() => jobs.result(ids[0]), /Unknown background delegate/);
	assert.equal(jobs.result(ids[1]).outcome.text, "Answer");
	await jobs.close();
});

test("runner rejections, invalid results, cleanup diagnostics and output bounds remain explicit", async () => {
	const jobs = new DelegateJobs(async () => { throw new Error("runner exploded"); });
	const receipt = jobs.start(input("error"));
	jobs.acknowledge("error", true);
	await setImmediate();
	assert.equal(jobs.result(receipt.taskId).status, "failed");
	assert.equal(jobs.result(receipt.taskId).outcome.code, "internal_error");
	await jobs.close();
	const { jobs: bounded, calls } = controlled();
	const a = bounded.start(input("large"));
	const b = bounded.start(input("failure"));
	bounded.acknowledge("large", true);
	bounded.acknowledge("failure", true);
	await setImmediate();
	calls[0].resolve({ ...success, text: "🙂".repeat(20000) });
	calls[1].resolve({ ok: false, code: "cleanup_failed", message: "x".repeat(20000), stderr: "z".repeat(20000), durationMs: 1, cleanup: { ...cleanup, diagnostic: "could not verify process group" } });
	await setImmediate();
	const large = bounded.result(a.taskId).outcome;
	assert.equal(large.truncated, true);
	assert.equal(large.originalBytes, 80000);
	assert.ok(Buffer.byteLength(large.text) <= 50 * 1024);
	assert.ok(!large.text.includes("�"));
	const failure = bounded.result(b.taskId);
	assert.equal(failure.failureCode, "cleanup_failed");
	assert.match(failure.cleanupDiagnostic, /could not verify/);
	assert.match(failure.outcome.message, /truncated/);
	assert.match(failure.outcome.stderr, /truncated/);
	await bounded.close();
});

test("progress is bounded and does not retain arbitrary tool arguments", async () => {
	const { jobs, calls } = controlled();
	const receipt = jobs.start(input("progress"));
	jobs.acknowledge("progress", true);
	await setImmediate();
	calls[0].options.onProgress({ type: "tool_start", toolName: "read", args: { secret: "not retained" } });
	calls[0].options.onProgress({ type: "assistant_message", text: "🙂".repeat(1000) });
	const view = jobs.list()[0];
	assert.equal(view.toolCalls, 1);
	assert.equal(view.lastTool, "read");
	assert.ok(Buffer.byteLength(view.preview) <= 512);
	assert.ok(!JSON.stringify(view).includes("not retained"));
	assert.equal(jobs.result(receipt.taskId).ready, false);
	await jobs.close();
});

test("UTF-8 bounding preserves both prefix and tail without replacement characters", () => {
	assert.equal(boundedText("🙂🙂🙂", 5).text, "🙂");
	assert.equal(boundedText("🙂🙂🙂", 5, true).text, "🙂");
});
