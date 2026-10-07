#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { portSource, wrapperSource, extensionName } from '../pig/lib/port-source.mjs';
import { assertPigIsolation } from '../pig/runtime.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function configPaths(env = process.env, home = os.homedir()) {
  if (env.PIG_USE_PI_DIRS === '1') throw new Error('Unset PIG_USE_PI_DIRS: this port requires separate Pig configuration.');
  const root = path.resolve(env.PIG_HOME || (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'pig') : path.join(home, '.pig')));
  const agent = path.resolve(env.PIG_CODING_AGENT_DIR || path.join(root, 'agent'));
  assertPigIsolation(root, agent, home);
  return { root, agent };
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
export function portableProviderConfig(config) {
  if (!Array.isArray(config.providers)) throw new Error('custom-providers.json providers must be an array.');
  return { ...config, providers: config.providers.map(provider => {
    const entry = { ...provider };
    if (typeof entry.apiKey === 'string' && entry.apiKey && !/^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(entry.apiKey)) {
      entry.apiKey = `$${String(entry.name).replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`;
    }
    // No startup probe with a missing migrated key. Refresh is explicit.
    entry.fetchModels = false;
    return entry;
  }) };
}
function regularFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${file}`);
    return entry.isDirectory() ? regularFiles(file) : entry.isFile() ? [file] : [];
  });
}
export function extensionMembers(root, pkg, filter) {
  const declarations = filter ?? pkg.pi?.extensions;
  const candidates = declarations ?? ['extensions'];
  const result = [];
  for (let member of candidates) {
    member = member.replace(/^\.\//, '');
    if (member.includes('*') || member.startsWith('!') || member.startsWith('-')) throw new Error(`Unsupported extension selection ${pkg.name}: ${member}`);
    const file = path.resolve(root, member);
    if (path.relative(root, file).startsWith('..')) throw new Error(`Escaping member: ${member}`);
    if (!fs.existsSync(file)) {
      if (declarations) throw new Error(`Missing extension member: ${pkg.name}/${member}`);
      continue;
    }
    if (fs.statSync(file).isDirectory()) {
      const index = ['index.ts', 'index.js'].find(name => fs.existsSync(path.join(file, name)));
      if (index) result.push(path.join(member, index));
      else for (const entry of fs.readdirSync(file, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
        if (entry.isFile() && /\.(?:ts|js|mjs)$/.test(entry.name)) result.push(path.join(member, entry.name));
        else if (entry.isDirectory()) {
          const sub = ['index.ts', 'index.js'].find(name => fs.existsSync(path.join(file, entry.name, name)));
          if (sub) result.push(path.join(member, entry.name, sub));
        }
      }
    } else result.push(member);
  }
  return [...new Set(result)];
}
const sdkPackage = name => /^@(?:earendil-works|mariozechner)\/pi-/.test(name);
function resolveDependency(from, name) {
  for (let dir = from;; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === path.dirname(dir)) return undefined;
  }
}
// Copy only the active dependency closure. Sources and licenses are preserved;
// installed but unselected packages do not become ambient Pig extensions.
function copyClosure(cache, target, ports) {
  const seen = new Set();
  const copy = (source) => {
    const rel = path.relative(path.join(cache, 'node_modules'), source);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Dependency escapes cache: ${source}`);
    if (seen.has(rel)) return;
    seen.add(rel);
    const pkg = json(path.join(source, 'package.json'));
    const destination = path.join(target, 'node_modules', rel);
    fs.cpSync(source, destination, { recursive: true, filter: file => !/(?:^|[/\\])(?:\.git|\.bin)(?:[/\\]|$)/.test(file) });
    for (const [name, optional] of [
      ...Object.keys(pkg.dependencies ?? {}).map(name => [name, false]),
      ...Object.keys(pkg.optionalDependencies ?? {}).map(name => [name, true]),
      ...Object.keys(pkg.peerDependencies ?? {}).filter(name => !sdkPackage(name)).map(name => [name, true]),
    ]) {
      if (sdkPackage(name)) continue;
      const dependency = resolveDependency(source, name);
      if (dependency) copy(dependency);
      else if (!optional) throw new Error(`Missing installed dependency ${pkg.name} -> ${name}`);
    }
  };
  for (const port of ports.packages) {
    const source = path.join(cache, 'node_modules', port.name);
    const pkg = json(path.join(source, 'package.json'));
    if (pkg.version !== port.version) throw new Error(`Version drift: ${port.name}: expected ${port.version}, found ${pkg.version}`);
    copy(source);
  }
  // All selected tools use TypeBox, including packages with SDK peers only.
  const typebox = path.join(cache, 'node_modules', 'typebox');
  if (fs.existsSync(typebox)) copy(typebox);
  return [...seen];
}
export function prepareBundle({ cache, destination, binary, root = repoRoot }) {
  const ports = json(path.join(root, 'pig/ports.json'));
  if (fs.existsSync(destination)) throw new Error(`Staging destination already exists: ${destination}`);
  fs.mkdirSync(destination, { recursive: true });
  const dependencies = copyClosure(cache, destination, ports);
  fs.copyFileSync(path.join(root, 'pig/runtime.mjs'), path.join(destination, 'runtime.mjs'));
  fs.copyFileSync(path.join(root, 'pig/subagent.mjs'), path.join(destination, 'subagent.mjs'));
  fs.cpSync(path.join(root, 'extensions'), path.join(destination, 'local'), { recursive: true });
  const mutations = [];
  for (const name of dependencies) {
    // Third-party non-Pi dependencies are copied, but never rewritten.
    if (!/(?:^|[/\\])(?:pi-[^/\\]+|rpiv-[^/\\]+|image-paste|pix-runtime|pix-pretty)(?:[/\\]|$)/.test(name)) continue;
    for (const file of regularFiles(path.join(destination, 'node_modules', name))) {
      if (!/\.(?:[cm]?js|ts|md)$/.test(file) || file.endsWith('.d.ts')) continue;
      const relative = path.relative(path.join(destination, 'node_modules'), file).split(path.sep).join('/');
      const { text, changes } = portSource(fs.readFileSync(file, 'utf8'), relative);
      if (changes.length) { fs.writeFileSync(file, text); mutations.push({ file: relative, changes }); }
    }
  }
  const extensions = [];
  const inventory = [];
  for (const port of ports.packages) {
    const source = path.join(destination, 'node_modules', port.name);
    const pkg = json(path.join(source, 'package.json'));
    const members = extensionMembers(source, pkg, port.extensions);
    const resources = [];
    for (const member of members) {
      const name = extensionName(port.name, member);
      const entry = `extensions/${name}.ts`;
      fs.mkdirSync(path.join(destination, 'extensions'), { recursive: true });
      const importPath = port.name === '@henryqw/pi-subagent' ? '../subagent.mjs' : `../node_modules/${port.name}/${member}`;
      fs.writeFileSync(path.join(destination, entry), wrapperSource(importPath, '../runtime.mjs', port.name));
      extensions.push(entry); resources.push({ name, member, entry });
    }
    inventory.push({ ...port, resources, ...(members.length ? {} : { inactive: 'No extension members declared or discovered in the original package.' }) });
  }
  for (const member of ports.localExtensions) {
    const entry = `extensions/local-${member}`;
    fs.writeFileSync(path.join(destination, entry), wrapperSource(`../local/${member}`, '../runtime.mjs', `local:${member}`));
    extensions.push(entry);
  }
  // Port the PDF cache too, without changing the original Pi extension.
  const pdf = path.join(destination, 'local/pdf-to-markdown.ts');
  const pdfSource = fs.readFileSync(pdf, 'utf8');
  const warmup = '  // Warm up the environment in the background so first call is fast.\n  pi.on("session_start", () => {\n    ensureEnvironment().catch(() => {});\n  });';
  if (!pdfSource.includes(warmup)) throw new Error('PDF lazy-setup anchor drift.');
  fs.writeFileSync(pdf, pdfSource.replaceAll('pi-pdf2md', 'pig-pdf2md').replace(warmup, '  // Pig port: install the PDF engine only when conversion is requested.'));
  save(path.join(destination, 'package.json'), {
    name: 'pig-pi-config', private: true, version: '1.0.0', type: 'module',
    description: 'Pig-compatible private ports of the configured Pi extensions',
    pi: { extensions, skills: ports.packages.filter(p => p.name !== '@henryqw/pi-subagent' && fs.existsSync(path.join(destination, 'node_modules', p.name, 'skills'))).map(p => `node_modules/${p.name}/skills`).concat(['skills']) },
  });
  fs.cpSync(path.join(root, 'skills'), path.join(destination, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(destination, 'skills/pi-subagent'), { recursive: true });
  fs.copyFileSync(path.join(root, 'pig/subagent-SKILL.md'), path.join(destination, 'skills/pi-subagent/SKILL.md'));
  const providerPackages = { commandcode: 'pi-commandcode-provider', qoder: 'pi-provider-qoder', antigravity: 'pi-antigravity' };
  save(path.join(destination, 'port-config.json'), { binary: path.resolve(binary),
    providerExtensions: Object.fromEntries(Object.entries(providerPackages).map(([provider, name]) => [provider,
      inventory.find(p => p.name === name)?.resources.map(r => r.entry) ?? []])),
    taskProfiles: {},
  });
  const hashes = regularFiles(destination).filter(f => !f.endsWith('port-report.json')).map(file => ({
    file: path.relative(destination, file).split(path.sep).join('/'),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  }));
  const report = { schemaVersion: 1, pigVersion: ports.pigVersion, inventory, extensions, dependencies, mutations, hashes };
  save(path.join(destination, 'port-report.json'), report);
  return report;
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.status}`);
}
export function findBinary(env = process.env) {
  if (env.PIG_BINARY) return fs.realpathSync(env.PIG_BINARY);
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(dir, process.platform === 'win32' ? 'pig.exe' : 'pig');
    if (fs.existsSync(file)) return fs.realpathSync(file);
  }
  throw new Error('pig is not on PATH; install Pig or set PIG_BINARY.');
}
export function dependencySource(argv, cache) {
  const exists = fs.existsSync(path.join(cache, 'node_modules'));
  if (argv.includes('--from-pi-cache') && !exists) throw new Error(`Pi npm cache is missing at ${cache}; cache-only mode never downloads. Use --download explicitly.`);
  return argv.includes('--download') || !exists ? 'download' : 'cache';
}
export function destinationPath(agent, prepareOnly) {
  return path.join(agent, prepareOnly ? `pig-pi-config-preview-${crypto.randomUUID()}` : 'pig-pi-config');
}
export function createStagingDirectory(agent) {
  const root = fs.mkdtempSync(path.join(agent, '.pig-pi-config-stage-'));
  return { root, bundle: path.join(root, 'bundle') };
}
export function publishBundle({ stage, target, agent, configFiles = [] }) {
  const settingsFile = path.join(agent, 'settings.json');
  const lock = `${settingsFile}.lock`;
  fs.mkdirSync(lock); // Same directory-lock convention as Pig/Pi; never steal a live lock.
  let previousTarget, moved = false, settingsChanged = false;
  const createdConfig = [];
  let oldSettings;
  try {
    if (fs.existsSync(settingsFile)) {
      if (fs.lstatSync(settingsFile).isSymbolicLink()) throw new Error('Refusing to replace symlinked Pig settings; use an independent Pig settings file.');
      oldSettings = fs.readFileSync(settingsFile);
    }
    const settings = oldSettings ? JSON.parse(oldSettings.toString('utf8')) : {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Pig settings must be an object.');
    const packages = settings.packages ?? [];
    if (!Array.isArray(packages)) throw new Error('Pig settings.packages must be an array.');
    if (packages.some(item => typeof item !== 'string' && (!item || typeof item.source !== 'string'))) throw new Error('Invalid Pig package entry.');
    for (const { name, content } of configFiles) {
      const dest = path.join(agent, name);
      if (!fs.existsSync(dest)) { fs.writeFileSync(dest, content, { flag: 'wx', mode: 0o600 }); createdConfig.push(dest); }
    }
    if (fs.existsSync(target)) {
      const backup = `${target}.pre-port.${Date.now()}`;
      if (fs.existsSync(backup)) throw new Error(`Backup already exists: ${backup}`);
      fs.renameSync(target, backup);
      previousTarget = backup;
    }
    fs.renameSync(stage, target); moved = true;
    settings.packages = packages.filter(item => (typeof item === 'string' ? item : item.source) !== target).concat([target]);
    const tmpRoot = fs.mkdtempSync(path.join(agent, '.pig-settings-stage-'));
    const tmp = path.join(tmpRoot, 'settings.json');
    try {
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      if (oldSettings) fs.writeFileSync(`${settingsFile}.pre-port.${Date.now()}`, oldSettings, { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, settingsFile); settingsChanged = true;
    } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
    return settingsFile;
  } catch (error) {
    // Restore only our proven mutations, never a concurrently edited user file.
    if (!settingsChanged) {
      if (moved) fs.renameSync(target, stage);
      if (previousTarget) fs.renameSync(previousTarget, target);
      for (const file of createdConfig) fs.unlinkSync(file);
    }
    throw error;
  } finally { fs.rmdirSync(lock); }
}
export function install(argv = process.argv.slice(2), env = process.env) {
  const allowed = new Set(['--prepare-only', '--from-pi-cache', '--download']);
  if (argv.some(arg => !allowed.has(arg))) throw new Error('Usage: node scripts/install-pig.mjs [--from-pi-cache|--download] [--prepare-only]');
  if (argv.includes('--from-pi-cache') && argv.includes('--download')) throw new Error('Choose one dependency source.');
  const { root, agent } = configPaths(env);
  fs.mkdirSync(agent, { recursive: true });
  const binary = findBinary(env);
  const ports = json(path.join(repoRoot, 'pig/ports.json'));
  const cache = env.PIG_PORT_NPM_CACHE || path.join(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), 'npm');
  let source = cache;
  let download;
  const sourceKind = dependencySource(argv, cache);
  const staging = createStagingDirectory(agent);
  const stage = staging.bundle;
  const target = destinationPath(agent, argv.includes('--prepare-only'));
  try {
    if (sourceKind === 'download') {
      download = fs.mkdtempSync(path.join(os.tmpdir(), 'pig-port-npm-'));
      source = download;
      const manifest = json(path.join(repoRoot, 'pig/package.json'));
      for (const port of ports.packages) if (manifest.dependencies[port.name] !== port.version) throw new Error(`Dependency manifest drift: ${port.name}`);
      fs.copyFileSync(path.join(repoRoot, 'pig/package.json'), path.join(download, 'package.json'));
      fs.copyFileSync(path.join(repoRoot, 'pig/package-lock.json'), path.join(download, 'package-lock.json'));
      run('npm', ['ci', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: download, env });
    }
    const report = prepareBundle({ cache: source, destination: stage, binary });
    console.log(`Prepared ${report.extensions.length} extension resources from ${ports.packages.length} pinned packages.`);
    // Validation constructs factories, but dispatches no sessions/tools. No live
    // provider checks or credentials are needed. A bad set never reaches settings.
    if (!argv.includes('--prepare-only')) run(binary, ['install', '--validate-only', '--json', ...report.extensions.map(entry => path.join(stage, entry))], { env });
    if (argv.includes('--prepare-only')) {
      if (fs.existsSync(target)) throw new Error(`Preview destination already exists: ${target}`);
      fs.renameSync(stage, target);
      console.log(`Prepared only (not activated): ${target}`); return target;
    }
    const configFiles = ports.configFiles.map(name => {
      const source = path.join(repoRoot, '.pi/agent', name);
      return { name, content: name === 'custom-providers.json' ? JSON.stringify(portableProviderConfig(json(source)), null, 2) + '\n' : fs.readFileSync(source) };
    });
    const settingsFile = publishBundle({ stage, target, agent, configFiles });
    console.log(`Installed: ${target}\nPig settings: ${settingsFile}\nConfig root: ${root}\nStart pig or run /reload. Credentials were not copied or changed.`);
    return target;
  } finally {
    fs.rmSync(staging.root, { recursive: true, force: true });
    if (download) fs.rmSync(download, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { install(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
