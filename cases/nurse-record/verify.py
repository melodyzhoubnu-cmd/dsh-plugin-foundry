#!/usr/bin/env python3
"""Verify the nursing-record case.

Run: python3 cases/nurse-record/verify.py
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

    check("counts: 5 errors + 1 warning", "错误 5 · 提示 1" in report)
    for rule, needle in [
        ("NR-001", "记录无签名护士标识"),
        ("NR-002", "记录时间为空"),
        ("NR-003", "只精确到日"),
        ("NR-004", "间隔 10小时10分钟"),
        ("NR-005", "缺 执行人签名"),
        ("NR-009", "压疮（压力性损伤）风险评估"),
    ]:
        check(f"{rule} finding", rule in report and needle in report)
    check("cites 国卫办医发〔2017〕8号", "国卫办医发〔2017〕8号" in report)
    check("cites 卫医政发〔2010〕11号", "卫医政发〔2010〕11号" in report)
    check("cites 6-hour rule", "6小时内" in report)
    check("NR-008 skipped, not passed", "NR-008" in report and "未配置 maxAfterAdmission" in report)
    check("disclaimer present", "免责声明" in report)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
