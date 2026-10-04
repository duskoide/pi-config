import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const CONFIG_DIR_NAME = ".pi";
export function getAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
}

const queues = new Map();
export async function withFileMutationQueue(path, operation) {
	const key = await realpath(path).catch((error) => {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return resolve(path);
		throw error;
	});
	const previous = queues.get(key) || Promise.resolve();
	let release;
	const next = new Promise((done) => { release = done; });
	const pending = previous.then(() => next);
	queues.set(key, pending);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (queues.get(key) === pending) queues.delete(key);
	}
}

export function parseFrontmatter(text) {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) return { frontmatter: {}, body: text };

	const frontmatter = {};
	for (const line of match[1].split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		frontmatter[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^"|"$/g, "");
	}
	return { frontmatter, body: text.slice(match[0].length) };
}
