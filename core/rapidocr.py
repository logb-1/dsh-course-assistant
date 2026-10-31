#!/usr/bin/env python3
"""RapidOCR helper for the course assistant plugin.

Reads a PDF with PyMuPDF, renders each page to a bitmap and runs RapidOCR
(onnxruntime) over it. Emits one JSON object per line so the Node side can
stream progress:

    {"pageCount": 54, "pages": 9}
    {"page": 3, "text": "...", "score": 0.87}
    {"error": "..."}                      # fatal, exit code 3

`--pages 3,17,18` reads exactly those 1-based pages; that is what page-level
triage uses to skip pages whose text layer is already readable. `score` is the
mean line confidence, which the Node side compares against a second engine.

Both packages are optional; when either is missing we say so instead of
crashing, and the plugin falls back to the Windows OCR engine.
"""
import argparse
import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_pages(spec, total):
    """'3,17,18' -> [2, 16, 17]; out-of-range and junk tokens are dropped."""
    wanted = set()
    for token in str(spec or "").split(","):
        token = token.strip()
        if not token.isdigit():
            continue
        number = int(token)
        if 1 <= number <= total:
            wanted.add(number)
    return sorted(number - 1 for number in wanted)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", default="")
    parser.add_argument("--image", default="")
    parser.add_argument("--pages", default="")
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

    source = args.image or args.pdf
    if not source:
        emit({"error": "no-input"})
        return 4
    try:
        doc = fitz.open(source)
    except Exception as exc:  # noqa: BLE001 - surfaced to the user verbatim
        emit({"error": "cannot-open-pdf: %s" % exc})
        return 3

    total = len(doc)
    if args.image:
        indices = [0]
    elif args.pages:
        indices = parse_pages(args.pages, total)
        if not indices:
            emit({"error": "no-valid-pages"})
            return 4
    else:
        last = args.last if 0 <= args.last < total else total - 1
        first = max(0, min(args.first, last))
        indices = list(range(first, last + 1))
    emit({"pageCount": total, "pages": len(indices)})

    try:
        engine = RapidOCR()
    except Exception as exc:  # noqa: BLE001
        emit({"error": "cannot-init-rapidocr: %s" % exc})
        return 3

    for index in indices:
        page = doc[index]
        pix = page.get_pixmap(dpi=args.dpi)
        image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        if pix.n == 4:
            image = image[:, :, :3]
        try:
            result, _ = engine(image)
        except Exception as exc:  # noqa: BLE001 - one bad page must not kill the run
            emit({"page": index + 1, "text": "", "score": 0.0, "warning": str(exc)})
            continue
        lines = [row[1] for row in (result or []) if len(row) > 1 and row[1]]
        scores = [float(row[2]) for row in (result or []) if len(row) > 2 and isinstance(row[2], (int, float))]
        payload = {"page": index + 1, "text": "\n".join(lines)}
        if scores:
            payload["score"] = round(sum(scores) / len(scores), 3)
        emit(payload)

    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
