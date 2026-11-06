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
				toolSnippets: { bash: "Existing snippet" },
				toolGuidelines: { bash: ["Existing safety rule"] },
				promptGuidelines: ["Existing global rule"],
			},
		},
	};
}

function withHc(value, fn) {
	const prev = process.env.HC_TERMINAL_ID;
	if (value === undefined) delete process.env.HC_TERMINAL_ID;
	else process.env.HC_TERMINAL_ID = value;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env.HC_TERMINAL_ID;
		else process.env.HC_TERMINAL_ID = prev;
	}
}

test("inside hc, delegation guidance steers to hc-spawned pi instances", () => {
	withHc("t1", () => {
		const { handler, event } = setup(["read", "bash"]);
		assert.equal(handler(event), undefined);
		const guidance = event.systemPromptOptions.sections[section];
		assert.match(guidance, /spawning interactive pi instances in herdr-core terminals/);
		assert.match(guidance, /hc templates/);
		assert.match(guidance, /hc run --bg --name/);
		assert.match(guidance, /never use `pi -p`/);
		assert.match(guidance, /hc wait --children/);
		assert.match(guidance, /disjoint files or separate worktrees/);
		assert.match(guidance, /Main remains responsible for tests and integration/);
		assert.doesNotMatch(guidance, /delegate_task|delegate_start|Use teleport/);
	});
});

test("codemode alone also receives hc guidance", () => {
	withHc("t1", () => {
		const { handler, event } = setup(["codemode"]);
		handler(event);
		assert.match(event.systemPromptOptions.sections[section], /hc run --bg/);
	});
});

test("outside hc or without a shell route there is no delegation section", () => {
	withHc(undefined, () => {
		const { handler, event } = setup(["read", "bash", "sudo_task"]);
		handler(event);
		assert.equal(Object.hasOwn(event.systemPromptOptions.sections, section), false);
	});
	withHc("t1", () => {
		const { handler, event } = setup(["read"]);
		handler(event);
		assert.equal(Object.hasOwn(event.systemPromptOptions.sections, section), false);
	});
});

test("teleport guidance is independently conditional", () => {
	withHc(undefined, () => {
		const { handler, event } = setup(["read", "teleport"]);
		handler(event);
		const guidance = event.systemPromptOptions.sections[section];
		assert.match(guidance, /Use teleport when continuing work/);
		assert.match(guidance, /not merely to read an external file/);
		assert.doesNotMatch(guidance, /hc run/);
	});
});

test("repeated invocations replace the owned section without duplicates or touching other sections", () => {
	withHc("t1", () => {
		const { handler, event } = setup(["bash", "teleport"], { project_policy: "Keep this" });
		handler(event);
		const first = event.systemPromptOptions.sections[section];
		handler(event);
		assert.equal(event.systemPromptOptions.sections[section], first);
		assert.equal(first.match(/hc run --bg --name/g).length, 1);
		event.systemPromptOptions.selectedTools = ["read"];
		handler(event);
		assert.deepEqual(event.systemPromptOptions.sections, { project_policy: "Keep this" });
	});
});

test("routing preserves the prompt, tool definitions, selection, and other instructions", () => {
	withHc("t1", () => {
		const { handler, event } = setup(["bash"], { project_policy: "Keep this" });
		const { sections, ...otherOptions } = structuredClone(event.systemPromptOptions);
		assert.equal(handler(event), undefined);
		const { sections: afterSections, ...afterOptions } = event.systemPromptOptions;
		assert.deepEqual(afterOptions, otherOptions);
		assert.equal(afterSections.project_policy, sections.project_policy);
		assert.equal(event.systemPrompt, "Existing system prompt");
	});
});

test("older Pi events without structured options are a safe no-op", () => {
	const { handler } = setup();
	const event = { systemPrompt: "Existing system prompt" };
	assert.equal(handler(event), undefined);
	assert.deepEqual(event, { systemPrompt: "Existing system prompt" });
});
