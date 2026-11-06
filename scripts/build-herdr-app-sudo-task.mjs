#!/usr/bin/env node
// Generates extensions/herdr-app-sudo-task/index.js from the installed
// pi-herdr-sudo-task dist, swapping the Herdr (TUI) backend for herdr-app/hc.
// Re-run after upgrading pi-herdr-sudo-task: node scripts/build-herdr-app-sudo-task.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(homedir(), ".pi/agent/npm/node_modules/pi-herdr-sudo-task/dist/index.js");
const out = join(dirname(fileURLToPath(import.meta.url)), "../extensions/herdr-app-sudo-task/index.js");
let code = readFileSync(src, "utf8");
const version = JSON.parse(readFileSync(join(src, "../../package.json"), "utf8")).version;

function sub(from, to) {
	const n = code.split(from).length - 1;
	if (n !== 1) throw new Error("Expected exactly one match (found " + n + "): " + from.slice(0, 80));
	code = code.replace(from, () => to);
}
function subFn(startMarker, endMarker, replacement) {
	const s = code.indexOf(startMarker);
	const e = code.indexOf(endMarker, s);
	if (s < 0 || e < 0) throw new Error("Function block not found: " + startMarker);
	code = code.slice(0, s) + replacement + code.slice(e);
}

// --- runner (runs inside the review pane) ---------------------------------
// Pane closes when the program exits; Escape -> exit 77 so the wrapper execs a shell.
sub(
	'const paneId=process.env.HERDR_PANE_ID;const closed=paneId&&await new Promise(resolve=>{const child=spawn("herdr",["pane","close",paneId],{stdio:"ignore"});child.once("error",()=>resolve(false));child.once("close",code=>resolve(code===0))});if(closed)break;await line("Could not close pane. Press Enter or Escape.",false)}}',
	'process.exit(0)}process.exitCode=77;process.exit(77)}',
);
sub("pi-herdr-sudo-task-${uid}", "pi-herdr-app-sudo-task-${uid}");

// --- backend helpers ------------------------------------------------------
subFn("function runHerdr(args, signal) {", "export function herdrNotificationArgs", String.raw`function execJson(bin, args, signal) {
    return new Promise((resolve, reject) => execFile(bin, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, signal, timeout: 15_000 }, (error, stdout) => error
        ? reject(new Error(bin + " " + args.slice(0, 2).join(" ") + " failed"))
        : resolve(stdout)));
}
const runApp = (args, signal) => execJson("herdr-app", args, signal);
const runHc = (args, signal) => execJson("hc", args, signal);
async function appDo(command, payload, signal) {
    const out = await runApp(["do", command, JSON.stringify(payload)], signal);
    try { return JSON.parse(out); } catch { return {}; }
}
async function appPanes(signal) {
    const tree = JSON.parse(await runApp(["ls"], signal));
    const panes = new Map();
    for (const space of tree?.spaces ?? [])
        for (const tab of space?.tabs ?? [])
            for (const t of tab?.terminals ?? [])
                if (typeof t?.pane === "string") panes.set(t.pane, t.terminal);
    return panes;
}
async function paneForTerminal(terminalId, signal) {
    for (const [pane, terminal] of await appPanes(signal)) if (terminal === terminalId) return pane;
    return null;
}
async function paneAlive(paneId) {
    try { return (await appPanes()).has(paneId); } catch { return false; }
}
async function runHerdr(args) {
    // Only notifications reach here; herdr-app has none, so try a desktop notifier.
    if (args[0] !== "notification") throw new Error("unsupported");
    const [, , title, ...rest] = args;
    const body = rest[0] === "--body" ? rest[1] : "";
    await execJson("notify-send", ["-a", "pi", title, body ?? ""]);
}
`);

// --- pane lifecycle -------------------------------------------------------
sub('export async function closeOwnedPane(paneId, close = (args) => runHerdr(args)) {\n    try {\n        await close(["pane", "close", paneId]);',
	'export async function closeOwnedPane(paneId, close = (pane) => appDo("pane.close", { pane })) {\n    try {\n        await close(paneId);');
sub('paneExists = async (id) => {\n    try {\n        await runHerdr(["pane", "get", id]);\n        return true;\n    }\n    catch {\n        return false;\n    }\n}', "paneExists = paneAlive");

