import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requestedWebToolNames } from "./tool-selection.ts";

type ToolRegistrar = (pi: ExtensionAPI) => void;

function captureTool(registrar: ToolRegistrar, expectedName: string): ToolDefinition {
	let captured: ToolDefinition | undefined;
	const collector = {
		registerTool(tool: ToolDefinition) {
			if (tool.name !== expectedName) throw new Error(`Unexpected child web tool: ${tool.name}`);
			if (captured) throw new Error(`Child web tool registered more than once: ${expectedName}`);
			captured = tool;
		},
	} as unknown as ExtensionAPI;

	registrar(collector);
	if (!captured) throw new Error(`Child web tool was not registered: ${expectedName}`);
	return captured;
}

/**
 * Build only the requested web tools. The dynamic import keeps web-provider
 * configuration out of children that do not request network access.
 */
export async function createRequestedWebTools(tools: readonly string[]): Promise<ToolDefinition[]> {
	const requested = requestedWebToolNames(tools);
	if (requested.length === 0) return [];

	const { registerWebFetchTool, registerWebSearchTool } = await import("@juicesharp/rpiv-web-tools/index.ts");
	const definitions: ToolDefinition[] = [];
	if (requested.includes("web_search")) definitions.push(captureTool(registerWebSearchTool, "web_search"));
	if (requested.includes("web_fetch")) definitions.push(captureTool(registerWebFetchTool, "web_fetch"));
	return definitions;
}
