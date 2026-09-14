import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scoreAgentDescription } from "../vendor/pi-core-subagent/src/agent-match.ts";
import { clearAgentFileCache, resolveAgentFile } from "../vendor/pi-core-subagent/src/agentfile.ts";
import {
	READONLY_TOOLS,
	selectChildTools,
	requestedWebToolNames,
	WRITE_TOOLS,
} from "../vendor/pi-core-subagent/src/tool-selection.ts";
import { createRequestedWebTools } from "../vendor/pi-core-subagent/src/web-tools.ts";

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

async function makeAgentSandbox({ project = {}, home = {} } = {}) {
	const base = await mkdtemp(join(tmpdir(), "pi-agent-match-"));
	const projectDir = join(base, "project");
	const agentDir = join(base, "home", ".pi", "agent");
	const projectAgents = join(projectDir, ".pi", "agents");
	const homeAgents = join(base, "home", ".pi", "agents");
	await mkdir(projectAgents, { recursive: true });
	await mkdir(homeAgents, { recursive: true });

	const writeAgents = async (directory, agents) => {
		for (const [name, config] of Object.entries(agents)) {
			const tools = config.tools ?? "read, grep, find, ls";
			const model = config.model ?? "example/model";
			await writeFile(
				join(directory, `${name}.md`),
				`---\ndescription: "${config.description}"\nmodel: ${model}\ntools: ${tools}\n---\n\nAgent body.\n`,
			);
		}
	};
	await writeAgents(projectAgents, project);
	await writeAgents(homeAgents, home);

	return {
		base,
		projectDir,
		agentDir,
		projectAgents,
		homeAgents,
		async cleanup() {
			clearAgentFileCache();
			await rm(base, { recursive: true, force: true });
		},
	};
}

test("read-only defaults remain minimal", () => {
	assert.deepEqual(selectChildTools({}).baseTools, [...READONLY_TOOLS]);
});

test("researcher agent files can be web-only without write access", () => {
	const result = selectChildTools({
		fileTools: ["web_search", "web_fetch"],
	});
	assert.deepEqual(result.baseTools, ["web_search", "web_fetch"]);
	assert.deepEqual(requestedWebToolNames(result.baseTools), ["web_search", "web_fetch"]);
});

test("write dispatch keeps the standard write toolset", () => {
	assert.deepEqual(selectChildTools({ write: true }).baseTools, [...WRITE_TOOLS]);
});

test("write-capable explicit tools require write: true", () => {
	assert.throws(() => selectChildTools({ explicitTools: ["read", "bash"] }), /require write: true/);
});

test("unknown explicit tools fail clearly", () => {
	assert.throws(() => selectChildTools({ explicitTools: ["read", "not_a_tool"] }), /Unknown subagent tools: not_a_tool/);
});

test("no web request avoids loading web provider definitions", async () => {
	assert.deepEqual(await createRequestedWebTools(["read", "grep"]), []);
});

test("approved agent files use distinct descriptions and expected tools", async () => {
	const expected = {
		Scout: { model: "openai-codex/gpt-5.6-luna", terms: ["Scout", "repository code exploration"] },
		Researcher: { model: "commandcode/z-ai/glm-5.3-flash", terms: ["Researcher", "external web research"] },
		Worker: { model: "openai-codex/gpt-5.6-luna", terms: ["Worker", "code implementation"] },
		Reviewer: { model: "openai-codex/gpt-5.6-luna", terms: ["Reviewer", "code review"] },
	};

	for (const [name, config] of Object.entries(expected)) {
		const text = await readFile(new URL(`.pi/agents/${name}.md`, root), "utf8");
		const fm = frontmatter(text);
		assert.equal(fm.model, config.model);
		for (const term of config.terms) assert.match(fm.description, new RegExp(term, "i"));
	}

	const researcher = frontmatter(await readFile(new URL(".pi/agents/Researcher.md", root), "utf8"));
	assert.equal(researcher.tools, "web_search, web_fetch");
});

test("typical role tasks satisfy the actual description matcher", async () => {
	const queries = {
		Scout: "scout explore repository code and map the architecture",
		Researcher: "researcher conduct external web research by fetching current documentation",
		Worker: "worker implement a code bug fix and tests",
		Reviewer: "reviewer perform code review and audit this diff for regressions",
	};

	for (const [name, query] of Object.entries(queries)) {
		const fm = frontmatter(await readFile(new URL(`.pi/agents/${name}.md`, root), "utf8"));
		assert.ok(scoreAgentDescription(query, fm.description) > 0, `${name} description should match its typical task`);
	}
});

test("exact role names select matching files for unrelated tasks", async () => {
	const sandbox = await makeAgentSandbox({
		home: {
			Researcher: {
				description: "Researcher for external web research and documentation.",
				model: "commandcode/z-ai/glm-5.3-flash",
				tools: "web_search, web_fetch",
			},
		},
	});
	try {
		const selected = resolveAgentFile("researcher", "unrelated task wording", sandbox.projectDir, sandbox.agentDir);
		assert.equal(selected?.path, join(sandbox.homeAgents, "Researcher.md"));
		assert.equal(selected?.model, "commandcode/z-ai/glm-5.3-flash");
		assert.deepEqual(selected?.tools, ["web_search", "web_fetch"]);
	} finally {
		await sandbox.cleanup();
	}
});

test("exact role matching is case-insensitive", async () => {
	const sandbox = await makeAgentSandbox({
		home: { Researcher: { description: "Researcher for external web research and documentation." } },
	});
	try {
		const selected = resolveAgentFile("RESEARCHER", "anything", sandbox.projectDir, sandbox.agentDir);
		assert.equal(selected?.path, join(sandbox.homeAgents, "Researcher.md"));
	} finally {
		await sandbox.cleanup();
	}
});

test("project exact matches take precedence over home exact matches", async () => {
	const sandbox = await makeAgentSandbox({
		project: { Researcher: { description: "Project researcher profile.", model: "project/model" } },
		home: { Researcher: { description: "Home researcher profile.", model: "home/model" } },
	});
	try {
		const selected = resolveAgentFile("researcher", "unrelated", sandbox.projectDir, sandbox.agentDir);
		assert.equal(selected?.path, join(sandbox.projectAgents, "Researcher.md"));
		assert.equal(selected?.model, "project/model");
	} finally {
		await sandbox.cleanup();
	}
});

test("free-form names still use description matching", async () => {
	const sandbox = await makeAgentSandbox({
		home: { Docs: { description: "Researcher for external web research and documentation." } },
	});
	try {
		const selected = resolveAgentFile("evidence", "external web research documentation", sandbox.projectDir, sandbox.agentDir);
		assert.equal(selected?.path, join(sandbox.homeAgents, "Docs.md"));
	} finally {
		await sandbox.cleanup();
	}
});

test("unmatched names preserve inline-agent behavior", async () => {
	const sandbox = await makeAgentSandbox({ home: { Worker: { description: "Worker for code implementation." } } });
	try {
		assert.equal(resolveAgentFile("specialist", "an unrelated task", sandbox.projectDir, sandbox.agentDir), undefined);
	} finally {
		await sandbox.cleanup();
	}
});

test("vendored child sessions retain extension isolation", async () => {
	const source = await readFile(new URL("vendor/pi-core-subagent/src/manager.ts", root), "utf8");
	assert.match(source, /noExtensions:\s*true/);
	assert.match(source, /createRequestedWebTools\(baseTools\)/);
});
