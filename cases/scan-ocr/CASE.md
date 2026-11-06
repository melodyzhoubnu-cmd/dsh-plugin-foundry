# Case：扫描件录入（反例）

> **结论：未通过。** 文件确实没有文字层，但 macOS 自带的 Vision 一条 Swift 脚本就能 OCR；插件只是把系统能力封装了一遍。

## 原来的假设

一张扫描的报销单 PDF——没有字体、没有文本操作符、只有一张图。不装 OCR 插件，任务在「拿数据」这一步就停了。

## 实测

- 插件 `ocr_image` 跑出 27 行、0.4 秒，金额、日期、备注都读到了，转录后 5 笔合计 2,600.50，与票面一致；
- 但 agent 没有装插件：它写了一条 [`ocr_local.swift`](ocr_local.swift)，直接调 `Vision` 框架，同样读出了文字并录成了表；
- 也就是说，缺的是「本机没有现成 OCR 命令」，不是「模型没有这个能力」。

## 为什么不算

插件把系统 Vision 包成了可复用工具，省了写脚本；但 agent 自己会写这条脚本，所以它不是唯一路径。

## 保留的文件

- [`input/receipt-scan.pdf`](input/receipt-scan.pdf) / [`input/receipt-scan.png`](input/receipt-scan.png)：无文字层的扫描件
- [`ocr_local.swift`](ocr_local.swift)：本地 Vision 路径
- [`build_receipt_xlsx.py`](build_receipt_xlsx.py)：把识别结果录成表
- [`out/receipt-ocr.txt`](out/receipt-ocr.txt) / [`out/receipt.csv`](out/receipt.csv)：OCR 文本与转录结果
- [`verify.py`](verify.py)：14 项校验

```sh
python3 cases/scan-ocr/verify.py
```
