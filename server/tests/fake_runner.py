"""Stand-in for bin/run-job.mjs: same JSON-lines contract, no Node, no model."""

import json
import sys
import time
from pathlib import Path


def main() -> int:
    args = sys.argv[1:]
    spec = json.loads(Path(args[args.index("--spec") + 1]).read_text(encoding="utf-8"))
    data_dir = Path(spec["dataDir"])
    emit = lambda payload: print(json.dumps(payload, ensure_ascii=False), flush=True)  # noqa: E731

    emit({"type": "progress", "status": "running", "phase": "parse", "progress": 0.05, "message": "解析文件…"})
    time.sleep(0.02)
    emit({"type": "progress", "status": "running", "phase": "summary", "progress": 0.5, "message": "生成摘要…"})
    time.sleep(0.02)
    reports = data_dir / "reports"
    reports.mkdir(parents=True, exist_ok=True)
    report = reports / "fake-report.md"
    report.write_text(
        "# 假报告\n\n这是测试用报告，用来验证任务状态流转。\n\n| 章 | 要点 |\n| --- | --- |\n| 1 | 甲 |\n",
        encoding="utf-8",
    )
    emit(
        {
            "type": "done",
            "id": spec.get("id"),
            "status": "done",
            "reportPath": str(report),
            "chapters": 2,
            "elapsedMs": 120,
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
