import { randomUUID } from "node:crypto";
import type { DelegateOutcome, DelegateProfile, RunOptions } from "./backend.ts";
import { shortJobId } from "./identity.ts";

export const MAX_ACTIVE_DELEGATES = 8;
export const MAX_RETAINED_DELEGATES = 32;
export type JobStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled";
export interface JobInput {
	readonly callId: string;
	readonly profile: DelegateProfile;
	readonly task: string;
	readonly model: string;
	readonly cwd: string;
	readonly notifyOnCompletion: boolean;
	readonly triggerOnCompletion: boolean;
}
interface Job {
	id: string;
	input: JobInput;
	status: JobStatus;
	controller: AbortController;
	completion: Promise<void>;
	startedAt: number;
	endedAt?: number;
	outcome?: DelegateOutcome;
	accepted: boolean;
	startupCancelled: boolean;
	taskPreview: string;
	retrieved: boolean;
	notificationAttempted: boolean;
	notificationError?: string;
	suppressNotification: boolean;
	releaseStartupSignal?: () => void;
	lastTool?: string;
	preview?: string;
	toolCalls: number;
}

export function boundedText(text: string, limit: number, tail = false): { text: string; truncated: boolean } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= limit) return { text, truncated: false };
	let start = tail ? bytes.length - limit : 0;
	let end = tail ? bytes.length : limit;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	for (;;) {
		try { return { text: decoder.decode(bytes.subarray(start, end)), truncated: true }; }
		catch { if (tail) start += 1; else end -= 1; }
	}
}

function normalizeOutcome(value: DelegateOutcome): DelegateOutcome {
	if (!value || typeof value.ok !== "boolean") throw new Error("Delegate runner returned an invalid outcome");
	const cleanup = value.cleanup ? {
		...value.cleanup,
		...(value.cleanup.diagnostic ? { diagnostic: boundedText(value.cleanup.diagnostic, 8192).text } : {}),
	} : undefined;
	const common = {
		durationMs: value.durationMs,
		exitCode: value.exitCode,
		malformedLineCount: value.malformedLineCount,
		...(value.nativeUsage ? { nativeUsage: structuredClone(value.nativeUsage) } : {}),
		...(cleanup ? { cleanup } : {}),
	};
	if (value.ok) {
		const original = value.text ?? "";
		const text = boundedText(original, 50 * 1024);
		return {
			...common, ok: true, text: text.text, truncated: Boolean(value.truncated || text.truncated),
			...(value.originalBytes !== undefined || text.truncated ? { originalBytes: value.originalBytes ?? Buffer.byteLength(original) } : {}),
		};
	}
	const message = boundedText(value.message ?? "Delegate failed", 8192);
	const stderr = boundedText(value.stderr ?? "", 16 * 1024, true);
	return {
		...common, ok: false, code: boundedText(value.code ?? "internal_error", 128).text,
		message: `${message.text}${message.truncated ? "\n[Failure message truncated.]" : ""}`,
		stderr: `${stderr.truncated ? "[Stderr tail truncated.]\n" : ""}${stderr.text}`,
	};
}

/** Session-owned, bounded state. Detached work never uses the parent turn's signal after receipt. */
export class DelegateJobs {
	private readonly jobs = new Map<string, Job>();
	private readonly startingCalls = new Map<string, Job>();
	private closed = false;
	private closing?: Promise<void>;
	private readonly run: (options: RunOptions) => Promise<DelegateOutcome>;
	private readonly observers: {
		onChange?: () => void;
		onComplete?: (job: ReturnType<DelegateJobs["view"]>) => void;
	};
	constructor(run: (options: RunOptions) => Promise<DelegateOutcome>, observers: DelegateJobs["observers"] = {}) {
		this.run = run;
		this.observers = observers;
	}

	private changed(): void {
		if (!this.closed) {
			try { this.observers.onChange?.(); } catch { /* Rendering must not own lifecycle. */ }
		}
	}
	private notify(job: Job): void {
		if (this.closed || !job.accepted || !job.outcome || job.suppressNotification || !job.input.notifyOnCompletion || job.notificationAttempted) return;
		job.notificationAttempted = true;
		try { this.observers.onComplete?.(this.view(job)); }
		catch (error) { job.notificationError = boundedText(String(error), 1024).text; }
	}
	private view(job: Job) {
		return {
			taskId: job.id, shortId: shortJobId(job.id, [...this.jobs.keys()]), agent: job.input.profile.name,
			...(job.input.profile.displayName ? { displayName: job.input.profile.displayName } : {}),
			model: job.input.model, thinking: job.input.profile.thinking, cwd: job.input.cwd,
			status: job.status, ready: job.outcome !== undefined,
			taskPreview: job.taskPreview,
			durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
			toolCalls: job.toolCalls,
			...(job.lastTool ? { lastTool: job.lastTool } : {}),
			...(job.preview ? { preview: job.preview } : {}),
			notifyOnCompletion: job.input.notifyOnCompletion,
			triggerOnCompletion: job.input.triggerOnCompletion,
			retrieved: job.retrieved,
			notificationAttempted: job.notificationAttempted,
			...(job.notificationError ? { notificationError: job.notificationError } : {}),
			...(job.outcome?.code ? { failureCode: job.outcome.code } : {}),
			...(job.outcome?.cleanup?.diagnostic ? { cleanupDiagnostic: job.outcome.cleanup.diagnostic } : {}),
		};
	}
	private get(id: string): Job {
		const job = this.jobs.get(id);
		if (!job) throw new Error(`Unknown background delegate ${id}. Jobs are session-scoped; retrieved results may be evicted when the buffer fills.`);
		return job;
	}

