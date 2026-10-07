import path from 'node:path';

// These transformations apply only to our private copy of the pinned extension
// sources. They never edit Pi's npm cache or the SDK supplied by Pig.
export function portSource(source, relativePath) {
  let text = source;
  const changes = [];
  const replace = (name, from, to, required = false) => {
    const next = typeof from === 'string' ? text.replaceAll(from, to) : text.replace(from, to);
    if (required && next === text) throw new Error(`Port anchor drift: ${relativePath}: ${name}`);
    if (next !== text) changes.push(name);
    text = next;
  };

  // Cover joined paths, escaped paths, instructions, and regular expressions.
  // Do not change package IDs, pi.events, URLs, or the package manifest's pi key.
  replace('separate Pig filesystem namespace', /https?:\/\/[^\s"'`<>]+|(?<![A-Za-z0-9_.-])\.pi(?=[/\\"'`])/g,
    match => /^https?:\/\//.test(match) ? match : '.pig');

  // getAgentDir() already belongs to Pig's compatibility SDK. Legacy extensions
  // which read this environment variable receive it from the wrapper instead.
  // Hard-coded home/agent paths need to respect PIG_HOME and agent-dir overrides.
  replace('configurable agent directory', /\b(join\d*|path\.join)\((?:homedir\(\)|getHomeDir\d*\(\)|getHomeDir\(\)|home|HOME_DIR|process\.env\.HOME \?\? homedir\(\)),\s*["']\.pig["'],\s*["']agent["']/g,
    (_match, join) => `${join}(process.env.PI_CODING_AGENT_DIR`);
  replace('configurable Pig root', /\b(join\d*|path\.join)\((?:homedir\(\)|getHomeDir\d*\(\)|getHomeDir\(\)|home|HOME_DIR|process\.env\.HOME \?\? homedir\(\)),\s*["']\.pig["']/g,
    (_match, join) => `${join}(process.env.PIG_PORT_HOME`);

  if (relativePath === '@henryqw/pi-subagent/dist/ephemeral.js') {
    replace('accept Pig extension host',
      'if (process.env.PI_CODING_AGENT !== "true" || (process.title !== "pi" && process.title !== "pi-rpc")) {',
      'if (!process.env.PIG_EXT_SOCKET && (process.env.PI_CODING_AGENT !== "true" || (process.title !== "pi" && process.title !== "pi-rpc"))) {', true);
    replace('launch Pig rather than Node extension runner', 'function piInvocation() {',
      'function piInvocation() {\n    if (process.env.PIG_PORT_BINARY) return { command: process.env.PIG_PORT_BINARY, args: [] };', true);
  }
  if (relativePath === 'pi-background-tasks/src/core/pi-launch.ts') {
    replace('Pig background child executable',
      'export function resolvePiLaunch(deps: PiLaunchDependencies = {}): PiLaunchSpec {',
      "export function resolvePiLaunch(deps: PiLaunchDependencies = {}): PiLaunchSpec {\n  if (process.env.PIG_PORT_BINARY) return { executable: process.env.PIG_PORT_BINARY, argvPrefix: [], kind: 'path' };", true);
  }
  if (relativePath === 'pi-background-tasks/src/core/registry.ts') {
    replace('instrument pig shell invocations', 'commandToSpawn = `pi() {', 'commandToSpawn = `pig() {', true);
  }
  if (relativePath === 'pi-powerline-footer/bash-mode/editor.ts') {
    // Pig hands editor factories pi-tui's base manager, not Pi's app subclass.
    // The subclass's getEffectiveConfig is exactly getResolvedBindings, which
    // includes host defaults, user overrides and disabled bindings. Do not
    // substitute an empty/default-only map or patch the shared SDK prototype.
    replace('Pig editor resolved keybindings', 'this.keybindingsRef.getEffectiveConfig()', 'this.keybindingsRef.getResolvedBindings()', true);
    replace('Pig editor conflict keybindings', 'const getEffectiveConfig = this.keybindingsRef.getEffectiveConfig;', 'const getEffectiveConfig = this.keybindingsRef.getResolvedBindings;', true);
  }
  if (relativePath === 'pi-agent-teleport/src/index.ts') {
    replace('Pig teleport continuation', ' pi --approve --session ', ' pig --approve --session ', true);
  }
  // Tool names and persisted upstream schemas remain stable. Attestations are
  // not renamed or reinterpreted: the Pi-only attested tool is blocked below.
  return { text, changes };
}

export function wrapperSource(importPath, adapterPath, packageName) {
  if (packageName === '@henryqw/pi-subagent') return `// Generated local Pig subagent bridge.\nimport { configurePig, adaptExtension } from ${JSON.stringify(adapterPath)};\nimport extension from ${JSON.stringify(importPath)};\nimport { registerModelTask, loadTaskModelsConfig, orderedProfileRoutes, resolveTaskModelRoute } from '../node_modules/@henryqw/pi-task-models/dist/index.js';\nexport default function pigSubagent(pi) {\n  configurePig();\n  registerModelTask(pi, {id:'pi-subagent/delegateTask',label:'Pig local delegation',purpose:'Launch bounded read-only Pig workers.',defaultProfile:'fast'});\n  return extension(adaptExtension(pi, '@henryqw/pi-subagent'), {resolveProfile(ctx, name) {\n    const loaded = loadTaskModelsConfig();\n    const profile = loaded.value?.profiles?.[name];\n    if (!profile) throw new Error('Pig task profile '+name+' is not configured. Run /task-models.');\n    for (const route of orderedProfileRoutes(profile)) {\n      const resolved = resolveTaskModelRoute(ctx, route);\n      if (resolved) return {model:resolved.model.provider+'/'+resolved.model.id,thinking:resolved.thinkingLevel};\n    }\n    throw new Error('Pig task profile '+name+' has no available route. Run /task-models.');\n  }});\n}\n`;
  return `// Generated Pig port of ${packageName}; edit pig/lib, not this file.\nimport { configurePig, adaptExtension } from ${JSON.stringify(adapterPath)};\nimport extension from ${JSON.stringify(importPath)};\nexport default async function pigPort(pi) {\n  configurePig();\n  return extension(adaptExtension(pi, ${JSON.stringify(packageName)}));\n}\n`;
}

export function extensionName(packageName, member) {
  return `${packageName.replace(/^@/, '').replaceAll('/', '-')}-${path.basename(member, path.extname(member))}`;
}
