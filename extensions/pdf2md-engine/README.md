# pdf2md — PDF → Markdown engine

Python converter used by the Pi extension `pdf-to-markdown` (a global extension at
`~/.pi/agent/extensions/pdf-to-markdown.ts`). It turns PDFs into clean, agent-readable
Markdown with **no ML model** (fast, offline, deterministic).

## What it extracts
- Headings (by font size), with correct `#` levels
- Inline **bold** / *italic* (font name + PyMuPDF font flags)
- Bulleted & numbered lists with indentation-based nesting
- Fenced code blocks (monospace detection)
- Tables (PyMuPDF table finder; ruled tables)
- Embedded figures → rendered to PNG and linked
- Scanned pages → full-page image fallback so output is never empty

## Files
- `pdf2md.py` — the converter. CLI:
  `python pdf2md.py INPUT.pdf [--out OUT.md] [--images-dir DIR] [--no-images] [--pages 1-3,5] [--page-markers] [--dpi 150]`
  Prints a JSON summary to stdout and writes Markdown to the output file.
- `run.sh` — wrapper that puts `libstdc++.so.6` (nix store) on `LD_LIBRARY_PATH` for PyMuPDF, then `exec`s its args.
- `.venv/` — Python venv with `pymupdf` (created on first use by the extension).
- `.gcc_lib_path` — cached path to the nix gcc lib dir.

## How the Pi tool uses it
The extension lazily creates the venv + installs `pymupdf` on first use (one-time, needs
internet), then calls `run.sh .venv/bin/python pdf2md.py ...` for every conversion. The
tool writes a `.md` file (and a `<file>.md.images/` folder) and returns the path + stats,
with an inline preview for small docs (the agent should `read` the file for large ones).
