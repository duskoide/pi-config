#!/usr/bin/env node
// pi-config: yolo patches for @gotgenes/pi-permission-system
//
// Desired policy:
//   yoloMode ON  — auto-approve EVERYTHING; `sudo *` is DENIED outright.
//   yoloMode OFF — stock package behavior; `sudo *` (config: ask) prompts.
//
// The package ships two mechanisms that defeat the "approve everything" half:
//
//  1. rewriteAsksToYolo (src/rule.ts) only tags `ask` rules as yolo; plain
//     `allow` rules keep their original origin.
//  2. The bash wrapper floor (src/handlers/gates/bash-command.ts) clamps any
//     `allow` for indirection/opaque wrappers (env, sudo, xargs, bash -c,
//     eval, find -exec, ...) back to `ask` — the docs call this absolute.
//
// Patches applied (idempotent, marker-guarded, upgrade-safe via install.sh):
//
//  rule.ts          — under yolo, tag both `ask` AND `allow` rules with
//                     origin "yolo" (so the wrapper-floor bypass below
//                     applies to them); bash patterns matching sudo* that are
//                     `ask` become `deny` instead, so sudo is blocked while
//                     yolo is on but prompts when yolo is off. `deny` rules
//                     are untouched.
//  bash-command.ts  — skip the wrapper floor when the matched rule carries
//                     origin "yolo" (i.e. only while yolo mode is enabled;
//                     disabling yoloMode restores the stock hardening).
//                     (Note: an unparseable string is opaque by definition,
//                     so under yolo an unparseable `sudo …` would be allowed
//                     too — inherent to "allow all unparseable".)
//
// Known residuals (unchanged stock behavior):
//  - unknown/unregistered tools are still blocked before permission checks
//  - explicit `deny` rules always win
//
// Usage: node patches/patch-pi-permission-system.mjs <package-or-agent-dir>
// Exit 0 = patched or already patched; exit 1 = package layout changed.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MARKER_V1 = "// pi-config:yolo-patch-v1";
const MARKER_V2 = "// pi-config:yolo-patch-v2";
const MARKER_V3 = "// pi-config:yolo-patch-v3";
// Argument is either the unified package root (pi-config repo, package
// installed at <root>/node_modules) or the legacy pi agent dir
// (<root>/npm/node_modules).
const root = process.argv[2] ?? join(process.env.HOME, ".pi", "agent");
const unifiedPkg = join(root, "node_modules", "@gotgenes", "pi-permission-system");
const legacyPkg = join(root, "npm", "node_modules", "@gotgenes", "pi-permission-system");
const pkgDir = existsSync(unifiedPkg) ? unifiedPkg : legacyPkg;

if (!existsSync(pkgDir)) {
  console.error(`patch-pi-permission-system: package not found at ${pkgDir}`);
  process.exit(1);
}

function read(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    console.error(`patch-pi-permission-system: cannot read ${file}: ${err.message}`);
    process.exit(1);
  }
}

function write(file, src) {
  writeFileSync(file, src, "utf8");
}

// ── rule.ts ────────────────────────────────────────────────────────────────

const RULE_PRISTINE = `export function rewriteAsksToYolo(rules: Ruleset): Ruleset {
  return rules.map((rule) =>
    rule.action === "ask" ? { ...rule, action: "allow", origin: "yolo" } : rule,
  );
}`;

const RULE_V1 = `${MARKER_V1}
const YOLO_PROMPT_PATTERNS = [/^sudo(\\s|$|\\*)/];

function isYoloPromptExempt(rule: Rule): boolean {
  return (
    rule.surface === "bash" &&
    YOLO_PROMPT_PATTERNS.some((re) => re.test(rule.pattern))
  );
}

export function rewriteAsksToYolo(rules: Ruleset): Ruleset {
  return rules.map((rule) =>
    rule.action === "ask" || rule.action === "allow"
      ? isYoloPromptExempt(rule)
        ? rule
        : { ...rule, action: "allow", origin: "yolo" }
      : rule,
  );
}`;

