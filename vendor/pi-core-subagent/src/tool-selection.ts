export const READONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export const WRITE_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
export const WEB_TOOLS = ["web_search", "web_fetch"] as const;
export const WRITE_CAPABLE = ["bash", "edit", "write"] as const;

const KNOWN_TOOLS = new Set<string>([...WRITE_TOOLS, ...WEB_TOOLS]);
const WRITE_TOOL_SET = new Set<string>(WRITE_CAPABLE);

export interface ToolSelectionInput {
	write?: boolean;
	explicitTools?: string[];
	fileTools?: string[];
}

export interface ToolSelection {
	baseTools: string[];
	toolsNote?: string;
}

export function selectChildTools(input: ToolSelectionInput): ToolSelection {
	const allowed = new Set<string>(input.write ? [...WRITE_TOOLS, ...WEB_TOOLS] : [...READONLY_TOOLS, ...WEB_TOOLS]);

	if (input.explicitTools) {
		const unknown = input.explicitTools.filter((tool) => !KNOWN_TOOLS.has(tool));
		if (unknown.length > 0) throw new Error(`Unknown subagent tools: ${unknown.join(", ")}`);

		const writeWithoutPermission = input.explicitTools.filter((tool) => WRITE_TOOL_SET.has(tool) && !input.write);
		if (writeWithoutPermission.length > 0) {
			throw new Error(`Tools require write: true: ${writeWithoutPermission.join(", ")}`);
		}

		return {
			baseTools: [...new Set(input.explicitTools)],
			toolsNote: input.fileTools?.length
				? `explicit tools overrode agent-file tools (${input.fileTools.join(", ")})`
				: undefined,
		};
	}

	// write:true is an explicit request for the standard write toolset. Agent
	// files can narrow normal read-only dispatches, but cannot silently alter it.
	if (input.write) return { baseTools: [...WRITE_TOOLS] };

	const fileTools = input.fileTools?.filter((tool) => allowed.has(tool));
	return { baseTools: fileTools?.length ? [...new Set(fileTools)] : [...READONLY_TOOLS] };
}

export function requestedWebToolNames(tools: readonly string[]): string[] {
	return WEB_TOOLS.filter((tool) => tools.includes(tool));
}
