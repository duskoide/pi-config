import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DELEGATOR_VERSION = "0.6.6";
export const CHILD_MARKER = "PI_DELEGATOR_CHILD";
export interface DelegateProfile {
	readonly name: string;
	readonly displayName?: string;
	readonly description: string;
	readonly model: string | null;
	readonly thinking: string;
	readonly tools: readonly string[];
	readonly skills: readonly string[];
	readonly extensions: readonly string[];
	readonly systemPrompt: string;
	readonly timeoutMs: number | null;
}
export type Profiles = Readonly<Record<string, DelegateProfile>>;
export interface DelegateOutcome {
	readonly ok: boolean;
	readonly text?: string;
	readonly code?: string;
	readonly message?: string;
	readonly stderr?: string;
	readonly durationMs: number;
	readonly truncated?: boolean;
	readonly originalBytes?: number;
	readonly exitCode?: number | null;
	readonly malformedLineCount?: number;
	readonly nativeUsage?: Usage;
	readonly cleanup?: {
		readonly forced: boolean;
		readonly termSent: boolean;
		readonly killSent: boolean;
		readonly processExited: boolean;
		readonly pipesClosed: boolean;
		readonly diagnostic?: string;
	};
}
export interface RunOptions {
	readonly profile: DelegateProfile;
	readonly task: string;
	readonly cwd: string;
	readonly model: string;
	readonly signal: AbortSignal;
	readonly onProgress: (progress: { type: string; toolName?: string; text?: string }) => void;
}
export interface DelegateBackend {
	loadProfiles(path?: string, lowerPrecedence?: Profiles): Profiles;
	projectConfigPath(cwd: string): string;
	normalizeModel(value: unknown, label: string): string;
	isSupportedPlatform(platform: NodeJS.Platform): boolean;
	run(options: RunOptions): Promise<DelegateOutcome>;
}

/** Intentionally version-pinned: reuse cleanup/protocol code, never patch Pi's npm cache. */
export async function loadDelegateBackend(): Promise<DelegateBackend> {
	const root = join(getAgentDir(), "npm/node_modules/@mostlyworks/pi-delegator");
	const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	if (manifest.name !== "@mostlyworks/pi-delegator" || manifest.version !== DELEGATOR_VERSION) {
		throw new Error(`Background delegates require @mostlyworks/pi-delegator@${DELEGATOR_VERSION}; review the bridge before upgrading.`);
	}
	const [config, runner] = await Promise.all([
		import(pathToFileURL(join(root, "src/config.ts")).href),
		import(pathToFileURL(join(root, "src/runner.ts")).href),
	]);
	if ([config.loadDelegateProfiles, config.getProjectDelegateConfigPath, config.normalizeModelSelector, runner.runDelegate, runner.isSupportedPlatform].some((method) => typeof method !== "function")) {
		throw new Error("Installed pi-delegator does not expose the expected pinned profile/runner API.");
	}
	return {
		loadProfiles: config.loadDelegateProfiles,
		projectConfigPath: config.getProjectDelegateConfigPath,
		normalizeModel: config.normalizeModelSelector,
		isSupportedPlatform: runner.isSupportedPlatform,
		run: runner.runDelegate,
	};
}
