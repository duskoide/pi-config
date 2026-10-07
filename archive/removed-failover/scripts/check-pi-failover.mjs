#!/usr/bin/env node

import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MARKER = "PI_FAILOVER_SMOKE_OK";
const EXTENSION = process.env.PI_MULTI_ACCOUNT_EXTENSION
	?? join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-multi-account", "index.ts");

function killProcessTree(child, signal) {
	if (process.platform !== "win32" && child.pid) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// The process group may already have exited.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// The child may have exited between the timeout and cleanup.
	}
}

function runBounded(command, args, { cwd, env, input, timeoutMs = 90_000, maxBuffer = 2_000_000, stopWhen } = {}) {
	return new Promise((resolveRun) => {
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let outputLimit = false;
		let timedOut = false;
		let terminationStarted = false;
		let termTimer;
		let spawnError;
		const terminate = () => {
			if (terminationStarted) return;
			terminationStarted = true;
			killProcessTree(child, "SIGTERM");
			termTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 2_000);
		};
		const append = (which, chunk) => {
			const text = String(chunk);
			if (which === "stdout") {
				if (stdout.length < maxBuffer) stdout += text.slice(0, maxBuffer - stdout.length);
				if (stdout.length >= maxBuffer) outputLimit = true;
				if (stopWhen?.(stdout)) terminate();
			} else {
				if (stderr.length < maxBuffer) stderr += text.slice(0, maxBuffer - stderr.length);
				if (stderr.length >= maxBuffer) outputLimit = true;
			}
			if (outputLimit) terminate();
		};
		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => append("stdout", chunk));
		child.stderr?.on("data", (chunk) => append("stderr", chunk));
		child.once("error", (error) => {
			spawnError = error;
		});
		child.once("close", (status, signal) => {
			clearTimeout(timeoutTimer);
			if (termTimer) clearTimeout(termTimer);
			resolveRun({ status, signal, stdout, stderr, outputLimit, timedOut, error: spawnError });
		});
		child.stdin?.end(input);
	});
}

function parseJsonLines(output) {
	const events = [];
	let parseErrors = 0;
	for (const line of String(output ?? "").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			parseErrors += 1;
		}
	}
	return { events, parseErrors };
}