// Completion: the runner writes outcome.json atomically before its DONE marker,
// so poll that; scrape the screen (hc read) only for the RUNNING marker.
subFn("async function waitForTerminalLine(paneId, match, signal) {", "export async function closeOwnedPane", String.raw`async function waitForDone(_paneId, token, signal, onRunning, a) {
    let running = false;
    while (true) {
        const outcome = await readRunnerOutcome(a.outcomePath);
        if (outcome) {
            if (!running) await onRunning?.();
            return { kind: "done", ...outcome };
        }
        if (!running && a.terminalId) {
            const screen = await runHc(["read", a.terminalId, "--lines", "200"], signal).catch(() => "");
            if (screen.includes(token + " RUNNING")) { running = true; await onRunning?.(); }
        }
        let alive = false;
        try {
            const owner = JSON.parse(await readFile(a.ownerPath, "utf8"));
            alive = (await processStart(owner.pid)) === owner.start;
        } catch { }
        if (!alive) {
            const last = await readRunnerOutcome(a.outcomePath);
            if (last) return { kind: "done", ...last };
            throw new Error("Runner exited without writing an outcome");
        }
        if (signal?.aborted) throw new Error("Privileged task wait cancelled");
        await delay(250, undefined, { signal }).catch(() => undefined);
    }
}
`);

// Pane creation: herdr-app runs argv directly in the split; no send-text.
subFn("        const direction = await runHerdr([", "        await waitForRunnerStart(a.ownerPath, signal);", String.raw`        const controllerPane = await paneForTerminal(controllerPaneId, signal);
        const direction = await runHc(["get", controllerPaneId, "--json"], signal)
            .then((o) => { const t = JSON.parse(o); return t.cols >= t.rows * 2 ? "right" : "down"; }, () => "right");
        commandQueued = true;
        launchFilesSafeToRemove = false;
        const split = await appDo("pane.split", {
            direction,
            ...(controllerPane ? { pane: controllerPane } : {}),
            argv: ["sh", "-c", 'cd -- "$1" || exit 1; node "$2"; [ $? -eq 77 ] && exec "${"$"}{SHELL:-sh}"; exit 0', "sudo-task", task.cwd, runner],
        }, signal);
        a.paneId = split?.pane;
        a.terminalId = split?.terminal;
        if (typeof a.paneId !== "string")
            throw new Error("herdr-app pane.split returned no pane id");
        await atomicMetadata(a);
        await appDo("pane.focus", { pane: a.paneId }).catch(() => undefined);
`);
sub("const marker = await waitForDone(a.paneId, token, signal, onRunning);", "const marker = await waitForDone(a.paneId, token, signal, onRunning, a);");

// --- environment / preflight ---------------------------------------------
subFn("export function hasHerdrEnvironment(env = process.env) {", "export default function", `export function hasHerdrEnvironment(env = process.env) {
    // herdr-app (hc core) terminal, and not plain Herdr (upstream package handles that).
    return Boolean(env.HC_TERMINAL_SOCKET) && Boolean(env.HC_TERMINAL_ID) && env.HERDR_ENV !== "1";
}
`);
sub("const socketPath = process.env.HERDR_SOCKET_PATH;\n            const controllerPaneId = process.env.HERDR_PANE_ID;",
	"const socketPath = process.env.HC_TERMINAL_SOCKET;\n            const controllerPaneId = process.env.HC_TERMINAL_ID;");
sub('await runHerdr(["pane", "get", controllerPaneId], signal);', 'await runHc(["get", controllerPaneId, "--json"], signal);\n                await runApp(["status"], signal);');
sub('"sudo_task requires HERDR_ENV, socket, and current pane."', '"sudo_task requires a herdr-app terminal (HC_TERMINAL_SOCKET, HC_TERMINAL_ID)."');
sub('"Herdr socket or current pane unavailable."', '"herdr-app window or current terminal unavailable."');
code = code.replaceAll("dedicated Herdr pane", "dedicated herdr-app pane").replaceAll("fresh Herdr review pane", "fresh herdr-app review pane").replaceAll("separate Herdr terminal consent", "separate herdr-app terminal consent");

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, "// GENERATED by scripts/build-herdr-app-sudo-task.mjs from pi-herdr-sudo-task@" + version + " (MIT, tigorlazuardi). Do not edit.\n" + code);
console.log("wrote", out);
