#!/usr/bin/env node
/** Real pinned foreground/background runners, isolated Pi children, loopback providers only. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
const packageRoot = join(agentDir, "npm/node_modules/@mostlyworks/pi-delegator");
const piCommand = spawnSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).stdout.trim();
if (!piCommand) throw new Error("Install Pi before running the native agent-failover smoke.");
async function findSdkRoot() {
	if (process.env.PI_AGENT_SDK_ROOT) return process.env.PI_AGENT_SDK_ROOT;
	for (let directory = dirname(await realpath(piCommand)); ; directory = dirname(directory)) {
		try {
			if (JSON.parse(await readFile(join(directory, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") return directory;
		} catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
		if (dirname(directory) === directory) throw new Error("Cannot locate Pi SDK; set PI_AGENT_SDK_ROOT to its package directory.");
	}
}
const sdkRoot = await findSdkRoot();
const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(sdkRoot, "dist/core/extensions/loader.js")));
const { SettingsManager } = await import(pathToFileURL(join(sdkRoot, "dist/core/settings-manager.js")));
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
assert.equal(manifest.version, "0.6.6");
const root = await mkdtemp(join(tmpdir(), "pi-initial-agent-failover-"));
const fixtureDir = join(root, "agent");
const previousEnv = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_DELEGATOR_PI_BINARY", "PI_DELEGATOR_CHILD"].map(key => [key, process.env[key]]));
let scenario = "quota", requests = [], receivedPrimary;
let foreground, background, ctx;
const checks = [];
const server = createServer(async (request, response) => {
	request.resume();
	const primary = request.url.startsWith("/primary/");
	requests.push(primary ? "primary" : "fallback");
	if (primary) receivedPrimary?.();
	const send = (events) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"); };
	if (!primary) return send([{ choices: [{ delta: { role: "assistant", content: "PI_AGENT_FALLBACK_OK" }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }]);
	if (scenario === "cancel") return; // The runner's abort must close this request.
	if (scenario === "post-tool" && requests.filter(item => item === "primary").length === 1) return send([{ choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "read-1", type: "function", function: { name: "read", arguments: '{"path":"sentinel.txt"}' } }] }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }]);
	if (scenario === "partial" || scenario === "usage") return send([
		scenario === "partial" ? { choices: [{ delta: { role: "assistant", content: "Started" }, finish_reason: null }] } : { choices: [], usage: { prompt_tokens: 7, completion_tokens: 0, total_tokens: 7 } },
		{ error: { message: "Qoder API request failed: 429 quota exhausted" } },
	]);
	const error = scenario === "overflow" ? "context_length_exceeded: maximum context length" : "429 quota exhausted";
	response.writeHead(scenario === "overflow" ? 400 : 429, { "content-type": "application/json" });
	response.end(JSON.stringify({ error: { message: error } }));
});
const emit = async (extension, name, event = {}) => { for (const handler of extension.handlers.get(name) || []) await handler({ type: name, ...event }, ctx); };
const notices = new Map(), waiters = new Map();
const waitNotice = id => notices.has(id) ? Promise.resolve(notices.get(id)) : new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error(`No terminal notice for ${id}`)), 40000);
	waiters.set(id, notice => { clearTimeout(timer); resolve(notice); });
});
let counter = 0;
const call = async (extension, name, params, signal) => {
	const id = `native-${counter++}`;
	const result = await extension.tools.get(name).definition.execute(id, params, signal, () => {}, ctx);
	await emit(extension, "tool_result", { toolName: name, toolCallId: id, input: params, details: result.details, isError: result.isError === true });
	return result;
};
async function policy(enabled = true, fallback = "fallback/test") {
	await writeFile(join(fixtureDir, "delegator/failover.json"), JSON.stringify({ version: 1, profiles: enabled ? { scout: { primary: "primary/test", fallback } } : {} }));
}
try {
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	await mkdir(join(fixtureDir, "delegator"), { recursive: true });
	await mkdir(join(fixtureDir, "npm/node_modules/@mostlyworks"), { recursive: true });
	await symlink(packageRoot, join(fixtureDir, "npm/node_modules/@mostlyworks/pi-delegator"));
	await writeFile(join(root, "sentinel.txt"), "Read-only fixture\n");
	await writeFile(join(fixtureDir, "scout.md"), "Inspect the given task without modifying files.\n");
	const shim = join(fixtureDir, "child.ts");
	await writeFile(shim, `import { registerChildFailover, eligibleProviderFailure } from ${JSON.stringify(join(repo, "extensions/delegator-failover/child.ts"))};
import { appendFileSync } from "node:fs";
export default function(pi) {
 let status, error;
 const trace = data => appendFileSync(${JSON.stringify(join(root, "trace.jsonl"))}, JSON.stringify(data)+"\\n");
 const route = ctx => ctx.model ? ctx.model.provider+"/"+ctx.model.id : null;
 pi.on("session_start", (_e, ctx) => trace({event:"session_start",mode:ctx.mode,model:route(ctx)}));
 pi.on("before_provider_request", () => { status=undefined; trace({event:"before_provider_request"}); });
 pi.on("after_provider_response", e => { status=e.status; trace({event:"after_provider_response",status}); });
 pi.on("message_end", e => { if(e.message.role!=="assistant")return; error=e.message.errorMessage; trace({event:"message_end",stop:e.message.stopReason,contentBlocks:e.message.content.length,status,eligible:eligibleProviderFailure(error||"",status),statusPrefix:/^(\\d{3}):/.exec(error||"")?.[1]}); });
 pi.on("agent_before_settle", (e, ctx) => trace({event:"agent_before_settle",outcome:e.outcome,entries:e.entries.length,pending:e.context.pendingMessages.length,model:route(ctx),eligible:eligibleProviderFailure(error||"",status)}));
 registerChildFailover(pi,"scout",${JSON.stringify(join(fixtureDir, "delegator/failover.json"))});
}`);
	await writeFile(join(fixtureDir, "pi-delegator.json"), JSON.stringify({ profiles: { scout: { description: "Fixture", model: "primary/test", thinking: "off", prompt: "scout.md", tools: ["read"], skills: [], extensions: [shim], deadlineMs: 30000 } } }));
	await writeFile(join(fixtureDir, "settings.json"), JSON.stringify({ packages: [], defaultProvider: "primary", defaultModel: "test", defaultThinkingLevel: "off", defaultProjectTrust: "ask", retry: { enabled: false }, compaction: { enabled: false } }));
	assert.equal(SettingsManager.create(root, fixtureDir).getRetrySettings().enabled, false, "fixture disables native retry");
	await writeFile(join(fixtureDir, "models.json"), JSON.stringify({ providers: Object.fromEntries(["primary", "fallback"].map(provider => [provider, { baseUrl: `http://127.0.0.1:${port}/${provider}/v1`, api: "openai-completions", apiKey: `fake-${provider}`, models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 256 }] }])) }));
	await writeFile(join(fixtureDir, "auth.json"), JSON.stringify(Object.fromEntries(["primary", "fallback"].map(provider => [provider, { type: "api_key", key: `fake-${provider}` }]))));
	process.env.PI_CODING_AGENT_DIR = fixtureDir;
	process.env.PI_DELEGATOR_PI_BINARY = piCommand;
	delete process.env.PI_DELEGATOR_CHILD;
	const runtime = createExtensionRuntime();
	runtime.sendMessage = message => { const id = message.details.taskId; notices.set(id, message); waiters.get(id)?.(message); waiters.delete(id); };
	const loaded = await loadExtensions([join(packageRoot, "src/index.ts"), join(repo, "extensions/delegator-background/index.ts")], root, undefined, runtime);
	assert.deepEqual(loaded.errors, []);
	[foreground, background] = loaded.extensions;
	ctx = { cwd: root, model: { provider: "primary", id: "test" }, isProjectTrusted: () => false, hasUI: false, ui: { setStatus() {}, setWidget() {}, notify() {} } };
	await emit(foreground, "session_start");
	await emit(background, "session_start");
	for (const kind of ["foreground", "background"]) {
		for (const name of ["quota", "usage", "disabled", "missing", "partial", "post-tool", "overflow"]) {
			try {
			scenario = name; requests = [];
			await policy(name !== "disabled", name === "missing" ? "fallback/missing" : "fallback/test");
			let result;
			if (kind === "foreground") {
				try { result = await call(foreground, "delegate", { agent: "scout", task: "Return the fixture marker." }); }
				catch (error) {
					if (name === "quota" || name === "usage") throw new Error(`${kind}/${name}: expected successful fallback`, { cause: error });
					result = { isError: true, content: [{ type: "text", text: error.message }] };
				}
			} else {
				const receipt = await call(background, "delegate_start", { agent: "scout", task: "Return the fixture marker." });
				await waitNotice(receipt.details.taskId);
				result = await call(background, "delegate_result", { taskId: receipt.details.taskId });
				assert.equal((await call(background, "delegate_result", { taskId: receipt.details.taskId })).usage, undefined);
			}
			const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
			if (name === "quota" || name === "usage") {
				assert.deepEqual(requests, ["primary", "fallback"], `${kind}/${name}: ${text}`);
				assert.match(text, /Initial agent failover: primary\/test → fallback\/test/);
				assert.match(text, /PI_AGENT_FALLBACK_OK/);
				assert.equal(result.usage.input, name === "usage" ? 18 : 11, `${kind}/${name}: usage accounting`);
			} else {
				assert.equal(requests.includes("fallback"), false, `${kind}/${name}: ${text}`);
				assert.doesNotMatch(text, /PI_AGENT_FALLBACK_OK/);
				assert.equal(requests.length, name === "post-tool" ? 2 : 1, `${kind}/${name}`);
			}
			checks.push({ kind, name, ok: true });
			console.log(`PASS ${kind}/${name}`);
			} catch (error) {
				checks.push({ kind, name, ok: false, detail: error.message, cause: error.cause?.message });
				console.log(`FAIL ${kind}/${name}: ${error.message}`);
			}
		}
	}
	try {
	scenario = "cancel"; requests = []; await policy();
	const started = new Promise(resolve => { receivedPrimary = resolve; });
	const receipt = await call(background, "delegate_start", { agent: "scout", task: "Wait for provider." });
	await started;
	await call(background, "delegate_cancel", { taskId: receipt.details.taskId });
	await waitNotice(receipt.details.taskId);
	assert.equal((await call(background, "delegate_result", { taskId: receipt.details.taskId })).details.status, "cancelled");
	assert.deepEqual(requests, ["primary"]);
	checks.push({ kind: "background", name: "cancellation", ok: true });
	} catch (error) {
		checks.push({ kind: "background", name: "cancellation", ok: false, detail: error.message });
	}
	const failures = checks.filter(check => !check.ok);
	console.log(JSON.stringify({ status: failures.length ? "FAIL" : "PASS", checks, productionReadiness: "No live Qoder/Codex inference or auth refresh tested; only loopback fixture providers." }, null, 2));
	assert.equal(failures.length, 0, JSON.stringify(failures));
} finally {
	console.log("Sanitized fixture lifecycle trace (bounded tail):");
	console.log((await readFile(join(root, "trace.jsonl"), "utf8").catch(() => "No trace file")).slice(-6000));
	if (background && ctx) await emit(background, "session_shutdown", { reason: "quit" });
	if (foreground && ctx) await emit(foreground, "session_shutdown", { reason: "quit" });
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
	for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	await rm(root, { recursive: true, force: true });
}
