/**
 * Custom Providers — add any model provider to pi with just a name, base URL,
 * and API key. Model names are fetched automatically from the provider's
 * `/models` endpoint (OpenAI-compatible), so newly added providers show up in
 * `/model` and `pi --list-models` without hand-writing model definitions.
 *
 * Works with OpenAI-compatible servers (OpenAI, OpenRouter, Ollama, LM Studio,
 * vLLM, llama.cpp, Together, Groq, ...) and, via the `api` field, with
 * Anthropic-compatible, OpenAI Responses, and Google endpoints.
 *
 * ── Commands ──────────────────────────────────────────────────────────────
 *   /custom-provider add                    interactive wizard (name, URL, key)
 *   /custom-provider add <name> <url> [key] non-interactive (api = openai-completions)
 *   /custom-provider list                   show configured providers + model counts
 *   /custom-provider remove <name>          remove a provider
 *   /custom-provider refresh [name]         re-fetch model lists (all if no name)
 *
 * ── Config ────────────────────────────────────────────────────────────────
 * Stored in {agent dir}/custom-providers.json (created on first save):
 *
 *   {
 *     "providers": [
 *       {
 *         "name": "my-llm",                       // provider id (used in /model)
 *         "displayName": "My LLM",                // optional friendly name
 *         "baseUrl": "https://api.example.com/v1",
 *         "apiKey": "$MY_LLM_KEY",                // literal or $ENV_VAR; omit for keyless local servers
 *         "api": "openai-completions",            // openai-completions | anthropic-messages |
 *                                                 // openai-responses | google-generative-ai
 *         "contextWindow": 128000,                // optional defaults for fetched models
 *         "maxTokens": -1,                        // -1 = unbounded: no client cap, server limit wins
 *         "fetchModels": true                     // set false to skip startup fetch
 *       }
 *     ]
 *   }
 *
 * The file lives in the agent dir (not the repo) because it may contain API
 * keys; use `$ENV_VAR` references instead of literal keys when possible.
 *
 * Install: place this file in ~/.pi/agent/extensions/ (or .pi/extensions/)
 * and restart pi, or run /reload.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// =============================================================================
// Types
// =============================================================================

interface StoredProvider {
	/** Provider id (slug, used as `provider/model` in the picker). */
	name: string;
	/** Optional friendly display name shown in UI such as /login. */
	displayName?: string;
	/** API endpoint URL, e.g. https://api.example.com/v1 */
	baseUrl: string;
	/** API key literal, `$ENV_VAR`, or `${ENV_VAR}`. Omit for keyless servers. */
	apiKey?: string;
	/** Streaming API implementation. Defaults to "openai-completions". */
	api?: string;
	/** Default context window for fetched models. */
	contextWindow?: number;
	/** Default max output tokens for fetched models. */
	maxTokens?: number;
	/** Fetch model names from {baseUrl}/models at startup. Default true. */
	fetchModels?: boolean;
}

interface ConfigFile {
	version: number;
	providers: StoredProvider[];
}

interface FetchedModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
}

// =============================================================================
// Config file handling
// =============================================================================

const CONFIG_VERSION = 1;
const FETCH_TIMEOUT_MS = 10_000;

function getConfigPath(): string {
	return join(getAgentDir(), "custom-providers.json");
}

