"""Render the launch intro's lettering from the film's own title-card CSS.

Run with the global python (Playwright + Chromium):
    python src/renderer/src/assets/intro/render_intro.py

Writes the PNGs (1x and 2x, transparent) and manifest.json next to this file.
No font file is shipped: the PNGs are rendered output. The script refuses to
run when the film's font is not installed, so a fallback is never baked in.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent
PAD = 160  # px; the 140 px glow must never be clipped
WORD = "LUMOPOLIS"
FONT = "Segoe UI Variable Display"

CSS = """
html,body{margin:0;background:transparent}
.wrap{position:absolute;left:0;top:0;visibility:hidden;width:max-content;padding:%dpx;box-sizing:content-box}
.mark{font-family:"@FONT@","Aptos","Segoe UI",sans-serif;font-weight:300;font-size:150px;
  letter-spacing:34px;padding-left:34px;color:#fff;white-space:nowrap;
  text-shadow:0 0 18px rgba(95,227,255,.55),0 0 60px rgba(95,227,255,.35),0 0 140px rgba(169,139,255,.25)}
.mark span{display:inline-block}
.tag{font-family:Georgia,serif;font-style:italic;font-size:48px;color:#d9e3f3;white-space:nowrap}
.rule{height:2px;margin:34px auto 30px;width:900px;
  background:linear-gradient(90deg,transparent,#5fe3ff,#fff,#ffb45a,transparent);box-shadow:0 0 18px #5fe3ff}
""" % PAD
CSS = CSS.replace("@FONT@", FONT)


def spans(word):
    return "".join("<span>%s</span>" % c for c in word)


def build_html():
    rows = [
        '<div class="wrap" id="termpolisMark"><div class="mark">%s</div></div>' % spans("TERMPOLIS"),
        '<div class="wrap" id="termpolisTag"><div class="tag">City of Terminals</div></div>',
        '<div class="wrap" id="lumopolisTag"><div class="tag">City of Enlightenment</div></div>',
        # measuring row: the whole word as the film lays it out (not screenshotted).
        # The .rule here exists ONLY to measure ruleTop; it is never rendered to a PNG.
        '<div class="wrap" id="measure"><div class="mark" id="measureMark">%s</div>'
        '<div class="rule" id="rule"></div></div>' % spans(WORD),
    ]
    for i, c in enumerate(WORD):
        rows.append('<div class="wrap" id="letter%d"><div class="mark" style="padding-left:0">'
                    '<span>%s</span></div></div>' % (i, c))
    return "<!doctype html><html><head><meta charset=utf-8><style>%s</style></head><body>%s</body></html>" % (
        CSS, "".join(rows))


def shoot(browser, html, scale):
    ctx = browser.new_context(viewport={"width": 3000, "height": 2000}, device_scale_factor=scale)
    page = ctx.new_page()
    page.set_content(html)
    page.evaluate("document.fonts.ready")
    # NOTE: document.fonts.check() is NOT a presence test: it returns true whenever no @font-face
    # matches the family, which is the case for a system font. So measure real glyph widths instead:
    # a probe in "<font>",<fallback> must differ from the bare fallback for two different fallbacks.
    ok = page.evaluate("""(font) => {
      const w = (family) => {
        const s = document.createElement('span');
        s.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-weight:300;font-size:150px;font-family:' + family;
        s.textContent = 'LUMOPOLISTERMPOLIS';
        document.body.appendChild(s);
        const width = s.getBoundingClientRect().width;
        s.remove();
        return width;
      };
      return w('"' + font + '",monospace') !== w('monospace') && w('"' + font + '",serif') !== w('serif');
    }""", FONT)
    if not ok:
        print("ERROR: font '%s' (weight 300) is not installed; refusing to bake a fallback." % FONT,
              file=sys.stderr)
        sys.exit(2)
    # Snap every wrapper to whole CSS px so the 2x PNG is exactly double the 1x one.
    page.evaluate("""() => document.querySelectorAll('.wrap').forEach(w => {
      const r = w.getBoundingClientRect();
      w.style.width = Math.ceil(r.width) + 'px'; w.style.height = Math.ceil(r.height) + 'px';
      w.style.boxSizing = 'border-box';
    })""")
    names = {"termpolisMark": "termpolis-mark", "termpolisTag": "termpolis-tag", "lumopolisTag": "lumopolis-tag"}
    for i in range(len(WORD)):
        names["letter%d" % i] = "lumopolis-%d" % i
    sizes = {}
    for key, base in names.items():
        # Each element is shot alone, at the page origin, so equal letters give identical bytes.
        page.evaluate("(k) => { document.querySelectorAll('.wrap').forEach(w => w.style.visibility = 'hidden');"
                      " document.getElementById(k).style.visibility = 'visible'; }", key)
        loc = page.locator("#" + key)
        loc.screenshot(path=str(OUT / ("%s@%dx.png" % (base, scale))), omit_background=True)
        box = loc.bounding_box()
        sizes[key] = (base, round(box["width"]), round(box["height"]))
    extra = None
    if scale == 1:
        extra = page.evaluate("""() => {
          const sp = [...document.querySelectorAll('#measureMark span')];
          const x0 = sp[0].getBoundingClientRect().left;
          const mm = document.querySelector('#measureMark').getBoundingClientRect();
          const rule = document.querySelector('#rule').getBoundingClientRect();
          return { offsets: sp.map(s => s.getBoundingClientRect().left - x0), ruleTop: rule.top - mm.top };
        }""")
    ctx.close()
    return sizes, extra


def main():
    html = build_html()
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        sizes1, extra = shoot(browser, html, 1)
        sizes2, _ = shoot(browser, html, 2)
        browser.close()

    def img(key):
        base, w, h = sizes1[key]
        return {"file1x": base + "@1x.png", "file2x": base + "@2x.png", "width": w, "height": h}

    manifest = {
        "stage": {"width": 1920, "height": 1080},
        "pad": PAD,
        "images": {
            "termpolisMark": img("termpolisMark"),
            "termpolisTag": img("termpolisTag"),
            "lumopolisTag": img("lumopolisTag"),
            "letters": [img("letter%d" % i) for i in range(len(WORD))],
        },
        "letterOffsets": [round(o, 2) for o in extra["offsets"]],
        "ruleTop": round(extra["ruleTop"], 2),
    }
    # LF on every platform: write_text would turn "\n" into CRLF on Windows.
    with open(OUT / "manifest.json", "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(manifest, indent=2) + "\n")
    print("wrote", len(list(OUT.glob("*.png"))), "PNGs and manifest.json")


if __name__ == "__main__":
    main()
