import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
// Engine (pdf2md.py + run.sh) lives next to this file so the package is self-contained.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(__dirname, "pdf2md-engine");
const SCRIPT = join(ENGINE_DIR, "pdf2md.py");
const RUN_SH = join(ENGINE_DIR, "run.sh");
// Runtime artifacts (venv, readiness marker, gcc-lib cache) live in the user cache,
// never inside the stowed dotfiles tree.
const CACHE_DIR = join(homedir(), ".cache", "pi-pdf2md");
const VENV_PY = join(CACHE_DIR, ".venv", "bin", "python");
const READY = join(CACHE_DIR, ".ready");
const GCC_CACHE = join(CACHE_DIR, ".gcc_lib_path");

let gccLib: string | null = null;
let envReady: Promise<void> | null = null;

function getGccLib(): string | null {
  if (gccLib !== null) return gccLib;
  try {
    if (existsSync(GCC_CACHE)) {
      const v = readFileSync(GCC_CACHE, "utf8").trim();
      if (v) gccLib = v;
    } else {
      const sync = execFileSync(
        "bash",
        ["-lc", "find /nix/store -maxdepth 4 -name 'libstdc++.so.6' 2>/dev/null | head -1"],
        { timeout: 20000 },
      )
        .toString()
        .trim();
      if (sync) {
        gccLib = dirname(sync);
        try { writeFileSync(GCC_CACHE, gccLib); } catch {}
      }
    }
  } catch {}
  return gccLib;
}

function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const lib = getGccLib();
  if (lib) {
    env.LD_LIBRARY_PATH = lib + (env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : "");
  }
  return env;
}

