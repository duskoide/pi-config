#!/usr/bin/env node
// Real interactive editor smoke in an isolated HOME + Python-owned PTY.
// No prompt is submitted, no credentials are loaded, and no model is invoked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { prepareBundle, findBinary, configPaths } from './install-pig.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pig-editor-smoke-'));
const agent = path.join(root, 'home/agent');
const workspace = path.join(root, 'workspace');
fs.mkdirSync(agent, { recursive: true }); fs.mkdirSync(workspace);
const binary = findBinary();
const bundle = path.join(agent, 'pig-pi-config');
const expectedBroken = process.argv.includes('--expect-broken');
const installed = process.argv.includes('--installed');
let report;
if (installed) {
  // Test the exact activated source copy, while keeping all mutable test data
  // under the disposable HOME. No auth/settings from the user are copied.
  fs.cpSync(path.join(configPaths().agent, 'pig-pi-config'), bundle, { recursive: true });
  report = JSON.parse(fs.readFileSync(path.join(bundle, 'port-report.json')));
} else report = prepareBundle({ cache: process.env.PIG_PORT_NPM_CACHE || path.join(os.homedir(), '.pi/agent/npm'), destination: bundle, binary });
const capture = path.join(root, 'editor-result.json');
const constructed = path.join(root, 'powerline-editor-constructed.json');
const editorFile = path.join(bundle, 'node_modules/pi-powerline-footer/bash-mode/editor.ts');
const inputs = path.join(root, 'editor-inputs.jsonl');
let editorSource = fs.readFileSync(editorFile, 'utf8');
if (expectedBroken) {
  // Reintroduce only the two old calls in this disposable test bundle.
  editorSource = editorSource.replaceAll('this.keybindingsRef.getResolvedBindings', 'this.keybindingsRef.getEffectiveConfig');
}
assert.ok(editorSource.includes('    this.keybindingsRef = keybindings;'), 'Editor constructor instrumentation anchor drift.');
assert.ok(editorSource.includes('  handleInput(data: string): void {'), 'Editor input instrumentation anchor drift.');
fs.writeFileSync(editorFile, `import { writeFileSync as recordEditorConstruction, appendFileSync as recordEditorInput } from 'node:fs';\n` + editorSource
  .replace('    this.keybindingsRef = keybindings;', `    this.keybindingsRef = keybindings;\n    recordEditorConstruction(${JSON.stringify(constructed)}, JSON.stringify({editor:'BashModeEditor',resolved:typeof keybindings.getResolvedBindings,effective:typeof keybindings.getEffectiveConfig}));`)
  .replace('  handleInput(data: string): void {', `  handleInput(data: string): void {\n    recordEditorInput(${JSON.stringify(inputs)}, JSON.stringify({data,jumpMode:Reflect.get(this,'jumpMode'),paste:Reflect.get(this,'isInPaste')})+'\\n');`));
