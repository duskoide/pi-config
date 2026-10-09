import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Delegate children disable ambient extensions; explicitly load Anthropic OAuth compatibility. */
export default async function anthropicAuthDelegateProvider(pi: ExtensionAPI): Promise<void> {
	if (process.env.PI_DELEGATOR_CHILD !== "1") return;
	const root = join(getAgentDir(), "npm/node_modules/@gotgenes/pi-anthropic-auth");
	const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	if (manifest.name !== "@gotgenes/pi-anthropic-auth" || !manifest.pi?.extensions?.includes("./src/index.ts")) {
		throw new Error("Delegate Anthropic auth requires an installed @gotgenes/pi-anthropic-auth with src/index.ts; review its entry point after upgrading.");
	}
	const ext = await import(pathToFileURL(join(root, "src/index.ts")).href);
	if (typeof ext.default !== "function") throw new Error("Installed Anthropic auth package has no extension factory.");
	await ext.default(pi);
}
