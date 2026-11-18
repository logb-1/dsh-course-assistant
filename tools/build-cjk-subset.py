#!/usr/bin/env python3
"""Build the bundled CJK font subset used by the PDF renderer.

The plugin must render Chinese PDFs on a machine that has no Chinese font
(Linux container on Render). We therefore ship a subset of Noto Sans SC
(SIL Open Font License 1.1) covering GB2312 + ASCII + common punctuation.

Source font (not shipped): NotoSansSC-VF.ttf from Google Fonts / noto-cjk.
Run from the repository root:

    server/.venv/Scripts/python.exe tools/build-cjk-subset.py \
        --source C:/Windows/Fonts/NotoSansSC-VF.ttf

The script instantiates the variable font at wght=400 and subsets it.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


def gb2312_chars() -> set[str]:
    chars: set[str] = set()
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                continue
    return chars


def extra_chars() -> set[str]:
    # Full-width forms and punctuation that reports actually use.
    ranges = [
        (0x3000, 0x303F),  # CJK symbols and punctuation
        (0xFF00, 0xFFEF),  # halfwidth and fullwidth forms
    ]
    chars = {chr(cp) for start, end in ranges for cp in range(start, end + 1)}
    chars.update("·—…“”‘’《》〈〉「」『』【】〔〕、。，；：？！（）％＋－×÷＝～￥")
    chars.update("Ωπ√≤≥≠∞°±→←↑↓■□●○◆◇★☆")
    chars.update(chr(cp) for cp in range(0x20, 0x7F))  # printable ASCII
    return chars


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="variable Noto Sans SC TTF")
    parser.add_argument("--out", default="assets/fonts/NotoSansSC-Regular.ttf")
    parser.add_argument("--weight", type=int, default=400)
    args = parser.parse_args()

    source = Path(args.source)
    if not source.exists():
        print(f"source font not found: {source}", file=sys.stderr)
        return 2

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    static_path = Path(tempfile.gettempdir()) / "NotoSansSC-Regular.full.ttf"
    font = TTFont(source)
    instantiateVariableFont(font, {"wght": args.weight}, inplace=True)
    font.save(static_path)
    print(f"instanced: {static_path} ({static_path.stat().st_size} bytes)")

    chars = gb2312_chars() | extra_chars()
    chars_path = Path(tempfile.gettempdir()) / "course-assistant-charset.txt"
    chars_path.write_text("".join(sorted(chars)), encoding="utf-8")
    print(f"charset: {len(chars)} code points")

    cmd = [
        sys.executable,
        "-m",
        "fontTools.subset",
        str(static_path),
        f"--text-file={chars_path}",
        f"--output-file={out}",
        "--layout-features=*",
        "--no-hinting",
        "--drop-tables+=DSIG",
    ]
    subprocess.run(cmd, check=True)
    print(f"subset: {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
