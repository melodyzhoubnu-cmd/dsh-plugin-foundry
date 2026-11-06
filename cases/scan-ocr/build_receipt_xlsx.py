#!/usr/bin/env python3
"""Build a formatted expense workbook from the locally OCR'd receipt."""
from __future__ import annotations

import csv
import json
from datetime import date
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.page import PageMargins

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
XLSX = OUT / "费用报销单.xlsx"
CSV = OUT / "receipt.csv"
JSON = OUT / "receipt-data.json"

meta = {
    "单据类型": "费用报销单",
    "报销部门": "市场部",
    "报销人": "林晓",
    "填报日期": "2026-10-18",
}
items = [
    {"序号": 1, "费用项目": "高铁票（上海—杭州）", "发生日期": "2026-10-11", "金额": 328.00, "备注": "出差"},
    {"序号": 2, "费用项目": "客户招待餐费", "发生日期": "2026-10-12", "金额": 1260.00, "备注": "3 人"},
    {"序号": 3, "费用项目": "酒店住宿 2 晚", "发生日期": "2026-10-11", "金额": 896.00, "备注": "含早"},
    {"序号": 4, "费用项目": "出租车费", "发生日期": "2026-10-13", "金额": 74.50, "备注": "机场往返"},
    {"序号": 5, "费用项目": "样品快递费", "发生日期": "2026-10-14", "金额": 42.00, "备注": "顺丰"},
]
printed_total = 2600.50
calculated_total = round(sum(item["金额"] for item in items), 2)
assert calculated_total == printed_total, (calculated_total, printed_total)

