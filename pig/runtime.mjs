import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function canonicalPath(value) {
  let dir = path.resolve(value);
  const missing = [];
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) { missing.unshift(path.basename(dir)); dir = path.dirname(dir); }
  return path.join(fs.realpathSync(dir), ...missing);
}
export function assertPigIsolation(root, agent, home = os.homedir()) {
  const pi = canonicalPath(path.join(home, '.pi'));
  for (const value of [root, agent]) {
    const resolved = canonicalPath(value);
    const relative = path.relative(pi, resolved);
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Refusing Pig output inside the Pi configuration tree (including symlinks).');
  }
}
export function configurePig(env = process.env, home = os.homedir()) {
  if (env.PIG_USE_PI_DIRS === '1') throw new Error('Pig ports require a separate Pig config root; unset PIG_USE_PI_DIRS.');
  const root = path.resolve(env.PIG_HOME || (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'pig') : path.join(home, '.pig')));
  const agent = path.resolve(env.PIG_CODING_AGENT_DIR || path.join(root, 'agent'));
  assertPigIsolation(root, agent, home);
  env.PI_CODING_AGENT_DIR = agent;
  env.PIG_PORT_HOME = root;
  // Legacy Pi libraries use this variable; no Pi process is launched.
  env.PI_CODING_AGENT_SESSION_DIR = env.PIG_CODING_AGENT_SESSION_DIR || path.join(agent, 'sessions');
  if (!env.PIG_PORT_BINARY) {
    const config = JSON.parse(fs.readFileSync(new URL('./port-config.json', import.meta.url), 'utf8'));
    env.PIG_PORT_BINARY = config.binary;
  }
  return { root, agent, binary: env.PIG_PORT_BINARY };
}

export function adaptExtension(pi, packageName) {
  return new Proxy(pi, {
    get(target, key) {
      if (key === 'registerTool') return definition => {
        // This producer promises a Pi-specific attestation with OAuth/channel
        // evidence. Changing its executable is not enough to attest a Pig run.
        if (packageName === 'pi-background-tasks' && definition.name === 'bg_run_pi_attested') return;
        if (packageName === 'pi-agent-teleport' && definition.name === 'teleport') {
          const execute = definition.execute;
          definition = { ...definition, execute: async (...args) => {
            const params = args[1];
            if (['jump', 'back'].includes(params.action) && process.env.HERDR_ENV !== '1') {
              throw new Error('Pig directory handoff currently requires Herdr. Pig session replacement keeps the old project services (D61); refusing to claim a successful directory change. Worktree create/history/remove remain available.');
            }
            return execute(...args);
          } };
        }
        return target.registerTool(definition);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// Static-import wrappers evaluate this before the extension's module body, so
// even module-level legacy path constants see Pig's directories.
if (fs.existsSync(new URL('./port-config.json', import.meta.url))) configurePig();
