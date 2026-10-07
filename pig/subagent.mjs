import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { configurePig } from './runtime.mjs';

const MAX_OUTPUT = 50 * 1024;
const MAX_EVENT = 1024 * 1024;
const roles = {
  scout: 'Map relevant code and evidence without changing files. Cite exact paths and line numbers.',
  reviewer: 'Independently review the bounded change for correctness, regressions, safety and tests. Do not change files.',
  researcher: 'Research the bounded question using the available local read-only tools. Separate evidence from assumptions.',
};
const string = { type: 'string', minLength: 1 };
const packet = { type: 'object', properties: {
  role: { ...string, enum: Object.keys(roles) }, name: { ...string, maxLength: 29 }, task: string,
  model: string, modelClass: { type: 'string', enum: ['fast', 'balanced', 'frontier', 'fav'] }, kind: { const: 'text' },
}, required: ['role', 'name', 'task'], additionalProperties: false };
export const parameters = { type: 'object', properties: {
  ...packet.properties, mode: { type: 'string', enum: ['direct', 'isolated'] },
  tasks: { type: 'array', items: packet, minItems: 1, maxItems: 8 },
  chain: { type: 'array', items: packet, minItems: 1, maxItems: 8 },
}, required: ['mode'], additionalProperties: false };

export function parseRequest(input) {
  if (input.mode !== 'direct') throw new Error('Pig local delegation supports read-only mode direct only. Checked isolated Herdr graphs require a Pig-aware Herdr backend; no fallback to direct or write-capable worker is permitted.');
  const kinds = ['tasks', 'chain'].filter(key => input[key] !== undefined);
  if (kinds.length > 1 || (kinds.length && ['role', 'name', 'task'].some(key => input[key] !== undefined))) throw new Error('Choose a single packet, tasks, or chain.');
  const packets = kinds.length ? input[kinds[0]] : [input];
  if (!Array.isArray(packets) || packets.length < 1 || packets.length > 8) throw new Error('A workflow needs 1–8 packets.');
  for (const item of packets) {
    if (!Object.hasOwn(roles, item.role)) throw new Error(`Unknown or write-capable role ${item.role}. Available read-only roles: ${Object.keys(roles).join(', ')}.`);
    for (const key of ['name', 'task']) if (typeof item[key] !== 'string' || !item[key].trim() || item[key].includes('\0')) throw new Error(`Invalid ${key}.`);
    if (item.name.length > 29 || /[\u0000-\u001f\u007f-\u009f]/.test(item.name)) throw new Error('Invalid task display name.');
    if (item.modelClass !== undefined && !['fast', 'balanced', 'frontier', 'fav'].includes(item.modelClass)) throw new Error('Invalid model class.');
    if (item.kind !== undefined && item.kind !== 'text') throw new Error('Direct delegation only accepts text tasks.');
  }
  return { mode: kinds[0] === 'chain' ? 'chain' : kinds[0] === 'tasks' ? 'parallel' : 'single', packets };
}
function cap(text, bytes = MAX_OUTPUT) { return new TextDecoder().decode(Buffer.from(String(text)).subarray(0, bytes), { stream: true }); }
function killGroup(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {}
  const timer = setTimeout(() => {
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
  }, 1000);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}
export function spawnReadOnlyPig({ binary, cwd, model, thinking, prompt, signal, idleMs = 120000, maxMs = 1200000, maxTurns = 50, maxTokens = 500000, providerExtensions = [], environment = process.env, onEvent = () => {} }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Delegation cancelled.'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pig-delegate-'));
    const promptFile = path.join(dir, 'prompt.md');
    fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
    const args = ['--mode', 'json', '--print', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--tools', 'read,grep,find,ls', '--model', model, '--thinking', thinking, '--append-system-prompt', promptFile];
    for (const entry of providerExtensions) args.push('--extension', entry);
    args.push('--', 'Execute the assigned bounded task. Do not delegate recursively.');
    const env = { ...environment };
    for (const key of Object.keys(env)) if (key.startsWith('PIG_EXT_') || key.startsWith('HERDR_') || key.startsWith('PI_SUBAGENT_')) delete env[key];
    const child = spawn(binary, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', stderr = '', answer = '', turns = 0, tokens = 0, failure;
    let idle;
    const stop = message => { failure ??= new Error(message); killGroup(child); };
    const abort = () => stop('Delegation cancelled.');
    signal?.addEventListener('abort', abort, { once: true });
    const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => stop('Pig child idle timeout.'), idleMs); idle.unref(); };
    resetIdle();
    const deadline = setTimeout(() => stop('Pig child hard runtime limit.'), maxMs); deadline.unref();
    const event = line => {
      if (!line.trim()) return;
      let data;
      try { data = JSON.parse(line); } catch { return stop('Pig child emitted malformed JSON.'); }
      try { onEvent(data); } catch (error) { return stop(`Pig event observer failed: ${error.message}`); }
      if (data.type === 'turn_end' && ++turns > maxTurns) stop('Pig child turn budget exceeded.');
      if (data.type === 'message_end' && data.message?.role === 'assistant') {
        const message = data.message;
        if (message.stopReason === 'error' || message.stopReason === 'aborted') stop(message.errorMessage || `Pig child ${message.stopReason}.`);
        const usage = message.usage ?? {};
        tokens += Number(usage.totalTokens ?? ((usage.input ?? 0) + (usage.output ?? 0))) || 0;
        if (tokens > maxTokens) stop('Pig child token budget exceeded.');
        const text = (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
        if (text) answer = cap(text);
      }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      resetIdle(); tail += chunk;
      let newline;
      while ((newline = tail.indexOf('\n')) >= 0) { const line = tail.slice(0, newline); tail = tail.slice(newline + 1); if (Buffer.byteLength(line) > MAX_EVENT) stop('Pig JSON event exceeds 1 MiB.'); else event(line); }
      if (Buffer.byteLength(tail) > MAX_EVENT) { tail = ''; stop('Pig JSON event exceeds 1 MiB.'); }
    });
    child.stderr.on('data', chunk => { stderr = cap(stderr + chunk, 4096); });
    let settled = false;
    const finish = error => {
      if (settled) return; settled = true;
      clearTimeout(idle); clearTimeout(deadline); signal?.removeEventListener('abort', abort);
      fs.rmSync(dir, { recursive: true, force: true });
      if (error) reject(error); else resolve({ answer, turns, tokens });
    };
    child.on('error', finish);
    child.on('close', (code, exitSignal) => {
      if (tail.trim()) event(tail);
      finish(failure || (code !== 0 ? new Error(`Pig child exited ${exitSignal || code}: ${stderr}`) : !answer ? new Error('Pig child returned no assistant answer.') : undefined));
    });
  });
}

