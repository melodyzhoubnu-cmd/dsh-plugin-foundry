# 实现映射与决策

> 对应 [ARCHITECTURE.md](./ARCHITECTURE.md) v11.6。本文说明每个章节落在哪个文件、哪些地方做了不同选择、哪些仍是边界。

## 1. 章节 → 代码

| 架构 | 实现 | 说明 |
|---|---|---|
| §1.1 三个断点 | `src/radar/task.js`、`rank.js` | 画像来自会话事件；召回是 BM25；推荐写进对话 |
| §1.2 现有做法 | — | 产品判断，不是代码 |
| §1.3 官方底座 | `src/protocol/`、`src/platform/server.js`、`src/radar/client.js` | 协议开源、参考平台、冷启入口 |
| §1.4 旁路架构 | `src/radar/index.js`（观察 → 评估 → 门控 → 投递）、`notify.js` | 静默时 0 token；触发时只追加一条 developer message |
| §1.5 Demo | `cases/icd-audit/`（真实插件）、`src/demo/run.js`、`test/demo.test.js` | 真实链路是 `dsh-icd-rule-check`；合成 demo 8 步覆盖分发、计量、结算、门户 |
| §2.1 按 token 分成 | `src/protocol/settlement.js` | 分成 / 返点两种口径，互斥 |
| §2.2 记录 | `src/radar/meter.js`、`store.js` | UsageEvent 写入 append-only 账本 |
| §2.3 归因 | `src/protocol/attribution.js` | 三桶 + 封顶 + 未归因 |
| §2.4 聚合与上报 | `src/protocol/batch.js`、`src/radar/uploader.js` | Merkle、prev 链、Ed25519、gzip、幂等、重试 |
| §2.5 纯本地与边界 | `store.js`、`uploader.js`、`test/plugin.test.js` | `local` 模式不上传；账单锚点 |
| §2.6 防滥用 | 已有：三桶封顶、账单对账、签名链、model source 校验、预算与撤销；缺口：每插件预算、异常检测、签名工具归属 | 见本文第 8 节 |
| §3.1 平台边界 | — | 设计稿；demo 未实现 |
| §3.2 开发者自收费 | — | 设计稿；demo 未实现 |
| §3.3 交易型插件 | — | 设计稿；demo 未实现 |
| §3.4 商店基座与最小集 | — | 设计稿；demo 未实现 |
| §4 结论 | 本文第 5 节 | 边界与后续 |

## 2. 分发

### 2.1 任务画像

`createTaskTracker()` 是每会话的状态机，观察：

- `turn/start`、`step/start`、`turn/end`：turn/step 与收尾阶段；
- `user/message`：最近 8 条用户文本、意图；
- `assistant/message`：工具调用、助手文本；
- `tool/call`、`tool/result`：工具名、结果大小、错误；
- 任意事件里的文件后缀（`.xlsx`、`.docx`…）。

输出 `TaskProfile`：`taskTypes`、`keywords`、`fileTypes`、`tools`、`errors`、`stage`、`recipe`、`intent`、`opportunity`、`signals`、`label`。

意图与机会：

| 机会 | 触发 | 置信度 |
|---|---|---|
| `gap` | 依赖/命令报错、用户问「有没有工具」 | 0.72–0.85 |
| `uplift` | 有任务类型，且正用 bash / write / edit 手工处理文件 | 0.62 |
| `discovery` | 任务类型命中目录能力 | 0.5 |
| `recipe` | 任务类型 + 配方模式（月度报表、调试、调研、演示） | 0.68 |

### 2.2 召回与排序

`createRanker(entries)` 在目录加载后构建一次 BM25 索引：

- 字段权重：标题 3、名称 2、关键词 2、能力 2、描述 1、类目 1；
- 查询：画像关键词 + 文件后缀 + 任务类型关键词 + 配方能力；
- `text = raw / max(raw)` 归一化。

综合分严格按文档权重：

```text
score = 0.35·text + 0.20·tags + 0.10·stage
      + 0.15·quality + 0.05·freshness + 0.10·feedback + 0.05·diversity
```

- `tags`：任务类型 → 类目 / 能力命中（能力 70% + 类目 30%）；
- `stage`：规划偏 tools/skill/research，执行偏 docs/tools/dev，调试偏 dev/tools，收尾偏 docs/notify/memory；
- `quality`：目录 `metadata.quality.score`；没有时用 curated/verified/用户数/版本数/新鲜度合成；
- `freshness = 1 / (1 + days/120)`；
- `feedback`：类目亲和度 `0.5 + affinity/6`，ignored 7 天内过滤，revoked 永久过滤；
- `diversity`：MMR 式惩罚，最多 1 张卡时通常不触发。

净值门控：

```text
confidence = 0.45 + 0.35·opportunity.confidence + 0.20·quality
install    = 0.05（免费）/ 0.10（付费）+ 0.10 postinstall + 0.05 restart
risk       = 0.15 postinstall + 0.08 restart + 0.15 dataEgress
interrupt  = 0.08（默认）
net        = score·confidence − interrupt − install − risk
```

