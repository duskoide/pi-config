import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { chmod, link, lstat, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { inspectDelegatorDocument, MAX_CONFIG_BYTES, readDelegatorConfigText } from "../../scripts/check-pi-delegator.mjs";
import { getFailoverConfigPath, isExplicitFallbackRoute, normalizePrimaryModel, parseFailoverConfigText, readFailoverConfig, readFailoverConfigText } from "./failover-config.ts";
import type { FailoverProfile } from "./failover-config.ts";
import { pickDelegateModel } from "./model-picker.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const INHERIT_MODEL = "@inherit-parent";
export const NO_AUTO_FAILOVER = "@no-automatic-failover";
const PRIMARY_ACTION = "Primary model and thinking";
const FALLBACK_ACTION = "Initial fallback model";
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
interface Profile {
	model: string | null;
	thinking: ThinkingLevel;
	displayName?: string;
	[key: string]: unknown;
}
interface Config { profiles: Record<string, Profile | null>; }
export interface ProfileSource {
	name: string;
	profile: Profile;
	configPath: string;
	scope: "global" | "project";
}

function readConfig(configPath: string): { document: Config; text: string } {
	const text = readDelegatorConfigText(configPath);
	const document = JSON.parse(text) as Config;
	const checked = inspectDelegatorDocument(document, { configPath });
	if (!checked.ok) throw new Error(checked.errors.join("\n"));
	return { document, text };
}

/** Only edit declared complete profiles; never synthesize incomplete bundled overrides. */
export function getEditableProfiles(ctx: Pick<ExtensionCommandContext, "cwd" | "isProjectTrusted">): ProfileSource[] {
	const sources: Array<{ configPath: string; scope: "global" | "project" }> = [
		{ configPath: join(getAgentDir(), "pi-delegator.json"), scope: "global" },
	];
	if (ctx.isProjectTrusted()) sources.push({ configPath: join(ctx.cwd, CONFIG_DIR_NAME, "pi-delegator.json"), scope: "project" });
	const profiles = new Map<string, ProfileSource>();
	for (const source of sources) {
		let document: Config;
		try {
			({ document } = readConfig(source.configPath));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const [name, profile] of Object.entries(document.profiles)) {
			if (profile === null) profiles.delete(name);
			else profiles.set(name, { name, profile, ...source });
		}
	}
	return [...profiles.values()];
}

export function delegateModelChoices(
	models: ReadonlyArray<{ provider: string; id: string }>,
	current: string | null,
): Array<{ value: string; label: string; description?: string }> {
	const routes = [...new Set(models.map((model) => `${model.provider}/${model.id}`))]
		.filter((route) => Buffer.byteLength(route, "utf8") <= 256)
		.sort((a, b) => a === current ? -1 : b === current ? 1 : a.localeCompare(b));
	const choices = [{ value: INHERIT_MODEL, label: "Inherit parent model", description: current === null ? "current" : "model: null" }];
	if (current !== null && !routes.includes(current)) {
		choices.push({ value: current, label: current, description: "current; not in available model snapshot (keep unchanged)" });
	}
	for (const route of routes) choices.push({ value: route, label: route, description: route === current ? "current" : "" });
	return choices;
}

export function delegateFallbackModelChoices(
	models: ReadonlyArray<{ provider: string; id: string }>,
	current: string | null,
): Array<{ value: string; label: string; description?: string }> {
	return [
		{ value: NO_AUTO_FAILOVER, label: "No automatic failover", description: current === null ? "current; disabled" : "disable initial failover" },
		...delegateModelChoices(models, current).slice(1).filter((choice) => isExplicitFallbackRoute(choice.value)),
	];
}

/** Re-read at save time, preserve other fields/profiles, and rename the symlink target. */
export async function saveDelegateSelection(source: ProfileSource, model: string | null, thinking: ThinkingLevel): Promise<boolean> {
	return withFileMutationQueue(source.configPath, async () => {
		const target = await realpath(source.configPath);
		const { document, text } = readConfig(source.configPath);
		const current = Object.hasOwn(document.profiles, source.name) ? document.profiles[source.name] : undefined;
		if (!current || current.model !== source.profile.model || current.thinking !== source.profile.thinking) {
			throw new Error(`${source.name} changed while the dialog was open. Run /delegator-config again.`);
		}
		if (current.model === model && current.thinking === thinking) return false;
		document.profiles[source.name] = { ...current, model, thinking };
		const checked = inspectDelegatorDocument(document, { configPath: source.configPath });
		if (!checked.ok) throw new Error(checked.errors.join("\n"));
		const output = `${JSON.stringify(document, null, 2)}\n`;
		if (Buffer.byteLength(output, "utf8") > MAX_CONFIG_BYTES) throw new Error(`Formatted config exceeds ${MAX_CONFIG_BYTES} UTF-8 bytes; shorten the profile document first.`);
		const mode = (await stat(target)).mode & 0o777;
		const stage = await mkdtemp(join(dirname(target), ".pi-delegator-"));
		try {
			const temporary = join(stage, "config.json");
			await writeFile(temporary, output, { encoding: "utf8", mode });
			if (await realpath(source.configPath) !== target || readDelegatorConfigText(source.configPath) !== text) {
				throw new Error("Configuration changed while saving. Run /delegator-config again.");
			}
			await rename(temporary, target);
		} finally {
			await rm(stage, { recursive: true, force: true });
		}
		return true;
	});
}

function sameFailoverEntry(left: FailoverProfile | undefined, right: FailoverProfile | undefined): boolean {
	return left === undefined || right === undefined ? left === right : left.primary === right.primary && left.fallback === right.fallback;
}

/** Resolve directory aliases even before creation; never replace a dangling file symlink. */
async function failoverTarget(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
		if (entry) throw new Error("Failover config has a dangling symlink; repair its target before saving.");
		return join(await realpath(dirname(path)), basename(path));
	}
}