export default function localSubagent(pi, { resolveProfile } = {}) {
  const tasks = new Map();
  let active = 0;
  const waiters = [];
  async function permit(signal) {
    if (signal.aborted) throw new Error('Delegation cancelled.');
    if (active < 3) active++;
    else await new Promise((resolve, reject) => {
      const waiter = { resolve: () => { signal.removeEventListener('abort', abort); resolve(); } };
      const abort = () => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error('Delegation cancelled.')); };
      waiters.push(waiter); signal.addEventListener('abort', abort, { once: true });
    });
    return () => { const waiter = waiters.shift(); if (waiter) waiter.resolve(); else active--; };
  }
  let session, latestCtx;
  const ownsBranch = (task, ctx) => !task.ownerEntry || ctx.sessionManager.getBranch().some(entry => entry.id === task.ownerEntry);
  pi.on('session_start', (_event, ctx) => { session = ctx.sessionManager.getSessionId(); latestCtx = ctx; });
  pi.on('agent_settled', (_event, ctx) => { latestCtx = ctx; });
  pi.on('session_tree', (_event, ctx) => {
    latestCtx = ctx;
    for (const task of tasks.values()) if (task.status === 'running' && !ownsBranch(task, ctx)) task.controller.abort();
  });
  pi.on('session_shutdown', async () => {
    for (const task of tasks.values()) task.controller.abort();
    await Promise.allSettled([...tasks.values()].map(task => task.done));
    tasks.clear();
  });
  pi.registerTool({ name: 'delegate_task', label: 'Pig Subagent', parameters,
    description: 'Launch bounded read-only Pig children in the current workspace. Roles: scout, reviewer, researcher. Supports single packets, parallel tasks, and chains with {previous}. TUI/RPC returns a local handle and one follow-up; headless mode awaits the results. Isolated/write-capable requests are rejected, never downgraded.',
    promptGuidelines: ['Use mode direct only for read-only work. Local Pig workers use read, grep, find and ls with all ambient extensions, skills and project files disabled. This is tool-level restriction, not an OS sandbox.', 'Isolated checked graphs are not available until Herdr supports Pig; do not fall back to a direct writing worker.'],
    async execute(_id, input, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const workflow = parseRequest(input);
      const { binary, agent } = configurePig();
      const config = JSON.parse(fs.readFileSync(new URL('./port-config.json', import.meta.url), 'utf8'));
      const userConfig = path.join(agent, 'pig-port.json');
      if (fs.existsSync(userConfig)) config.taskProfiles = JSON.parse(fs.readFileSync(userConfig, 'utf8')).taskProfiles ?? config.taskProfiles;
      for (const packet of workflow.packets) {
        let profile = packet.modelClass ? config.taskProfiles?.[packet.modelClass] : undefined;
        if (packet.modelClass && !profile && resolveProfile) {
          profile = resolveProfile(ctx, packet.modelClass);
          config.taskProfiles ??= {}; config.taskProfiles[packet.modelClass] = profile;
        }
        if (packet.modelClass && (!profile || typeof profile.model !== 'string' || !profile.model.includes('/'))) throw new Error(`No valid Pig task profile configured for ${packet.modelClass}; add taskProfiles in ${userConfig} or omit modelClass.`);
        if (packet.model !== undefined && (typeof packet.model !== 'string' || !packet.model.includes('/'))) throw new Error('Pig delegate model must be a provider/model reference.');
      }
      for (const [key, task] of tasks) if (tasks.size >= 64 && task.status !== 'running') tasks.delete(key);
      if (tasks.size >= 64) throw new Error('Pig delegation task limit reached; wait for active workers.');
      const defaultModel = `${ctx.model.provider}/${ctx.model.id}`;
      const defaultThinking = pi.getThinkingLevel() || 'off';
      const id = `direct-${randomUUID()}`;
      const controller = new AbortController();
      const launchSession = session;
      const foreground = !ctx.hasUI;
      const state = { id, status: 'running', controller, entries: [], ownerEntry: ctx.sessionManager.getLeafId?.() };
      const resultText = () => cap(`Pig delegation ${id}: ${state.status}\n` + state.entries.map(e => `${e.name} (${e.role}, ${e.model}): ${e.answer || e.error || e.status}`).join('\n\n') + (state.error ? `\n${state.error}` : ''));
      const run = async (packet, previous = '') => {
        // Class profiles are explicit configuration, not aliases for the current
        // model. Refuse missing profiles instead of silently ignoring a request.
        const profile = packet.modelClass ? config.taskProfiles?.[packet.modelClass] : undefined;
        if (packet.modelClass && !profile) throw new Error(`No Pig task profile configured for ${packet.modelClass}; add taskProfiles in ${userConfig} or omit modelClass.`);
        const model = packet.model || profile?.model || defaultModel;
        const provider = model.split('/')[0];
        const selectedThinking = profile?.thinking || defaultThinking;
        const thinking = selectedThinking === 'none' ? 'off' : selectedThinking;
        const entry = { name: packet.name, role: packet.role, model, status: 'running' }; state.entries.push(entry);
        const release = await permit(controller.signal);
        try {
          controller.signal.throwIfAborted();
          const result = await spawnReadOnlyPig({ binary, cwd: ctx.cwd, model, thinking, signal: controller.signal,
            providerExtensions: (config.providerExtensions?.[provider] ?? []).map(entry => fileURLToPath(new URL(entry, import.meta.url))),
            prompt: `You are a delegated Pig ${packet.role}, not Main.\n${roles[packet.role]}\nNo writing, shell execution, recursive delegation, network access, or privileged actions.\n\nBounded task:\n${packet.task.replaceAll('{previous}', previous)}` });
          Object.assign(entry, result, { status: 'completed' }); return result.answer;
        } catch (error) { entry.status = 'failed'; entry.error = cap(error.message); throw error; }
        finally { release(); }
      };
      // Own the background lifetime independently from the launch tool's signal.
      // Session shutdown cancels and drains it before the runtime exits.
      state.done = (async () => {
        await new Promise(resolve => setImmediate(resolve));
        try {
          if (workflow.mode === 'parallel') {
            // Bound productive concurrency to three, independently of packet count.
            let next = 0;
            await Promise.allSettled(Array.from({ length: Math.min(3, workflow.packets.length) }, async () => {
              while (next < workflow.packets.length) { const packet = workflow.packets[next++]; try { await run(packet); } catch {} }
            }));
          } else { let previous = ''; for (const packet of workflow.packets) previous = await run(packet, previous); }
          state.status = state.entries.some(e => e.status === 'failed') ? 'failed' : 'completed';
        } catch (error) { state.status = 'failed'; state.error = cap(error.message); }
        if (!foreground && !controller.signal.aborted && launchSession === session) {
          try {
            if (ownsBranch(state, latestCtx ?? ctx)) pi.sendMessage({ customType: 'pig-subagent-result', display: true,
              content: resultText(), details: { id, status: state.status, entries: state.entries } }, { triggerTurn: true, deliverAs: 'followUp' });
          } catch (error) { state.deliveryError = cap(error.message); }
        }
      })();
      tasks.set(id, state);
      if (foreground) {
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        try {
          if (signal?.aborted) abort();
          await state.done;
          signal?.throwIfAborted();
          return { content: [{ type: 'text', text: resultText() }], details: { id, status: state.status, entries: state.entries }, isError: state.status !== 'completed' };
        } finally { signal?.removeEventListener('abort', abort); }
      }
      return { content: [{ type: 'text', text: `Pig delegation started: ${id}. ${workflow.packets.length} read-only task(s). Results will arrive as one follow-up message.` }], details: { id } };
    },
  });
  pi.registerCommand('subagent', { description: 'Inspect, show or cancel local Pig read-only workers: /subagent [show|cancel <id>]',
    handler: async (args, ctx) => {
      const [action, id] = args.trim().split(/\s+/);
      if (action === 'cancel') { const task = tasks.get(id); if (!task) throw new Error('Unknown local Pig task.'); task.controller.abort(); await task.done; task.status = 'cancelled'; }
      if (action === 'show') {
        const task = tasks.get(id); if (!task) throw new Error('Unknown local Pig task.');
        ctx.ui.notify(cap(task.entries.map(e => `${e.name}: ${e.answer || e.error || e.status}`).join('\n\n')), 'info');
      } else ctx.ui.notify([...tasks.values()].map(t => `${t.id}: ${t.status}`).join('\n') || 'No local Pig workers.', 'info');
    },
  });
}
