import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Delegate children disable ambient extensions; explicitly load their Qoder provider. */
export default async function qoderDelegateProvider(pi: ExtensionAPI): Promise<void> {
	if (process.env.PI_DELEGATOR_CHILD !== "1") return;
	const root = join(getAgentDir(), "npm/node_modules/pi-provider-qoder");
	const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	if (manifest.name !== "pi-provider-qoder" || !manifest.pi?.extensions?.includes("./dist/index.js")) {
		throw new Error("Delegate Qoder provider requires an installed pi-provider-qoder with dist/index.js; review its entry point after upgrading.");
	}
	const provider = await import(pathToFileURL(join(root, "dist/index.js")).href);
	if (typeof provider.default !== "function") throw new Error("Installed Qoder provider has no extension factory.");
	await provider.default(pi);
}