async function loadConfig(): Promise<ConfigFile> {
	try {
		const raw = await readFile(getConfigPath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<ConfigFile>;
		return {
			version: CONFIG_VERSION,
			providers: Array.isArray(parsed.providers) ? parsed.providers : [],
		};
	} catch {
		return { version: CONFIG_VERSION, providers: [] };
	}
}

async function saveConfig(cfg: ConfigFile): Promise<void> {
	const path = getConfigPath();
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
	await rename(tmp, path);
}

function readConfiguredNames(): string[] {
	try {
		const parsed = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Partial<ConfigFile>;
		return Array.isArray(parsed.providers)
			? parsed.providers.map((p) => p.name).filter((n): n is string => typeof n === "string")
			: [];
	} catch {
		return [];
	}
}

// =============================================================================
// Helpers
// =============================================================================

/** Slugify a provider name into a valid provider id. */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Resolve a literal or `$ENV_VAR` / `${ENV_VAR}` apiKey value. */
export function resolveKey(value: string | undefined): string {
	if (!value) return "";
	let v = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? "");
	v = v.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => process.env[name] ?? "");
	return v;
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Parse an OpenAI-style `/models` payload into a sorted, deduped model list. */
export function parseModelList(payload: unknown): FetchedModel[] {
	let list: unknown[] = [];
	if (Array.isArray(payload)) {
		list = payload;
	} else if (payload && typeof payload === "object") {
		const p = payload as Record<string, unknown>;
		if (Array.isArray(p.data)) list = p.data;
		else if (Array.isArray(p.models)) list = p.models;
	}

	const out: FetchedModel[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const m = item as Record<string, unknown>;
		const id =
			typeof m.id === "string"
				? m.id
				: typeof m.name === "string"
					? m.name
					: typeof m.model === "string"
						? m.model
						: undefined;
		if (!id) continue;
		out.push({
			id,
			name: typeof m.name === "string" && m.name !== id ? m.name : undefined,
			contextWindow: num(m.context_window) ?? num(m.context_length),
			maxTokens: num(m.max_tokens) ?? num(m.max_completion_tokens),
		});
	}

	const seen = new Set<string>();
	const deduped = out.filter((m) => {
		if (seen.has(m.id)) return false;
		seen.add(m.id);
		return true;
	});
	deduped.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: "base" }));
	return deduped;
}

function toModelConfig(sp: StoredProvider, m: FetchedModel): ProviderModelConfig {
	return {
		id: m.id,
		name: m.name ?? m.id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow ?? sp.contextWindow ?? 128_000,
		// -1 = unbounded: don't send a client-side cap, let the server's own
		// limit apply (e.g. llama.cpp -n -1). Prevents silent 8k truncation.
		maxTokens: m.maxTokens ?? sp.maxTokens ?? -1,
	};
}

/**
 * Fetch the model catalog from an OpenAI-compatible `{baseUrl}/models`
 * endpoint. Uses an Authorization: Bearer header when an apiKey is configured.
 */
export async function fetchModels(
	sp: StoredProvider,
	outerSignal?: AbortSignal,
): Promise<ProviderModelConfig[]> {
	const base = sp.baseUrl.replace(/\/+$/, "");
	const key = resolveKey(sp.apiKey);

	const headers: Record<string, string> = { Accept: "application/json" };
	if (key) headers.Authorization = `Bearer ${key}`;

	const controller = new AbortController();
	const onAbort = () => controller.abort();
	outerSignal?.addEventListener("abort", onAbort, { once: true });
	if (outerSignal?.aborted) controller.abort();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const res = await fetch(`${base}/models`, { headers, signal: controller.signal });
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
		const payload: unknown = await res.json();
		const models = parseModelList(payload);
		if (models.length === 0) throw new Error("server returned no models");
		return models.map((m) => toModelConfig(sp, m));
	} finally {
		clearTimeout(timeout);
		outerSignal?.removeEventListener("abort", onAbort);
	}
}

/** Build the ProviderConfig pi receives, with an on-demand model refresh. */
export function buildProviderConfig(sp: StoredProvider, models: ProviderModelConfig[]): ProviderConfig {
	const config: ProviderConfig = {
		name: sp.displayName ?? sp.name,
		baseUrl: sp.baseUrl,
		api: (sp.api ?? "openai-completions") as ProviderConfig["api"],
		// pi resolves $ENV_VAR refs at request time; a dummy key keeps keyless
		// local servers (Ollama, LM Studio) happy.
		apiKey: sp.apiKey || "local",
		models,
		refreshModels: async () => fetchModels(sp),
	};
	return config;
}