// ---------------------------------------------------------------------------
// One-time environment setup (create venv + install pymupdf)
// ---------------------------------------------------------------------------
async function ensureEnvironment(
  onUpdate?: (u: { content: { type: "text"; text: string }[] }) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (envReady) return envReady;
  envReady = (async () => {
    if (existsSync(READY) && existsSync(VENV_PY)) return;
    onUpdate?.({ content: [{ type: "text", text: "Setting up PDF→Markdown engine (one-time)…" }] });
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

    // create venv if missing
    if (!existsSync(VENV_PY)) {
      await execFileP("python3", ["-m", "venv", join(CACHE_DIR, ".venv")], { signal });
    }
    // upgrade pip + install pymupdf
    await execFileP(VENV_PY, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"], {
      signal,
      env: baseEnv(),
    });
    await execFileP(VENV_PY, ["-m", "pip", "install", "--quiet", "pymupdf"], {
      signal,
      env: baseEnv(),
    });
    // verify import works (catches missing system libs like libstdc++)
    await execFileP(VENV_PY, ["-c", "import fitz"], { signal, env: baseEnv() });
    writeFileSync(READY, new Date().toISOString());
  })();
  try {
    await envReady;
  } catch (e) {
    envReady = null; // allow retry
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------
async function convert(params: {
  path: string;
  pages?: string;
  outputDir?: string;
  extractImages?: boolean;
  pageMarkers?: boolean;
  dpi?: number;
  cwd: string;
  signal?: AbortSignal;
}): Promise<{ mdPath: string; imagesDir: string | null; pages: number; totalPages: number; chars: number; images: number; tables: number }> {
  await ensureEnvironment(undefined, params.signal);
  const input = resolve(params.cwd, params.path);
  if (!existsSync(input)) {
    throw new Error(`PDF not found: ${input}`);
  }
  const args = [SCRIPT, input];
  const outDir = params.outputDir ? resolve(params.cwd, params.outputDir) : undefined;
  if (outDir) args.push("--out", join(outDir, basename(input).replace(/\.pdf$/i, ".md")));
  if (params.pages) args.push("--pages", params.pages);
  if (params.extractImages === false) args.push("--no-images");
  if (params.pageMarkers) args.push("--page-markers");
  if (params.dpi) args.push("--dpi", String(params.dpi));

  const { stdout } = await execFileP("bash", [RUN_SH, VENV_PY, ...args], {
    signal: params.signal,
    env: baseEnv(),
    maxBuffer: 64 * 1024 * 1024,
  });
  const summary = JSON.parse(stdout.trim().split("\n").pop() || "{}");
  if (summary.error) throw new Error(summary.error);
  return {
    mdPath: summary.md_path,
    imagesDir: summary.images_dir,
    pages: summary.pages,
    totalPages: summary.total_pages,
    chars: summary.chars,
    images: summary.images,
    tables: summary.tables,
  };
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  // Warm up the environment in the background so first call is fast.
  pi.on("session_start", () => {
    ensureEnvironment().catch(() => {});
  });

  pi.registerTool({
    name: "pdf_to_markdown",
    label: "PDF to Markdown",
    description:
      "Convert a PDF file into clean, readable Markdown. Layout-aware: detects headings, " +
      "bold/italic, bulleted & numbered lists, fenced code blocks, tables, and embedded " +
      "figures (rendered to PNG). Writes a .md file and returns its path plus stats.",
    promptSnippet: "Convert a PDF file into clean Markdown (headings, lists, tables, code, images)",
    promptGuidelines: [
      "Use pdf_to_markdown when the user shares, uploads, or references a .pdf file and wants its " +
      "content as Markdown. The tool writes a .md file (and an images folder) and returns the file " +
      "path; use the read tool on that path to view the full Markdown.",
      "Use pdf_to_markdown with the `pages` parameter (e.g. \"1-3,5\") to convert only part of a large PDF.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the PDF file (absolute or relative to the project)." }),
      pages: Type.Optional(
        Type.String({ description: 'Page range to convert, e.g. "1-3,5" or "7". Omit for all pages.' }),
      ),
      outputDir: Type.Optional(
        Type.String({ description: "Directory for the .md output and images. Defaults next to the PDF." }),
      ),
      extractImages: Type.Optional(
        Type.Boolean({ description: "Extract embedded figures as PNG images (default true)." }),
      ),
      pageMarkers: Type.Optional(
        Type.Boolean({ description: "Emit '<!-- page N -->' comments between pages (default false)." }),
      ),
      dpi: Type.Optional(
        Type.Number({ description: "Image render resolution in DPI (default 150)." }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const result = await convert({
          path: params.path,
          pages: params.pages,
          outputDir: params.outputDir,
          extractImages: params.extractImages,
          pageMarkers: params.pageMarkers,
          dpi: params.dpi,
          cwd: ctx.cwd,
          signal,
        });

        // Read a preview of the produced markdown (full file may be large).
        let preview = "";
        let truncated = false;
        try {
          const full = readFileSync(result.mdPath, "utf8");
          if (full.length <= 8000) {
            preview = full;
          } else {
            preview = full.slice(0, 4000);
            truncated = true;
          }
        } catch {}

        const stats =
          `pages ${result.pages}/${result.totalPages}, ` +
          `${result.chars} chars, ${result.images} image(s), ${result.tables} table(s)`;

        const text =
          `# PDF converted to Markdown\n` +
          `Saved to: \`${result.mdPath}\`\n` +
          `(${stats})\n\n` +
          (truncated
            ? `${preview}\n\n… (truncated — ${result.chars} chars total; use the read tool on the path above for the full Markdown)\n`
            : `${preview}\n`);

        return {
          content: [{ type: "text", text }],
          details: result,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text:
                `Failed to convert PDF: ${msg}\n\n` +
                `If this is the first run, the engine may still be installing (needs internet). ` +
                `Try again in a moment.`,
            },
          ],
          details: { error: msg },
          isError: true,
        };
      }
    },
  });

  // Manual command for interactive use.
  pi.registerCommand("pdf2md", {
    description: "Convert a PDF to Markdown: /pdf2md <path> [pages]",
    handler: async (args, ctx) => {
      const [path, pages] = (args || "").trim().split(/\s+/);
      if (!path) {
        ctx.ui.notify("Usage: /pdf2md <path> [pages]", "error");
        return;
      }
      ctx.ui.notify("Converting PDF…", "info");
      try {
        const r = await convert({ path, pages, cwd: ctx.cwd });
        ctx.ui.notify(
          `Saved ${r.mdPath} (${r.pages} pages, ${r.images} img, ${r.tables} tbl)`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(`PDF conversion failed: ${e instanceof Error ? e.message : e}`, "error");
      }
    },
  });
}
