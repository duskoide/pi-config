import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { configPaths, extensionMembers, portableProviderConfig, publishBundle, dependencySource, createStagingDirectory, destinationPath } from '../scripts/install-pig.mjs';
import { portSource, wrapperSource } from '../pig/lib/port-source.mjs';
import { configurePig, adaptExtension } from '../pig/runtime.mjs';
import subagent, { parseRequest, spawnReadOnlyPig } from '../pig/subagent.mjs';

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pig-port-unit-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function fakePig(t, body) {
  const dir = temp(t), file = path.join(dir, 'pig');
  fs.writeFileSync(file, '#!/usr/bin/env node\n' + body); fs.chmodSync(file, 0o755); return file;
}
const answer = `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Verified answer'}],usage:{totalTokens:20},stopReason:'stop'}}));`;

test('Pig config roots respect overrides and reject shared Pi state', () => {
  assert.deepEqual(configPaths({}, '/test/home'), { root: '/test/home/.pig', agent: '/test/home/.pig/agent' });
  assert.deepEqual(configPaths({ XDG_CONFIG_HOME: '/test/config' }, '/test/home'), { root: '/test/config/pig', agent: '/test/config/pig/agent' });
  assert.deepEqual(configPaths({ PIG_HOME: '/test/pig', PIG_CODING_AGENT_DIR: '/test/agent' }, '/test/home'), { root: '/test/pig', agent: '/test/agent' });
  assert.throws(() => configPaths({ PIG_USE_PI_DIRS: '1' }), /Unset PIG_USE_PI_DIRS/);
});
test('Pig output cannot follow a symlink into the Pi tree', t => {
  const home = temp(t); fs.mkdirSync(path.join(home, '.pi/agent'), { recursive: true }); fs.symlinkSync(path.join(home, '.pi'), path.join(home, '.pig'));
  assert.throws(() => configPaths({}, home), /Pi configuration tree/);
  assert.throws(() => configPaths({ PIG_HOME: path.join(home, '.pi') }, home), /Pi configuration tree/);
  assert.throws(() => configPaths({ PIG_HOME: path.join(home, 'elsewhere'), PIG_CODING_AGENT_DIR: path.join(home, '.pi/agent') }, home), /Pi configuration tree/);
});
test('provider migration never copies literal credentials or probes a public endpoint', () => {
  const input = { version: 1, providers: [{ name: 'fixture-provider', apiKey: 'not-a-real-key', baseUrl: 'https://example.invalid' }, { name: 'env', apiKey: '${EXAMPLE_KEY}' }] };
  const output = portableProviderConfig(input);
  assert.equal(output.providers[0].apiKey, '$FIXTURE_PROVIDER_API_KEY');
  assert.equal(output.providers[1].apiKey, '${EXAMPLE_KEY}');
  assert.ok(output.providers.every(provider => provider.fetchModels === false));
  assert.equal(input.providers[0].apiKey, 'not-a-real-key');
  assert.ok(!JSON.stringify(output).includes('not-a-real-key'));
});
test('cache-only never selects network and staging/previews are uniquely owned', t => {
  const agent = temp(t), missing = path.join(agent, 'missing');
  assert.throws(() => dependencySource(['--from-pi-cache'], missing), /never downloads/);
  assert.equal(dependencySource(['--download'], missing), 'download');
  const cache = path.join(agent, 'cache'); fs.mkdirSync(path.join(cache, 'node_modules'), { recursive: true });
  assert.equal(dependencySource(['--from-pi-cache'], cache), 'cache');
  const legacyStage = path.join(agent, `.pig-pi-config-stage-${process.pid}`); fs.mkdirSync(legacyStage); fs.writeFileSync(path.join(legacyStage, 'sentinel'), 'owned by someone else');
  const staging = createStagingDirectory(agent); assert.notEqual(staging.root, legacyStage); fs.rmSync(staging.root, { recursive: true });
  assert.equal(fs.readFileSync(path.join(legacyStage, 'sentinel'), 'utf8'), 'owned by someone else');
  const active = destinationPath(agent, false); assert.notEqual(destinationPath(agent, true), active); assert.notEqual(destinationPath(agent, true), destinationPath(agent, true));
});
test('cache-only CLI fails offline without invoking npm', t => {
  const dir = temp(t), bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const marker = path.join(dir, 'npm-was-invoked');
  fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected'); process.exit(99);`, { mode: 0o700 });
  const result = spawnSync(process.execPath, ['scripts/install-pig.mjs', '--from-pi-cache'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, HOME: dir, PIG_HOME: path.join(dir, 'pig'), PIG_CODING_AGENT_DIR: path.join(dir, 'pig/agent'), PIG_BINARY: process.execPath, PIG_PORT_NPM_CACHE: path.join(dir, 'missing'), PIG_USE_PI_DIRS: '0', PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.equal(result.status, 1); assert.match(result.stderr, /never downloads/); assert.ok(!fs.existsSync(marker));
});
test('prepare-only CLI leaves active registered bundle and settings unchanged', t => {
  const dir = temp(t), agent = path.join(dir, 'pig/agent'), cache = path.join(dir, 'cache'), active = path.join(agent, 'pig-pi-config');
  fs.mkdirSync(active, { recursive: true }); fs.writeFileSync(path.join(active, 'sentinel'), 'active bundle');
  const settings = JSON.stringify({ packages: [active], theme: 'light' }); fs.writeFileSync(path.join(agent, 'settings.json'), settings);
  const ports = JSON.parse(fs.readFileSync(new URL('../pig/ports.json', import.meta.url)));
  for (const port of ports.packages) {
    const pkg = path.join(cache, 'node_modules', port.name); fs.mkdirSync(pkg, { recursive: true });
    const members = port.extensions ?? (port.name === '@xynogen/pix-pretty' ? [] : ['index.ts']);
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: port.name, version: port.version, pi: { extensions: members } }));
    for (const member of members) { const file = path.join(pkg, member); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'export default function(pi) {}'); }
  }
  const result = spawnSync(process.execPath, ['scripts/install-pig.mjs', '--from-pi-cache', '--prepare-only'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env, HOME: dir, PIG_HOME: path.join(dir, 'pig'), PIG_CODING_AGENT_DIR: agent, PIG_BINARY: process.execPath, PIG_PORT_NPM_CACHE: cache, PIG_USE_PI_DIRS: '0' } });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Prepared only \(not activated\)/);
  assert.equal(fs.readFileSync(path.join(active, 'sentinel'), 'utf8'), 'active bundle'); assert.equal(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8'), settings);
  assert.equal(fs.readdirSync(agent).filter(name => name.startsWith('pig-pi-config-preview-')).length, 1);
  assert.ok(!fs.readdirSync(agent).some(name => name.startsWith('.pig-pi-config-stage-')));
});
test('publication restores target/settings/config after a post-publication error', t => {
  const agent = temp(t), stage = path.join(agent, 'stage'), target = path.join(agent, 'pig-pi-config'), settingsFile = path.join(agent, 'settings.json');
  fs.mkdirSync(stage); fs.writeFileSync(path.join(stage, 'new'), 'new'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'old'), 'old');
  const bytes = JSON.stringify({ packages: [target], theme: 'light' }); fs.writeFileSync(settingsFile, bytes);
  const originalNow = Date.now; Date.now = () => 123456;
  const existingBackup = `${settingsFile}.pre-port.123456`; fs.mkdirSync(existingBackup);
  try { assert.throws(() => publishBundle({ stage, target, agent, configFiles: [{ name: 'new-config.json', content: '{}' }] }), /EEXIST/); }
  finally { Date.now = originalNow; }
  assert.equal(fs.readFileSync(path.join(target, 'old'), 'utf8'), 'old'); assert.ok(fs.existsSync(path.join(stage, 'new')));
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), bytes); assert.ok(!fs.existsSync(path.join(agent, 'new-config.json')));
  assert.ok(fs.existsSync(existingBackup)); assert.ok(!fs.existsSync(`${settingsFile}.lock`));
});
test('publication validates settings before replacing a working bundle', t => {
  const agent = temp(t), stage = path.join(agent, 'stage'), target = path.join(agent, 'pig-pi-config');
  fs.mkdirSync(stage); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'old'), 'preserved');
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ packages: 7 }));
  assert.throws(() => publishBundle({ stage, target, agent }), /must be an array/);
  assert.equal(fs.readFileSync(path.join(target, 'old'), 'utf8'), 'preserved');
  assert.ok(fs.existsSync(stage)); assert.ok(!fs.existsSync(path.join(agent, 'settings.json.lock')));
});
test('publication preserves settings and refuses symlinks/live locks', t => {
  const agent = temp(t), stage = path.join(agent, 'stage'), target = path.join(agent, 'pig-pi-config'); fs.mkdirSync(stage);
  const settingsFile = path.join(agent, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ defaultProvider: 'example', packages: ['another-package'], unknown: { value: true } }));
  publishBundle({ stage, target, agent, configFiles: [{ name: 'new-config.json', content: '{}' }] });
  const settings = JSON.parse(fs.readFileSync(settingsFile));
  assert.equal(settings.defaultProvider, 'example'); assert.deepEqual(settings.unknown, { value: true });
  assert.deepEqual(settings.packages, ['another-package', target]);
  fs.mkdirSync(stage); fs.mkdirSync(settingsFile + '.lock');
  assert.throws(() => publishBundle({ stage, target, agent }), /EEXIST/); fs.rmdirSync(settingsFile + '.lock');
  fs.renameSync(settingsFile, settingsFile + '.real'); fs.symlinkSync(settingsFile + '.real', settingsFile);
  assert.throws(() => publishBundle({ stage, target, agent }), /symlinked/);
  assert.ok(fs.lstatSync(settingsFile).isSymbolicLink()); assert.ok(fs.existsSync(stage));
});
test('legacy environment is scoped to Pig, not Pi credentials', () => {
  const env = { PIG_HOME: '/test/pig', PIG_CODING_AGENT_DIR: '/test/agent', PIG_PORT_BINARY: '/test/bin/pig', PI_CODING_AGENT_DIR: '/never/pi' };
  const result = configurePig(env, '/test/home');
  assert.equal(result.agent, '/test/agent'); assert.equal(env.PI_CODING_AGENT_DIR, '/test/agent');
  assert.equal(env.PI_CODING_AGENT_SESSION_DIR, '/test/agent/sessions');
  assert.equal(env.PIG_PORT_BINARY, '/test/bin/pig');
});
test('port only filesystem namespace, not identifiers or provider URLs', () => {
  const source = `join(homedir(), ".pi", "agent", "auth.json"); join(cwd, '.pi', 'tasks'); const url = "https://pi.dev/x"; const nestedUrl = 'https://host/.pi/api'; pi.events.emit('pi-subagent'); // .pi/tasks`;
  const result = portSource(source, 'pi-test/index.ts');
  assert.match(result.text, /join\(process.env.PI_CODING_AGENT_DIR, "auth.json"\)/);
  assert.match(result.text, /join\(cwd, '\.pig', 'tasks'\)/);
  assert.match(result.text, /https:\/\/pi\.dev\/x/); assert.match(result.text, /https:\/\/host\/\.pi\/api/); assert.match(result.text, /pi\.events\.emit\('pi-subagent'\)/);
});
test('Powerline uses Pig resolved keybindings without losing overrides or disabled actions', () => {
  const source = `class Editor {
    constructor(keybindings) { this.keybindingsRef = keybindings; }
    printableBindings() { return this.keybindingsRef.getEffectiveConfig(); }
    conflictBindings() { const getEffectiveConfig = this.keybindingsRef.getEffectiveConfig; return getEffectiveConfig.call(this.keybindingsRef); }
  }`;
  const manager = { config: { 'app.tools.expand': 'x', 'tui.input.submit': [], 'tui.editor.cursorLeft': ['left', 'ctrl+b'] }, getResolvedBindings() { return this.config; } };
  const original = new Function('keybindings', `${source}; return new Editor(keybindings);`)(manager);
  assert.throws(() => original.printableBindings(), /getEffectiveConfig is not a function/);
  const result = portSource(source, 'pi-powerline-footer/bash-mode/editor.ts');
  const editor = new Function('keybindings', `${result.text}; return new Editor(keybindings);`)(manager);
  assert.deepEqual(editor.printableBindings(), manager.config); assert.deepEqual(editor.conflictBindings(), manager.config);
  manager.config = { 'app.clear': 'backspace', 'tui.input.submit': 'enter' };
  assert.deepEqual(editor.printableBindings(), manager.config); assert.deepEqual(editor.conflictBindings(), manager.config);
  assert.equal(manager.getEffectiveConfig, undefined, 'The original manager/prototype must remain untouched.');
  assert.ok(result.changes.includes('Pig editor resolved keybindings')); assert.ok(result.changes.includes('Pig editor conflict keybindings'));
});
test('Powerline keybindings port fails closed on either source anchor drifting', () => {
  for (const source of ['this.keybindingsRef.getEffectiveConfig()', 'const getEffectiveConfig = this.keybindingsRef.getEffectiveConfig;']) {
    assert.throws(() => portSource(source, 'pi-powerline-footer/bash-mode/editor.ts'), /Port anchor drift/);
  }
});
test('background and ephemeral children launch the Pig executable', () => {
  const ephemeral = portSource(`if (process.env.PI_CODING_AGENT !== "true" || (process.title !== "pi" && process.title !== "pi-rpc")) {\n}\nfunction piInvocation() {\n}`, '@henryqw/pi-subagent/dist/ephemeral.js');
  assert.match(ephemeral.text, /PIG_EXT_SOCKET/); assert.match(ephemeral.text, /command: process.env.PIG_PORT_BINARY/);
  const background = portSource('export function resolvePiLaunch(deps: PiLaunchDependencies = {}): PiLaunchSpec {\n}', 'pi-background-tasks/src/core/pi-launch.ts');
  assert.match(background.text, /executable: process.env.PIG_PORT_BINARY/);
  assert.throws(() => portSource('function changed() {}', '@henryqw/pi-subagent/dist/ephemeral.js'), /anchor drift/);
});
test('wrappers load runtime setup before the extension module', () => {
  const text = wrapperSource('../vendor/index.ts', '../runtime.mjs', 'example');
  assert.ok(text.indexOf('from "../runtime.mjs"') < text.indexOf('from "../vendor/index.ts"'));
  assert.doesNotMatch(text, /import\(/);
});
test('extension membership honors explicit filters and inert packages', t => {
  const dir = temp(t); fs.mkdirSync(path.join(dir, 'extensions'));
  fs.writeFileSync(path.join(dir, 'extensions/a.ts'), ''); fs.writeFileSync(path.join(dir, 'extensions/b.ts'), '');
  assert.deepEqual(extensionMembers(dir, { name: 'pkg' }, ['extensions/a.ts']), ['extensions/a.ts']);
  assert.deepEqual(extensionMembers(dir, { name: 'pkg' }), ['extensions/a.ts', 'extensions/b.ts']);
  assert.deepEqual(extensionMembers(dir, { name: 'pkg', pi: { extensions: [] } }), []);
  assert.throws(() => extensionMembers(dir, { name: 'pkg' }, ['../escape.ts']), /Escaping/);
});
test('Pi-only attestation is not falsely registered as Pig evidence', () => {
  const tools = [], pi = { registerTool: t => tools.push(t), example() { return this; } };
  const adapted = adaptExtension(pi, 'pi-background-tasks');
  adapted.registerTool({ name: 'bg_run_pi_attested' }); adapted.registerTool({ name: 'bg_run' });
  assert.deepEqual(tools.map(t => t.name), ['bg_run']); assert.equal(adapted.example(), pi);
});
test('teleport does not claim directory handoff without Herdr', async () => {
  let tool, calls = 0; const env = process.env.HERDR_ENV; delete process.env.HERDR_ENV;
  try {
    adaptExtension({ registerTool: t => { tool = t; } }, 'pi-agent-teleport').registerTool({ name: 'teleport', execute: async () => ++calls });
    await assert.rejects(tool.execute('id', { action: 'jump' }), /requires Herdr/);
    assert.equal(await tool.execute('id', { action: 'history' }), 1); assert.equal(calls, 1);
  } finally { if (env !== undefined) process.env.HERDR_ENV = env; }
});
test('direct parser rejects ambiguous or write-capable workflows before launch', () => {
  const packet = { role: 'scout', name: 'Inspect paths', task: 'Inspect src' };
  assert.equal(parseRequest({ mode: 'direct', ...packet }).mode, 'single');
  assert.equal(parseRequest({ mode: 'direct', tasks: [packet] }).mode, 'parallel');
  assert.equal(parseRequest({ mode: 'direct', chain: [packet] }).mode, 'chain');
  assert.throws(() => parseRequest({ mode: 'isolated', ...packet }), /no fallback/);
  assert.throws(() => parseRequest({ mode: 'direct', ...packet, role: 'implementer' }), /write-capable/);
  assert.throws(() => parseRequest({ mode: 'direct', ...packet, tasks: [packet] }), /Choose/);
});
test('Pig child is tool-restricted and returns validated JSON results', async t => {
  const binary = fakePig(t, `const args = process.argv.slice(2);\nfor (const flag of ['--no-session','--no-extensions','--no-skills','--no-context-files','--no-approve']) if(!args.includes(flag)) process.exit(5);\nif(args[args.indexOf('--tools')+1] !== 'read,grep,find,ls') process.exit(6);\nif(Object.keys(process.env).some(k=>k.startsWith('PIG_EXT_')||k.startsWith('HERDR_'))) process.exit(7);\n${answer}`);
  const result = await spawnReadOnlyPig({ binary, cwd: temp(t), model: 'example/model', thinking: 'high', prompt: 'Bounded task' });
  assert.equal(result.answer, 'Verified answer'); assert.equal(result.tokens, 20);
});
test('Pig child failure, invalid JSON and budgets are errors, never success', async t => {
  const options = { cwd: temp(t), model: 'example/model', thinking: 'off', prompt: 'Task', maxMs: 1000 };
  await assert.rejects(spawnReadOnlyPig({ ...options, binary: fakePig(t, 'process.exit(3);') }), /exited 3/);
  await assert.rejects(spawnReadOnlyPig({ ...options, binary: fakePig(t, 'console.log("not-json");') }), /malformed JSON/);
  await assert.rejects(spawnReadOnlyPig({ ...options, binary: fakePig(t, answer), maxTokens: 1 }), /token budget/);
  await assert.rejects(spawnReadOnlyPig({ ...options, binary: fakePig(t, 'setInterval(()=>{},1000);'), idleMs: 40 }), /idle timeout/);
});
test('cancellation drains the child instead of leaving an orphan', async t => {
  const controller = new AbortController();
  const promise = spawnReadOnlyPig({ binary: fakePig(t, 'setInterval(()=>{},1000);'), cwd: temp(t), model: 'example/model', thinking: 'off', prompt: 'Task', signal: controller.signal });
  controller.abort(); await assert.rejects(promise, /cancelled/);
});
test('headless delegate awaits a real child process and does not promise a lost follow-up', async t => {
  const dir = temp(t), modules = path.join(dir, 'modules'); fs.mkdirSync(modules);
  const binary = fakePig(t, answer);
  for (const file of ['runtime.mjs', 'subagent.mjs']) fs.copyFileSync(new URL(`../pig/${file}`, import.meta.url), path.join(modules, file));
  fs.writeFileSync(path.join(modules, 'port-config.json'), JSON.stringify({ binary, providerExtensions: {}, taskProfiles: {} }));
  const keys = ['PIG_HOME', 'PIG_CODING_AGENT_DIR', 'PIG_PORT_BINARY', 'PIG_PORT_HOME', 'PIG_USE_PI_DIRS', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });
  Object.assign(process.env, { PIG_HOME: path.join(dir, 'home'), PIG_CODING_AGENT_DIR: path.join(dir, 'home/agent'), PIG_PORT_BINARY: binary }); delete process.env.PIG_USE_PI_DIRS;
  const { default: factory } = await import(pathToFileURL(path.join(modules, 'subagent.mjs')).href);
  const handlers = new Map(), tools = new Map(), messages = [];
  const ctx = { hasUI: false, cwd: dir, model: { provider: 'fixture', id: 'model' }, sessionManager: { getSessionId: () => 'unit-session', getLeafId: () => 'root', getBranch: () => [{ id: 'root' }] } };
  factory({ on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, getThinkingLevel: () => 'none', sendMessage: message => messages.push(message) });
  handlers.get('session_start')({}, ctx);
  const result = await tools.get('delegate_task').execute('id', { mode: 'direct', role: 'scout', name: 'Check child', task: 'Bounded question' }, undefined, undefined, ctx);
  assert.equal(result.isError, false); assert.equal(result.details.status, 'completed'); assert.match(result.content[0].text, /Verified answer/); assert.deepEqual(messages, []);
  await handlers.get('session_shutdown')();
});
test('isolated request never starts a child or produces an asynchronous handle', async () => {
  const tools = new Map();
  subagent({ on() {}, registerTool: t => tools.set(t.name, t), registerCommand() {} });
  await assert.rejects(tools.get('delegate_task').execute('id', { mode: 'isolated' }, undefined, undefined, {}), /no fallback/);
});
