"""Generate Deep Navy / Sky Blue themed PDF from READMEFIRST.md."""
import re
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, HRFlowable, Preformatted
)
from reportlab.lib.enums import TA_LEFT

BG      = colors.HexColor('#080C1A')
SURFACE = colors.HexColor('#111930')
ACCENT  = colors.HexColor('#38BDF8')
TEXT    = colors.HexColor('#E2E8F0')
MUTED   = colors.HexColor('#94A3B8')
BORDER  = colors.HexColor('#1E2847')

def make_styles():
    h1     = ParagraphStyle('H1', fontName='Helvetica-Bold', fontSize=20,
                             textColor=ACCENT, spaceAfter=8, spaceBefore=16)
    h2     = ParagraphStyle('H2', fontName='Helvetica-Bold', fontSize=14,
                             textColor=ACCENT, spaceAfter=6, spaceBefore=12)
    h3     = ParagraphStyle('H3', fontName='Helvetica-Bold', fontSize=12,
                             textColor=TEXT, spaceAfter=4, spaceBefore=8)
    body   = ParagraphStyle('Body', fontName='Helvetica', fontSize=10,
                             textColor=TEXT, spaceAfter=4, leading=15)
    bullet = ParagraphStyle('Bullet', fontName='Helvetica', fontSize=10,
                             textColor=TEXT, spaceAfter=3, leading=14,
                             leftIndent=16)
    code   = ParagraphStyle('Code', fontName='Courier', fontSize=8,
                             textColor=MUTED, spaceAfter=6, leading=12,
                             leftIndent=12, backColor=SURFACE)
    return h1, h2, h3, body, bullet, code

def pi(text):
    text = text.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'\*(.+?)\*', r'<i>\1</i>', text)
    text = re.sub(r'`([^`]+)`', r'<font name="Courier" color="#94A3B8">\1</font>', text)
    return text

def parse(md_text):
    h1, h2, h3, body, bullet, code = make_styles()
    out = []
    in_code = False
    code_buf = []

    def flush_code():
        if code_buf:
            out.append(Preformatted('\n'.join(code_buf), code))
            out.append(Spacer(1, 4))
            code_buf.clear()

    for line in md_text.split('\n'):
        if line.startswith('```'):
            if in_code:
                flush_code()
                in_code = False
            else:
                in_code = True
            continue
        if in_code:
            code_buf.append(line)
            continue
        if line.startswith('### '):
            flush_code(); out.append(Paragraph(pi(line[4:]), h3))
        elif line.startswith('## '):
            flush_code()
            out.append(Spacer(1,6))
            out.append(HRFlowable(width='100%', thickness=0.5, color=BORDER, spaceAfter=4))
            out.append(Paragraph(pi(line[3:]), h2))
        elif line.startswith('# '):
            flush_code()
            out.append(Spacer(1,8))
            out.append(Paragraph(pi(line[2:]), h1))
            out.append(HRFlowable(width='100%', thickness=1.5, color=ACCENT, spaceAfter=6))
        elif re.match(r'^[-*+] ', line):
            flush_code(); out.append(Paragraph('•  ' + pi(line[2:]), bullet))
        elif re.match(r'^\d+\. ', line):
            flush_code()
            m = re.match(r'^(\d+)\. (.+)', line)
            if m: out.append(Paragraph(f'{m.group(1)}.  {pi(m.group(2))}', bullet))
        elif line.startswith('|'):
            pass
        elif not line.strip() or line.strip() == '---':
            flush_code(); out.append(Spacer(1, 6))
        else:
            flush_code()
            t = pi(line.strip())
            if t: out.append(Paragraph(t, body))

    flush_code()
    return out

def main():
    md_path  = r'D:\Projects\offlineid\submission\READMEFIRST.md'
    pdf_path = r'D:\Projects\offlineid\submission\READMEFIRST.pdf'
    with open(md_path, encoding='utf-8') as f:
        md = f.read()
    doc = SimpleDocTemplate(pdf_path, pagesize=A4,
                            leftMargin=inch, rightMargin=inch,
                            topMargin=inch, bottomMargin=inch,
                            title='OfflineID v1.4.0', author='OfflineID Hackathon 7.0')
    def bg(canvas, _d):
        canvas.saveState()
        canvas.setFillColor(BG)
        canvas.rect(0, 0, A4[0], A4[1], fill=1, stroke=0)
        canvas.restoreState()
    doc.build(parse(md), onFirstPage=bg, onLaterPages=bg)
    print(f'PDF generated: {pdf_path}')

if __name__ == '__main__':
    main()
