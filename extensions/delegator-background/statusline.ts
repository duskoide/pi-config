import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { terminalSafe } from "./renderers.ts";
import { shortJobId } from "./identity.ts";

interface StatusJob {
	readonly taskId: string;
	readonly agent: string;
	readonly status: string;
	readonly ready: boolean;
	readonly retrieved: boolean;
	readonly lastTool?: string;
}
function compact(text: string, width: number): string {
	return truncateToWidth(terminalSafe(text).replace(/\s+/gu, " ").trim(), width);
}

/** Plain, theme-independent text for Pi's footer/Powerline custom item. */
export function agentStatusline(jobs: readonly StatusJob[], maxWidth = 72): string | undefined {
	const visible = jobs.filter((job) => !job.ready || !job.retrieved);
	if (!visible.length || maxWidth <= 0) return undefined;
	const priority = (job: StatusJob) => job.status === "failed" ? 0 : job.status === "cancelling" ? 1 : !job.ready ? 2 : 3;
	const ordered = [...visible].sort((a, b) => priority(a) - priority(b));
	const counts = new Map<string, number>();
	// Compare rendered names, not raw identifiers: truncation can collapse two
	// distinct agent types into the same visual label.
	for (const job of visible) {
		const name = compact(job.agent, 10);
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const taskIds = visible.map((job) => job.taskId);
	const entries = ordered.map((job) => {
		const label = compact(job.agent, 10);
		const id = (counts.get(label) ?? 0) > 1 ? `#${shortJobId(job.taskId, taskIds)}` : "";
		const name = `${label}${id}`;
		const state = job.status === "running" ? job.lastTool ? compact(job.lastTool, 8) : "..."
			: job.status === "completed" ? "done"
				: job.status === "failed" ? "error"
					: job.status === "cancelling" ? "stopping" : "cancelled";
		return `${name}:${state}`;
	});
	const shown: string[] = [];
	for (const entry of entries.slice(0, 8)) {
		const remaining = entries.length - shown.length - 1;
		const candidate = [...shown, entry].join(" · ") + (remaining ? ` +${remaining}` : "");
		if (visibleWidth(candidate) > maxWidth) break;
		shown.push(entry);
	}
	if (shown.length) return shown.join(" · ") + (entries.length > shown.length ? ` +${entries.length - shown.length}` : "");
	const running = visible.filter((job) => !job.ready).length;
	return truncateToWidth(`${running} running · ${visible.length - running} unread`, maxWidth);
}

/** A reserved one-line widget gets the real width, independent of footer packing. */
export function agentStatusRow(jobs: readonly StatusJob[], width: number): string | undefined {
	if (width <= 0) return undefined;
	const prefix = width >= 16 ? "Agents · " : "";
	const label = agentStatusline(jobs, width - visibleWidth(prefix));
	return label === undefined ? undefined : truncateToWidth(prefix + label, width);
}
