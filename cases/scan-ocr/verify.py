#!/usr/bin/env python3
"""Verify the scan-OCR case.

Checks that the PDF really has no text layer, that the OCR text carries every
field, and that the transcribed CSV adds up.

Run: python3 cases/scan-ocr/verify.py
"""
from __future__ import annotations

import csv
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
PDF = HERE / "input" / "receipt-scan.pdf"
OCR = HERE / "out" / "receipt-ocr.txt"
CSV = HERE / "out" / "receipt.csv"

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"[{'PASS' if condition else 'FAIL'}] {label}{(' — ' + detail) if detail else ''}")
    if not condition:
        failures.append(label)


def main() -> int:
    for path in (PDF, OCR, CSV):
        if not path.exists():
            print(f"missing {path}")
            return 2

    raw = PDF.read_bytes()
    check("PDF has no fonts", b"/Font" not in raw)
    check("PDF has no text operators", raw.count(b"BT") == 0, f"{raw.count(b'BT')} BT")
    check("PDF is one image xobject", b"/Subtype /Image" in raw)

    text = OCR.read_text(encoding="utf-8")
    for field in ("报销单", "林晓", "2026-10-18", "2,600.50", "顺丰", "机场往返"):
        check(f"OCR text contains {field}", field in text)

    with CSV.open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    check("5 line items + total", len(rows) == 6, f"{len(rows)} rows")

    items = rows[:5]
    total = rows[5]
    amounts = [float(row["金额"]) for row in items]
    check("amounts add up to the printed total", abs(sum(amounts) - 2600.50) < 0.001, f"{sum(amounts):.2f}")
    check("total row matches", abs(float(total["金额"]) - 2600.50) < 0.001)
    check("every amount appears in OCR text", all(f"{value:,.2f}" in text.replace("¥", "") for value in amounts))
    check("every date appears in OCR text", all(row["发生日期"] in text for row in items))

    print()
    if failures:
        print(f"{len(failures)} check(s) failed")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
