#!/usr/bin/env python3
"""pdf2md - Convert PDF to clean, readable Markdown using PyMuPDF (no ML, fast, offline).

Layout-aware: detects headings via font size, inline bold/italic/monospace,
bulleted & numbered lists with nesting, fenced code blocks, links, tables
(via PyMuPDF table finder), and embedded figures (rendered to PNG).
Scanned pages fall back to a full-page image so output is never empty.
"""
import sys
import os
import re
import json
import argparse

import fitz  # PyMuPDF

# ---------------------------------------------------------------------------
# Span style helpers
# ---------------------------------------------------------------------------
MONO_RE = re.compile(r"(mono|courier|consol|code|fira|menlo|monaco|liberation mono)", re.I)
BOLD_RE = re.compile(r"bold", re.I)
ITALIC_RE = re.compile(r"italic|oblique", re.I)

BULLET_CHARS = set("•‣◦▪▸▸●○♦›◾")  # common PDF bullet glyphs
LIST_RE = re.compile(r"^(\s*)([•‣◦▪▸●○♦›◾\-*]|\d{1,3}[.)]|[a-zA-Z][.)])\s+(.*)$")


# PyMuPDF span font-flag bits (see TEXT_FONT_* in pymupdf.__init__)
FLAG_BOLD = 16
FLAG_ITALIC = 2
FLAG_MONO = 8


def span_bold(s):
    name = (s.get("font") or "")
    return bool(BOLD_RE.search(name)) or bool(s.get("flags", 0) & FLAG_BOLD)


def span_italic(s):
    name = (s.get("font") or "")
    return bool(ITALIC_RE.search(name)) or bool(s.get("flags", 0) & FLAG_ITALIC)


def span_mono(s):
    name = (s.get("font") or "")
    return bool(MONO_RE.search(name)) or bool(s.get("flags", 0) & FLAG_MONO)


def apply_inline(span):
    text = span.get("text", "")
    if not text:
        return text
    # never inline-format within what will become a code block
    if span_mono(span):
        return text
    if span_bold(span) and span_italic(span):
        return f"***{text}***"
    if span_bold(span):
        return f"**{text}**"
    if span_italic(span):
        return f"*{text}*"
    return text


# ---------------------------------------------------------------------------
# Document-level helpers
# ---------------------------------------------------------------------------
def estimate_body_size(doc, pages):
    sizes = []
    for pno in pages:
        page = doc[pno]
        for block in page.get_text("dict").get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    t = span.get("text", "").strip()
                    if t:
                        sizes.append((span.get("size", 0) or 0, len(t)))
    if not sizes:
        return 11.0
    sizes.sort()
    # weighted median by text length
    total = sum(w for _, w in sizes)
    cum = 0
    for sz, w in sizes:
        cum += w
        if cum >= total / 2:
            return sz
    return sizes[-1][0]


def heading_level(size, body):
    ratio = size / body if body else 1.0
    if ratio >= 2.0:
        return 1
    if ratio >= 1.5:
        return 2
    if ratio >= 1.25:
        return 3
    if ratio >= 1.12:
        return 4
    return 0


def strip_ctr(s):
    """Remove stray control characters (e.g. zero-width spaces, soft hyphens)."""
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b\u200c\u200d\ufeff]", "", s or "")


def rects_overlap(a, b):
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