function maskKey(key: string | undefined): string {
	if (!key) return "(none)";
	if (key.startsWith("$")) return key; // env var reference
	if (key.length <= 12) return "••••";
	return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

// =============================================================================
// Commands
// =============================================================================

const API_OPTIONS = [
	"openai-completions — OpenAI-compatible (recommended)",
	"anthropic-messages — Anthropic Messages API",
	"openai-responses — OpenAI Responses API",
	"google-generative-ai — Google Generative AI",
];

function registerCommands(pi: ExtensionAPI) {
	pi.registerCommand("custom-provider", {
		description: "Manage custom model providers (add, list, remove, refresh)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const trimmed = prefix.trim();
			const [sub, partial] = trimmed.split(/\s+/);
			const base: AutocompleteItem[] = ["add", "list", "remove", "refresh"].map((s) => ({
				value: s,
				label: s,
			}));
			if (sub === "remove" || sub === "refresh") {
				const names = readConfiguredNames().filter((n) => n.startsWith(partial ?? ""));
				const items = names.map((n) => ({ value: `${sub} ${n}`, label: n }));
				return items.length > 0 ? items : base;
			}
			const items = base.filter((i) => i.value.startsWith(trimmed));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [sub, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			switch (sub) {
				case "add":
					await addProvider(pi, ctx, rest);
					break;
				case "list":
					await listProviders(ctx);
					break;
				case "remove":
					await removeProvider(pi, ctx, rest[0]);
					break;
				case "refresh":
					await refreshProviders(pi, ctx, rest[0]);
					break;
				default:
					showHelp(ctx);
			}
		},
	});
}

type CmdCtx = ExtensionCommandContext;

async function addProvider(pi: ExtensionAPI, ctx: CmdCtx, rest: string[]) {
	let name = "";
	let baseUrl = "";
	let apiKey = "";
	let api = "openai-completions";

	if (rest.length >= 2) {
		name = rest[0];
		baseUrl = rest[1];
		apiKey = rest[2] ?? "";
	} else {
		if (!ctx.hasUI) {
			ctx.ui.notify("Interactive add needs the TUI. Use: /custom-provider add <name> <baseUrl> [apiKey]", "error");
			return;
		}
		name = ((await ctx.ui.input("Provider name:", "e.g. my-llm")) ?? "").trim();
		if (!name) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		baseUrl = ((await ctx.ui.input("Base URL:", "e.g. https://api.example.com/v1")) ?? "").trim();
		if (!baseUrl) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		apiKey = ((await ctx.ui.input("API key ($ENV_VAR recommended; empty for local servers):", "")) ?? "").trim();
		const chosen = await ctx.ui.select("API type:", API_OPTIONS);
		if (chosen) api = chosen.split(" — ")[0];
	}

	const id = slugify(name);
	if (!id) {
		ctx.ui.notify(`Invalid provider name "${name}"`, "error");
		return;
	}
	if (!/^https?:\/\//i.test(baseUrl)) {
		ctx.ui.notify("Base URL must start with http:// or https://", "error");
		return;
	}

	const cfg = await loadConfig();
	const existing = cfg.providers.find((p) => p.name === id);
	if (existing) {
		const ok = ctx.hasUI ? await ctx.ui.confirm("Overwrite?", `Provider "${id}" already exists. Replace it?`) : true;
		if (!ok) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		cfg.providers = cfg.providers.filter((p) => p.name !== id);
	}

	const sp: StoredProvider = {
		name: id,
		displayName: name !== id ? name : undefined,
		baseUrl,
		apiKey: apiKey || undefined,
		api,
	};
	cfg.providers.push(sp);
	await saveConfig(cfg);

	let models: ProviderModelConfig[] = [];
	let error: string | undefined;
	try {
		models = await fetchModels(sp);
	} catch (e) {
		error = errorMessage(e);
	}

	pi.registerProvider(id, buildProviderConfig(sp, models));
	if (!error) {
		ctx.ui.notify(`Added "${id}" with ${models.length} model(s). Pick one with /model.`, "info");
	} else {
		ctx.ui.notify(
			`Added "${id}" but model fetch failed (${error}). Run /custom-provider refresh ${id} once the server responds.`,
			"warning",
		);
	}
}

async function listProviders(ctx: CmdCtx) {
	const cfg = await loadConfig();
	if (cfg.providers.length === 0) {
		ctx.ui.notify("No custom providers configured. Run /custom-provider add", "info");
		return;
	}
	const lines = cfg.providers.map((p) => {
		let count = "?";
		try {
			const live = ctx.modelRegistry.getProvider(p.name);
			if (live) count = String(live.getModels().length);
		} catch {
			// registry may not expose a live provider; keep "?"
		}
		return (
			`${p.name}${p.displayName && p.displayName !== p.name ? ` (${p.displayName})` : ""}\n` +
			`  url:    ${p.baseUrl}\n` +
			`  api:    ${p.api ?? "openai-completions"}\n` +
			`  key:    ${maskKey(p.apiKey)}\n` +
			`  models: ${count}`
		);
	});
	ctx.ui.notify(lines.join("\n\n"), "info");
}

async function removeProvider(
	pi: ExtensionAPI,
	ctx: CmdCtx,
	name: string | undefined,
) {
	if (!name) {
		ctx.ui.notify("Usage: /custom-provider remove <name>", "error");
		return;
	}
	const cfg = await loadConfig();
	const target = cfg.providers.find((p) => p.name === name);
	if (!target) {
		ctx.ui.notify(`No provider named "${name}". See /custom-provider list`, "error");
		return;
	}
	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm("Remove provider?", `${name} (${target.baseUrl})`);
		if (!ok) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
	}
	cfg.providers = cfg.providers.filter((p) => p.name !== name);
	await saveConfig(cfg);
	pi.unregisterProvider(name);
	ctx.ui.notify(`Removed provider "${name}"`, "info");
}

