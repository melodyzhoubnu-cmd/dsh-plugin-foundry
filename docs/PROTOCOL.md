# Plugin Foundry 协议（v1）

> 这是公开底座，不是平台私有接口。任何分发者、Host、平台都可以按同一套字段与验证顺序实现；`src/protocol/` 是参考实现，第三方可以复算、校验、接入。

协议由两个通用原语构成：

1. **canonical JSON**：对象键排序、去掉 `undefined`、不写空白、拒绝非有限数字；
2. **Ed25519 签名**：对 canonical JSON 的 UTF-8 字节签名，签名为 base64url。

所有文档都带 `schema: 1`。新增可选字段不需要升版本；改变字段语义、删除字段或改变签名覆盖范围需要升 `schema`。

---

## 0. 标识

| 标识 | 形式 | 说明 |
|---|---|---|
| `host_id` | `ed25519:<22 chars>` | Host 公钥 SPKI DER 的 SHA-256 前 22 个 base64url 字符 |
| `install_id` | `i_<random>` | 一次安装的随机 ID，首次生成后持久化 |
| `meter_key` | `ed25519:<22 chars>` | 计量密钥指纹；参考实现里等于 Host 指纹，也可独立 |
| `plugin_id` | `pkg:npm/<name>@<version>#sha256:<hex>` | 包名、版本、完整性；版本缺失时为 `0.0.0` |
| `publisher` | `ed25519:<22 chars>` | 开发者公钥指纹 |

`plugin_id` 的完整性段：传入 64 位小写十六进制则直接使用；传入 `sha256-<base64>` 则解码为十六进制；其他字符串取 SHA-256。这样不同目录给出的完整性声明能归一化到同一形式。

---

## 1. UsageEvent

一次请求里，一个插件、一个归因桶产生一条事件。事件只记计数和哈希，不记 prompt、文件内容、工具参数。

