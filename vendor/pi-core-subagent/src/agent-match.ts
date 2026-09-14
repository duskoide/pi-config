const STOP = new Set([
	"the",
	"a",
	"an",
	"of",
	"for",
	"and",
	"or",
	"to",
	"in",
	"on",
	"with",
	"by",
	"at",
	"during",
	"your",
	"you",
	"their",
	"its",
	"is",
	"are",
	"be",
	"as",
	"how",
	"what",
	"who",
	"from",
	"into",
	"this",
	"that",
	"it",
	"all",
	"any",
	"per",
	"via",
	"other",
]);

const MIN_SHARED_TERMS = 2;
const MIN_COVERAGE = 0.4;

function tokens(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
		.filter((token) => !STOP.has(token) && token.length > 1)
		.map((token) => {
			if (token.endsWith("ing") && token.length > 5) token = token.slice(0, -3);
			if (/(?:ch|sh|ss|x|z|s)es$/.test(token) && token.length > 4) token = token.slice(0, -2);
			else if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) token = token.slice(0, -1);
			return token;
		});
}

export function scoreAgentDescription(query: string, description: string): number {
	const queryTokens = tokens(query);
	const descriptionTokens = tokens(description);
	if (descriptionTokens.length === 0) return 0;

	const querySet = new Set(queryTokens);
	const shared = new Set<string>();
	for (const token of descriptionTokens) if (querySet.has(token)) shared.add(token);
	if (shared.size < MIN_SHARED_TERMS) return 0;

	const denominator = Math.min(new Set(descriptionTokens).size, querySet.size);
	if (denominator === 0 || shared.size / denominator < MIN_COVERAGE) return 0;
	return shared.size;
}