async function refreshProviders(
	pi: ExtensionAPI,
	ctx: CmdCtx,
	name: string | undefined,
) {
	const cfg = await loadConfig();
	const targets = name ? cfg.providers.filter((p) => p.name === name) : cfg.providers;
	if (targets.length === 0) {
		ctx.ui.notify(name ? `No provider named "${name}"` : "No custom providers configured", "error");
		return;
	}
	let okCount = 0;
	let failCount = 0;
	for (const sp of targets) {
		try {
			const models = await fetchModels(sp);
			pi.registerProvider(sp.name, buildProviderConfig(sp, models));
			okCount++;
		} catch (e) {
			failCount++;
			ctx.ui.notify(`Refresh "${sp.name}" failed: ${errorMessage(e)}`, "warning");
		}
	}
	if (okCount > 0) {
		ctx.ui.notify(`Refreshed ${okCount} provider(s). Use /model to pick a model.`, "info");
	}
	if (failCount > 0 && okCount === 0) {
		ctx.ui.notify(`All ${failCount} refresh(s) failed.`, "error");
	}
}

function showHelp(ctx: CmdCtx) {
	ctx.ui.notify(
		[
			"Custom providers — add providers with name, base URL, API key; models are fetched automatically.",
			"  /custom-provider add                     interactive wizard",
			"  /custom-provider add <name> <url> [key]   non-interactive",
			"  /custom-provider list",
			"  /custom-provider remove <name>",
			"  /custom-provider refresh [name]",
			`Config: ${getConfigPath()}`,
		].join("\n"),
		"info",
	);
}

// =============================================================================
// Extension entry point
// =============================================================================

export default async function (pi: ExtensionAPI) {
	const cfg = await loadConfig();
	const warnings: string[] = [];

	await Promise.all(
		cfg.providers.map(async (sp) => {
			if (!sp.name || !sp.baseUrl) {
				warnings.push("Skipping an invalid custom-provider entry (missing name or baseUrl) in custom-providers.json");
				return;
			}
			let models: ProviderModelConfig[] = [];
			if (sp.fetchModels !== false) {
				try {
					models = await fetchModels(sp);
				} catch (e) {
					warnings.push(`[${sp.name}] model fetch failed: ${errorMessage(e)} — run /custom-provider refresh ${sp.name}`);
				}
			}
			pi.registerProvider(sp.name, buildProviderConfig(sp, models));
		}),
	);

	// Surface startup fetch failures as non-blocking notifications.
	if (warnings.length > 0) {
		pi.on("session_start", (_event, ctx) => {
			if (!ctx.hasUI) return;
			for (const w of warnings) ctx.ui.notify(w, "warning");
		});
	}

	registerCommands(pi);
}