	start(input: JobInput, startupSignal?: AbortSignal) {
		if (this.closed) throw new Error("Background delegate session is shutting down");
		if (startupSignal?.aborted) throw new Error("Delegate launch cancelled before acceptance");
		if (this.startingCalls.has(input.callId)) throw new Error("Duplicate in-flight delegate launch call");
		if (this.list().filter((job) => !job.ready).length >= MAX_ACTIVE_DELEGATES) throw new Error(`At most ${MAX_ACTIVE_DELEGATES} background delegates can run concurrently`);
		if (this.jobs.size >= MAX_RETAINED_DELEGATES) {
			const old = [...this.jobs.values()].find((job) => job.outcome && job.retrieved && !this.startingCalls.has(job.input.callId));
			if (!old) throw new Error(`Background result buffer is full (${MAX_RETAINED_DELEGATES}); retrieve completed results before starting more delegates`);
			this.jobs.delete(old.id);
		}
		const profile = Object.freeze({ ...input.profile, tools: Object.freeze([...input.profile.tools]), skills: Object.freeze([...input.profile.skills]), extensions: Object.freeze([...input.profile.extensions]) });
		const job: Job = {
			id: `del-${randomUUID()}`, input: { ...input, profile },
			status: "running", controller: new AbortController(), completion: Promise.resolve(),
			startedAt: Date.now(), accepted: false, startupCancelled: false, retrieved: false,
			taskPreview: boundedText(input.task.replace(/\s+/gu, " ").trim(), 256).text,
			notificationAttempted: false, suppressNotification: false, toolCalls: 0,
		};
		this.jobs.set(job.id, job);
		this.startingCalls.set(input.callId, job);
		job.completion = Promise.resolve().then(() => this.run({
			profile, task: input.task, cwd: input.cwd, model: input.model,
			signal: job.controller.signal,
			onProgress: (progress) => {
				if (this.closed || job.outcome) return;
				if (progress.type === "tool_start") {
					job.toolCalls += 1;
					job.lastTool = boundedText(progress.toolName ?? "unknown", 128).text;
				}
				if (progress.text) job.preview = boundedText(progress.text.replace(/\s+/gu, " ").trim(), 512).text;
				this.changed();
			},
		})).then(normalizeOutcome).catch((error) => normalizeOutcome({
			ok: false, code: "internal_error", message: error instanceof Error ? error.message : String(error), durationMs: Date.now() - job.startedAt,
		})).then((outcome) => {
			job.outcome = outcome;
			job.endedAt = Date.now();
			job.status = outcome.ok ? "completed" : outcome.code === "cancelled" ? "cancelled" : "failed";
			this.changed();
			this.notify(job);
		});
		if (startupSignal) {
			const cancel = () => { job.startupCancelled = true; this.cancel(job.id); };
			startupSignal.addEventListener("abort", cancel, { once: true });
			job.releaseStartupSignal = () => startupSignal.removeEventListener("abort", cancel);
			if (startupSignal.aborted) cancel();
		}
		this.changed();
		return this.view(job);
	}

	/** Called from Pi's tool_result boundary, not merely when execute() returns. */
	acknowledge(callId: string, success: boolean): void {
		const job = this.startingCalls.get(callId);
		if (!job) return;
		this.startingCalls.delete(callId);
		job.releaseStartupSignal?.();
		job.releaseStartupSignal = undefined;
		if (success && !job.startupCancelled) job.accepted = true;
		else { job.suppressNotification = true; this.cancel(job.id); }
		this.notify(job);
	}
	get isClosed(): boolean { return this.closed; }
	list() { return [...this.jobs.values()].map((job) => this.view(job)); }
	result(id: string) {
		if (this.closed) throw new Error("Background delegate results belonged to a closed session");
		const job = this.get(id);
		const firstRead = job.outcome !== undefined && !job.retrieved;
		if (job.outcome) job.retrieved = true;
		this.changed();
		return {
			...this.view(job),
			...(job.outcome ? { outcome: structuredClone(job.outcome) } : {}),
			...(firstRead && job.outcome?.nativeUsage ? { usage: structuredClone(job.outcome.nativeUsage) } : {}),
		};
	}
	cancel(id: string) {
		const job = this.get(id);
		const requested = job.outcome === undefined && !job.controller.signal.aborted;
		if (requested) { job.status = "cancelling"; job.controller.abort(); this.changed(); }
		return { ...this.view(job), cancellationRequested: requested };
	}
	async close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		for (const job of this.jobs.values()) {
			job.releaseStartupSignal?.();
			if (!job.outcome) { job.status = "cancelling"; job.controller.abort(); }
		}
		this.startingCalls.clear();
		this.closing = Promise.allSettled([...this.jobs.values()].map((job) => job.completion)).then(() => undefined);
		return this.closing;
	}
}
