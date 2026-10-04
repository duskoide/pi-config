import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { registerChildFailover } from "../../../../extensions/delegator-failover/child.ts";
export default function (pi: ExtensionAPI): void {
	registerChildFailover(pi, "worker", fileURLToPath(new URL("../failover.json", import.meta.url)));
}
