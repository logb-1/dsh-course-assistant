#!/usr/bin/env python3
"""RapidOCR helper for the course assistant plugin.

Reads a PDF with PyMuPDF, renders each page to a bitmap and runs RapidOCR
(onnxruntime) over it. Emits one JSON object per line so the Node side can
stream progress:

    {"pageCount": 54}
    {"page": 1, "text": "..."}
    {"error": "..."}                      # fatal, exit code 3

Both packages are optional; when either is missing we say so instead of
crashing, and the plugin falls back to the Windows OCR engine.
"""
import argparse
import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--first", type=int, default=0)
    parser.add_argument("--last", type=int, default=-1)
    parser.add_argument("--dpi", type=int, default=190)
    args = parser.parse_args()

    try:
        import fitz  # PyMuPDF
    except ImportError:
        emit({"error": "missing-pymupdf (pip install pymupdf)"})
        return 3
    try:
        import numpy as np
        from rapidocr_onnxruntime import RapidOCR
    except ImportError:
        emit({"error": "missing-rapidocr (pip install rapidocr_onnxruntime)"})
        return 3

    try:
        doc = fitz.open(args.pdf)
    except Exception as exc:  # noqa: BLE001 - surfaced to the user verbatim
        emit({"error": "cannot-open-pdf: %s" % exc})
        return 3

    total = len(doc)
    last = args.last if 0 <= args.last < total else total - 1
    first = max(0, min(args.first, last))
    emit({"pageCount": total, "first": first, "last": last})

    try:
        engine = RapidOCR()
    except Exception as exc:  # noqa: BLE001
        emit({"error": "cannot-init-rapidocr: %s" % exc})
        return 3

    for index in range(first, last + 1):
        page = doc[index]
        pix = page.get_pixmap(dpi=args.dpi)
        image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        if pix.n == 4:
            image = image[:, :, :3]
        try:
            result, _ = engine(image)
        except Exception as exc:  # noqa: BLE001 - one bad page must not kill the run
            emit({"page": index + 1, "text": "", "warning": str(exc)})
            continue
        lines = [row[1] for row in (result or []) if len(row) > 1 and row[1]]
        emit({"page": index + 1, "text": "\n".join(lines)})

    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
