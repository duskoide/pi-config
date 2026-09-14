import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { scoreAgentDescription } from "./agent-match.ts";

export interface AgentFileInfo {
	body: string;
	model?: string;
	tools?: string[];
	description?: string;
	path?: string;
}

const AGENT_DIRS = [".agents/agents", ".claude/agents", ".pi/agents"] as const;
const MAX_BODY_CHARS = 64_000;

const walkCache = new Map<string, AgentFileInfo[]>();

export function clearAgentFileCache(): void {
	walkCache.clear();
}

function readAgentFile(dir: string): AgentFileInfo[] {
	if (!existsSync(dir)) return [];
	const out: AgentFileInfo[] = [];
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".md")) continue;
		const path = join(dir, entry);
		const { frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8"));
		let trimmed = body;
		if (trimmed.length > MAX_BODY_CHARS) {
			trimmed = `${trimmed.slice(0, MAX_BODY_CHARS)}\n\n[truncated: agent file exceeded ${MAX_BODY_CHARS} chars — slim it down]`;
		}
		const toolsF = frontmatter.tools;
		const tools =
			typeof toolsF === "string"
				? toolsF
						.split(",")
						.map((t) => t.trim())
						.filter(Boolean)
				: Array.isArray(toolsF)
					? toolsF.map(String)
					: undefined;
		out.push({
			body: trimmed,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			tools: tools?.length ? tools : undefined,
			description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
			path,
		});
	}
	return out;
}

function allAgentFiles(cwd: string, agentDir: string): AgentFileInfo[] {
	const out: AgentFileInfo[] = [];
	let dir = cwd;
	while (true) {
		for (const sub of AGENT_DIRS) out.push(...readAgentFile(join(dir, sub)));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const home = dirname(dirname(agentDir));
	for (const sub of AGENT_DIRS) out.push(...readAgentFile(join(home, sub)));
	return out;
}

export function resolveAgentFile(name: string, task: string, cwd: string, agentDir: string): AgentFileInfo | undefined {
	const query = `${name} ${task}`;
	const cacheKey = `${agentDir}${cwd}`;
	let files = walkCache.get(cacheKey);
	if (!files) {
		files = allAgentFiles(cwd, agentDir);
		if (walkCache.size >= 512) walkCache.clear();
		walkCache.set(cacheKey, files);
	}
	const normalizedName = name.trim().toLowerCase();
	if (normalizedName) {
		for (const file of files) {
			const stem = file.path ? basename(file.path, ".md").toLowerCase() : "";
			if (stem === normalizedName && file.description?.trim()) return file;
		}
	}

	let best: AgentFileInfo | undefined;
	let bestScore = 0;
	for (const file of files) {
		const s = scoreAgentDescription(query, file.description ?? "");
		if (s > 0 && s > bestScore) {
			best = file;
			bestScore = s;
		}
	}
	return best;
}
