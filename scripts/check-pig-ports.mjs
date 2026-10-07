#!/usr/bin/env node
// Deterministic end-to-end smoke: Pig + real extension processes + a loopback
// OpenAI-compatible fixture. No account credentials or public services used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { prepareBundle, findBinary } from './install-pig.mjs';
import { spawnReadOnlyPig } from '../pig/subagent.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pig-ports-smoke-'));
const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
fs.writeFileSync(path.join(cwd, 'example.txt'), 'Pig port fixture needle\n');
const agent = path.join(root, 'home/agent'); fs.mkdirSync(agent, { recursive: true });
const bundle = path.join(agent, 'pig-pi-config');
const binary = findBinary();
const cache = process.env.PIG_PORT_NPM_CACHE || path.join(os.homedir(), '.pi/agent/npm');
const report = prepareBundle({ cache, destination: bundle, binary });
const requests = [], toolResults = [];
let call = 0, stdout = '', stderr = '', child, childPhase = false;
const childRequests = [];
const plan = [
  ['port_fixture', {}],
  ['todo', { action: 'create', subject: 'Verify Pig port' }],
  ['todo', { action: 'update', id: 1, status: 'in_progress', activeForm: 'checking ports' }],
  ['todo', { action: 'update', id: 1, status: 'completed' }],
  ['todo', { action: 'list' }],
  ['fffind', { pattern: 'example', limit: 5 }],
  ['ffgrep', { pattern: 'needle', path: '*.txt', limit: 5 }],
  ['web_fetch', { url: '' }],
  ['teleport', { action: 'history' }],
  ['delegate_task', { mode: 'direct', role: 'scout', name: 'Verify Pig child', task: 'Return the bounded fixture answer without modifying files.' }],
  ['delegate_task', { mode: 'direct', role: 'reviewer', modelClass: 'fast', name: 'Verify class routing', task: 'Return the bounded fixture answer without modifying files.' }],
];
const server = http.createServer(async (req, res) => {
  if (req.url === '/page') { res.setHeader('Content-Type', 'text/html'); res.end('<html><body><h1>Pig fixture</h1><p>Local fetch verified.</p></body></html>'); return; }
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const isChild = childPhase || JSON.stringify(body.messages).includes('You are a delegated Pig');
    if (isChild) childRequests.push(body); else requests.push(body);
    for (const message of body.messages ?? []) if (message.role === 'tool') toolResults.push(message);
    const current = isChild ? undefined : plan[call++];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = delta => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    emit({ role: 'assistant' });
    if (current) {
      const [name, args] = current;
      emit({ tool_calls: [{ index: 0, id: `call-${call}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    } else {
      emit({ content: isChild ? 'PIG_CHILD_SMOKE_OK' : 'PIG_PORT_SMOKE_OK' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  plan[7][1].url = `${base}/page`;
  const fixture = path.join(root, 'fixture.ts');
  fs.writeFileSync(fixture, `export default function(pi) { pi.registerProvider('pig-port-fixture', { api:'openai-completions', apiKey:'fixture-key', baseUrl:${JSON.stringify(base + '/v1')}, models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:128000,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}] }); pi.registerTool({name:'port_fixture',label:'Fixture',description:'Inspect fixture registration',parameters:{type:'object',properties:{}},execute:async()=>{const commands=pi.getCommands().map(c=>c.name);return {content:[{type:'text',text:JSON.stringify(commands)}],details:{commands}};}}); }`);
  const fixtureConfigFile = path.join(bundle, 'port-config.json');
  const fixtureConfig = JSON.parse(fs.readFileSync(fixtureConfigFile));
  fixtureConfig.providerExtensions['pig-port-fixture'] = [fixture];
  fs.writeFileSync(fixtureConfigFile, JSON.stringify(fixtureConfig));
  const taskConfig = path.join(agent, 'config/pi-task-models/config.json');
  fs.mkdirSync(path.dirname(taskConfig), { recursive: true });
  fs.writeFileSync(taskConfig, JSON.stringify({ profiles: { fast: { primary: { model: 'pig-port-fixture/fixture', thinkingLevel: 'off' } } }, tasks: {} }));
  // Exercise normal settings-package discovery, not only explicit -e wrappers.
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ packages: [bundle] }));
  const args = ['--offline', '--mode', 'json', '--print', '--no-session', '--no-skills', '--no-context-files', '--no-approve', '--provider', 'pig-port-fixture', '--model', 'fixture', '-e', fixture];
  args.push('--', 'Exercise the deterministic Pig port fixture.');
  const env = { ...process.env, HOME: path.join(root, 'home'), PIG_HOME: path.join(root, 'home'), PIG_CODING_AGENT_DIR: agent, PI_OFFLINE: '1' };
  for (const key of Object.keys(env)) if (key.startsWith('HERDR_') || key.startsWith('PI_CODING_AGENT') || key.startsWith('PIG_EXT_') || /(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN)$/.test(key)) delete env[key];
  child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} reject(new Error('Pig smoke exceeded 120 seconds')); }, 120000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /PIG_PORT_SMOKE_OK/, stderr);
  assert.ok(requests.length >= plan.length + 1, `Only ${requests.length} fixture requests; ${stderr}`);
  const tools = requests[0].tools.map(t => t.function.name);
  for (const name of ['todo', 'fffind', 'ffgrep', 'web_search', 'web_fetch', 'resolve-library-id', 'query-docs', 'bg_run', 'bg_status', 'bg_logs', 'delegate_task', 'teleport', 'pdf_to_markdown', 'generate_image']) assert.ok(tools.includes(name), `Tool missing: ${name}\n${stderr}`);
  // Upstream deliberately removes UI/Herdr-only tools in print mode.
  assert.ok(!tools.includes('ask_user_question'), 'Headless question tool must be hidden.');
  assert.ok(!tools.includes('sudo_task'), 'Privileged Herdr workflow must be hidden without Herdr.');
  assert.ok(!tools.includes('bg_run_pi_attested'), 'Pi-only evidence producer must not be exposed.');
  const events = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const completed = events.filter(e => e.type === 'tool_execution_end');
  assert.equal(completed.length, plan.length, stderr);
  for (const event of completed) {
    if (event.toolName === 'web_fetch') {
      assert.equal(event.isError, true, 'The SSRF guard must reject our loopback fixture.');
      assert.match(JSON.stringify(event.result), /Refusing to fetch private\/loopback/);
    } else assert.notEqual(event.isError, true, `${event.toolName}: ${JSON.stringify(event.result)}`);
  }
  const commands = completed.find(e => e.toolName === 'port_fixture')?.result?.details?.commands ?? [];
  for (const name of ['powerline', 'gpt-enhance', 'undo', 'redo', 'usage', 'advisor', 'btw', 'task-models', 'custom-provider', 'pdf2md', 'web-tools']) assert.ok(commands.includes(name), `Extension command missing: ${name}`);
  const text = toolResults.map(result => JSON.stringify(result.content)).join('\n');
  assert.match(text, /completed/); assert.match(text, /example\.txt/); assert.match(text, /Refusing to fetch private\/loopback/);
  childPhase = true;
  const delegated = await spawnReadOnlyPig({ binary, cwd, model: 'pig-port-fixture/fixture', thinking: 'off', prompt: 'Read-only worker fixture', providerExtensions: [fixture], environment: env });
  assert.equal(delegated.answer, 'PIG_CHILD_SMOKE_OK');
  assert.ok(childRequests.length >= 3, 'Default/class-routed delegate_task and the direct child probe must launch real Pig.');
  for (const request of childRequests) assert.deepEqual(request.tools.map(t => t.function.name).sort(), ['find', 'grep', 'ls', 'read']);
  console.log(JSON.stringify({ valid: true, resources: report.extensions.length, modelTools: tools, commands, executed: completed.map(e => e.toolName), requests: requests.length, realPigChild: true, taskClassRouting: true, discovery: 'settings package', modelTransport: 'loopback fixture', usesUserAuth: false }, null, 2));
} catch (error) {
  const artifact = path.join(os.tmpdir(), `pig-ports-smoke-failure-${Date.now()}.json`);
  fs.writeFileSync(artifact, JSON.stringify({ error: error.message, stderr, stdout, requests }, null, 2));
  console.error(`${error.message}\nFailure evidence: ${artifact}`); process.exitCode = 1;
} finally {
  if (child?.exitCode === null && child?.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
