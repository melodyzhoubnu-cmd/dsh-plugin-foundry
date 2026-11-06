#!/usr/bin/env python3
"""Verify the medical-record front-page case.

Run: python3 cases/medrec-qc/verify.py
"""
from __future__ import annotations

import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
REPORT = HERE / "out" / "report.md"

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"[{'PASS' if condition else 'FAIL'}] {label}{(' — ' + detail) if detail else ''}")
    if not condition:
        failures.append(label)


def main() -> int:
    if not REPORT.exists():
        print(f"missing {REPORT}")
        return 2
    report = REPORT.read_text(encoding="utf-8")

    check("counts: 6 errors", "错误 6" in report)
    for rule, needle in [
        ("MR-001", "「主治医师」为空"),
        ("MR-002", "只精确到日"),
        ("MR-003", "出院时间早于入院时间"),
        ("MR-006", "不符合编码形式"),
        ("MR-009", "签名栏缺 主治医师"),
    ]:
        check(f"{rule} finding", rule in report and needle in report)
    check("cites 国卫办医发〔2016〕24号", "国卫办医发〔2016〕24号" in report)
    check("cites 卫医政发〔2011〕84号", "卫医政发〔2011〕84号" in report)
    check("skips inapplicable checks", "MR-012" in report and "MR-015" in report)
    check("disclaimer present", "免责声明" in report)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
