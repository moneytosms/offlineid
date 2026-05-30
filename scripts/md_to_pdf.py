"""
md_to_pdf.py - render a Markdown file to a clean, print-friendly PDF.

Pure-Python (markdown + xhtml2pdf), no system binaries required.

Usage:
  python scripts/md_to_pdf.py submission/READMEFIRST.md
  python scripts/md_to_pdf.py input.md output.pdf
"""

import sys
from pathlib import Path

import markdown
from xhtml2pdf import pisa

CSS = """
@page { size: A4; margin: 1.8cm 1.8cm; }
body { font-family: Helvetica, Arial, sans-serif; font-size: 10.5pt;
       color: #1a2420; line-height: 1.45; }
h1 { font-size: 21pt; color: #0b6b3a; margin: 0 0 2pt 0; }
h2 { font-size: 13.5pt; color: #0b6b3a; border-bottom: 1.5px solid #00a85a;
     padding-bottom: 3px; margin: 16pt 0 6pt 0; }
h3 { font-size: 11.5pt; color: #14302a; margin: 12pt 0 4pt 0; }
p { margin: 4pt 0; }
strong { color: #0e1a16; }
a { color: #0b6b3a; text-decoration: none; }
code { font-family: "Courier New", monospace; font-size: 9.5pt;
       background: #eef4f1; color: #0b3d2a; padding: 1px 3px; }
pre { background: #f3f7f5; border: 1px solid #d8e4de; padding: 8px;
      font-family: "Courier New", monospace; font-size: 9pt; }
hr { border: none; border-top: 1px solid #cdd9d3; margin: 12pt 0; }
table { -pdf-keep-in-frame-mode: shrink; width: 100%; border-collapse: collapse;
        margin: 6pt 0; }
th { background: #0b6b3a; color: #ffffff; font-size: 9.5pt; text-align: left;
     padding: 5px 7px; }
td { border-bottom: 1px solid #dde7e2; font-size: 9.5pt; padding: 5px 7px;
     vertical-align: top; }
ul, ol { margin: 4pt 0 4pt 0; }
li { margin: 2pt 0; }
"""


def convert(md_path: Path, pdf_path: Path) -> None:
    text = md_path.read_text(encoding="utf-8")
    body = markdown.markdown(text, extensions=["tables", "fenced_code", "sane_lists"])
    html = (
        "<html><head><meta charset='utf-8'><style>"
        + CSS
        + "</style></head><body>"
        + body
        + "</body></html>"
    )
    with pdf_path.open("wb") as f:
        result = pisa.CreatePDF(html, dest=f, encoding="utf-8")
    if result.err:
        raise SystemExit(f"PDF generation failed for {md_path}")
    print(f"wrote {pdf_path}")


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: python scripts/md_to_pdf.py input.md [output.pdf]")
    md_path = Path(sys.argv[1])
    pdf_path = Path(sys.argv[2]) if len(sys.argv) > 2 else md_path.with_suffix(".pdf")
    convert(md_path, pdf_path)


if __name__ == "__main__":
    main()