```json
{
  "schema": 1,
  "plugin_id": "pkg:npm/dsh-excel-chat@1.2.0#sha256:...",
  "publisher": "ed25519:...",
  "tool": "excel_create_chart",
  "request_id": "session:turn:step",
  "session_hash": "9f2c…（24 位十六进制）",
  "tokens": {
    "input": 1200,
    "output": 340,
    "cacheRead": 800,
    "cacheWrite": 0,
    "reasoning": 0
  },
  "share": 0.5,
  "bucket": "base",
  "meter_key": "ed25519:...",
  "ts": 1793813045000,
  "seq": 41,
  "prev_hash": "…64 位十六进制…",
  "hash": "…64 位十六进制…"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `plugin_id` | 是 | 可为 `null`，表示未归因；未归因事件不计入任何开发者 |
| `publisher` | 是 | 可为 `null` |
| `tool` | 是 | 可为 `null`；`base` 桶取该请求里代表该插件的工具，`capability` 桶为 `null` |
| `request_id` | 是 | 同一请求的事件共享；聚合时用于计 `requests` |
| `session_hash` | 是 | 至少 8 位十六进制；不保存 session id 原文 |
| `tokens` | 是 | 非负整数；五个字段至少一个 |
| `share` | 是 | 该行占请求总 token 的比例，`[0,1]` |
| `bucket` | 是 | `base` / `tool_result` / `capability` |
| `ts` | 是 | epoch 毫秒 |
| `seq` / `prev_hash` / `hash` | 账本内 | 由 `ledger.append()` 写入 |

### 归因

```text
Tokens_p = base_p + tool_result_p + capability_p
```

- **base**：请求的 `input + output + reasoning + cacheRead + cacheWrite`，按该请求里的插件工具数均分，或按工具结果大小加权（`1 + sqrt(result_tokens)`）。每个 token 字段独立用最大余数法分配，保证整数且和恰好等于原字段。
- **tool_result**：工具返回内容的估算 token（CJK 1 token/字，其他约 4 字符/token），记入 `input`，归工具提供方。
- **capability**：分发注入的能力信号与回执的估算 token，记入 `input`，归被推荐的插件。

三个桶先合并，再按字段封顶：任何字段的归因总量超过请求该字段总量时，所有行等比缩小，余量落到 `unattributed`。因此：

```text
attributed(p) + unattributed = request total
```

未映射 owner 的工具不猜测归属，整条请求落为未归因。

### 账本

- 每行 `hash = sha256(canonical(record without hash))`；
- `prev_hash` 是上一行的 `hash`，首行为 64 个 `0`；
- `seq` 从 1 连续递增；
- 校验时重算每行 hash、检查 `seq` 连续与 `prev_hash` 链接；删除、重排、改字段都会留下可检测的缺口；
- 账本 append-only，不裁剪；`usage.head.json` 只是检查点，丢失后可重算，伪造会被发现。

---

## 2. Receipt

对一批事件的签名回执，用于争议、抽查和第三方审计。它只包含事件哈希，不包含事件内容。

```json
{
  "schema": 1,
  "receipt_id": "r_…",
  "host_id": "ed25519:...",
  "install_id": "i_...",
  "batch_id": "b_20261105_ab12cd34_1a2b3c4d",
  "period": { "start": 1793813045000, "end": 1793899445000 },
  "root": "sha256:…",
  "event_count": 42,
  "totals": [ { "plugin_id": "…", "publisher": "…", "tokens": { "input": 12000 }, "requests": 9, "tool_calls": 7 } ],
  "leaves": ["…event hash…"],
  "issued_at": 1793900000000,
  "sig": "…base64url…"
}
```

`leaves` 是事件哈希样本（参考实现最多 1000 条）。当 `leaves.length === event_count` 时，验证者必须复算 `merkleRoot(leaves) === root`；不等时只验签，并承认回执不覆盖全部叶子。

---

## 3. Batch

按日聚合计量的上报单位。`batch_id` 是幂等键；同一批重复提交返回已有结果。

```json
{
  "schema": 1,
  "batch_id": "b_20261105_ab12cd34_1a2b3c4d",
  "host_id": "ed25519:...",
  "install_id": "i_...",
  "runtime_version": "0.2.1-rc.5",
  "period": { "start": "2026-11-04T00:00:00.000Z", "end": "2026-11-05T00:00:00.000Z" },
  "root": "…64 位十六进制…",
  "prev": "…上一批次的 root，首批为 64 个 0…",
  "event_count": 42,
  "totals": [
    {
      "plugin_id": "pkg:npm/dsh-excel-chat@1.2.0#sha256:...",
      "publisher": "ed25519:...",
      "tokens": { "input": 12000, "output": 3400, "cacheRead": 8000, "cacheWrite": 0, "reasoning": 0 },
      "requests": 42,
      "tool_calls": 37
    }
  ],
  "unattributed": { "input": 120, "output": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0 },
  "created_at": 1793900000000,
  "sig": "…base64url…"
}
```

- `root = merkleRoot(event hashes)`；
- `prev` 是该 `install_id` 上一条被接受批次的 `root`，形成跨批次的链；
- 传输：`POST /v1/usage/batches`，`content-encoding: gzip`，`idempotency-key: <batch_id>`，`x-install-id`；
- 请求体是批次本身的 JSON（gzip 后），不是 multipart。

### 平台验证顺序

1. **结构 + 签名**：用注册的 Host 公钥验 `sig`，失败返回 400 `bad-signature`；
2. **身份**：`install_id` 与注册记录、`x-install-id` 一致，否则 403；
3. **幂等**：`batch_id` 已存在则返回 `{accepted:true, duplicate:true, server_seq}`，不重复计入；
4. **链**：`prev` 必须等于该 Host 上一条被接受批次的 `root`；首批必须是 64 个 `0`，否则 409 `prev-mismatch`；
5. **周期**：ISO 时间可解析、`end > start`、跨度不超过 31 天；
6. **对账**：累计归因 token 不得超过该 Host 的 provider 账单锚点；超出时按剩余额度等比缩放本批，并返回 `disputes: [{kind:'over-anchor', …}]`；没有账单锚点时接受，但记录 `no-bill-anchor`；
7. **入库**：写批次、更新 `lastRoot`、按 `period.start` 的日期写 rollup。

成功响应：

```json
{ "accepted": true, "duplicate": false, "batch_id": "…", "server_seq": 12, "disputes": [], "scaled": false, "credited_tokens": 24000, "received_tokens": 24000 }
```

---

## 4. Settlement

平台对开发者签发的结算单。金额使用**整数微单位**（1e-6 货币单位），避免浮点误差。

```json
{
  "schema": 1,
  "settlement_id": "s_20261105_ab12cd34_xyz",
  "publisher": "ed25519:...",
  "meter_key": "ed25519:...",
  "currency": "USD",
  "period": { "start": "2026-11-01T00:00:00.000Z", "end": "2026-11-30T23:59:59.999Z" },
  "created_at": 1793900000000,
  "lines": [
    {
      "plugin_id": "pkg:npm/dsh-excel-chat@1.2.0#sha256:...",
      "publisher": "ed25519:...",
      "tokens": { "input": 12000, "output": 3400, "cacheRead": 8000, "cacheWrite": 0, "reasoning": 0 },
      "requests": 42,
      "tool_calls": 37,
      "basis": "share",
      "revenue_micros": 11700,
      "developer_micros": 3510,
      "rebate_tokens": 0,
      "share_rate": 0.3,
      "rebate_rate": 0.1,
      "price_per_mtokens": 0.5
    }
  ],
  "totals": {
    "tokens": { "input": 12000, "output": 3400, "cacheRead": 8000, "cacheWrite": 0, "reasoning": 0 },
    "revenue_micros": 11700,
    "developer_micros": 3510,
    "rebate_tokens": 0,
    "requests": 42,
    "tool_calls": 37
  },
  "sig": "…base64url…"
}
```

计算：

```text
total = input + output + cacheRead + cacheWrite + reasoning