function messageText(message) {
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((block) => block?.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

function parseInference(stdout) {
	const { events, parseErrors } = parseJsonLines(stdout);
	const assistants = events
		.filter((event) => event?.type === "message_end" && event.message?.role === "assistant")
		.map((event) => event.message);
	const final = assistants.at(-1);
	const primaryError = assistants.some((message) => message.provider === "primary" && message.stopReason === "error");
	const hasToolCalls = Boolean(final && (
		(Array.isArray(final.toolCalls) && final.toolCalls.length > 0) ||
		(Array.isArray(final.content) && final.content.some((block) => block?.type === "toolCall" || block?.type === "tool_use"))
	));
	const fallbackSuccess = final?.provider === "fallback"
		&& final.model === "fallback-model"
		&& final.stopReason === "stop"
		&& !hasToolCalls
		&& messageText(final) === MARKER;
	return {
		parseErrors,
		primaryError,
		fallbackSuccess,
		finalProvider: final?.provider,
		finalModel: final?.model,
		finalStopReason: final?.stopReason,
	};
}

function sanitizedStatus(message) {
	const wanted = ["Current:", "Rotation (", "Other providers", "Needs models configured", "Cooldowns:", "Failover priority"];
	return String(message ?? "")
		.split(/\r?\n/)
		.filter((line) => wanted.some((prefix) => line.startsWith(prefix)))
		.map((line) => line.slice(0, 500));
}

function parseStatus(stdout) {
	const { events, parseErrors } = parseJsonLines(stdout);
	for (const event of events) {
		if (event?.type !== "extension_ui_request" || event.method !== "notify") continue;
		const lines = sanitizedStatus(event.message);
		if (lines.some((line) => line.startsWith("Current:"))) {
			return { observed: true, parseErrors, lines };
		}
	}
	return { observed: false, parseErrors, lines: [] };
}

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}

function closeServer(server) {
	return new Promise((resolve) => server.close(() => resolve()));
}

function writeFixture(agentDir, port) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({
		packages: [],
		defaultProvider: "primary",
		defaultModel: "primary-model",
		defaultThinkingLevel: "off",
		defaultProjectTrust: "ask",
		httpIdleTimeoutMs: 30_000,
	}, null, 2)}\n`);
	writeFileSync(join(agentDir, "provider-failover.json"), `${JSON.stringify({
		enabled: true,
		autoContinue: false,
		autoDiscover: true,
		autoDiscoverModels: false,
		// The fixture uses generic local providers to exercise rotation; production config disables
		// this broad discovery. Child proxying stays off so the fixture does not create a loopback
		// auth route while reporting status.
		includeOtherProviders: true,
		childProxy: false,
		providerOrder: [],
		providerPriority: ["fallback", "primary"],
		fallbacks: [],
		debugLog: false,
		maxAutoContinuesPerPrompt: 2,
	}, null, 2)}\n`);
	const providers = {};
	for (const [name, model] of [["primary", "primary-model"], ["fallback", "fallback-model"]]) {
		providers[name] = {
			baseUrl: `http://127.0.0.1:${port}/${name}/v1`,
			api: "openai-completions",
			apiKey: `$${name.toUpperCase()}_KEY`,
			models: [{
				id: model,
				name: model,
				reasoning: false,
				input: ["text"],
				contextWindow: 128_000,
				maxTokens: 256,
			}],
		};
	}
	writeFileSync(join(agentDir, "models.json"), `${JSON.stringify({ providers }, null, 2)}\n`);
	writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify({
		primary: { type: "api_key", key: "fake-primary" },
		fallback: { type: "api_key", key: "fake-fallback" },
	}, null, 2)}\n`);
}

async function runSmoke() {
	if (!existsSync(EXTENSION)) {
		return { status: "SKIPPED", reason: "pi-multi-account is not installed in the Pi package cache" };
	}
	const root = mkdtempSync(join(tmpdir(), "pi-config-failover-smoke-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const home = join(root, "home");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(home, { recursive: true });
	const requests = [];
	const server = createServer((request, response) => {
		requests.push(request.url);
		if (request.method === "POST" && request.url?.startsWith("/primary/")) {
			request.resume();
			const body = JSON.stringify({ error: { message: "429 quota exhausted" } });
			response.writeHead(429, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
			response.end(body);
			return;
		}
		if (request.method === "POST" && request.url?.startsWith("/fallback/")) {
			request.resume();
			const body = [
				`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: MARKER }, finish_reason: null }] })}`,
				"",
				`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
				"",
				"data: [DONE]",
				"",
			].join("\n");
			response.writeHead(200, { "content-type": "text/event-stream", "content-length": Buffer.byteLength(body) });
			response.end(body);
			return;
		}
		request.resume();
		response.writeHead(404);
		response.end();
	});
	let port;
	try {
		port = await listen(server);
		writeFixture(agentDir, port);
		const env = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: home,
			XDG_CONFIG_HOME: join(root, "xdg"),
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			PRIMARY_KEY: "fake-primary",
			FALLBACK_KEY: "fake-fallback",
			NO_COLOR: "1",
		};
		const baseArgs = [
			"--no-extensions",
			"-e",
			EXTENSION,
			"--no-tools",
			"--no-session",
			"--no-context-files",
			"--no-skills",
			"--offline",
		];
		const inference = await runBounded("pi", [
			"--mode",
			"json",
			...baseArgs,
			"--provider",
			"primary",
			"--model",
			"primary-model",
			"--thinking",
			"off",
			"-p",
			`Return exactly ${MARKER} and nothing else.`,
		], { cwd, env });
		const parsedInference = parseInference(inference.stdout);
		const statusRun = await runBounded("pi", [
			"--mode",
			"rpc",
			...baseArgs,
			"--provider",
			"fallback",
			"--model",
			"fallback-model",
			"--thinking",
			"off",
		], {
			cwd,
			env,
			input: `${JSON.stringify({ id: "status", type: "prompt", message: "/multi-account status" })}\n`,
			timeoutMs: 30_000,
			stopWhen: (stdout) => parseStatus(stdout).observed,
		});
		const parsedStatus = parseStatus(statusRun.stdout);
		const ok = inference.status === 0
			&& !inference.error
			&& !inference.timedOut
			&& !inference.outputLimit
			&& parsedInference.parseErrors === 0
			&& parsedInference.primaryError
			&& parsedInference.fallbackSuccess
			&& requests.includes("/primary/v1/chat/completions")
			&& requests.includes("/fallback/v1/chat/completions")
			&& !statusRun.error
			&& !statusRun.timedOut
			&& !statusRun.outputLimit
			&& parsedStatus.observed
			&& parsedStatus.parseErrors === 0;
		return {
			status: ok ? "PASS" : "FAIL",
			configured: { explicitFallbackCount: 0, providerPriority: ["fallback", "primary"] },
			loaded: { statusNotificationObserved: parsedStatus.observed, sanitizedStatus: parsedStatus.lines, parseErrors: parsedStatus.parseErrors },
			syntheticRecovery: {
				primaryRequestFailed: requests.includes("/primary/v1/chat/completions") && parsedInference.primaryError,
				fallbackRequestSucceeded: requests.includes("/fallback/v1/chat/completions") && parsedInference.fallbackSuccess,
				finalProvider: parsedInference.finalProvider,
				finalModel: parsedInference.finalModel,
			},
			productionReadiness: "not proven by this isolated fixture",
			requestPaths: requests,
			diagnostics: {
				piExitCode: inference.status,
				piTimedOut: inference.timedOut,
				statusTimedOut: statusRun.timedOut,
				outputLimit: inference.outputLimit || statusRun.outputLimit,
				stderrPresent: Boolean(inference.stderr || statusRun.stderr),
			},
		};
	} finally {
		await closeServer(server);
		rmSync(root, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	let report;
	try {
		report = await runSmoke();
	} catch {
		report = { status: "FAIL", reason: "synthetic failover smoke could not complete" };
	}
	if (process.argv.includes("--json")) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(`Pi failover smoke: ${report.status}`);
		if (report.reason) console.log(`  reason: ${report.reason}`);
		if (report.configured) console.log(`  configured fallbacks: ${report.configured.explicitFallbackCount}; priority: ${report.configured.providerPriority.join(" -> ")}`);
		if (report.loaded) console.log(`  loaded status: ${report.loaded.statusNotificationObserved ? "PASS" : "FAIL"}`);
		if (report.syntheticRecovery) {
			console.log(`  synthetic primary failure: ${report.syntheticRecovery.primaryRequestFailed ? "PASS" : "FAIL"}`);
			console.log(`  synthetic fallback recovery: ${report.syntheticRecovery.fallbackRequestSucceeded ? "PASS" : "FAIL"}`);
		}
		if (report.productionReadiness) console.log(`  production rotation: ${report.productionReadiness}`);
	}
	process.exitCode = report.status === "FAIL" ? 1 : 0;
}

export { parseInference, parseJsonLines, parseStatus, sanitizedStatus };
