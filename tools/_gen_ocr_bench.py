"""Generate OCR benchmark images with known ground truth (P2).

Each sample is small or dark on purpose: those are the two failure modes seen on
real slide pictures.
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.environ.get("TEMP", "."), "ca-ocr-bench")
os.makedirs(OUT, exist_ok=True)

CN = r"C:\Windows\Fonts\msyh.ttc"
CN_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
MONO = r"C:\Windows\Fonts\consola.ttf"


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf", size)


samples = []


def add(name, size, lines, bg, fg, font_path, fs):
    img = Image.new("RGB", size, bg)
    d = ImageDraw.Draw(img)
    f = font(font_path, fs)
    y = 20
    for line in lines:
        d.text((24, y), line, fill=fg, font=f)
        y += int(fs * 1.6)
    path = os.path.join(OUT, name + ".png")
    img.save(path)
    samples.append({"id": name, "image": path, "text": " ".join(lines)})


# 1) clean, medium size (baseline)
add("clean_cn", (900, 240), ["补码表示法：负数的反码加一", "IEEE754 单精度浮点"], "white", "black", CN, 44)

# 2) small text — the common slide case
add("small_cn", (520, 160), ["第 3 章 程序的机器级表示", "调用约定与栈帧"], "white", "black", CN, 22)

# 3) dark theme — code screenshots look like this
add("dark_code", (640, 220), ["int main(void) {", "  return 0;", "}"], (30, 32, 38), (220, 220, 220), MONO, 26)

# 4) dark + small Chinese
add("dark_cn", (520, 150), ["浮点数按 IEEE754 存储"], (24, 24, 28), (230, 230, 230), CN, 20)

with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as fh:
    json.dump(samples, fh, ensure_ascii=False, indent=2)

print(json.dumps({"out": OUT, "samples": len(samples)}, ensure_ascii=False))
