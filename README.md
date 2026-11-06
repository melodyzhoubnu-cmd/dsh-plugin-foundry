# 插件工坊 / Plugin Foundry

一个 DSH 插件：把「**对话内分发 → 分布式 token 计量 → 按用量分配**」做成一条可运行的闭环。

## 摘要

> 一个插件生态是否繁荣，不取决于目录里有多少条目，而取决于三件事能否同时成立：开发者愿意持续投入、插件能被需要它的人用上、投入能获得可计量的回报。DSH 生态已有 35,000 个插件，供给不再稀缺；短板在需求侧的分发效率，以及供给侧的收益闭环。
>
> 收益的第一种形态，也是本参考实现唯一实现的一种：**按 token 消耗分成或返点**——用户为模型调用付费，平台按插件归因的 token 把收入分给开发者，或按消耗量返还 token 配额。
>
> 这一切都依赖于同一个前提：插件能被分发出去。没有分发，分成没有基数。因此把问题拆成三个支柱：**在对话内与工作过程中的分发**、**分布式 token 计量**、**按用量分配**。三者合起来，构成生态飞轮的基础设施。

完整论证与边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（v11.6）。架构文档里还保留着「开发者自收费」与「交易型插件」两节设计，**本 demo 不包含这两部分**，代码里也没有对应实现。

## 它解决什么问题

插件市场的拉式模型假设用户知道自己要找什么，也愿意离开任务去找。真实任务里的需求不是这样发生的：

| 断点 | 表现 | 后果 |
|---|---|---|
| **看不见** | 任务进行中，用户不知道有插件能帮上忙 | 用内置方法凑合，或根本不知道有更优路径 |
| **选不对** | 同类太多，质量、兼容性、来源不透明 | 推荐像广告，用户干脆不选 |
| **用不上** | 装完模型不知道，用户也忘了 | 安装量不等于使用量 |

对应的三个支柱：

| 支柱 | 解决的问题 | 本仓库的落点 |
|---|---|---|
| 对话内分发 | 用户看不见、选不对、装完用不上 | 旁路观察事件 → 画像 → BM25 召回 → 门控 → `developer/message` + 回合末尾卡片 |
| 分布式 token 计量 | 用量记不下来、归因对不上、上报不可信 | 三桶归因 → append-only 账本 → Merkle + Ed25519 批次 → 平台验签对账 |
| 按用量分配 | 开发者拿不到可核对的回报 | 平台按归因 token 签发分成 / 返点结算单，金额用整数微单位可复算 |

```text
会话事件 ──► 任务画像 ──► 召回 / 排序 / 门控 ──► developer/message + 回合末尾卡片
                                                    │
                                                    ▼
                                              安装 / 不安装
                                                    │
usage ──► 三桶归因 ──► 账本 ──► Merkle+签名批次 ──► 平台验签 / 对账 ──► 结算单 / 门户
```

## 快速开始

要求 Node.js ≥ 22，零依赖。

```sh
npm test        # 47 项测试：协议、画像、排序、插件、平台、客户端、端到端
npm run demo    # 从冷启到结算的 8 步，末尾输出 Demo: PASS
```

demo 不联网、不写 `~/.dsh`、不启动真实 DSH；产物在 `demo/out/`。

**在 DSH 里装：**

```sh
dsh plugin --profile <profile> add <本仓库绝对路径>
```

刷新页面，冷启弹窗问两件事：安装策略（默认「始终不自动安装」）和用量上报（默认「纯本地」）。之后正常做事，工坊会在需要时把插件卡片写进对话。

## 案例

`cases/` 里是可以直接复跑的插件案例。判据只有一条：**这个能力，agent 用本地工具造不造得出来。**

