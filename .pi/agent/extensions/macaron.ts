import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("macaron", {
    name: "Macaron",
    baseUrl: "https://mint.macaron.im/v1",
    apiKey: "$MACARON_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "macaron-v1-coding-venti",
        name: "Macaron V1 Coding Venti",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096
      }
    ]
  });
}
