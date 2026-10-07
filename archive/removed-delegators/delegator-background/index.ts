import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { CHILD_MARKER, loadDelegateBackend, type DelegateBackend, type Profiles } from "./backend.ts";
import { DelegateJobs, MAX_ACTIVE_DELEGATES, MAX_RETAINED_DELEGATES } from "./jobs.ts";
import { backgroundRenderers } from "./renderers.ts";
import { agentStatusRow } from "./statusline.ts";

const TOOL_NAMES = ["delegate_start", "delegate_result", "delegate_cancel"] as const;
const MAX_TASK_BYTES = 32 * 1024;
const SELF = fileURLToPath(import.meta.url);

function validObject(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown field ${key}`);
}
function taskId(value: unknown): string {
	if (typeof value !== "string" || !/^del-[0-9a-f-]{36}$/u.test(value)) throw new Error("Expected the full background delegate taskId returned by delegate_start");
	return value;
}
async function assertNoRecursion(profiles: Profiles): Promise<void> {
	const self = await stat(SELF);
	for (const profile of Object.values(profiles)) {
		if (profile.tools.some((tool) => tool === "delegate" || TOOL_NAMES.includes(tool as (typeof TOOL_NAMES)[number]))) {
			throw new Error(`Profile ${profile.name} may not enable nested delegation tools`);
		}
		for (const path of profile.extensions) {
			const identity = await stat(path);
			if (identity.dev === self.dev && identity.ino === self.ino) throw new Error(`Profile ${profile.name} may not load the background delegation extension`);
		}
	}
}

/** Exported separately so lifecycle tests can supply a controlled runner without paid calls. */
export function registerBackgroundDelegation(pi: ExtensionAPI, backend: DelegateBackend): void {
	if (process.env[CHILD_MARKER] === "1") return;
	const userProfiles = backend.loadProfiles();
	let jobs: DelegateJobs | undefined;
	let teardown: Promise<void> | undefined;

	pi.on("tool_result", (event) => {
		if (event.toolName === "delegate_start") jobs?.acknowledge(event.toolCallId, !event.isError);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!teardown) {
			let finished!: () => void;
			let failed!: (error: unknown) => void;
			// Publish the shared pending promise before aborting: even reentrant or
			// overlapping shutdown/reload must await the same cleanup drain.
			teardown = new Promise<void>((resolve, reject) => { finished = resolve; failed = reject; });
			const closing = jobs;
			jobs = undefined;
			void (async () => {
				if (closing) {
					await closing.close();
					for (const job of closing.list()) {
						if (job.cleanupDiagnostic || job.failureCode === "cleanup_failed") ctx.ui.notify(`Background delegate ${job.taskId} cleanup warning: ${job.cleanupDiagnostic ?? "cleanup could not be verified"}`, "warning");
					}
				}
				ctx.ui.setWidget("delegators", undefined);
				ctx.ui.setStatus("delegators", undefined);
			})().then(finished, failed);
		}
		await teardown;
	});
	pi.on("session_start", async (_event, ctx) => {
		await teardown;
		await jobs?.close();
		teardown = undefined;
		const profiles = ctx.isProjectTrusted() ? backend.loadProfiles(backend.projectConfigPath(ctx.cwd), userProfiles) : userProfiles;
		await assertNoRecursion(profiles);
		let refreshAgentRow = () => {};
		const group = new DelegateJobs((options) => backend.run(options), {
			onChange: () => refreshAgentRow(),
			onComplete: (job) => pi.sendMessage({
				customType: "delegator-background-notification", display: false, details: job,
				content: `Background delegate ${job.taskId} (${job.agent}) ${job.status}. Retrieve the terminal result once with delegate_result({"taskId":"${job.taskId}"}); do not poll or reconfirm status. This is completed delegation, not proof the requested task passed. Results are session-scoped.`,
			}, { deliverAs: "followUp", triggerTurn: job.triggerOnCompletion }),
		});
		jobs = group;
		// Own a single responsive row rather than an indivisible footer segment,
		// which Powerline may drop when earlier segments consume the row budget.
		ctx.ui.setStatus("delegators", undefined);
		ctx.ui.setWidget("delegators", (tui, theme) => {
			refreshAgentRow = () => tui.requestRender();
			return {
				render(width: number) {
					const label = agentStatusRow(group.list(), width);
					return label === undefined ? [] : [theme.fg("accent", label)];
				},
				invalidate() {},
			};
		}, { placement: "belowEditor" });
		registerTools(pi, backend, profiles, group);
	});
}

function registerTools(pi: ExtensionAPI, backend: DelegateBackend, profiles: Profiles, group: DelegateJobs): void {
	const names = Object.keys(profiles);
	const agentSchema = names.length ? Type.Union(names.map((name) => Type.Literal(name))) : Type.Never();
	const parameters = Type.Object({
		agent: agentSchema,
		task: Type.String({ minLength: 1, maxLength: MAX_TASK_BYTES, description: "Focused, self-contained task; no parent conversation is copied" }),
		model: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Pi model selector; overrides profile model, then active parent model" })),
		cwd: Type.Optional(Type.String({ minLength: 1, description: "Existing directory; relative paths resolve from the parent cwd" })),
		notifyOnCompletion: Type.Optional(Type.Boolean({ description: "Send a completion notification (default true)" })),
		triggerOnCompletion: Type.Optional(Type.Boolean({ description: "Wake a follow-up model turn on completion (default follows notifyOnCompletion)" })),
	}, { additionalProperties: false });
	pi.registerTool({
		name: "delegate_start", label: "Start background delegate",
		exposure: names.length ? "direct" : "hidden",
		description: `Start one profile-based Pi subprocess without waiting for its answer. Profiles: ${names.join(", ") || "none enabled"}. Same permissions and thinking as foreground delegate. Up to ${MAX_ACTIVE_DELEGATES} concurrent jobs; results are session-scoped.`,
		promptSnippet: "Start a focused delegate in the background and continue independent parent work",
		promptGuidelines: [
			"Use foreground delegate when its answer is needed before continuing; use delegate_start when independent work can run while the main session continues.",
			`When authorized work splits into independent subtasks, launch multiple background agents in parallel: issue several delegate_start calls in one turn. Each returns a taskId immediately without waiting for completion; up to ${MAX_ACTIVE_DELEGATES} jobs may run concurrently. Keep trivial/tightly coupled tasks local and respect requests not to delegate.`,

			"Default completion notifications wake a follow-up turn. Continue useful independent work, otherwise yield; do not poll delegate_result while waiting.",
			"Retrieve each terminal delegate_result once after notification. Running results are point-in-time, never a waiting primitive.",
			"Agent progress is shown in the statusline. Avoid routine agent-by-agent launch/completion narration in the chat; report useful results or important blockers when relevant.",
			"Concurrent workers and the parent must own disjoint files or separate worktrees. No automatic worktree or sandbox is created.",
			"Profiles own tools, prompts, thinking and optional deadlines. Background jobs do not inherit ambient extensions, skills, or the parent conversation.",
		],
		parameters,
		...backgroundRenderers("Start background delegate", "start"),
		async execute(callId, params, signal, _onUpdate, ctx) {
			validObject(params, ["agent", "task", "model", "cwd", "notifyOnCompletion", "triggerOnCompletion"]);
			if (signal?.aborted) throw new Error("Delegate launch cancelled");
			if (!backend.isSupportedPlatform(process.platform)) throw new Error("Background delegate process cleanup is supported only on Linux/macOS");
			if (typeof params.agent !== "string" || !Object.hasOwn(profiles, params.agent)) throw new Error("Unknown or disabled delegate profile");
			if (typeof params.task !== "string" || !params.task.trim() || Buffer.byteLength(params.task, "utf8") > MAX_TASK_BYTES) throw new Error(`Delegate task must be nonblank and at most ${MAX_TASK_BYTES} UTF-8 bytes`);
			if (params.cwd !== undefined && (typeof params.cwd !== "string" || !params.cwd.trim())) throw new Error("Delegate cwd must be a nonblank path");
			for (const key of ["notifyOnCompletion", "triggerOnCompletion"]) if (params[key] !== undefined && typeof params[key] !== "boolean") throw new Error(`${key} must be boolean`);
			const profile = profiles[params.agent]!;
			const inherited = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const selected = params.model !== undefined ? params.model : profile.model ?? inherited;
			if (selected === undefined) throw new Error("Choose a model explicitly, configure the profile, or select a parent model first");
			const model = backend.normalizeModel(selected, "Background delegate model");
			const cwd = resolve(ctx.cwd, params.cwd === undefined ? "." : params.cwd as string);
			if (!(await stat(cwd)).isDirectory()) throw new Error(`Delegate cwd is not a directory: ${cwd}`);
			const notifyOnCompletion = params.notifyOnCompletion === undefined ? true : params.notifyOnCompletion as boolean;
			const triggerOnCompletion = params.triggerOnCompletion === undefined ? notifyOnCompletion : params.triggerOnCompletion as boolean;
			if (triggerOnCompletion && !notifyOnCompletion) throw new Error("triggerOnCompletion requires notifyOnCompletion");
			if (signal?.aborted) throw new Error("Delegate launch cancelled before acceptance");
			const receipt = group.start({ callId, profile, task: params.task, model, cwd, notifyOnCompletion, triggerOnCompletion }, signal);
			return {
				content: [{ type: "text", text: `Started background delegate ${receipt.taskId} (${receipt.agent}). The main session can continue.\n${JSON.stringify(receipt, null, 2)}\nUse delegate_result after completion${notifyOnCompletion ? " notification" : "; automatic notifications are disabled"}. Jobs stop on reload, session replacement, or orderly shutdown.` }],
				details: receipt,
			};
		},
	});

	pi.registerTool({
		name: "delegate_result", label: "Background delegate result",
		description: "Read a background delegate result without waiting, or omit taskId to list this session's jobs. Default notifications identify completion; do not poll. Child usage is reported once on the first terminal result retrieval, including failures/cancellation.",
		parameters: Type.Object({ taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })) }, { additionalProperties: false }),
		...backgroundRenderers("Background delegate result"),
		async execute(_callId, params) {
			if (group.isClosed) throw new Error("Background delegate results belonged to a closed session");
			validObject(params, ["taskId"]);
			if (params.taskId === undefined) {
				const listing = { jobs: group.list(), maxActive: MAX_ACTIVE_DELEGATES, maxRetained: MAX_RETAINED_DELEGATES };
				return { content: [{ type: "text", text: JSON.stringify(listing, null, 2) }], details: listing };
			}
			const result = group.result(taskId(params.taskId));
			let text: string;
			if (!result.ready) text = `Background delegate ${result.taskId} is ${result.status}. Not ready; this call did not wait. Await its notification and do not poll.`;
			else if (result.outcome?.ok) text = `Background delegate ${result.taskId} (${result.agent}) completed.\n${result.outcome.text ?? ""}`;
			else text = `Background delegate ${result.taskId} ${result.status} [${result.outcome?.code}]: ${result.outcome?.message}\n${result.outcome?.stderr ? `Stderr tail:\n${result.outcome.stderr}\n` : ""}${result.outcome?.cleanup?.diagnostic ? `Cleanup diagnostic: ${result.outcome.cleanup.diagnostic}` : ""}`;
			const { outcome, usage, ...metadata } = result;
			const evidence = { ...metadata, ...(outcome ? { cleanup: outcome.cleanup, truncated: outcome.truncated, originalBytes: outcome.originalBytes } : {}) };
			text = `${JSON.stringify(evidence, null, 2)}\n\n${text}`;
			return { content: [{ type: "text", text }], details: result, ...(usage ? { usage } : {}) };
		},
	});
	pi.registerTool({
		name: "delegate_cancel", label: "Cancel background delegate",
		description: "Request cancellation of one background delegate. Returns immediately; wait for terminal notification/result to verify process cleanup. Already-finished jobs are unchanged.",
		parameters: Type.Object({ taskId: Type.String({ minLength: 1, maxLength: 80 }) }, { additionalProperties: false }),
		...backgroundRenderers("Cancel background delegate", "cancel"),
		async execute(_callId, params) {
			if (group.isClosed) throw new Error("Background delegates belonged to a closed session");
			validObject(params, ["taskId"]);
			const result = group.cancel(taskId(params.taskId));
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});
}

export default async function backgroundDelegator(pi: ExtensionAPI): Promise<void> {
	if (process.env[CHILD_MARKER] === "1") return;
	registerBackgroundDelegation(pi, await loadDelegateBackend());
}