/** Sidecar-only, selected-entry CAS, queued by canonical target (including missing files). */
export async function saveFailoverSelection(
	source: ProfileSource,
	fallback: string | null,
	expected: FailoverProfile | undefined,
	configPath = getFailoverConfigPath(),
): Promise<boolean> {
	if (source.scope !== "global") throw new Error("Initial fallback is managed only for global profiles; project-specific overrides are not owned by these adapters.");
	const primary = normalizePrimaryModel(source.profile.model);
	if (fallback !== null && !isExplicitFallbackRoute(fallback)) throw new Error("Fallback must be an explicit provider/id route of at most 256 UTF-8 bytes.");
	if (fallback !== null && fallback === primary) throw new Error("Fallback must differ from the profile's primary model.");
	const target = await failoverTarget(configPath);
	return withFileMutationQueue(target, async () => {
		if (await failoverTarget(configPath) !== target) throw new Error("Failover config target changed while saving. Run /delegator-config again.");
		const checkPrimary = () => {
			const { document } = readConfig(source.configPath);
			const current = Object.hasOwn(document.profiles, source.name) ? document.profiles[source.name] : undefined;
			if (!current || current.model !== source.profile.model) throw new Error(`${source.name} primary changed while the dialog was open. Run /delegator-config again.`);
		};
		checkPrimary();
		const text = readFailoverConfigText(configPath);
		const document = text === undefined ? { version: 1 as const, profiles: {} as Record<string, FailoverProfile> } : parseFailoverConfigText(text);
		const current = Object.hasOwn(document.profiles, source.name) ? document.profiles[source.name] : undefined;
		if (!sameFailoverEntry(current, expected)) throw new Error(`${source.name} fallback changed while the dialog was open. Run /delegator-config again.`);
		const selected = fallback === null ? undefined : { primary, fallback };
		if (sameFailoverEntry(current, selected)) return false;
		if (selected === undefined) delete document.profiles[source.name];
		else document.profiles[source.name] = selected;
		const output = `${JSON.stringify(document, null, 2)}\n`;
		parseFailoverConfigText(output);
		const mode = text === undefined ? 0o600 : (await stat(target)).mode & 0o777;
		const stage = await mkdtemp(join(dirname(target), ".delegator-failover-"));
		try {
			const temporary = join(stage, "config.json");
			await writeFile(temporary, output, { encoding: "utf8", mode: 0o600, flag: "wx" });
			await chmod(temporary, mode);
			if (await failoverTarget(configPath) !== target || readFailoverConfigText(configPath) !== text
				|| (text !== undefined && ((await stat(target)).mode & 0o777) !== mode)) {
				throw new Error("Failover configuration changed while saving. Run /delegator-config again.");
			}
			checkPrimary();
			// A new file must not clobber an external creator between the check and commit.
			if (text === undefined) await link(temporary, target);
			else await rename(temporary, target);
		} finally {
			await rm(stage, { recursive: true, force: true });
		}
		return true;
	});
}

