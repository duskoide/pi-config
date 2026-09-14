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