`score < minScore` 或 `net < minNet` 不投递。这样「匹配但代价高」的插件不会打扰用户。

### 2.3 自动安装门禁

只有同时满足以下条件才静默安装 top1：

| 检查 | 不过时 |
|---|---|
| `allowInstall && autoInstall` | 只推荐 |
| consent 已保存、策略为 `all` / `official` | 只推荐 |
| 授权更新时间早于最后一条用户消息 | 只推荐 |
| 最后一条用户消息在 5 分钟内 | 只推荐 |
| `score ≥ 0.45`、`net ≥ 0.22`、`confidence ≥ 0.6` | 只推荐 |
| 目录质量分 ≥ 0.55 | 只推荐 |
| 来源是 npm、版本数 ≥ 2（official 策略） | 只推荐 |
| 无 postinstall、无需重启、无数据外发 | 只推荐 |
| 不在 security/terminal/system/market/theme/fun | 只推荐 |
| 未被 ignored / revoked / never | 只推荐 |
| 当天预算 < 3、同插件只装一次、同会话一次 | 只推荐 |

安装成功 → `developer/message` 说明「已装好，下一步可直接使用」，并把目录 `metadata.tools` 写入本地 `tool-owners.json`，下一步的工具调用即可归因。
安装失败 → 明确写「安装失败，当前没有安装」，不把失败说成成功。

### 2.4 投递

`src/radar/notify.js` 追加 `developer/message`：

```js
session.append('developer/message', {
  turn, step,
  message: {
    id, role: 'developer',
    source: { kind: 'capability', form: 'notice', summary: 'plugin-foundry' },
    content: [{ type: 'text', text }],
  },
}, { surfaceOp: 'append' })
```

只追加到会话尾部，不改工具声明、不重写 system prompt。失败时先尝试省略 turn/step 的兼容写法，再记录警告。投递的文本同时记为 capability 信号，下一次请求计量时归入 `capability` 桶。

客户端的回合末尾卡片（`conversation.chat.turnTail`，`plugin-foundry-turn-tail`）读取同一个 `context` 节点，把这段文本再次显示给用户；DSH 自带的 Chat 会把 `developer/message` 渲染成折叠的 context 行，用户不容易注意到。卡片不额外写会话、不调用模型、不增加 token，只是同一份内容的可见呈现。

**模型自检的互补**：`task.js` 观察 `plugin_market` 和带插件关键词的 `web_search` 调用；命中后 `evaluateDiscovery()` 用同一份聚合目录 + npm registry 搜索排序，把 top 3 作为一条 `developer/message` 注入下一步。它不注册新工具、不重复模型已经拿到的网页结果，只补上「目录里有哪些、是否已安装、分数多少」。

**覆盖范围**：静态目录支持 `catalogUrls` 多索引（按包名合并、保留更高质量元数据）；模型查找插件时按需请求 npm registry 与 GitHub 仓库搜索，把未收录的包作为低质量先验的候选。静态目录的 top 分数低于 `discoveryMinScore` 或质量分低于 0.5 时，普通任务也会先扩召回再排序，避免「目录里没有就找不到」。这不是字面意义上的全网爬取，而是「可安装来源的聚合 + 按需搜索」；GitHub 仓库通过 `installSpec` 安装，`inspect` 不通过就不装。

**明确同意全部自动安装的人**：`autoEligible` 对 `policy === 'all'` 使用 `autoMinQualityAll`（默认 0.15），允许 npm 与 git 源进入自动安装；仍然要求 score/net/confidence、免费、无 postinstall/重启/数据外发、预算和去重。安装成功后回执额外写明「这是你授权全部自动安装后的自动安装」，客户端卡片显示「已自动安装」、它能带来的好处和撤销按钮。

## 3. 计量

### 3.1 事件来源

`ctx.on('session/event')` 里：

1. `tracker.observe` 更新画像；
2. `meter.observe` 维护「当前请求的待归因工具调用」；
3. `assistant/message` 读到 `usage` 时 `meter.record`（只接受 `message.source.kind === 'model'`，插件伪造的 surface 事件不会进入账本）：
   - 取出当前请求的调用与被消费的 capability 信号；
   - `attributeRequest` 生成三桶行；
   - 每个 (plugin, bucket) 写一条 UsageEvent；
   - 还有未归因余量时，再写一条 `plugin_id: null` 事件；
   - 标记 notice 已计量。

为什么要「待归因调用」：工具结果在 assistant message 之后才到，下一次请求的 usage 才是包含结果的请求。`meter.observe` 在 `tool/result` 时把调用和结果 token 存进 pending，下一次 `record` 消费；否则带结果的请求会全部变成未归因。

### 3.2 估算与精确值

- provider 给的 `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens` 是精确值；
- 工具结果与 capability 信号的 token 是估算值（CJK 1 token/字，其他约 4 字符/token），只在桶内分配时使用；
- 三桶封顶保证最终归因不超过 provider 真实值。