JSON.write_text(
    json.dumps(
        {
            "meta": meta,
            "items": items,
            "printed_total": printed_total,
            "calculated_total": calculated_total,
            "source": "cases/scan-ocr/input/receipt-scan.png",
            "ocr": "Apple Vision, local, offline",
        },
        ensure_ascii=False,
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)

with CSV.open("w", encoding="utf-8", newline="") as handle:
    writer = csv.DictWriter(handle, fieldnames=["序号", "费用项目", "发生日期", "金额", "备注"])
    writer.writeheader()
    for item in items:
        writer.writerow({**item, "金额": f'{item["金额"]:.2f}'})
    writer.writerow({"序号": "合计", "金额": f"{calculated_total:.2f}"})

NAVY = "17365D"
BLUE = "2F5597"
PALE_BLUE = "EDF2F9"
LIGHT_ROW = "F5F8FC"
TOTAL_FILL = "D9E2F3"
BORDER = "B4C6E7"
TEXT = "1F2937"
MUTED = "5B6573"
WHITE = "FFFFFF"

thin = Side(style="thin", color=BORDER)
medium = Side(style="medium", color=BLUE)
all_thin = Border(left=thin, right=thin, top=thin, bottom=thin)
font_name = "PingFang SC"

wb = Workbook()
ws = wb.active
ws.title = "费用明细"
ws.sheet_view.showGridLines = False

# Title
ws.merge_cells("A1:E1")
ws["A1"] = meta["单据类型"]
ws["A1"].font = Font(name=font_name, size=20, bold=True, color=WHITE)
ws["A1"].fill = PatternFill("solid", fgColor=NAVY)
ws["A1"].alignment = Alignment(horizontal="center", vertical="center")
ws.row_dimensions[1].height = 48

# Metadata strip
ws.merge_cells("A2:B2")
ws["A2"] = f'报销部门：{meta["报销部门"]}'
ws.merge_cells("C2:D2")
ws["C2"] = f'报销人：{meta["报销人"]}'
ws["E2"] = f'日期：{meta["填报日期"]}'
for ref in ("A2", "C2", "E2"):
    cell = ws[ref]
    cell.font = Font(name=font_name, size=11, color=TEXT)
    cell.fill = PatternFill("solid", fgColor=PALE_BLUE)
    cell.alignment = Alignment(horizontal="left", vertical="center", indent=1)
    cell.border = Border(bottom=thin)
ws.row_dimensions[2].height = 28

# Spacer
ws.row_dimensions[3].height = 10

# Table header
headers = ["序号", "费用项目", "发生日期", "金额（元）", "备注"]
for col, header in enumerate(headers, start=1):
    cell = ws.cell(row=4, column=col, value=header)
    cell.font = Font(name=font_name, size=11, bold=True, color=WHITE)
    cell.fill = PatternFill("solid", fgColor=BLUE)
    cell.alignment = Alignment(horizontal="center", vertical="center")
    cell.border = Border(left=thin, right=thin, top=medium, bottom=medium)
ws.row_dimensions[4].height = 30

# Items
for index, item in enumerate(items):
    row = 5 + index
    values = [item["序号"], item["费用项目"], date.fromisoformat(item["发生日期"]), item["金额"], item["备注"]]
    for col, value in enumerate(values, start=1):
        cell = ws.cell(row=row, column=col, value=value)
        cell.font = Font(name=font_name, size=11, color=TEXT)
        cell.border = all_thin
        cell.fill = PatternFill("solid", fgColor=(WHITE if index % 2 == 0 else LIGHT_ROW))
        if col == 1:
            cell.alignment = Alignment(horizontal="center", vertical="center")
        elif col == 3:
            cell.alignment = Alignment(horizontal="center", vertical="center")
            cell.number_format = "yyyy-mm-dd"
        elif col == 4:
            cell.alignment = Alignment(horizontal="right", vertical="center")
            cell.number_format = '¥#,##0.00;[Red]-¥#,##0.00'
        else:
            cell.alignment = Alignment(horizontal="left", vertical="center", indent=1)
    ws.row_dimensions[row].height = 28

# Total
ws.merge_cells("A10:C10")
ws["A10"] = "合计（人民币）"
ws["D10"] = "=SUM(D5:D9)"
ws["E10"] = None
for ref in ("A10", "B10", "C10", "D10", "E10"):
    cell = ws[ref]
    cell.fill = PatternFill("solid", fgColor=TOTAL_FILL)
    cell.font = Font(name=font_name, size=12, bold=True, color=NAVY)
    cell.border = Border(left=thin, right=thin, top=medium, bottom=Side(style="double", color=NAVY))
ws["A10"].alignment = Alignment(horizontal="right", vertical="center", indent=1)
ws["D10"].alignment = Alignment(horizontal="right", vertical="center")
ws["D10"].number_format = '¥#,##0.00;[Red]-¥#,##0.00'
ws.row_dimensions[10].height = 32

# Note
ws.merge_cells("A12:E12")
ws["A12"] = "备注：本单据需在 11 月 5 日前提交。"
ws["A12"].font = Font(name=font_name, size=10, color=MUTED)
ws["A12"].alignment = Alignment(horizontal="left", vertical="center", indent=1)
ws.row_dimensions[12].height = 22

# Column widths
for column, width in {"A": 7, "B": 32, "C": 15, "D": 16, "E": 24}.items():
    ws.column_dimensions[column].width = width

# Freeze panes
ws.freeze_panes = "A5"

# Print setup
ws.print_area = "A1:E12"
ws.page_setup.orientation = "landscape"
ws.page_setup.paperSize = ws.PAPERSIZE_A4
ws.page_setup.fitToWidth = 1
ws.page_setup.fitToHeight = 1
ws.sheet_properties.pageSetUpPr.fitToPage = True
ws.page_margins = PageMargins(left=0.5, right=0.5, top=0.6, bottom=0.6)

wb.properties.title = "费用报销单"
wb.properties.subject = "本地 OCR 识别后录入的费用明细"
wb.properties.creator = "Local Apple Vision OCR"
wb.properties.description = "来源：cases/scan-ocr/input/receipt-scan.png；OCR 全程本地运行，未联网。"

wb.save(XLSX)
print(f"saved {XLSX}")
print(f"saved {CSV}")
print(f"saved {JSON}")
print(f"total {calculated_total:.2f}")
