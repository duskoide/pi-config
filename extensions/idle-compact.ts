import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Idle auto-compaction.
 *
 * Pi has no idle trigger: compaction starts on a context threshold, `/compact`,
 * or overflow recovery. This extension adds one — after a run settles and the
 * session stays quiet for `idleCompact.minutes`, it triggers Pi's normal
 * compaction path.
 *
 * With pi-vcc installed and `overrideDefaultCompaction: true`, that compaction
 * is handled by pi-vcc (algorithmic summary, no LLM call, `vcc_recall` keeps
 * the folded history searchable).
 *
 * Settings in ~/.pi/agent/settings.json:
 *   "idleCompact": { "enabled": true, "minutes": 10, "minTokens": 50000 }
 */

const DEFAULTS = { enabled: true, minutes: 10, minTokens: 50000 } as const;

type IdleCompactConfig = { enabled: boolean; minutes: number; minTokens: number };

function readConfig(pi: ExtensionAPI): IdleCompactConfig {
	const getSettings = (pi as { getSettings?: () => Record<string, unknown> }).getSettings;
	const settings = typeof getSettings === "function" ? getSettings.call(pi) : {};
	const raw = settings?.idleCompact;
	const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const number = (key: string, fallback: number, min: number): number => {
		const candidate = value[key];
		return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= min ? candidate : fallback;
	};
	return {
		enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULTS.enabled,
		minutes: number("minutes", DEFAULTS.minutes, 0.1),
		minTokens: number("minTokens", DEFAULTS.minTokens, 0),
	};
}

function stopTimer(timer: ReturnType<typeof setTimeout> | null): null {
	if (timer !== null) clearTimeout(timer);
	return null;
}

function hasEnoughContext(ctx: ExtensionContext, minTokens: number): boolean {
	// tokens is null right after a compaction, before the next model response.
	const { tokens } = ctx.getContextUsage();
	return typeof tokens === "number" && tokens >= minTokens;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	try {
		ctx.ui.notify(message, level);
	} catch {
		// Notifications are best-effort (headless or torn-down runtime).
	}
}

const NOTHING_TO_DO = /Nothing to compact|Already compacted|Compaction cancelled/i;

function compactNow(ctx: ExtensionContext, config: IdleCompactConfig): void {
	try {
		// Re-check at fire time: a prompt may have started after the timer was armed.
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		if (!hasEnoughContext(ctx, config.minTokens)) return;
		notify(ctx, `Session idle for ${config.minutes} min — compacting`, "info");
		ctx.compact({
			onError: (error: Error) => {
				if (!NOTHING_TO_DO.test(error?.message ?? "")) {
					notify(ctx, `Idle compaction failed: ${error.message}`, "error");
				}
			},
		});
	} catch {
		// The runtime was replaced (reload, /new, /resume, fork): nothing to do.
	}
}

export default function idleCompact(pi: ExtensionAPI): void {
	// Per-runtime state: two runtimes can share this process (subagents, delegator).
	let timer: ReturnType<typeof setTimeout> | null = null;
	let unsubscribeTerminalInput: (() => void) | undefined;

	pi.on("agent_settled", (_event, ctx) => {
		timer = stopTimer(timer);
		const config = readConfig(pi);
		// Headless runs must not be kept alive by a pending timer.
		if (!config.enabled || !ctx.hasUI) return;
		// Nothing worth compacting yet; the next settle re-checks.
		if (!hasEnoughContext(ctx, config.minTokens)) return;
		timer = setTimeout(() => {
			timer = null;
			compactNow(ctx, config);
		}, config.minutes * 60_000);
		(timer as { unref?: () => void }).unref?.();
	});

	pi.on("agent_start", () => {
		timer = stopTimer(timer);
	});

	pi.on("input", () => {
		timer = stopTimer(timer);
		return undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		timer = stopTimer(timer);
		if (!ctx.hasUI) return;
		// `input` only fires on submit; ten minutes spent drafting is still activity.
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = ctx.ui.onTerminalInput(() => {
			timer = stopTimer(timer);
			return undefined;
		});
	});

	pi.on("session_shutdown", () => {
		timer = stopTimer(timer);
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
	});
}