| 案例 | 插件 | 结论 |
|---|---|---|
| [icd-audit](cases/icd-audit/CASE.md) | `dsh-icd-rule-check` | **正例**：5 条编码差异，每条带文号与条款原文；没配对照表的检查明确 `skipped`，不猜 |
| [nurse-record](cases/nurse-record/CASE.md) | `dsh-nurse-record-check` | **正例**：5 条时限/签名差异；6 小时补记、三级签名都有条款依据 |
| [medrec-qc](cases/medrec-qc/CASE.md) | `dsh-medrec-qc` | **正例**：6 条首页矛盾；必填栏、日期先后、编码形式都对应到 24 号文 |
| [scan-ocr](cases/scan-ocr/CASE.md) | `dsh-ocr-free` | **反例**：系统 Vision 一条 Swift 脚本就能做，插件只是封装 |

三个正例的共同点：**标准在插件里，不在模型里**。报告逐条带文号、条款号和逐字摘录，还区分「没查到」和「查不了」。反例说明另一半：本地已有的能力，包装成插件也挡不住 agent 自己调。

## 目录

```text
src/protocol/    协议层：canonical JSON、Ed25519、归因、账本、批次、结算、目录
src/radar/       DSH 插件：画像、排序、consent、store、meter、uploader、client
src/platform/    参考平台：验签与对账、HTTP server、开发者门户
src/demo/        种子目录、假 Host、端到端演示
cases/           3 个正例 + 1 个反例
test/            47 项测试
docs/            架构原文、协议、实现映射、演示说明
```

## 文档

- [架构原文](docs/ARCHITECTURE.md)：生态视角、三个支柱、协议与结论
- [协议规范](docs/PROTOCOL.md)：`UsageEvent` / `Receipt` / `Batch` / `Settlement` 的字段与验签顺序
- [实现映射](docs/IMPLEMENTATION.md)：每个章节落在哪个文件、哪些是偏离与边界
- [演示说明](docs/DEMO.md)：8 步合成 demo 的输入输出

## 计量与分配

一次请求的 token 按三个桶归因，三者之和不超过总量：`base`（请求本身）、`tool_result`（工具返回内容）、`capability`（能力信号与回执）。写入 append-only 账本，按日聚合成带 Merkle 根和 Ed25519 签名的批次；只有聚合离开本机。

平台按顺序验签、查 install id、去重、检查 `prev` 链、对账，再入库并按分成或返点签发结算单。金额用整数微单位（1e-6）计算，第三方可复算。分成与返点互斥，同一笔用量只取一种口径。

## 配置

`cordis.patch.yml` 里的 `config` 原样传给 `apply(ctx, config)`，全部字段可省略。最常改的几个：

| 字段 | 默认 | 说明 |
|---|---|---|
| `home` | `~/.dsh/plugin-foundry` | 本地状态目录 |
| `catalogUrl` | jsDelivr 目录 | format-1 插件索引，6 小时缓存 |
| `autoInstall` | `true` | 是否允许自动安装；仍受 consent 与门禁约束 |
| `autoMinScore` / `autoMinNet` / `autoMinQuality` | `0.45` / `0.22` / `0.55` | 自动安装门槛 |
| `uploadUrl` / `uploadToken` | 空 | 批次上报地址与 Bearer token |
| `rewardMode` | `share` | `share` 分成 / `rebate` 返点 |

完整字段见 [cordis.patch.yml](cordis.patch.yml) 与 [IMPLEMENTATION](docs/IMPLEMENTATION.md)。

## 已知边界

- **真实环境验证**：macOS · DSH 0.2.2-rc.1 上装过 `dsh-excel-chat`、`dsh-icd-rule-check`、`dsh-nurse-record-check`、`dsh-medrec-qc` 并跑通工具链路；Windows / Linux、其他 DSH 版本、客户端卡片与重启行为仍未验收。
- **推荐是启发式**：BM25 + 规则 + 净值，不是因果判断；阈值来自演示目录，真实目录要重新校准。实测里它会把「表格/报表」类任务推给泛化插件，能力匹配仍需加强。
- **参考平台是单进程 JSON 存储**：没有鉴权、限流、多租户；账单锚点是 Host 累计 token，生产要换成按账期的 provider 账单。
- **支付与交易未实现**：架构文档保留设计，本 demo 与代码都不包含开发者收银台、许可证或交易型插件。
- **组件型插件**（注入 / 压缩）的 token 口径尚未单独实现。

## License

MIT，见 [LICENSE](LICENSE)。
