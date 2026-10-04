import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const stub = pathToFileURL(resolvePath("tests/pi-coding-agent-stub.mjs")).href;
const tuiStub = pathToFileURL(resolvePath("tests/pi-tui-stub.mjs")).href;
const typeboxStub = pathToFileURL(resolvePath("tests/typebox-stub.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "@earendil-works/pi-coding-agent") return { url: stub, shortCircuit: true };
	if (specifier === "@earendil-works/pi-tui") return { url: tuiStub, shortCircuit: true };
	if (specifier === "typebox") return { url: typeboxStub, shortCircuit: true };
	return nextResolve(specifier, context);
}
