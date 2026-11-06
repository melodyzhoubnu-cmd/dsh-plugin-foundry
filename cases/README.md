# 案例（Cases）

这里放用来检验「插件到底有没有用」的案例。每个目录都有输入、脚本和 `verify.py`，可以直接复跑。

## 判据

一个插件值得被推荐，至少要满足一条：

1. **打包内容 / 规则**：模型没有那份条款、标准或目录，自己写要重造一遍；
2. **外部数据 / 服务**：没有凭证就没有数据，本地脚本变不出来；
3. **应用内界面**：渲染发生在客户端，agent 只能输出文本。

只满足「本地代码更好写」的，不算——那种插件会被 agent 自己重写掉。

## 三个正例

| 案例 | 插件 | 抓到了什么 |
|---|---|---|
| [icd-audit](icd-audit/CASE.md) | `dsh-icd-rule-check` | 5 条编码差异；没配对照表的检查明确 `skipped`，不猜 |
| [nurse-record](nurse-record/CASE.md) | `dsh-nurse-record-check` | 5 条时限/签名差异；6 小时补记、三级签名都有条款原文 |
| [medrec-qc](medrec-qc/CASE.md) | `dsh-medrec-qc` | 6 条首页矛盾；必填栏、日期先后、编码形式都对应到 24 号文 |

它们的共同点：**标准在插件里，不在模型里**。报告逐条带文号、条款号和逐字摘录，还明确区分「没查到」和「查不了」（`skipped`）。这三份报告，模型自己写不出来同等引用，也不敢像插件这样只列差异、不下结论。

## 一个反例

| 案例 | 插件 | 结论 |
|---|---|---|
| [scan-ocr](scan-ocr/CASE.md) | `dsh-ocr-free` | 系统 Vision 一条 Swift 脚本就能做，插件只是封装 |

反例不是失败品，是判据的一部分：本地系统已有的能力，包装成插件也挡不住 agent 自己调。

## 复跑

```sh
python3 cases/icd-audit/verify.py
python3 cases/nurse-record/verify.py
python3 cases/medrec-qc/verify.py
python3 cases/scan-ocr/verify.py
```

三个正例需要先装对应插件（`dsh-icd-rule-check`、`dsh-nurse-record-check`、`dsh-medrec-qc`，都是 npm 0.2.1x）；反例用本地工具就能复现，正好是对照组。
