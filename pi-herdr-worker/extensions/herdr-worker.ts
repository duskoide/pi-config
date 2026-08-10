import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Settings file location
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "herdr-worker.json");

interface WorkerSettings {
  defaultModel: string;
  allowedModels: string[];
  defaultTimeout: number;
  defaultDirection: "right" | "down";
}

// Load settings from JSON file
function loadSettings(): WorkerSettings {
  const defaults: WorkerSettings = {
    defaultModel: "claude-sonnet-5",
    allowedModels: ["gpt-4o", "claude-sonnet-5", "claude-sonnet-4-5", "gpt-4o-mini"],
    defaultTimeout: 120000,
    defaultDirection: "right",
  };

  try {
    if (existsSync(SETTINGS_PATH)) {
      const raw = readFileSync(SETTINGS_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        defaultModel: parsed.defaultModel ?? defaults.defaultModel,
        allowedModels: parsed.allowedModels ?? defaults.allowedModels,
        defaultTimeout: parsed.defaultTimeout ?? defaults.defaultTimeout,
        defaultDirection: parsed.defaultDirection ?? defaults.defaultDirection,
      };
    }
  } catch {
    // Fall through to defaults
  }

  return defaults;
}

const SpawnWorkerInput = z.object({
  prompt: z.string().describe("The prompt to send to the worker pi agent"),
  name: z
    .string()
    .optional()
    .describe(
      "Unique name for the worker (lowercase, hyphens, max 31 chars). Auto-generated if not provided."
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Model to use for the worker. Must be in allowedModels from settings. Uses defaultModel from settings if not specified."
    ),
  timeout: z
    .number()
    .optional()
    .describe("Timeout in milliseconds for the prompt (uses defaultTimeout from settings if not specified)"),
  direction: z
    .enum(["right", "down"])
    .optional()
    .describe("Pane split direction (uses defaultDirection from settings if not specified)"),
});