# ---------------------------------------------------------------------------
# Block renderers
# ---------------------------------------------------------------------------
def render_text_block(block, body, links_by_rect, margin_x, page_w):
    lines = block.get("lines", [])
    if not lines:
        return ""
    # Determine if this block is a heading: large/short/bold
    sizes = [s.get("size", 0) for ln in lines for s in ln.get("spans", [])]
    avg_size = sum(sizes) / len(sizes) if sizes else body
    span_count = sum(len(ln.get("spans", [])) for ln in lines)
    text_plain = "".join(s.get("text", "") for ln in lines for s in ln.get("spans", [])).strip()
    is_heading = heading_level(avg_size, body) > 0 and (
        len(text_plain.split("\n")) <= 2 and len(text_plain) < 120
    )

    out = []
    if is_heading:
        lvl = heading_level(avg_size, body)
        clean = strip_ctr(re.sub(r"^#+\s*", "", text_plain)).strip()
        out.append(f"{'#' * lvl} {clean}")
        return "\n".join(out) + "\n\n"

    # Detect code block: predominantly monospace
    mono_spans = sum(1 for ln in lines for s in ln.get("spans", []) if span_mono(s))
    if span_count and mono_spans / span_count > 0.6:
        code = "\n".join(
            "".join(s.get("text", "") for s in ln.get("spans", [])) for ln in lines
        )
        return f"```\n{code.rstrip()}\n```\n\n"

    # Otherwise build paragraphs / lists
    for line in lines:
        spans = line.get("spans", [])
        if not spans:
            continue
        x0 = line["bbox"][0]
        raw = "".join(apply_inline(s) for s in spans)
        # collapse intra-line markdown spacing issues
        raw = strip_ctr(re.sub(r"\s+", " ", raw)).strip()
        m = LIST_RE.match(raw)
        if m:
            indent, marker, content = m.group(1), m.group(2), m.group(3)
            # nesting level from indentation relative to margin
            level = max(0, int((x0 - margin_x) // 24))
            indent_str = "  " * level
            if marker in BULLET_CHARS or marker == "-":
                out.append(f"{indent_str}- {content}")
            else:
                # preserve the original number/letter (e.g. "2.", "a.)")
                out.append(f"{indent_str}{marker} {content}")
        else:
            out.append(raw)
    return "\n".join(out).rstrip() + "\n\n"


def render_table(table):
    try:
        rows = table.extract()
    except Exception:
        return ""
    if not rows:
        return ""
    # drop fully-empty rows
    rows = [r for r in rows if any((c or "").strip() for c in r)]
    if not rows:
        return ""
    cols = max(len(r) for r in rows)
    norm = [ [(c or "").strip().replace("\n", " ") for c in r] + [""] * (cols - len(r)) for r in rows ]
    norm = [[strip_ctr(c) for c in row] for row in norm]
    head = norm[0]
    lines = []
    lines.append("| " + " | ".join(head) + " |")
    lines.append("| " + " | ".join("---" for _ in head) + " |")
    for r in norm[1:]:
        lines.append("| " + " | ".join(r) + " |")
    return "\n".join(lines) + "\n\n"


def render_image(page, bbox, out_dir, base_name, idx, dpi):
    x0, y0, x1, y1 = [c for c in bbox]
    clip = fitz.Rect(x0, y0, x1, y1)
    try:
        pix = page.get_pixmap(clip=clip, matrix=fitz.Matrix(dpi / 72, dpi / 72))
    except Exception:
        return None
    if pix.width < 24 or pix.height < 24:
        return None
    rel = f"{base_name}_img{idx}.png"
    path = os.path.join(out_dir, rel)
    pix.save(path)
    return rel


# ---------------------------------------------------------------------------
# Main conversion
# ---------------------------------------------------------------------------
def convert(doc, pages, out_dir, base_name, extract_images, page_markers, dpi):
    body = estimate_body_size(doc, pages)
    # gather links once per page
    link_map = {}
    for pno in pages:
        link_map[pno] = doc[pno].get_links()

    md_parts = []
    image_count = 0
    table_count = 0
    img_idx = 0
    page_w = doc[0].rect.width if len(doc) else 612
    margin_x = page_w * 0.08

    for pno in pages:
        page = doc[pno]
        if page_markers:
            md_parts.append(f"<!-- page {pno + 1} -->\n")

        # text dict blocks
        blocks = page.get_text("dict").get("blocks", [])
        # tables
        try:
            tables = page.find_tables().tables
        except Exception:
            tables = []
        table_rects = [t.bbox for t in tables]

        # text length check (scanned page fallback)
        text_len = sum(len(b.get("lines", [{}])[0].get("spans", [{}])[0].get("text", "")) for b in blocks if b.get("type") == 0) if blocks else 0

        # build ordered flowables (text blocks + tables) by y0
        flow = []
        for b in blocks:
            if b.get("type") != 0:
                continue
            y0 = b["bbox"][1]
            # skip text blocks that sit inside a table (avoid duplication)
            if any(rects_overlap(b["bbox"], tr) for tr in table_rects):
                continue
            flow.append((y0, "text", b))
        for t in tables:
            flow.append((t.bbox[1], "table", t))
        flow.sort(key=lambda x: x[0])

        page_md = []
        for _, kind, item in flow:
            if kind == "text":
                page_md.append(
                    render_text_block(item, body, link_map[pno], margin_x, page_w)
                )
            else:
                page_md.append(render_table(item))
                table_count += 1

        # images (embedded figures only)
        if extract_images:
            for b in blocks:
                if b.get("type") == 1:
                    bbox = b["bbox"]
                    # skip tiny images (likely logos/icons)
                    if (bbox[2] - bbox[0]) < 40 or (bbox[3] - bbox[1]) < 40:
                        continue
                    rel = render_image(page, bbox, out_dir, base_name, img_idx, dpi)
                    img_idx += 1
                    if rel:
                        image_count += 1
                        page_md.append(f"![image]({rel})\n")

        body_text = "".join(page_md)
        if not body_text.strip() and extract_images:
            # scanned / image-only page: render whole page as an image
            rel = render_image(page, page.rect, out_dir, base_name, img_idx, dpi)
            img_idx += 1
            if rel:
                image_count += 1
                page_md.append(f"_Page {pno + 1} (no selectable text; rendered as image:_\n\n![page {pno + 1}]({rel})\n")

        md_parts.append("".join(page_md))

    md = "".join(md_parts).strip() + "\n"
    return md, image_count, table_count


def parse_pages(spec, total):
    if not spec:
        return list(range(total))
    out = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            a = int(a) - 1
            b = int(b) - 1 if b else total - 1
            out.update(range(a, b + 1))
        else:
            out.add(int(part) - 1)
    return sorted(i for i in out if 0 <= i < total)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--out", help="output .md path (default: alongside input)")
    ap.add_argument("--images-dir", help="dir for extracted images (default: <out>.images)")
    ap.add_argument("--no-images", action="store_true")
    ap.add_argument("--pages", help="page range e.g. 1-3,5")
    ap.add_argument("--page-markers", action="store_true", help="emit <!-- page N --> comments")
    ap.add_argument("--dpi", type=int, default=150)
    args = ap.parse_args()

    if not os.path.exists(args.input):
        print(json.dumps({"error": f"file not found: {args.input}"}))
        sys.exit(2)

    doc = fitz.open(args.input)
    total = len(doc)
    pages = parse_pages(args.pages, total)

    base = os.path.splitext(os.path.basename(args.input))[0]
    out_path = args.out or os.path.join(os.path.dirname(os.path.abspath(args.input)), base + ".md")
    out_path = os.path.abspath(out_path)
    out_dir = args.images_dir or (out_path + ".images")
    os.makedirs(out_dir, exist_ok=True)

    md, image_count, table_count = convert(
        doc, pages, out_dir, base, not args.no_images, args.page_markers, args.dpi
    )
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(md)
    doc.close()

    summary = {
        "md_path": out_path,
        "images_dir": out_dir if not args.no_images else None,
        "pages": len(pages),
        "total_pages": total,
        "chars": len(md),
        "images": image_count,
        "tables": table_count,
    }
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
