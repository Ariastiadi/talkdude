"""Subset Material Symbols Rounded to the icons talkdude uses (ligature font).

Run again after using a new icon name in the UI:
  1. Download MaterialSymbolsRounded[FILL,GRAD,opsz,wght].ttf (or the static Rounded TTF) from
     https://github.com/google/material-design-icons/tree/master/variablefont
  2. pip install fonttools brotli
  3. python3 scripts/subset-icons.py <downloaded.ttf> public/fonts/MaterialSymbolsRounded-subset.woff2
"""
import re, glob, sys
from fontTools.ttLib import TTFont
from fontTools import subset

SRC, OUT = sys.argv[1], sys.argv[2]
EXTRA = {"chat_bubble", "error", "warning", "more_vert", "person", "smart_toy", "visibility", "visibility_off",
         "content_paste", "arrow_upward", "arrow_downward", "check_box", "check_box_outline_blank", "image", "close"}

f = TTFont(SRC)
gsub = f["GSUB"].table
all_names = set()
for lk in gsub.LookupList.Lookup:
    for st in lk.SubTable:
        t = st.ExtSubTable if lk.LookupType == 7 else st
        if hasattr(t, "ligatures"):
            for ligs in t.ligatures.values():
                all_names.update(l.LigGlyph for l in ligs)

tokens = set()
for p in glob.glob("src/**/*.ts*", recursive=True):
    s = open(p, encoding="utf-8").read()
    tokens |= set(re.findall(r"[\"'`>]\s*([a-z0-9_]{2,40})\s*[\"'`<]", s))
used = {t for t in tokens | EXTRA if t in all_names}

# Drop every ligature rule except the used icons, so the subsetter's closure
# doesn't pull in the other ~3700 icons through the letter glyphs.
for lk in gsub.LookupList.Lookup:
    for st in lk.SubTable:
        t = st.ExtSubTable if lk.LookupType == 7 else st
        if hasattr(t, "ligatures"):
            for k in list(t.ligatures):
                keep = [l for l in t.ligatures[k] if l.LigGlyph in used]
                if keep: t.ligatures[k] = keep
                else: del t.ligatures[k]

opts = subset.Options()
opts.layout_features = ["liga", "rlig", "calt", "ccmp"]
opts.flavor = "woff2"
opts.name_IDs = ["*"]
opts.notdef_outline = True
sub = subset.Subsetter(opts)
chars = "abcdefghijklmnopqrstuvwxyz0123456789_ "
sub.populate(text=chars, glyphs=sorted(used))
sub.subset(f)
f.flavor = "woff2"
f.save(OUT)
print(f"{len(used)} icons -> {OUT}")
