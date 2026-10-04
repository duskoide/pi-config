import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFailoverConfig } from "../delegator-config/failover-config.ts";

const RETRYABLE_STATUS = new Set([401, 403, 408, 425, 429, 500, 502, 503, 504, 529]);
const QODER_STATUS = /^(?:Qoder API request failed:|Upstream status)\s*(\d{3})(?:\b|:)/i;
const GENERIC_STATUS = /^(\d{3}):/; // Pi AI's explicit HTTP error format, not arbitrary numeric text.
const EXCLUDED = /context[ _-](?:length|window|overflow)|maximum context|too many tokens|token limit exceeded|input is too long|model[ _-]not[ _-]found|unknown model|unsupported model|missing (?:api key|credentials)|no api key|abort|cancel|malformed|invalid json|protocol|cleanup|spawn/i;

/** Fail closed: remote response status, or the Qoder provider's explicit HTTP/SSE error envelope. */
export function eligibleProviderFailure(message: string, responseStatus?: number): boolean {
	if (!message || EXCLUDED.test(message)) return false;
	const explicitStatus = QODER_STATUS.exec(message) ?? GENERIC_STATUS.exec(message);
	const status = explicitStatus ? Number(explicitStatus[1]) : responseStatus;
	return status !== undefined && (RETRYABLE_STATUS.has(status) || (status === 402 && /quota|budget|balance|billing|payment/i.test(message)));
}

function hasOutput(message: any): boolean {
	return Array.isArray(message?.content) && message.content.some((block: any) =>
		block.type === "toolCall" || block.type === "image" ||
		(typeof block.text === "string" && block.text.length > 0) ||
		(typeof block.thinking === "string" && block.thinking.length > 0));
}

/** Loaded only by explicit, per-profile delegate shims; never changes the parent. */
export function registerChildFailover(pi: ExtensionAPI, profile: string, configPath: string): void {
	if (process.env.PI_DELEGATOR_CHILD !== "1") return;
	const policy = readFailoverConfig(configPath).profiles[profile];
	let disabled = false;
	let consumed = false;
	let stopped = false;
	let initialModel = "";
	let fallback: string | undefined;
	let lastError: string | undefined;
	let responseStatus: number | undefined;
	let requestObserved = false;
	let switchedFrom: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "json") { disabled = true; return; }
		initialModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
		if (!policy || !initialModel || (policy.primary !== null && policy.primary !== initialModel) || policy.fallback === initialModel) {
			disabled = true;
			return;
		}
		fallback = policy.fallback;
	});
	pi.on("cache_warming_decision", () => ({ action: "stop" }));
	pi.on("session_shutdown", () => { stopped = true; });
	pi.on("turn_start", () => { responseStatus = undefined; requestObserved = false; });
	pi.on("before_provider_request", () => { responseStatus = undefined; requestObserved = true; });
	pi.on("after_provider_response", (event) => { responseStatus = event.status; });
	const disarm = () => { disabled = true; };
	pi.on("tool_call", disarm);
	pi.on("tool_execution_start", disarm);
	pi.on("tool_result", disarm);
	pi.on("message_start", (event) => { if (event.message.role === "toolResult") disarm(); });
	pi.on("message_update", (event) => {
		const update = event.assistantMessageEvent;
		const contentStarted = update && /^(?:text|thinking|toolcall)_(?:start|delta|end)$/.test(update.type);
		const partial = update && "partial" in update ? update.partial : undefined;
		if (hasOutput(event.message) || contentStarted || hasOutput(partial)) disarm();
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const message = event.message;
		if (hasOutput(message) || message.stopReason !== "error") disarm();
		lastError = message.stopReason === "error" ? message.errorMessage : undefined;
		// Foreground/background receipts name the requested model; make the actual switch explicit in the answer.
		if (switchedFrom && message.stopReason === "stop" && !message.content.some((block) => block.type === "toolCall")) {
			return { message: { ...message, content: [{ type: "text", text: `[Initial agent failover: ${switchedFrom} → ${message.provider}/${message.model}]\n\n` }, ...message.content] } };
		}
	});
	pi.on("agent_before_settle", async (event, ctx) => {
		try {
			if (disabled || consumed || stopped || !fallback || !lastError || event.outcome !== "error" || ctx.signal?.aborted ||
				event.continue || event.entries.length > 0 || event.context.pendingMessages.length > 0 ||
				!eligibleProviderFailure(lastError, responseStatus)) return;
			// Generic HTTP errors require request provenance; Qoder does not emit request hooks.
			if (responseStatus === undefined && !requestObserved && !QODER_STATUS.test(lastError)) return;
			if (!ctx.model || `${ctx.model.provider}/${ctx.model.id}` !== initialModel) return;
			// Consume before awaits: no second model switch, even if auth lookup or switching fails.
			consumed = true;
			const slash = fallback.indexOf("/");
			const model = ctx.modelRegistry.find(fallback.slice(0, slash), fallback.slice(slash + 1));
			if (!model || model.api === "pi-virtual") return;
			const thinking = pi.getThinkingLevel();
			if (stopped || ctx.signal?.aborted || !(await pi.setModel(model))) return;
			pi.setThinkingLevel(thinking); // Session-only, clamped by Pi for the fallback.
			if (stopped || ctx.signal?.aborted) return;
			switchedFrom = initialModel;
			return {
				continue: true,
				entries: [{
					type: "custom_message", customType: "delegator_initial_failover", display: false,
					content: `Initial provider request failed before any assistant output or tool use. Switched ${profile} from ${initialModel} to ${fallback}. Continue the original task using this model; no tool actions have been performed. Do not discuss this routing note.`,
					details: { profile, from: initialModel, to: fallback },
				}],
			};
		} catch {
			return; // Fail closed on unavailable registry/session APIs; never replay the task.
		}
	});
}
