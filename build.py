#!/usr/bin/env python3
"""Bundle the dashboard into one self-contained index.html (easy to upload with File editor).

Usage: python3 build.py   ->  writes dist/index.html and dist/version.json from src/
"""
import json
import os
import re
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "src"
OUT = ROOT.parent / "dist" / "index.html"
# Dependency order: each module only imports from modules listed before it.
MODULES = ["icons.js", "entities.js", "controls.js", "auth.js", "ha.js", "plan.js", "planedit.js", "planset.js",
           "camera.js", "people.js", "energy.js", "calendar.js", "brief.js", "notify.js", "home.js", "news.js",
           "sky.js", "tint.js", "wall.js", "install.js", "voice.js", "main.js"]
STYLES = ["app.css", "_plan.css", "_map.css", "_cam.css", "_settings.css", "_wall.css"]


def strip_module_syntax(src: str) -> str:
    src = re.sub(r"^import\s[\s\S]*?from\s+'[^']+';\n", "", src, flags=re.M)
    return re.sub(r"^export\s+(?=(const|function|class|async)\b)", "", src, flags=re.M)


def main() -> None:
    html = (ROOT / "index.html").read_text()
    css = "\n".join(re.sub(r"^@import [^\n]*\n", "", (ROOT / "css" / name).read_text(), flags=re.M) for name in STYLES)
    js = "\n".join(
        f"// ---- {name} ----\n" + strip_module_syntax((ROOT / "js" / name).read_text())
        for name in MODULES
    )
    stamp = datetime.now(ZoneInfo("Australia/Sydney")).strftime("%-d %b %Y, %H:%M")
    if os.environ.get("DASH_COMMIT"):  # set by the GitHub Action
        stamp += f" ({os.environ['DASH_COMMIT'][:7]})"
    js = js.replace("const DASH_BUILD = 'source';", f"const DASH_BUILD = '{stamp}';", 1)
    html = html.replace('<link rel="stylesheet" href="css/app.css">', f"<style>\n{css}</style>")
    html = html.replace('<script type="module" src="js/main.js"></script>', f'<script type="module">\n{js}</script>')
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(html)
    # Open dashboards check this file and reload themselves when the build changes.
    (OUT.parent / "version.json").write_text(json.dumps({"build": stamp}) + "\n")
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
