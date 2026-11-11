# 宿主执行前的筛选关卡

`checkExecution` 将一份已保存的筛选记录与宿主将要执行的操作核对。它是筛选前置条件，不是发送接口，也不替代业务审批、预算、收件人确认或渠道权限。

## 调用方式

- 内置服务：`service.checkExecution(request, authenticatedActor)`，也可用 `service.admin('check_execution', request, authenticatedActor)`。
- 独立服务：owner 凭据调用 `POST /v1/owner`，body 为 `{ "action": "check_execution", "input": request }`。
- CLI：`node src/cli.mjs check_execution --client /private/owner-client.json --input execution-request.json`。
- 模型 HTTP 路由和 stdio MCP 不提供这个入口；模型仍只有原有 7 个工具。

宿主从**登录企业、已认证的操作人、实际操作对象**生成 request，不能照搬模型提供的 `allowed:true` 或一份历史响应。独立 HTTP 服务的 actor 仍是配置中的 owner，不支持客户端自报身份。

| 字段 | 要求 |
|---|---|
| `enterpriseId` | 宿主当前登录企业；必须与数据库绑定企业相同 |
| `caseId` | 已执行筛选的 case ID |
| `input` | 实际买家输入：`companyId / role / intentConfirmed / sourceRefs`；按既有规则规范化后必须完全匹配 |
| `operationId` | 宿主待执行操作 ID，用于审计关联；不是本模块的幂等键 |
| `action` | `outbound_message`、`lead_write` 或 `artifact_submit` |
| `payloadHash` | 宿主对实际发送/写入内容计算的 SHA-256，小写 64 位十六进制；关卡记录此值，不读取或发送 payload |
| `expectedMode` | 默认 `production`；隔离测试必须显式填 `test`，不要从模型参数取值 |

示例是宿主接线伪代码，`operation`、身份认证和 `outbox` 由宿主提供：

```js
import { digest } from './src/domain.mjs';

// Run under the host's dispatch/configuration coordination mechanism.
const decision = service.checkExecution({
  enterpriseId: session.enterpriseId,
  caseId: operation.caseId,
  input: operation.buyer,
  operationId: operation.id,
  action: 'outbound_message',
  payloadHash: digest(operation.payload),
}, session.authenticatedActor);

if (decision.allowed !== true) {
  return { state: 'blocked', reason: decision.code, checkId: decision.checkId };
}
// Host must also enforce its own approval, channel permissions and idempotency.
// Preserve checkId + payloadHash alongside the operation in the host's outbox.
await outbox.dispatch(operation, { screeningCheckId: decision.checkId });
```

异常、超时、无法连接、无法写审计都必须停止执行。示例没有捕获后放行的分支。

## 返回与拒绝原因

每次有效调用都会重新读取当前状态，以一个 SQLite 写事务核对并保存审计记录。返回 `checkId / checkedAt / enterpriseId / mode / operationId / action / payloadHash / caseId / inputHash / allowed / code`，已读取的版本以 `releaseId / currentReleaseId` 返回。审计记录包含认证 actor，不复制原文、收件人或完整 payload。

| code | 宿主处理 |
|---|---|
| `ALLOWED` | 此刻满足筛选条件，继续宿主的其他业务检查 |
| `ENTERPRISE_MISMATCH` / `MODE_MISMATCH` | 修正企业路由或部署配置，不能放行 |
| `PAUSED` | 停止新动作 |
| `RECEIPT_NOT_FOUND` | 先对真实输入分类 |
| `INPUT_MISMATCH` | 实际输入不同，使用新 case ID 重新分类 |
| `STALE_RECEIPT` | 当前版本已变化，使用新 case ID 和当前 release 重新分类；回滚也会创建新 release |
| `NOT_ELIGIBLE` | 不合格或待复核，停止该操作 |
| `REVIEW_BLOCKED` | 该 case 已有人工不合格/待复核标签，交回人工处理 |
| `REVIEW_INPUT_CHANGED` | 人工修正过提取事实，修正宿主输入再重新分类 |

参数错误抛出相应领域错误；审计链、回执内容或元数据异常抛出 `INTEGRITY_ERROR / SCHEMA_MISMATCH`。数据库错误同样不产生放行结果。损坏的审计链不会继续追加记录。

## 精确边界

- `ALLOWED` 是**当前检查的快照**，不是可转让或可缓存的执行令牌。重试同一 `operationId` 会重新检查，并生成新的 `checkId`。
- 本模块没有发送、去重、预留额度或 exactly-once 保证。payload 哈希用于宿主核对和审计，宿主必须保证最终执行内容与哈希一致。
- SQLite 事务只保护本次检查与审计；提交之后仍可能发生暂停、规则发布或人工纠正。严格“暂停后无新发送”需要宿主将配置变更、最终检查和发送调度纳入同一个串行机制。远程 HTTP 调用本身不提供这一保证。
- 标签检查只针对该 `caseId`；没有跨 case、全公司的撤销名单。宿主不能通过新建 case 忽略尚未解决的人工否定。
- 输入仍依赖宿主核实的事实；仅提供 URL 不证明来源内容真实。此关卡也不把 `not_target_product / spam / duplicate` 这类不映射为买家标签的询盘结果自动变成公司禁用规则。
- 每次检查验证完整审计链，适用于当前试点规模；尚未做高吞吐压测。拥有数据库写权限的管理员仍可能重写全部数据和哈希，不能把这些哈希视为第三方签名。
- 学习关闭不影响已发布规则的分类与关卡；已有影子配置在关闭期间不会产生新影子结果，历史记录保留。再次开启且基线未变化时继续使用该配置。

## 本地验收

```sh
npm test
npm run verify -- --out ./local-verification-gate.json
```

`verify` 使用独立临时 test 数据库、真实 loopback HTTP 服务和 stdio MCP 子进程，核对原规则放行、发布后旧回执拒绝、新不合格结果拒绝、回滚后新 case 放行、暂停后拒绝。没有发邮件、写真实线索库或运行 OpenMausBot。