export default function herdrWorker() {
  const settings = loadSettings();

  return {
    name: "herdr-worker",
    description:
      "Spawn a worker pi agent in a new Herdr pane to execute delegated tasks. The primary agent acts as orchestrator.",
    commands: [
      {
        name: "worker",
        description: `Spawn a worker. Usage: /worker <prompt> [name] [model] [timeout]. Default model: ${settings.defaultModel}`,
        execute: async (args: string) => {
          // Parse: /worker <prompt> [name] [model] [timeout]
          // Parse from right to left to handle multi-word prompts
          const parts = args.trim().split(/\s+/);

          if (parts.length === 0 || !parts[0]) {
            return {
              message: `Usage: /worker <prompt> [worker-name] [model] [timeout-ms]\n\nDefault model: ${settings.defaultModel}\nAllowed models: ${settings.allowedModels.join(", ")}\n\nExamples:\n/worker Implement login page\n/worker Review code worker-review claude-sonnet-4-5\n/worker Build project worker-builder gpt-4o 300000`,
            };
          }

          // Parse from right: timeout (number) → model (in allowedModels) → name (matches pattern) → rest is prompt
          let timeout = settings.defaultTimeout;
          let model: string | undefined;
          let name: string | undefined;
          let promptEndIdx = parts.length;

          // Check for timeout (last token, must be a number)
          if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
            timeout = parseInt(parts[parts.length - 1], 10);
            promptEndIdx--;
          }

          // Check for model (second-to-last, must be in allowedModels)
          if (promptEndIdx > 1 && settings.allowedModels.includes(parts[promptEndIdx - 1])) {
            model = parts[promptEndIdx - 1];
            promptEndIdx--;
          }

          // Check for name (third-to-last, must match agent name pattern)
          if (promptEndIdx > 1 && /^[a-z][a-z0-9_-]{0,30}$/.test(parts[promptEndIdx - 1])) {
            name = parts[promptEndIdx - 1];
            promptEndIdx--;
          }

          // Everything remaining is the prompt
          const prompt = parts.slice(0, promptEndIdx).join(" ");
          const workerName = name || `worker-${Date.now().toString(36)}`;

          // Check Herdr environment
          if (process.env.HERDR_ENV !== "1") {
            return {
              error: "Not running in Herdr environment. Cannot spawn worker.",
            };
          }

          // Validate model if provided
          if (model && !settings.allowedModels.includes(model)) {
            return {
              error: `Model "${model}" not in allowedModels. Allowed: ${settings.allowedModels.join(", ")}`,
            };
          }

          try {
            const { execSync } = require("child_process");

            // Create new pane
            const splitResult = execSync(
              `herdr pane split --current --direction ${settings.defaultDirection} --cwd "${process.env.PWD}" --no-focus`,
              { encoding: "utf-8" }
            );
            const split = JSON.parse(splitResult);
            const newPaneId = split.result?.pane?.pane_id;

            if (!newPaneId) {
              return { error: "Could not create new pane" };
            }

            // Build start command with model (from arg or settings default)
            const effectiveModel = model || settings.defaultModel;
            let startCmd = `herdr agent start "${workerName}" --kind pi --pane "${newPaneId}" -- --model "${effectiveModel}"`;

            // Start worker
            execSync(startCmd, { encoding: "utf-8" });

            // Send prompt
            const escapedPrompt = prompt.replace(/"/g, '\\"');
            execSync(
              `herdr agent prompt "${workerName}" "${escapedPrompt}" --wait --timeout ${timeout}`,
              { encoding: "utf-8" }
            );

            // Read response
            const response = execSync(
              `herdr agent read "${workerName}" --source recent-unwrapped --lines 100`,
              { encoding: "utf-8" }
            );

            // Cleanup
            execSync(`herdr pane close "${newPaneId}" 2>/dev/null || true`, {
              encoding: "utf-8",
            });

            return {
              message: `✅ Worker "${workerName}" (model: ${effectiveModel}) completed in pane ${newPaneId}\n\n${response}`,
            };
          } catch (error: any) {
            return { error: `Failed: ${error.message}` };
          }
        },
      },
      {
        name: "workerp",
        description: `Quick worker spawn: /workerp <prompt> [model]. Auto-generates name, uses default model (${settings.defaultModel})`,
        execute: async (args: string) => {
          if (!args.trim()) {
            return { error: `Usage: /workerp <prompt> [model]. Default: ${settings.defaultModel}` };
          }

          const parts = args.trim().split(/\s+/);
          const prompt = parts[0];
          const model = parts[1] || undefined;
          const autoName = `worker-${Date.now().toString(36)}`;

          // Delegate to /worker
          const workerCmd = this.commands!.find((c) => c.name === "worker")!;
          const cmdArgs = model
            ? `${prompt} ${autoName} ${model}`
            : `${prompt} ${autoName}`;
          return workerCmd.execute(cmdArgs);
        },
      },
      {
        name: "workerlist",
        description: "List all currently running workers",
        execute: async () => {
          if (process.env.HERDR_ENV !== "1") {
            return { error: "Not running in Herdr environment" };
          }

          try {
            const { execSync } = require("child_process");
            const result = execSync("herdr agent list", { encoding: "utf-8" });
            const agents = JSON.parse(result);

            if (!agents.result?.agents?.length) {
              return { message: "No workers currently running." };
            }

            const list = agents.result.agents
              .map((a: any) => `- ${a.name} (${a.agent_status}) in ${a.pane_id}`)
              .join("\n");

            return { message: `Running workers:\n${list}` };
          } catch (error: any) {
            return { error: `Failed: ${error.message}` };
          }
        },
      },
      {
        name: "workerkill",
        description: "Kill a worker by name: /workerkill <worker-name>",
        execute: async (args: string) => {
          const workerName = args.trim();
          if (!workerName) {
            return { error: "Usage: /workerkill <worker-name>" };
          }

          if (process.env.HERDR_ENV !== "1") {
            return { error: "Not running in Herdr environment" };
          }

          try {
            const { execSync } = require("child_process");

            // Get worker info to find pane ID
            const agentInfo = execSync(`herdr agent get "${workerName}"`, {
              encoding: "utf-8",
            });
            const agent = JSON.parse(agentInfo);
            const paneId = agent.result?.agent?.pane_id;

            if (!paneId) {
              return { error: `Worker "${workerName}" not found` };
            }

            // Close the pane (this stops the worker)
            execSync(`herdr pane close "${paneId}"`, { encoding: "utf-8" });

            return { message: `✅ Killed worker "${workerName}" in pane ${paneId}` };
          } catch (error: any) {
            return { error: `Failed: ${error.message}` };
          }
        },
      },
    ],
    tools: [
      {
        name: "spawn_worker",
        description: `Spawn a worker pi agent in a new Herdr pane, send a prompt, wait for response, and return the result. The pane is automatically closed after completion. Default model: ${settings.defaultModel}. Allowed models: ${settings.allowedModels.join(", ")}`,
        inputSchema: SpawnWorkerInput,
        execute: async (input: z.infer<typeof SpawnWorkerInput>) => {
          // Check if we're in Herdr
          if (process.env.HERDR_ENV !== "1") {
            return {
              error: "Not running in Herdr environment. Cannot spawn worker.",
            };
          }

          const { prompt } = input;
          const workerName =
            input.name ||
            `worker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const model = input.model || settings.defaultModel;
          const timeout = input.timeout || settings.defaultTimeout;
          const direction = input.direction || settings.defaultDirection;

          // Validate worker name
          if (!/^[a-z][a-z0-9_-]{0,30}$/.test(workerName)) {
            return {
              error:
                "Worker name must be lowercase letters, numbers, hyphens; max 31 chars",
            };
          }

          // Validate model against allowedModels
          if (!settings.allowedModels.includes(model)) {
            return {
              error: `Model "${model}" not in allowedModels. Allowed: ${settings.allowedModels.join(", ")}`,
            };
          }

          try {
            // Get current pane context
            const currentResult = await execCommand(
              "herdr pane current --current"
            );
            const current = JSON.parse(currentResult);
            const currentPaneId = current.result?.pane?.pane_id;

            if (!currentPaneId) {
              return { error: "Could not get current pane ID" };
            }

            // Create new pane
            const splitResult = await execCommand(
              `herdr pane split --current --direction ${direction} --cwd "${process.env.PWD}" --no-focus`
            );
            const split = JSON.parse(splitResult);
            const newPaneId = split.result?.pane?.pane_id;

            if (!newPaneId) {
              return { error: "Could not create new pane" };
            }

            // Start worker agent with specified model
            const startCmd = `herdr agent start "${workerName}" --kind pi --pane "${newPaneId}" -- --model "${model}"`;
            const startResult = await execCommand(startCmd);
            const start = JSON.parse(startResult);

            if (!start.result?.agent?.agent_status) {
              return { error: "Failed to start worker" };
            }

            // Send prompt (escape quotes in prompt)
            const escapedPrompt = prompt.replace(/"/g, '\\"');
            const promptResult = await execCommand(
              `herdr agent prompt "${workerName}" "${escapedPrompt}" --wait --timeout ${timeout}`
            );
            const promptRes = JSON.parse(promptResult);

            if (promptRes.type !== "agent_prompted") {
              // Cleanup on failure
              await execCommand(`herdr pane close "${newPaneId}" 2>/dev/null || true`);
              return { error: "Failed to send prompt to worker" };
            }

            // Read response
            const readResult = await execCommand(
              `herdr agent read "${workerName}" --source recent-unwrapped --lines 100`
            );

            // Cleanup: close the pane
            await execCommand(`herdr pane close "${newPaneId}" 2>/dev/null || true`);

            return {
              pane_id: newPaneId,
              worker_name: workerName,
              model: model,
              status: "completed",
              response: readResult,
            };
          } catch (error: any) {
            return {
              error: `Failed to spawn worker: ${error.message}`,
            };
          }
        },
      },
    ],
  };
}

// Helper function to execute bash commands
async function execCommand(command: string): Promise<string> {
  const { execSync } = require("child_process");
  try {
    return execSync(command, {
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error: any) {
    throw new Error(
      `Command failed: ${command}\n${error.stderr || error.message}`
    );
  }
}
