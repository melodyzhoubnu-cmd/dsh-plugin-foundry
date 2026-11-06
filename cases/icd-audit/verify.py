#!/usr/bin/env python3
"""Verify the ICD audit case.

Checks that the report keeps the five findings, the verbatim citations, the
honest skipped section, and that the plugin never touched the input record.

Run: python3 cases/icd-audit/verify.py
"""
from __future__ import annotations

import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
RECORD = HERE / "input" / "record.json"
REPORT = HERE / "out" / "report.md"

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"[{'PASS' if condition else 'FAIL'}] {label}{(' — ' + detail) if detail else ''}")
    if not condition:
        failures.append(label)


def main() -> int:
    for path in (RECORD, REPORT):
        if not path.exists():
            print(f"missing {path}")
            return 2

    report = REPORT.read_text(encoding="utf-8")

    check("two errors, two warnings, one info", "错误 2 · 提示 2 · 参考 1" in report)
    for rule, needle in [
        ("IC-001", "不符合 ICD-10 形式"),
        ("IC-007", "不符合 ICD-9-CM-3 形式"),
        ("IC-002", "重复出现"),
        ("IC-006", "入院病情代码为 4"),
        ("IC-008", "没有可识别的字面重叠"),
    ]:
        check(f"{rule} finding", rule in report and needle in report)

    check("cites 国卫办医发〔2016〕24号 第六条", "国卫办医发〔2016〕24号" in report and "第六条" in report)
    check("cites 医保办发〔2020〕20号", "医保办发〔2020〕20号" in report)
    check("marks derived conclusions", "原则性条款推论" in report)
    check("IC-003 skipped, not guessed", "IC-003" in report and "未配置 pairs" in report)
    check("disclaimer present", "免责声明" in report)

    record = RECORD.read_text(encoding="utf-8")
    check("input record untouched", "心梗" in record and "360600" in record and "E11.900" in record)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
