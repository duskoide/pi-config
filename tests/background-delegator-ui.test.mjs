import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { agentStatusline, agentStatusRow } from "../extensions/delegator-background/statusline.ts";
import { shortJobId } from "../extensions/delegator-background/identity.ts";
import { backgroundRenderers } from "../extensions/delegator-background/renderers.ts";

const theme = { fg: (_color, text) => text, bold: (text) => text };
function job(agent, overrides = {}) {
	return { taskId: "del-12345678-0000-0000-0000-000000000000", shortId: "1234", agent, status: "running", ready: false, retrieved: false, ...overrides };
}
function result(details, text = "full original metadata\nanswer") {
	return { content: [{ type: "text", text }], details };
}
function lines(component, width = 80) { return component.render(width); }

test("statusline shows individual agent progress and terminal unread states", () => {
	const label = agentStatusline([
		job("scout", { lastTool: "read" }), job("reviewer", { lastTool: "bash" }),
		job("worker", { status: "completed", ready: true }),
	]);
	assert.ok(label.includes("scout:read"));
	assert.ok(label.includes("reviewer:bash"));
	assert.ok(label.includes("worker:done"));
	assert.ok(!label.includes("\n"));
});

test("retrieved completed entries disappear, running entries remain, and idle status clears", () => {
	assert.equal(agentStatusline([]), undefined);
	assert.equal(agentStatusline([job("worker", { status: "completed", ready: true, retrieved: true })]), undefined);
	assert.equal(agentStatusline([job("scout"), job("worker", { status: "completed", ready: true, retrieved: true })]), "scout:...");
});

test("duplicate types gain short IDs and unread failures have display priority", () => {
	const label = agentStatusline([
		job("worker"), job("worker", { taskId: "del-abcd5678-0000-0000-0000-000000000000" }),
		job("oracle", { ready: true, status: "failed" }),
	]);
	assert.ok(label.startsWith("oracle:error"));
	assert.ok(label.includes("worker#1234"));
	assert.ok(label.includes("worker#abcd"));
});

test("large cohorts and narrow status widths remain bounded with overflow summaries", () => {
	const jobs = Array.from({ length: 8 }, (_, index) => job(`agent-${index}`, { lastTool: "long-tool-name" }));
	for (const width of [1, 10, 20, 72]) {
		const text = agentStatusline(jobs, width);
		assert.ok(visibleWidth(text) <= width);
		assert.ok(!text.includes("\n"));
	}
	assert.match(agentStatusline(jobs), /\+\d/);
	assert.equal(agentStatusline(jobs, 0), undefined);
});

test("statusline sanitizes terminal controls and marks cancellation separately from completion", () => {
	const label = agentStatusline([
		job("scout\x1b[31m", { status: "cancelling" }),
		job("worker", { status: "cancelled", ready: true }),
	]);
	assert.ok(!label.includes("\x1b"));
	assert.match(label, /scout:stopping/);
	assert.match(label, /worker:cancelled/);
});

test("routine launch and cancellation tool calls/results are invisible while collapsed", () => {
	for (const operation of ["start", "cancel"]) {
		const renderer = backgroundRenderers("Lifecycle", operation);
		assert.equal(renderer.renderShell, "self");
		assert.deepEqual(lines(renderer.renderCall({ agent: "scout", task: "task" }, theme, { expanded: false })), []);
		const response = result({ agent: "scout", ready: false, status: "running" });
		assert.deepEqual(lines(renderer.renderResult(response, { expanded: false }, theme)), []);
		assert.ok(lines(renderer.renderCall({ agent: "scout", task: "task" }, theme, { expanded: true })).join("\n").includes("task"));
		assert.ok(lines(renderer.renderResult(response, { expanded: true }, theme)).join("\n").includes("full original metadata"));
	}
});

