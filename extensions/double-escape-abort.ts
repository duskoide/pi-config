import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// While the agent is running, require two Escape presses (within WINDOW_MS) to abort.
// When idle, Escape passes through untouched (built-in double-Escape -> tree/fork still works).
const WINDOW_MS = 600;
const ESC = new Set(["\x1b", "\x1b[27u", "\x1b[27;1:1u"]);

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		let last = 0;
		ctx.ui.onTerminalInput((data) => {
			if (!ESC.has(data) || ctx.isIdle()) {
				return undefined;
			}
			const now = Date.now();
			if (now - last <= WINDOW_MS) {
				last = 0;
				return undefined; // second press: let the built-in abort run
			}
			last = now;
			ctx.ui.notify("Press Escape again to abort", "info");
			return { consume: true };
		});
	});
}
