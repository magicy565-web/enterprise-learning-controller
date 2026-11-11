# 执行前回执校验：本轮验证

- 日期：2026-11-11（北京时间）。
- 开发基线：`feat/bundled-service`，commit `459142683e883a501c80517f1accd9f013e8c17d`，叠加在 PR #4 上。
- 环境：Linux，Node.js `v24.22.1`，零第三方 npm 依赖。
- 数据：全部为隔离的合成工程夹具，没有真实买手、渠道凭据或外发行为。

## 已执行

| 命令 | 结果 |
|---|---|
| `npm test` | 125 passed，0 failed，0 skipped（基线 100 项，新增 25 项） |
| `npm run verify -- --out /tmp/elc-receipt-gate-e2e.json` | 真实 loopback HTTP + stdio MCP 子进程闭环通过 |
| `git diff --check` | 通过 |

端到端关卡结果：

| 时点 | code |
|---|---|
| 初始规则，匹配输入 | `ALLOWED` |
| 发布新规则后重用旧 case | `STALE_RECEIPT` |
| 新规则下判为不合格 | `NOT_ELIGIBLE` |
| 回滚后使用新 case 重新筛选 | `ALLOWED` |
| 管理员暂停后重查同一操作 | `PAUSED` |

新增测试还覆盖：企业/模式不匹配；同企业换公司、角色、意向或来源；人工否定与提取纠正；损坏回执/审计链/元数据；审计写失败；owner/model 路由权限；重复操作重新检查；两个数据库连接间暂停可见；重启后审计持久化；关闭服务后的拒绝；学习关闭后的影子停止。

## 交付边界

本轮提供宿主可调用的校验函数、owner HTTP/CLI 动作和审计。没有修改或部署 OpenMausBot，没有实际接线邮箱、线索库或 business-loop，没有验证真实模型或商业效果。检查后的网络发送竞态、发送幂等及业务审批仍由宿主协调。详见 [EXECUTION-GATE.md](../EXECUTION-GATE.md)。

原 `RELEASE-MANIFEST.json` 和 `docs/TEST-REPORT.md` 是初版历史交付记录，不代表本分支新文件的清单或验收结果。本轮以 Git commit、PR diff 和此验证记录为准。