const RULE_V2 = `${MARKER_V2}
const YOLO_PROMPT_PATTERNS = [/^sudo(\\s|$|\\*)/];

function isYoloPromptExempt(rule: Rule): boolean {
  return (
    rule.surface === "bash" &&
    YOLO_PROMPT_PATTERNS.some((re) => re.test(rule.pattern))
  );
}

export function rewriteAsksToYolo(rules: Ruleset): Ruleset {
  return rules.map((rule) => {
    if (isYoloPromptExempt(rule)) {
      // sudo*: an ask becomes a hard deny under yolo (it prompts when yolo
      // is off, because this rewrite only runs while yolo is enabled).
      return rule.action === "ask"
        ? { ...rule, action: "deny", origin: "yolo" }
        : rule;
    }
    return rule.action === "ask" || rule.action === "allow"
      ? { ...rule, action: "allow", origin: "yolo" }
      : rule;
  });
}`;

{
  const file = join(pkgDir, "src/rule.ts");
  const src = read(file);
  if (src.includes(MARKER_V2)) {
    console.log("patch-pi-permission-system: src/rule.ts already patched (v2)");
  } else if (src.includes(RULE_V1)) {
    write(file, src.replace(RULE_V1, RULE_V2));
    console.log("patch-pi-permission-system: patched src/rule.ts (v1 -> v2)");
  } else if (src.includes(RULE_PRISTINE)) {
    write(file, src.replace(RULE_PRISTINE, RULE_V2));
    console.log("patch-pi-permission-system: patched src/rule.ts (pristine -> v2)");
  } else {
    console.error(
      "patch-pi-permission-system: expected source not found in src/rule.ts; " +
        "package likely changed — review and update this patch",
    );
    process.exit(1);
  }
}

// ── bash-command.ts ────────────────────────────────────────────────────────

{
  const relativePath = "src/handlers/gates/bash-command.ts";
  const file = join(pkgDir, relativePath);
  const src = read(file);
  if (src.includes(MARKER_V1) || src.includes(MARKER_V2)) {
    console.log(`patch-pi-permission-system: ${relativePath} already patched`);
  } else {
    const original = `    const result =
      cmd.wrapperKind && base.state === "allow"`;
    if (!src.includes(original)) {
      console.error(
        `patch-pi-permission-system: expected source not found in ${relativePath}; ` +
          "package likely changed — review and update this patch",
      );
      process.exit(1);
    }
    write(
      file,
      src.replace(
        original,
        `    // ${MARKER_V2} yolo-tagged allows bypass the wrapper floor
    const result =
      cmd.wrapperKind && base.state === "allow" && base.origin !== "yolo"`,
      ),
    );
    console.log(`patch-pi-permission-system: patched ${relativePath}`);
  }
}

// ── bash-command.ts (unparseable fallback) ─────────────────────────────

{
  const relativePath = "src/handlers/gates/bash-command.ts";
  const file = join(pkgDir, relativePath);
  const src = read(file);
  if (src.includes(MARKER_V3)) {
    console.log(
      `patch-pi-permission-system: ${relativePath} unparseable fallback already patched`,
    );
  } else {
    const original = `    return {
      state: "ask",
      toolName: "bash",
      source: "bash",
      origin: "builtin",
      command,
      matchedPattern: "<unparseable-bash-command>",
    };`;
    if (!src.includes(original)) {
      console.error(
        `patch-pi-permission-system: expected source not found in ${relativePath}; ` +
          "package likely changed — review and update this patch",
      );
      process.exit(1);
    }
    write(
      file,
      src.replace(
        original,
        `    // ${MARKER_V3} under yolo, auto-allow unparseable commands. Yolo is
    // detected by probing the ruleset: while yolo is enabled, every
    // allow/ask rule carries origin "yolo" (rewriteAsksToYolo), so a
    // benign resolve reveals the mode without new plumbing. Without
    // yolo the stock fail-closed ask is preserved.
    const yoloProbe = resolver.resolve({
      kind: "tool",
      surface: "bash",
      input: { command },
      agentName,
    });
    if (yoloProbe.state === "allow" && yoloProbe.origin === "yolo") {
      return {
        state: "allow",
        toolName: "bash",
        source: "bash",
        origin: "yolo",
        command,
        matchedPattern: "<unparseable-bash-command>",
      };
    }
    return {
      state: "ask",
      toolName: "bash",
      source: "bash",
      origin: "builtin",
      command,
      matchedPattern: "<unparseable-bash-command>",
    };`,
      ),
    );
    console.log(
      `patch-pi-permission-system: patched ${relativePath} unparseable fallback`,
    );
  }
}

console.log("patch-pi-permission-system: done");
