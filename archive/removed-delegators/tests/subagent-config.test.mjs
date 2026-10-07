import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

function frontmatter(text) {
	const match = text.match(/^---\n([\s\S]*?)\n---/);
	assert.ok(match, "agent file must start with YAML frontmatter");
	return Object.fromEntries(
		match[1].split("\n").map((line) => {
			const colon = line.indexOf(":");
			return [line.slice(0, colon).trim(), line.slice(colon + 1).trim().replace(/^"|"$/g, "")];
		}),
	);
}

test("retained role files have distinct descriptions and expected metadata", async () => {
	const expected = {
		Scout: {
			model: "openai-codex/gpt-5.6-luna",
			tools: "read, grep, find, ls",
			terms: ["Scout", "repository code exploration"],
		},
		Researcher: {
			model: "commandcode/z-ai/glm-5.3-flash",
			tools: "web_search, web_fetch",
			terms: ["Researcher", "external web research"],
		},
		Worker: {
			model: "openai-codex/gpt-5.6-luna",
			tools: "read, grep, find, ls, bash, edit, write",
			terms: ["Worker", "code implementation"],
		},
		Reviewer: {
			model: "openai-codex/gpt-5.6-luna",
			tools: "read, grep, find, ls",
			terms: ["Reviewer", "code review"],
		},
	};
	const descriptions = new Set();
	for (const [name, config] of Object.entries(expected)) {
		const text = await readFile(new URL(`.pi/agents/${name}.md`, root), "utf8");
		const fm = frontmatter(text);
		assert.equal(fm.model, config.model);
		assert.equal(fm.tools, config.tools);
		assert.ok(!descriptions.has(fm.description), `${name} must have a distinct description`);
		descriptions.add(fm.description);
		for (const term of config.terms) assert.match(fm.description, new RegExp(term, "i"));
	}
});

test("local package exposes only maintained extensions", async () => {
	const { pi } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
	assert.deepEqual(pi.extensions, ["./extensions"]);
});
