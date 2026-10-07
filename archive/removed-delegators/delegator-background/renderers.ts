import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { boundedText } from "./jobs.ts";

// Same terminal-safety policy as the pinned runner (upstream MIT license is
// retained in .pi/agent/delegator/LICENSE). Model-facing content is unchanged.
export function terminalSafe(text: string): string {
	return stripVTControlCharacters(text).replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu, "");
}

function empty() { return { render: (_width: number): string[] => [], invalidate() {} }; }
function oneLine(text: string, theme: Theme, color: "toolOutput" | "error" = "toolOutput") {
	const safe = terminalSafe(text).replace(/\s+/gu, " ").trim();
	return {
		render(width: number) { return width > 0 ? [theme.fg(color, truncateToWidth(safe, width))] : []; },
		invalidate() {},
	};
}
function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function backgroundRenderers(label: string, operation: "start" | "result" | "cancel" = "result") {
	return {
		renderShell: "self" as const,
		renderCall(args: Record<string, unknown> = {}, theme: Theme, context?: { expanded: boolean }) {
			if (!context?.expanded) return empty();
			return new Text(`${theme.fg("toolTitle", theme.bold(label))}\n${terminalSafe(JSON.stringify(args, null, 2))}`, 0, 0);
		},
		renderResult(
			result: { content: readonly { type: string; text?: string }[]; details?: unknown; isError?: boolean },
			options: { expanded: boolean }, theme: Theme, context?: { isError: boolean },
		) {
			const full = terminalSafe(result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"));
			if (options.expanded) return new Text(theme.fg("toolOutput", full), 0, 0);
			if (context?.isError || result.isError) return oneLine(`${label}: ${boundedText(full, 512).text}`, theme, "error");
			// Routine lifecycle rows live in the statusline, not the transcript.
			if (operation !== "result") return empty();
			const details = record(result.details);
			if (Array.isArray(details.jobs)) {
				const jobs = details.jobs.map(record);
				return oneLine(`Agents: ${jobs.filter((job) => !job.ready).length} running · ${jobs.filter((job) => job.ready && !job.retrieved).length} unread (expand for details)`, theme);
			}
			if (details.ready === false) return empty();
			const outcome = record(details.outcome);
			const agent = typeof details.agent === "string" ? details.agent : "delegate";
			const id = typeof details.shortId === "string" ? `#${details.shortId}` : typeof details.taskId === "string" ? `#${details.taskId.replace(/^del-/u, "").replace(/-/gu, "")}` : "";
			const state = typeof details.status === "string" ? details.status : "result";
			const report = outcome.ok === false ? outcome.message : outcome.text;
			const preview = boundedText(typeof report === "string" ? report : full, 256).text;
			return oneLine(`${agent}${id} ${state} · ${preview} (expand)`, theme, outcome.ok === false ? "error" : "toolOutput");
		},
	};
}
