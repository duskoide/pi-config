import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getFailoverConfigPath, isExplicitFallbackRoute, MAX_FAILOVER_CONFIG_BYTES, normalizePrimaryModel, parseFailoverConfigText, readFailoverConfig } from "../extensions/delegator-config/failover-config.ts";

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "pi-delegator-failover-config-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return { directory, path: join(directory, "failover.json") };
}

const entry = { primary: "primary/model", fallback: "fallback/model" };
const policy = (profiles = { scout: entry }) => ({ version: 1, profiles });

test("reader is explicit-path, missing/empty defaults are disabled, and reads never create files", async (t) => {
	const { directory, path } = await fixture(t);
	assert.deepEqual(readFailoverConfig(path), policy({}));
	await assert.rejects(lstat(path), { code: "ENOENT" });
	await writeFile(path, JSON.stringify(policy({})));
	const before = await readFile(path);
	assert.deepEqual(readFailoverConfig(path), policy({}));
	assert.deepEqual(await readFile(path), before);
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = join(directory, "custom-agent");
		assert.equal(getFailoverConfigPath(), join(directory, "custom-agent/delegator/failover.json"));
		assert.deepEqual(readFailoverConfig(path), policy({}), "explicit path does not depend on the agent directory");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("valid normalized primary selectors, null inheritance bindings, and exact nested routes are supported", async (t) => {
	const { path } = await fixture(t);
	const document = policy({
		scout: entry,
		worker_2: { primary: null, fallback: "openai-codex/exact-model" },
		custom: { primary: "normalized fuzzy selector", fallback: "openrouter/owner/model:version" },
	});
	await writeFile(path, JSON.stringify(document));
	assert.deepEqual(readFailoverConfig(path), document);
	assert.equal(normalizePrimaryModel(null), null);
	assert.equal(normalizePrimaryModel(" model "), "model");
});

test("schema limits are UTF-8 bytes, not code units", () => {
	const fallback = `p/${"é".repeat(127)}`;
	assert.equal(Buffer.byteLength(fallback), 256);
	const name = `p${"a".repeat(63)}`;
	const document = policy({ [name]: { primary: "é".repeat(128), fallback } });
	assert.deepEqual(parseFailoverConfigText(JSON.stringify(document)), document);
	assert.equal(isExplicitFallbackRoute(fallback), true);
	assert.equal(isExplicitFallbackRoute(`${fallback}x`), false);
	assert.throws(() => parseFailoverConfigText(JSON.stringify(policy({ scout: { ...entry, primary: "é".repeat(129) } }))), /primary/);
	assert.throws(() => parseFailoverConfigText(JSON.stringify(policy({ [`${name}x`]: entry }))), /profile name/);
});

const invalidDocuments = [
	["null root", null],
	["array root", []],
	["missing version", { profiles: {} }],
	["unknown version", { version: 2, profiles: {} }],
	["string version", { version: "1", profiles: {} }],
	["unknown root fields", { ...policy({}), enabled: true }],
	["null profiles", { version: 1, profiles: null }],
	["array profiles", { version: 1, profiles: [] }],
	["uppercase profile", policy({ Scout: entry })],
	["empty profile name", policy({ "": entry })],
	["invalid profile name", policy({ "bad.name": entry })],
	["trailing newline profile", policy({ "scout\n": entry })],
	["oversized profile name", policy({ ["x".repeat(65)]: entry })],
	["null entry", policy({ scout: null })],
	["array entry", policy({ scout: [] })],
	["missing primary", policy({ scout: { fallback: entry.fallback } })],
	["missing fallback", policy({ scout: { primary: null } })],
	["unknown entry field", policy({ scout: { ...entry, thinking: "off" } })],
	["nonstrings", policy({ scout: { primary: 42, fallback: entry.fallback } })],
	["blank primary", policy({ scout: { ...entry, primary: " " } })],
	["untrimmed primary", policy({ scout: { ...entry, primary: " primary/model " } })],
	["control primary", policy({ scout: { ...entry, primary: "primary/\u0000model" } })],
	["null fallback", policy({ scout: { ...entry, fallback: null } })],
	["boolean fallback", policy({ scout: { ...entry, fallback: false } })],
	["inherited fallback", policy({ scout: { ...entry, fallback: "@inherit-parent" } })],
	["short fallback selector", policy({ scout: { ...entry, fallback: "model" } })],
	["empty provider", policy({ scout: { ...entry, fallback: "/model" } })],
	["empty id", policy({ scout: { ...entry, fallback: "provider/" } })],
	["fallback whitespace", policy({ scout: { ...entry, fallback: "provider/model " } })],
	["fallback trailing newline", policy({ scout: { ...entry, fallback: "provider/model\n" } })],
	["fallback internal whitespace", policy({ scout: { ...entry, fallback: "provider/model name" } })],
	["fallback control", policy({ scout: { ...entry, fallback: "provider/\u0000model" } })],
	["fallback wildcard", policy({ scout: { ...entry, fallback: "provider/model*" } })],
	["fallback glob", policy({ scout: { ...entry, fallback: "provider/model?" } })],
	["equal primary/fallback", policy({ scout: { primary: "provider/model", fallback: "provider/model" } })],
];
for (const [label, document] of invalidDocuments) {
	test(`strict sidecar schema rejects ${label}`, async (t) => {
		const { path } = await fixture(t);
		await writeFile(path, JSON.stringify(document));
		assert.throws(() => readFailoverConfig(path));
	});
}

test("bounded regular-file reads reject malformed JSON, invalid UTF-8, BOM, and oversized documents", async (t) => {
	const { directory, path } = await fixture(t);
	for (const bytes of ["{", Buffer.from([0xff]), Buffer.from([0xc3, 0x28]), `\ufeff${JSON.stringify(policy({}))}`]) {
		await writeFile(path, bytes);
		assert.throws(() => readFailoverConfig(path));
	}
	const short = JSON.stringify(policy({}));
	await writeFile(path, short.padEnd(MAX_FAILOVER_CONFIG_BYTES, " "));
	assert.deepEqual(readFailoverConfig(path), policy({}));
	await writeFile(path, short.padEnd(MAX_FAILOVER_CONFIG_BYTES + 1, " "));
	assert.throws(() => readFailoverConfig(path), /exceeds 16384 UTF-8 bytes/);
	assert.throws(() => parseFailoverConfigText(short.padEnd(MAX_FAILOVER_CONFIG_BYTES + 1, " ")), /exceeds/);
	const folder = join(directory, "folder.json");
	await mkdir(folder);
	assert.throws(() => readFailoverConfig(folder), /regular file/);
});

test("FIFO reads fail closed without blocking", { skip: process.platform === "win32" }, async (t) => {
	const { path } = await fixture(t);
	execFileSync("mkfifo", [path], { timeout: 1000 });
	assert.throws(() => readFailoverConfig(path), /regular file/);
});

test("reader follows directory/file symlinks without modifying their targets", async (t) => {
	const { directory, path } = await fixture(t);
	await writeFile(path, JSON.stringify(policy()));
	await mkdir(join(directory, "linked-dir"));
	await symlink(path, join(directory, "linked-dir/policy.json"));
	await symlink(join(directory, "linked-dir"), join(directory, "alias"));
	const before = await readFile(path);
	assert.deepEqual(readFailoverConfig(join(directory, "alias/policy.json")), policy());
	assert.deepEqual(await readFile(path), before);
	assert.equal((await lstat(join(directory, "linked-dir/policy.json"))).isSymbolicLink(), true);
});
