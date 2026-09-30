import assert from "node:assert/strict";
import test from "node:test";
import toolRouting from "../extensions/tool-routing.ts";

const section = "pi_config_tool_routing";

function setup(selectedTools = [], sections = {}) {
	const handlers = new Map();
	toolRouting({
		on(name, handler) {
			handlers.set(name, handler);
		},
	});
	assert.deepEqual([...handlers.keys()], ["before_agent_start"]);
	return {
		handler: handlers.get("before_agent_start"),
		event: {
			systemPrompt: "Existing system prompt",
			systemPromptOptions: {
				selectedTools,
				sections,
				toolSnippets: { delegate_task: "Existing snippet" },
				toolGuidelines: { delegate_task: ["Existing safety rule"] },
				promptGuidelines: ["Existing global rule"],
			},
		},
	};
}

test("active delegation gets proactive triggers and existing safety boundaries", () => {
	const { handler, event } = setup(["read", "delegate_task"]);
	assert.equal(handler(event), undefined);
	const guidance = event.systemPromptOptions.sections[section];
	assert.match(guidance, /Use delegate_task proactively/);
	assert.match(guidance, /early bounded scout/);
	assert.match(guidance, /independent delegate_task reviewer/);
	assert.match(guidance, /user requests no delegation/);
	assert.match(guidance, /trivial tasks local/);
	assert.match(guidance, /complementary work rather than duplicating/);
	assert.match(guidance, /instead of polling or sleeping/);
	assert.match(guidance, /pi-subagent skill/);
	assert.match(guidance, /mode direct only for read-only/);
	assert.match(guidance, /mode isolated for implementation or any writing/);
	assert.match(guidance, /preserve existing authorization and check\/integration requirements/);
	assert.doesNotMatch(guidance, /Use teleport/);
});

test("inactive tools receive no routing section", () => {
	const { handler, event } = setup(["read", "bash", "sudo_task"]);
	handler(event);
	assert.equal(Object.hasOwn(event.systemPromptOptions.sections, section), false);
});

test("teleport guidance is independently conditional and keeps ownership distinct", () => {
	const { handler, event } = setup(["read", "teleport"]);
	handler(event);
	const guidance = event.systemPromptOptions.sections[section];
	assert.match(guidance, /Use teleport when continuing work/);
	assert.match(guidance, /not merely to read an external file/);
	assert.match(guidance, /do not move Main into subagent-owned worktrees/);
	assert.doesNotMatch(guidance, /Use delegate_task/);
});

test("repeated invocations replace the owned section without duplicate rules", () => {
	const { handler, event } = setup(["delegate_task", "teleport"]);
	handler(event);
	const first = event.systemPromptOptions.sections[section];
	handler(event);
	assert.equal(event.systemPromptOptions.sections[section], first);
	assert.equal(first.match(/Use delegate_task proactively/g).length, 1);
	assert.equal(first.match(/Use teleport when continuing work/g).length, 1);
});

test("tool selection changes remove stale guidance without affecting other sections", () => {
	const { handler, event } = setup(["delegate_task", "teleport"], { project_policy: "Keep this" });
	handler(event);
	event.systemPromptOptions.selectedTools = ["teleport"];
	handler(event);
	assert.doesNotMatch(event.systemPromptOptions.sections[section], /Use delegate_task/);
	event.systemPromptOptions.selectedTools = ["read"];
	handler(event);
	assert.deepEqual(event.systemPromptOptions.sections, { project_policy: "Keep this" });
});

test("routing preserves the prompt, tool definitions, selection, and other instructions", () => {
	const { handler, event } = setup(["delegate_task"], { project_policy: "Keep this" });
	const { sections, ...otherOptions } = structuredClone(event.systemPromptOptions);
	assert.equal(handler(event), undefined);
	const { sections: afterSections, ...afterOptions } = event.systemPromptOptions;
	assert.deepEqual(afterOptions, otherOptions);
	assert.equal(afterSections.project_policy, sections.project_policy);
	assert.equal(event.systemPrompt, "Existing system prompt");
});

test("older Pi events without structured options are a safe no-op", () => {
	const { handler } = setup();
	const event = { systemPrompt: "Existing system prompt" };
	assert.equal(handler(event), undefined);
	assert.deepEqual(event, { systemPrompt: "Existing system prompt" });
});
