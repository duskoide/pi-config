/**
 * sudo_prompt: run privileged commands after prompting the user for their sudo
 * password inside pi's own TUI (masked). Works in any terminal.
 *
 * Safety: the user approves the exact commands first; the password goes only to
 * sudo's stdin (never argv/env, never returned to the model, scrubbed from output).
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_OUT = 20_000;
const MAX_ATTEMPTS = 3;

const DEFAULT_TIMEOUT_MS = 120_000;
const NO_RETRY = /not in the sudoers|may not run sudo|is not allowed to|account (is )?locked|account has expired|a password is required/i;

function runSudo(args: string[], password: string, cwd: string, signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS) {
	return new Promise<{ code: number | null; out: string; truncated: boolean; timedOut: boolean }>((resolve) => {
		const child = spawn("sudo", ["-S", "-k", "-p", "", ...args], { cwd, signal, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		let truncated = false;
		let timedOut = false;
		const add = (b: Buffer) => {
			if (out.length >= MAX_OUT) truncated = true;
			else out += b.toString();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
		}, timeoutMs);
		child.stdout.on("data", add);
		child.stderr.on("data", add);
		child.stdin.on("error", () => undefined);
		child.stdin.end(password + "\n");
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ code: null, out: String((e as Error).message), truncated, timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, out, truncated, timedOut });
		});
	});
}

/** Pure input reducer for the masked prompt (exported for tests). */
export function applyPasswordInput(buf: string, data: string): { buf: string; action: "none" | "submit" | "cancel" } {
	if (data === "\x1b") return { buf, action: "cancel" };
	if (data === "\x03") return { buf, action: "cancel" };
	data = data.replace(/\x1b\[20[01]~/g, "");
	// other escape sequences (arrows, F-keys, ...) are ignored
	if (data.startsWith("\x1b")) return { buf, action: "none" };
	for (const ch of data) {
		if (ch === "\r" || ch === "\n") return { buf, action: "submit" };
		if (ch === "\x7f" || ch === "\b") buf = buf.slice(0, -1);
		else if (ch === "\x15") buf = "";
		else if (ch >= " ") buf += ch;
	}
	return { buf, action: "none" };
}

const scrub = (s: string, pw: string) => (pw ? s.split(pw).join("[redacted]") : s).slice(0, MAX_OUT);

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "sudo_prompt",
		label: "Sudo (prompt)",
		description:
			"Run commands as root via sudo. The user reviews the exact commands, then types their sudo password in pi's own masked prompt. Commands run sequentially via `sh -c`.",
		promptSnippet: "Run privileged commands; user approves and enters sudo password inside pi",
		promptGuidelines: [
			"Use sudo_prompt when a command needs root. Never put `sudo` in the command itself and never run sudo through bash.",
			"Keep commands minimal and exact with a concrete reason for each step.",
		],
		parameters: Type.Object({
			title: Type.String(),
			cwd: Type.Optional(Type.String()),
			timeoutSeconds: Type.Optional(Type.Number()),
			steps: Type.Array(
				Type.Object({
					command: Type.String(),
					reason: Type.String(),
					continueOnError: Type.Optional(Type.Boolean()),
				}),
				{ minItems: 1, maxItems: 10 },
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: { status: "failed" } });
			if (!ctx.hasUI) return fail("sudo_prompt needs an interactive UI.");
			const cwd = params.cwd ?? ctx.cwd;
			if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return fail(`cwd is not a directory: ${cwd}`);
			if (params.steps.some((s) => !s.command.trim())) return fail("Empty command.");
			if (params.steps.some((s) => /^\s*sudo\b/.test(s.command))) return fail("Do not include `sudo` in commands.");
			const timeoutMs = Math.min(Math.max(params.timeoutSeconds ?? 120, 1), 3600) * 1000;

			const summary = params.steps.map((s, i) => `${i + 1}. ${s.command}\n   why: ${s.reason}`).join("\n");
			const ok = await ctx.ui.confirm(`Run as root? ${params.title}`, `cwd: ${cwd}\n\n${summary}`);
			if (!ok) return { content: [{ type: "text" as const, text: "User rejected." }], details: { status: "rejected" } };

			let password = "";
			let attempts = 0;
			try {
				let validated = false;
				let note = "";
				while (attempts < MAX_ATTEMPTS && !validated) {
					const pw = await askPassword(ctx, note || "sudo password");
					if (pw === null) return { content: [{ type: "text" as const, text: "User cancelled password prompt." }], details: { status: "cancelled", attempts } };
					if (pw === "") {
						note = "Empty password, try again";
						continue; // not counted: sudo was never asked
					}
					attempts++;
					const r = await runSudo(["-v"], pw, cwd, signal, 15_000);
					if (r.code === 0) {
						password = pw;
						validated = true;
					} else if (NO_RETRY.test(r.out)) {
						return { content: [{ type: "text" as const, text: `sudo refused: ${scrub(r.out, pw).trim()}` }], details: { status: "failed", attempts } };
					} else if (r.code === null || r.timedOut) {
						return { content: [{ type: "text" as const, text: `Could not run sudo: ${scrub(r.out, pw).trim() || "timed out"}` }], details: { status: "failed", attempts } };
					} else note = "Wrong password, try again";
				}
				if (!validated) return { content: [{ type: "text" as const, text: `Authentication failed after ${attempts} attempts.` }], details: { status: "failed", attempts } };

				const results: string[] = [];
				for (const [i, s] of params.steps.entries()) {
					if (signal?.aborted) {
						results.push("Aborted.");
						return { content: [{ type: "text" as const, text: results.join("\n") }], details: { status: "cancelled", attempts, completedSteps: i } };
					}
					const r = await runSudo(["--", "sh", "-c", s.command], password, cwd, signal, timeoutMs);
					const flags = [r.timedOut ? `timed out after ${timeoutMs / 1000}s` : "", r.truncated ? "output truncated" : ""].filter(Boolean).join(", ");
					results.push(`[${i + 1}] exit ${r.code}${flags ? ` (${flags})` : ""}: ${s.command}\n${scrub(r.out, password)}`);
					if (r.code !== 0 && !s.continueOnError) {
						results.push("Stopped after failure.");
						return { content: [{ type: "text" as const, text: results.join("\n") }], details: { status: "failed", attempts, completedSteps: i } };
					}
				}
				return { content: [{ type: "text" as const, text: results.join("\n") }], details: { status: "completed", attempts } };
			} finally {
				password = "";
			}
		},
	});
}

function askPassword(ctx: any, prompt: string): Promise<string | null> {
	return ctx.ui.custom<string | null>((_tui: any, theme: any, kb: any, done: (v: string | null) => void) => {
		let buf = "";
		return {
			render(width: number): string[] {
				return [
					truncateToWidth(theme.fg("warning", `🔒 ${prompt}: `) + "•".repeat(buf.length) + theme.fg("dim", "▏"), width),
					truncateToWidth(theme.fg("dim", "Enter to submit, Esc to cancel"), width),
				];
			},
			handleInput(data: string) {
				const r = applyPasswordInput(buf, data);
				if (kb.matches(data, "tui.select.cancel")) return done(null);
				buf = r.buf;
				if (r.action === "cancel") return done(null);
				if (r.action === "submit") return done(buf);
				_tui.requestRender?.();
			},
			invalidate() {},
		};
	});
}
