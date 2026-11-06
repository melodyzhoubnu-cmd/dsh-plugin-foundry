"""Build demo-sales-折线图.xlsx: formatted data sheet + native Excel line chart."""
from openpyxl import load_workbook, Workbook
from openpyxl.chart import LineChart, Reference
from openpyxl.chart.marker import Marker
from openpyxl.chart.shapes import GraphicalProperties
from openpyxl.chart.text import RichText
from openpyxl.drawing.text import (
    Paragraph, ParagraphProperties, CharacterProperties, RichTextProperties,
)
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

SRC, OUT = "demo-sales.xlsx", "demo-sales-折线图.xlsx"

src_wb = load_workbook(SRC, data_only=False)
src = src_wb["销售表"]
rows = list(src.iter_rows(min_row=1, max_row=src.max_row,
                          max_col=src.max_column, values_only=True))
n = len(rows) - 1

wb = Workbook()
ws = wb.active
ws.title = "销售表"
for r in rows:
    ws.append(list(r))

HDR = "1F3864"
hdr_fill = PatternFill("solid", fgColor=HDR)
band_fill = PatternFill("solid", fgColor="F2F5FA")
thin = Side(style="thin", color="D6DCE5")
border = Border(left=thin, right=thin, top=thin, bottom=thin)

for c in ws[1]:
    c.font = Font(name="微软雅黑", bold=True, color="FFFFFF", size=11)
    c.fill = hdr_fill
    c.alignment = Alignment(horizontal="center", vertical="center")
    c.border = border
ws.row_dimensions[1].height = 26

for r in range(2, n + 2):
    for col in range(1, 5):
        c = ws.cell(row=r, column=col)
        c.border = border
        c.font = Font(name="微软雅黑", size=11)
        if col == 1:
            c.alignment = Alignment(horizontal="center", vertical="center")
        else:
            c.number_format = "#,##0"
            c.alignment = Alignment(horizontal="right", vertical="center")
        if r % 2 == 1:
            c.fill = band_fill

for col, w in zip("ABCD", (12, 15, 14, 14)):
    ws.column_dimensions[col].width = w
ws.freeze_panes = "A2"
ws.sheet_view.showGridLines = False


def txpr(size=1000, bold=False, rot=None, color=None):
    """size is in hundredths of a point (1000 = 10pt)."""
    cp = CharacterProperties(sz=size, b=bool(bold))
    if color:
        cp.solidFill = color
    return RichText(
        bodyPr=RichTextProperties(rot=rot, vert="horz"), 
        p=[Paragraph(pPr=ParagraphProperties(defRPr=cp), endParaRPr=cp)],
    )


ch = LineChart()
ch.title = "2026 年月度销售趋势"
ch.height, ch.width = 10.8, 18.0
ch.add_data(Reference(ws, min_col=2, max_col=4, min_row=1, max_row=n + 1),
            titles_from_data=True)
ch.set_categories(Reference(ws, min_col=1, min_row=2, max_row=n + 1))

palette = ["2E5BFF", "F5883B", "17B26A"]
symbols = ["circle", "square", "triangle"]
for s, color, sym in zip(ch.series, palette, symbols):
    s.smooth = False
    s.graphicalProperties.line.solidFill = color
    s.graphicalProperties.line.width = 28575  # 2.25 pt
    m = Marker(symbol=sym, size=7)
    m.graphicalProperties = GraphicalProperties(solidFill=color)
    m.graphicalProperties.line.solidFill = "FFFFFF"
    m.graphicalProperties.line.width = 9525  # 0.75 pt
    s.marker = m

# Title styling
ch.title.tx.rich.p[0].pPr = ParagraphProperties(
    defRPr=CharacterProperties(sz=1500, b=True, solidFill="1F3864"))

# Axes
ch.x_axis.delete = False
ch.y_axis.delete = False
ch.x_axis.title = "月份"
ch.y_axis.title = "金额（元）"
ch.x_axis.txPr = txpr(size=900, rot=-2700000)   # -45° labels
ch.y_axis.txPr = txpr(size=900)
ch.x_axis.tickLblPos = "low"
ch.y_axis.majorGridlines.spPr = GraphicalProperties()
ch.y_axis.majorGridlines.spPr.line.solidFill = "E8ECF2"
ch.y_axis.majorGridlines.spPr.line.width = 9525
ch.y_axis.scaling.min = 0
ch.y_axis.scaling.max = 250000
ch.y_axis.majorUnit = 50000
ch.y_axis.numFmt = "#,##0"
ch.y_axis.title.tx.rich.p[0].pPr = ParagraphProperties(
    defRPr=CharacterProperties(sz=1000))
ch.x_axis.title.tx.rich.p[0].pPr = ParagraphProperties(
    defRPr=CharacterProperties(sz=1000))

ch.legend.position = "b"
ch.legend.overlay = False
ch.legend.txPr = txpr(size=1000)

# Plot area: white, no border; chart area: thin border
ch.graphical_properties = GraphicalProperties(
    solidFill="FFFFFF", ln=None)
ch.graphical_properties.line.solidFill = "DDE3EC"
ch.graphical_properties.line.width = 9525

ws.add_chart(ch, "F2")
ws_ = ws

wb.save(OUT)
print("saved", OUT)
