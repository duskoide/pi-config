import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SECTION = "pi_config_tool_routing";

function routingGuidance(selectedTools: readonly string[]): string {
	const rules: string[] = [];

	if (selectedTools.includes("delegate_task")) {
		rules.push(
			"Use delegate_task proactively for authorized nontrivial work; do not wait for an explicit request to use subagents. For unfamiliar-code exploration, cross-component debugging, or multi-part investigations, prefer an early bounded scout. Keep trivial tasks local, and skip delegation when its overhead outweighs its value or the user requests no delegation.",
			"Before declaring a meaningful code change complete, prefer an independent delegate_task reviewer with the relevant diff, scope, and verification evidence. Main remains responsible for tests and integration.",
			"Use delegate_task tasks for independent read-only questions. While workers run, do complementary work rather than duplicating their investigation; after receiving a launch handle, continue useful work or end the turn instead of polling or sleeping.",
			"Prefer configured delegate_task Roles for repository scouting, review, and checked implementation rather than bg_delegate or Fusion. Read the pi-subagent skill before delegation; give each worker a bounded outcome, allowed scope, exclusions, and expected evidence.",
			"Use delegate_task mode direct only for read-only work with read-only Roles; use mode isolated for implementation or any writing. Keep tightly coupled implementation under one owner, preserve existing authorization and check/integration requirements, and never silently switch modes on failure.",
		);
	}

	if (selectedTools.includes("teleport")) {
		rules.push(
			"Use teleport when continuing work in another directory or repository, not merely to read an external file. Prefer teleport over shell cd for moving the active session; do not move Main into subagent-owned worktrees or remove them with teleport.",
		);
	}

	return rules.map((rule) => `- ${rule}`).join("\n");
}

export default function toolRouting(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		// Older Pi versions lack structured sections. Do not replace their entire prompt.
		const options = event.systemPromptOptions;
		if (!options) return;

		const guidance = routingGuidance(options.selectedTools);
		if (guidance) {
			options.sections[SECTION] = guidance;
		} else {
			delete options.sections[SECTION];
		}
	});
}