async function configureFallback(source: ProfileSource, ctx: ExtensionCommandContext): Promise<void> {
	if (source.scope !== "global") throw new Error("Initial fallback is managed only for global profiles. Project-specific overrides are not owned by the managed foreground/background adapters; no global policy was changed.");
	const configPath = getFailoverConfigPath();
	const document = readFailoverConfig(configPath);
	const expected = Object.hasOwn(document.profiles, source.name) ? document.profiles[source.name] : undefined;
	const current = expected?.fallback ?? null;
	const choices = delegateFallbackModelChoices(await ctx.modelRegistry.getAvailable(), current);
	const selected = await pickDelegateModel(ctx, `${source.name} initial fallback`, choices, current ?? NO_AUTO_FAILOVER);
	if (selected === undefined) return;
	if (!choices.some((choice) => choice.value === selected)) throw new Error("Invalid fallback model selection");
	const fallback = selected === NO_AUTO_FAILOVER ? null : selected;
	const primary = normalizePrimaryModel(source.profile.model);
	if (fallback !== null && fallback === primary) throw new Error("Fallback must differ from the profile's primary model.");
	const confirmed = await ctx.ui.confirm("Save initial fallback?", `${source.name} (global)\nPrimary binding: ${primary ?? "inherit parent model (model: null)"}\nInitial fallback: ${fallback ?? "No automatic failover"}\nFile: ${configPath}\n\nOne provider fallback, only for INITIAL failures before any output or tool use; no mid-run recovery.\nChild-only policy for managed foreground and background agents. No parent model, thinking, authentication, or provider settings are changed or refreshed.\nOnly this sidecar changes; the profile's primary model and thinking stay unchanged. Changing the primary leaves this policy inactive until reconfigured.\nRestart Pi after saving to apply the policy.`);
	if (!confirmed) return;
	const latest = getEditableProfiles(ctx).find((candidate) => candidate.name === source.name);
	if (!latest || latest.scope !== "global" || latest.configPath !== source.configPath) throw new Error("Profile scope changed while the dialog was open; project-specific overrides are not owned by these adapters. No global policy was changed.");
	const changed = await saveFailoverSelection(source, fallback, expected, configPath);
	ctx.ui.notify(changed ? `Saved ${source.name} initial fallback to ${configPath}. Restart Pi to apply; child-only policy, parent model/thinking were not changed.` : `No changes for ${source.name}.`, "info");
}

export default function delegatorConfig(pi: ExtensionAPI): void {
	pi.registerCommand("delegator-config", {
		description: "Interactively configure a delegate profile's model, thinking, or initial fallback (restart Pi to apply)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("/delegator-config requires interactive Pi. Edit pi-delegator.json directly in headless/RPC mode.", "warning");
				return;
			}
			try {
				const profiles = getEditableProfiles(ctx);
				if (!profiles.length) {
					ctx.ui.notify(`No enabled complete profiles to edit. Install the managed ${join(getAgentDir(), "pi-delegator.json")} first.`, "warning");
					return;
				}
				let source: ProfileSource | undefined;
				const tokens = args.trim() ? args.trim().split(/\s+/) : [];
				if (tokens.length > 2 || (tokens.length === 2 && tokens[1] !== "fallback")) throw new Error("Usage: /delegator-config [profile [fallback]]");
				if (tokens.length) {
					source = profiles.find((candidate) => candidate.name === tokens[0]);
					if (!source) throw new Error(`Unknown, disabled, or undeclared profile ${tokens[0]}. Available: ${profiles.map((profile) => profile.name).join(", ")}`);
				} else {
					const labels = profiles.map((candidate) => `${candidate.name} · ${candidate.profile.model ?? "inherit parent"} · ${candidate.profile.thinking} · ${candidate.scope}`);
					const selected = await ctx.ui.select("Delegate profile to configure", labels);
					if (selected === undefined) return;
					source = profiles[labels.indexOf(selected)];
					if (!source) throw new Error("Invalid profile selection");
				}
				const action = tokens[1] === "fallback" ? FALLBACK_ACTION : await ctx.ui.select(`Settings for ${source.name} (${source.scope})`, [PRIMARY_ACTION, FALLBACK_ACTION]);
				if (action === undefined) return;
				if (action === FALLBACK_ACTION) {
					await configureFallback(source, ctx);
					return;
				}
				if (action !== PRIMARY_ACTION) throw new Error("Invalid settings action");
				const choices = delegateModelChoices(await ctx.modelRegistry.getAvailable(), source.profile.model);
				const selectedModel = await pickDelegateModel(ctx, source.name, choices, source.profile.model ?? INHERIT_MODEL);
				if (selectedModel === undefined) return;
				if (!choices.some((choice) => choice.value === selectedModel)) throw new Error("Invalid model selection");
				const model = selectedModel === INHERIT_MODEL ? null : selectedModel;
				const levels = [source.profile.thinking, ...THINKING_LEVELS.filter((level) => level !== source.profile.thinking)];
				const selectedThinking = await ctx.ui.select(`Thinking for ${source.name} (currently ${source.profile.thinking}; Pi clamps unsupported levels)`, [...levels]);
				if (selectedThinking === undefined) return;
				if (!THINKING_LEVELS.includes(selectedThinking as ThinkingLevel)) throw new Error("Invalid thinking selection");
				const confirmed = await ctx.ui.confirm("Save delegate settings?", `${source.name} (${source.scope})\nModel: ${model ?? "inherit parent model"}\nThinking: ${selectedThinking}\nFile: ${source.configPath}\n\nOnly model and thinking change. Provider extensions are not inherited; configure them separately if needed.\nRestart Pi after saving to apply the new profile.`);
				if (!confirmed) return;
				const changed = await saveDelegateSelection(source, model, selectedThinking as ThinkingLevel);
				ctx.ui.notify(changed ? `Saved ${source.name} to ${source.configPath}. Restart Pi to apply; the active parent model/thinking were not changed.` : `No changes for ${source.name}.`, "info");
			} catch (error) {
				ctx.ui.notify(`Delegator config: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
