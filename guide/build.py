"""Собирает учебник guide/index.html из src/ и файлов решений.

Запуск из корня репозитория:  python3 guide/build.py [путь_вывода]
"""
import html
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

HEAD = """<title>Конспект эксперта IoT</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&family=Press+Start+2P&family=Unbounded:wght@500;700&display=swap">
"""


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as f:
        return f.read()


def oled(match):
    attrs = dict(re.findall(r'(\w+)="([^"]*)"', match.group(1)))
    inner = []
    for item in attrs.get("lines", "").split(";"):
        if not item:
            continue
        y, text = item.split(":", 1)
        inner.append('<span style="top:calc(%s * var(--px))">%s</span>' % (y, html.escape(text)))
    if "bar" in attrs:
        y, fill = attrs["bar"].split(":")
        inner.append('<div class="bar" style="top:calc(%s * var(--px))"><i style="width:calc(%s * var(--px))"></i></div>' % (y, fill))
    if "lamp" in attrs:
        inner.append('<div class="lamp%s"></div>' % (" on" if attrs["lamp"] == "on" else ""))
    cls = "oled inv" if attrs.get("inv") == "1" else "oled"
    label = html.escape(" / ".join(i.split(":", 1)[1] for i in attrs.get("lines", "").split(";") if i))
    return ('<figure class="oled-fig"><div class="oled-frame"><div class="%s" role="img" aria-label="%s">%s</div></div>'
            "<figcaption>%s</figcaption></figure>" % (cls, label, "".join(inner), html.escape(attrs.get("cap", ""))))


def code(match):
    path, title = match.group(1).split("|", 1)
    src = read(ROOT, path)
    n = src.count("\n")
    return ('<details class="code"><summary>Эталонный код: %s <small>%d строк · %s</small></summary>'
            '<div class="codebox"><button class="copy" type="button">Копировать</button>'
            '<pre class="py">%s</pre></div></details>' % (html.escape(title), n, html.escape(path), html.escape(src)))


def build(out):
    body = read(HERE, "src", "body.html")
    body = re.sub(r"<oled\s(.*?)\s*/>", oled, body)
    body = re.sub(r"\{\{CODE:([^}]*)\}\}", code, body)
    page = (HEAD + "<style>\n" + read(HERE, "src", "style.css") + "</style>\n" + body +
            "\n<script>\n" + read(HERE, "src", "app.js") + "</script>\n")
    with open(out, "w", encoding="utf-8") as f:
        f.write(page)
    print("written", out, len(page.encode()), "bytes")


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "index.html"))