### 3.3 账本与批次

- `createLedger` 每次 append 同步写 JSONL，head 用原子替换；
- `verify()` 重算整条链，检测 hash、seq、prev 不一致；
- `buildBatch` 按 `event_count` 聚合，`root = merkleRoot(hashes)`，`prev` 是上一条被接受批次的 root；
- 只上传聚合；`Receipt` 带事件哈希样本，用于争议。

### 3.4 上传与 outbox

- 只有 `reporting === 'contribute'` 且 `uploadUrl` 非空才上传；
- 请求路径只 `schedule()`，5 秒后异步 flush；
- 批次先落本地 `batches.json`，并写 `outbox/<batch_id>.json.gz`；
- 失败指数退避（5s 起，最大 5 分钟），成功的批次删除 outbox；
- 重复批次返回 `duplicate: true`，不会重复计费；
- `prev` 链保证批次顺序；重放旧批会被平台按 id 去重。

## 4. 支付与交易（未实现）

架构文档第 3 章保留了开发者自收费、许可证与交易型插件的设计，但本 demo 与代码**不包含**这些能力：没有收银台、没有许可证、没有交易型插件条目。参考实现只覆盖分发、计量与按用量分配。

## 5. 参考平台

`src/platform/server.js` 是零依赖 HTTP 服务：

| 路由 | 作用 |
|---|---|
| `POST /v1/hosts/register` | 注册 Host 公钥、install id、运行时版本 |
| `POST /v1/hosts/bill` | 写入 provider 账单锚点（参考实现按 Host 累计） |
| `POST /v1/usage/batches` | 验签、幂等、prev 链、对账、入库 |
| `GET /v1/settlements` | 按 publisher / 日期生成并签名结算单 |
| `GET /v1/settlements/:id` | 读取并复验结算单 |
| `POST /v1/distributors` | 注册自签名分销商清单 |
| `GET /v1/catalog` | format-1 目录 |
| `GET /portal` / `GET /portal.json` | 开发者门户（HTML / JSON） |

平台状态是一个 JSON 文件（`state.json`），包含 hosts、batches、hostSeq、rollups、bills、distributors、settlements。生产实现应换数据库，但字段和验证顺序不变。

## 6. 安全与边界

- 私钥权限 `0600`；只存在本地目录；
- 上传与结算都验签；批次不验签不入库；
- 归因有上限，账单是外部锚点；超出缩放并记争议；
- 本地账本 append-only，可检测删改；
- 纯本地模式没有任何网络请求（目录拉取除外）；
- §2.6 的防滥用机制当前只实现了「可验证 + 可封顶」的一部分：账单锚点、三桶封顶、model source 校验、预算与撤销；每插件预算、按有用增量结算、异常检测、签名工具归属仍是后续工作。

## 7. 与架构文档的差异

| 架构 | 实现 | 原因 |
|---|---|---|
| 侧栏 / 悬浮卡（历史章节） | 只保留冷启弹窗 | v11 明确改成对话内 `developer/message`；侧栏会被忽略 |
| §1.3 提到「计量与结算、冷启入口」是官方职责 | 本仓库同时提供参考实现 | 便于第三方按同一协议接入与复算，不主张官方身份 |
| §2.4 账单是周期账单 | 参考平台用 Host 累计 token 锚点 | 单场景 demo；生产应按账期比对 provider 账单 |
| §2.3 `tool_result_tokens` 是精确值 | 用字符估算 | provider 不返回按工具的 token；估算只在桶内分配，并被总量封顶 |
| §2.2 原始事件只记计数和哈希 | 账本保存 tokens 聚合计数与 `session_hash` | 与文档一致；不保存 prompt / 文件 / 参数 |
| §1.4 旁路可观察文件/错误 | 规则观察 | 不读文件内容，只看文件名后缀与错误文本 |

## 8. 后续

1. **工具级计量更细**：从已安装包 manifest 自动生成 `toolOwners`，并把工具结果 token 用 provider 的 usage 反推；
2. **上下文账本**：组件型插件（注入 / 压缩 / 缓存）的注入 token 口径；
3. **推荐评估**：golden set、recall@3、安装后 10 分钟使用率、撤销率，替换纯启发式；
4. **协议治理**：发布者身份吊销、版本协商、分发者注册与争议处理、一致性测试；
5. **平台生产化**：按账期的 provider 账单、数据库、队列、k-匿名门户、结算状态机；
7. **真实 DSH 验证**：已在 macOS · DSH 0.2.2-rc.1 上装过 `dsh-excel-chat` 与 `dsh-icd-rule-check` 并跑通工具链路；弹窗、`developer/message` 的客户端呈现与重启行为仍未复核；
8. **防滥用**：每插件 / 每任务 token 预算、按有用增量结算、工具结果与 schema 封顶、异常检测、发布者签名的工具归属、结算 holdback 与 clawback。