share:
  revenue_micros   = round(total × price_per_mtokens)
  developer_micros = round(revenue_micros × share_rate)

rebate:
  rebate_tokens = round(total × rebate_rate)
  revenue_micros = developer_micros = 0
```

同一插件的同一笔用量只能选一种 `basis`；`settle()` 会先按 `plugin_id` 合并 totals，再逐行计算，避免重复支付。验证者复算 `totals` 与每行金额，任何不一致都拒绝。

`price_per_mtokens` 的单位是「每 token 的微单位」：`0.5` 表示 1M token 收入 0.5 个货币单位（$0.50）；因为 `micros = tokens × 0.5`。

---

## 5. DistributorManifest

多分发者的自签名清单。第三方分发者发布自己的目录/上报入口，消费者离线验证后仍使用同一套事件、批次、结算格式。

```json
{
  "schema": 1,
  "id": "ed25519:...",
  "name": "Third-party distributor",
  "public_key": "…base64url SPKI…",
  "capabilities": [{ "id": "spreadsheet.read", "title": "读取表格" }],
  "endpoints": {
    "catalog": "https://example.com/catalog.json",
    "batch": "https://example.com/v1/usage/batches",
    "portal": "https://example.com/portal"
  },
  "issued_at": 1793900000000,
  "expires_at": null,
  "sig": "…base64url…"
}
```

`id` 若以 `ed25519:` 开头，必须等于 `public_key` 的指纹；签名由 `public_key` 对应的私钥生成。`expires_at` 非空且早于当前时间时失效。

---

## 6. CapabilityIndex

目录的能力视图，供召回与跨分发者合并使用。

```json
{
  "schema": 1,
  "generated_at": 1793900000000,
  "capabilities": [
    {
      "id": "chart.create",
      "title": "生成图表",
      "providers": [
        { "plugin_id": "pkg:npm/dsh-excel-chat@1.4.0#sha256:...", "name": "dsh-excel-chat", "title": "Excel 对话助手", "category": "docs", "verified": true }
      ]
    }
  ]
}
```

目录条目通过 `metadata.capabilities: [{id,title}]` 声明能力；`buildCapabilityIndex(entries)` 生成索引，`lookupCapability(index, id)` 读取。

---

## 7. format-1 目录的扩展字段

目录本身兼容 DSH 的 format-1 形状。推荐相关字段都在 `metadata` 内，全部可选：

```json
{
  "name": "dsh-excel-chat",
  "title": { "zh": "Excel 对话助手", "en": "Excel chat" },
  "description": { "zh": "…", "en": "…" },
  "metadata": {
    "category": "docs",
    "keywords": ["xlsx", "excel"],
    "labels": [],
    "capabilities": [{ "id": "spreadsheet.read", "title": "读取表格" }],
    "tools": ["excel_read", "excel_create_chart"],
    "quality": { "score": 0.86, "verified": true, "curated": true, "users": 12800, "stars": 420 },
    "risk": { "postinstall": false, "restartRequired": false, "dataEgress": false, "permissions": [] },
    "publisher": { "id": "ed25519:...", "publicKey": "…base64url…", "name": "…", "verified": true }
  },
  "versions": [
    { "version": "1.4.0", "publishTimestamp": 1793813045, "source": { "type": "npm" }, "engines": { "dsh": ">=0.2.1" }, "integrity": "sha256-…" }
  ]
}
```


---

## 8. 隐私与统计边界

- 只统计经过 DSH 工具管线的调用；插件绕过 DSH 直连模型 API、其他客户端、插件自报都不计入。
- 上报只有聚合；事件哈希可以证明顺序与数量，不能还原内容。
- `session_hash` 是 SHA-256 前 24 位，不保存 session id。
- 纯本地模式不联网、不回填、不后台重试；导出是本地操作。
- 账单是外部锚点：归因总量不得超过 provider 账单；超出缩放并记争议，而不是静默接受。

## 9. 版本与兼容

- `schema: 1` 是当前所有文档的版本；
- 目录 `format: 1` 不变；扩展都在 `metadata` 内；
- `engines.dsh` 使用 semver 范围；对 prerelease 运行时（如 `0.2.1-rc.5`），当范围没有写 prerelease 时按 release 线比较，避免候选构建上所有插件都被判不兼容；
- 签名覆盖「除 `sig` 外的整个对象」。增加字段会改变签名内容，因此签名方与验证方必须使用同一份文档。
