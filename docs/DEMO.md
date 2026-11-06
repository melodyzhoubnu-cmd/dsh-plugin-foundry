# 演示：从冷启到结算

`node src/demo/run.js` 会启动一个本地参考平台，注册一个假 Host，加载插件，然后跑完下面 8 步。整个过程不联网、不写 `~/.dsh`。

> 这是**合成 demo**（种子目录 + 假 Host），跑的是整条管道。架构 §1.5 描述的是**真实插件案例**：见 [cases/icd-audit](../cases/icd-audit/CASE.md)，那里装的是 npm 上的 `dsh-icd-rule-check`。

## 运行

```sh
npm run demo
```

输出以 `Demo: PASS` 结束，并写出：

```text
demo/out/summary.json
demo/out/portal.html
demo/out/settlement.json
demo/out/host/           # 假 Host 的密钥、consent、账本、批次、安装记录
demo/out/platform/       # 参考平台状态
```

想直接看门户：

```sh
open demo/out/portal.html
```

## 8 步

| # | 步骤 | 预期 |
|---|---|---|
| 0 | 注册 Host + 账单锚点 | 平台接受 Host 公钥；账单锚点 50,000,000 token |
| 1 | 冷启授权前 | `needsConsent=true`，默认 `never` + `local` |
| 2 | 冷启授权 | 选 `all` + `contribute`，写入 `consent.json` |
| 3 | 任务内分发 | 一条「正在自动安装」，一条「本次任务安装了…下一步可以直接使用」；安装 `dsh-excel-chat` |
| 4 | 任务画像 | `表格 / 报表 · .xlsx · stage=planning · opportunity=recipe` |
| 5 | token 归因 | 2 次请求共 3,440 token 归到 Excel 助手；账本链校验通过 |
| 6 | 批次上传 | 签名批次被平台接受，`server_seq` 递增 |
| 7 | 结算单 | 平台签名；按 0.5 微单位/token、30% 分成算出开发者所得 |
| 8 | 开发者门户 | HTML 含归因 token、请求数、开发者所得、结算单、批次 |

## 数据流

```text
user/message ──► TaskTracker ──► Opportunity
                                    │
catalog（format-1）──► BM25 + 权重 ──► net gate ──► developer/message
                                    │
                                    └─► AutoGate ──► installBundle
                                                        │
assistant/message(usage) ──► attributeRequest ──► ledger.jsonl
                                                        │
                                              buildBatch + sign
                                                        │
                                          gzip POST /v1/usage/batches
                                                        │
                                     verify → rollup → settlement
                                                        │
                                                  /portal
```

## 亲手验证

```sh
# 账本链
node -e "const s=require('./demo/out/summary.json'); console.log(s.report.ledger)"

# 结算单
cat demo/out/settlement.json

# 批次状态
cat demo/out/host/batches.json

# 平台 rollup
node -e "const s=require('./demo/out/platform/state.json'); console.log(Object.keys(s), s.rollups)"

# 门户 HTML
grep -o 'Excel 对话助手' demo/out/portal.html
```

## 想换成真实目录 / 真实平台

- 把 `catalogUrl` 指到任意 format-1 索引；
- 把 `uploadUrl` 指到实现了 `POST /v1/usage/batches` 的服务；
- 把 `toolOwners` 换成真实工具名，或在目录条目里写 `metadata.tools`；
- 通过 `consent` RPC 选择 `all` / `official` / `never` / `off`。

支付与交易不在演示里：架构文档第 3 章保留设计，代码与 demo 都未实现。