const probe = path.join(root, 'probe.ts');
const readyFile = path.join(root, 'editor-ready.json');
let modelRequests = 0;
const server = http.createServer((_req, res) => { modelRequests++; res.writeHead(503); res.end('Editor test must not invoke a model.'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(probe, `import fs from 'node:fs'; export default function(pi) { pi.registerProvider('pig-editor-fixture',{api:'openai-completions',apiKey:'fixture-key',baseUrl:${JSON.stringify(baseUrl)},models:[{id:'fixture',name:'Editor Fixture',reasoning:false,input:['text'],contextWindow:128000,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}); pi.on('session_start', (_e,ctx) => { ctx.ui.onTerminalInput(data => { if(data==='\\x1d') { fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({text:ctx.ui.getEditorText()})); ctx.shutdown(); return {consume:true}; } }); fs.writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({hasUI:ctx.hasUI,powerline:pi.getCommands().some(c=>c.name==='powerline')})); ctx.ui.notify('PIG_EDITOR_READY','info'); }); }`);
fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'pig-editor-fixture', defaultModel: 'fixture', theme: 'dark', powerline: { welcome: false }, packages: [bundle] }));
const env = { ...process.env, HOME: path.join(root, 'home'), PIG_HOME: path.join(root, 'home'), PIG_CODING_AGENT_DIR: agent, PIG_USE_PI_DIRS: '0', TERM: 'xterm-256color', PI_OFFLINE: '1' };
for (const key of Object.keys(env)) if (/^(HERDR_|PI_CODING_AGENT|PIG_EXT_|OTEL_|KITTY_)/.test(key) || /KEY|TOKEN|AUTH|CREDENTIAL|PASSWORD|SECRET/i.test(key) || ['DISPLAY', 'WAYLAND_DISPLAY'].includes(key)) delete env[key];
const harness = `import os, sys, pty, subprocess, select, time, signal, fcntl, termios, struct, json
args=json.loads(sys.argv[1]); capture=sys.argv[2]; constructed=sys.argv[3]; ready_file=sys.argv[4]; expected_broken=sys.argv[5]=='true'
master, slave=pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
p=subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
buf=b''; deadline=time.monotonic()+30; next_key=None; ready=False; sent=0
keys=[b'a',b'b',b'\\x1b[D',b'\\x7f',b'x',b'\\x1b[C',b'\\x7f',b'y',b'\\x1d']
try:
  while time.monotonic()<deadline:
    if os.path.exists(capture): break
    if p.poll() is not None: break
    if not ready and os.path.exists(ready_file) and os.path.exists(constructed):
      ready=True; next_key=time.monotonic()+0.3
    if next_key is not None and time.monotonic()>=next_key:
      os.write(master,keys[sent]); sent+=1
      next_key=time.monotonic()+0.12 if sent<len(keys) else None
    readable,_,_=select.select([master],[],[],0.05)
    if readable:
      try: data=os.read(master,65536)
      except OSError: break
      if not data: break
      buf+=data
      if len(buf)>2000000: raise RuntimeError('PTY output limit exceeded')
      if b'\\x1b[6n' in data: os.write(master,b'\\x1b[1;1R')
      if expected_broken and b'getEffectiveConfig is not a function' in buf: break
finally:
  if p.poll() is None:
    os.killpg(p.pid,signal.SIGTERM)
    try: p.wait(timeout=3)
    except subprocess.TimeoutExpired: os.killpg(p.pid,signal.SIGKILL); p.wait(timeout=3)
  os.close(master)
sys.stdout.buffer.write(buf)
`;
let stdout = '', stderr = '';
try {
  const args = [binary, '--offline', '--no-extensions', '--no-skills', '--no-context-files', '--no-approve', '--provider', 'pig-editor-fixture', '--model', 'fixture'];
  // The target is Powerline; the separate agent smoke covers the whole bundle.
  const powerlineEntry = report.extensions.find(entry => entry === 'extensions/pi-powerline-footer-index.ts');
  assert.ok(powerlineEntry, 'Powerline factory is selected.');
  args.push('-e', path.join(bundle, powerlineEntry));
  args.push('-e', probe);
  const process = spawn('python3', ['-c', harness, JSON.stringify(args), capture, constructed, readyFile, String(expectedBroken)], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.on('data', chunk => { stdout += chunk; }); process.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { process.on('error', reject); process.on('close', resolve); });
  assert.equal(code, 0, stderr);
  assert.equal(modelRequests, 0, 'The interactive editing test must not make inference requests.');
  assert.ok(fs.existsSync(constructed), 'Powerline custom editor must be constructed; testing the default editor is not sufficient.');
  assert.deepEqual(JSON.parse(fs.readFileSync(readyFile)), { hasUI: true, powerline: true });
  assert.ok(fs.existsSync(inputs), 'Input must reach BashModeEditor, not the host default editor.');
  if (expectedBroken) {
    assert.match(stdout, /getEffectiveConfig is not a function/, 'Expected to reproduce the reported error.');
  } else {
    assert.ok(fs.existsSync(capture), `Editor probe did not complete. ${stderr}`);
    assert.equal(JSON.parse(fs.readFileSync(capture)).text, 'xy', 'Typing, cursor moves and backspace must work.');
    assert.doesNotMatch(stdout, /editor (?:render )?failed:|getEffectiveConfig is not a function|Rendered line .* exceeds terminal width/);
  }
  console.log(JSON.stringify({ valid: true, installedSource: installed, reproduced: expectedBroken, editor: 'Powerline via real Pig PTY', resources: 1, editing: expectedBroken ? 'known failure reproduced' : 'typing/cursor/backspace passed', modelInvoked: false, usesUserAuth: false }, null, 2));
} catch (error) {
  const artifact = path.join(os.tmpdir(), `pig-editor-failure-${Date.now()}.json`);
  fs.writeFileSync(artifact, JSON.stringify({ error: error.message, stdout, stderr, constructed: fs.existsSync(constructed) ? JSON.parse(fs.readFileSync(constructed)) : null, inputs: fs.existsSync(inputs) ? fs.readFileSync(inputs, 'utf8') : null, capture: fs.existsSync(capture) ? JSON.parse(fs.readFileSync(capture)) : null, ready: fs.existsSync(readyFile) ? JSON.parse(fs.readFileSync(readyFile)) : null }, null, 2));
  console.error(`${error.message}\nFailure evidence: ${artifact}`); process.exitCode = 1;
} finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