test("pending reads are quiet, terminal answers are one line, and expansion preserves complete content", () => {
	const renderer = backgroundRenderers("Result");
	assert.deepEqual(lines(renderer.renderResult(result(job("scout")), { expanded: false }, theme)), []);
	const text = "Metadata\n" + "Detailed answer line\n".repeat(50);
	const response = result(job("scout", { ready: true, status: "completed", outcome: { ok: true, text: "Detailed answer" } }), text);
	const collapsed = lines(renderer.renderResult(response, { expanded: false }, theme));
	assert.equal(collapsed.length, 1);
	assert.match(collapsed[0], /scout#1234 completed/);
	assert.match(collapsed[0], /expand/);
	assert.equal(lines(renderer.renderResult(response, { expanded: true }, theme), 10000).join("\n"), text);
	assert.equal(response.content[0].text, text);
});

test("operation errors remain visible even for hidden lifecycle rows", () => {
	const renderer = backgroundRenderers("Start", "start");
	const response = result({}, "Invalid cwd\nlong diagnostics");
	const rendered = lines(renderer.renderResult(response, { expanded: false }, theme, { isError: true }));
	assert.equal(rendered.length, 1);
	assert.match(rendered[0], /Invalid cwd/);
});

test("failed results and job listings retain a concise visible trace", () => {
	const renderer = backgroundRenderers("Result");
	const failed = result(job("worker", { ready: true, status: "failed", outcome: { ok: false, message: "cleanup failed" } }));
	assert.match(lines(renderer.renderResult(failed, { expanded: false }, theme))[0], /worker#1234 failed/);
	const listing = result({ jobs: [job("scout"), job("worker", { ready: true, status: "completed" })] });
	assert.match(lines(renderer.renderResult(listing, { expanded: false }, theme))[0], /1 running · 1 unread/);
});

test("compact result rendering fits narrow widths without mutating model-facing payload", () => {
	const renderer = backgroundRenderers("Result");
	const response = result(job("scout", { ready: true, status: "completed", outcome: { ok: true, text: "very long answer ".repeat(500) } }), "original payload");
	for (const width of [0, 1, 10, 40]) {
		const rendered = lines(renderer.renderResult(response, { expanded: false }, theme), width);
		assert.ok(rendered.every((line) => visibleWidth(line) <= width));
		assert.ok(rendered.length <= 1);
	}
	assert.equal(response.content[0].text, "original payload");
});

test("agent row uses the real width and remains present on narrow/crowded terminals", () => {
	const jobs = Array.from({ length: 8 }, (_, index) => job("reviewer", { taskId: `del-${index}2345678-0000-0000-0000-000000000000`, lastTool: "read" }));
	for (const width of [1, 10, 20, 40, 60, 80, 200]) {
		const row = agentStatusRow(jobs, width);
		assert.ok(row, `agents must not disappear at width ${width}`);
		assert.ok(visibleWidth(row) <= width);
	}
	assert.equal(agentStatusRow([], 60), undefined);
	assert.equal(agentStatusRow(jobs, 0), undefined);
});

test("truncated-name and UUID-prefix collisions produce distinguishable identities", () => {
	const first = "del-1234aaaa-0000-0000-0000-000000000000";
	const second = "del-1234bbbb-0000-0000-0000-000000000000";
	const ids = [first, second];
	assert.equal(shortJobId(first, ids), "1234a");
	assert.equal(shortJobId(second, ids), "1234b");
	const label = agentStatusline([job("reviewer-alpha", { taskId: first }), job("reviewer-beta", { taskId: second })], 100);
	assert.ok(label.includes("#1234a"));
	assert.ok(label.includes("#1234b"));
	const renderer = backgroundRenderers("Result");
	for (const [taskId, shortId] of [[first, "1234a"], [second, "1234b"]]) {
		const response = result(job("reviewer", { taskId, shortId, ready: true, status: "completed", outcome: { ok: true, text: "answer" } }));
		assert.ok(lines(renderer.renderResult(response, { expanded: false }, theme))[0].includes(`#${shortId}`));
	}
});

test("agent widget does not require or duplicate a packed Powerline custom item", async () => {
	const settings = JSON.parse(await readFile(new URL("../.pi/agent/settings.json", import.meta.url), "utf8"));
	assert.ok(!(settings.powerline?.customItems ?? []).some((entry) => entry.statusKey === "delegators"));
});
