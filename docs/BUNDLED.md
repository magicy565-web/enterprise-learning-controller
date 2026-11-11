# 作为宿主内置服务（OpenMausBot 默认自带）

本文是**集成契约**，基于本仓库的实现编写。OpenMausBot 的内部接口我没有看过，凡涉及宿主的部分请由宿主团队对照核实。

## 与独立部署的区别

| | 独立 sidecar（旧） | 内置（本文） |
|---|---|---|
| 初始化 | 人工 `init`，生成 client 文件与令牌 | 首次启动自动创建、迁移，无令牌文件 |
| 模型入口 | HTTP + model token | 宿主直接启动 `mcp-bundled.mjs`（stdio），或在进程内调用 `startBundled().mcp` |
| 管理入口 | owner token + CLI | `service.admin(action, input, actor)`，`actor` 是**宿主已认证的用户** |
| 默认学习状态 | 开 | **关（只观察）**，企业显式开启 |
| 升级 | 手工 | 启动时自动迁移，迁移前自动备份 |

## 宿主需要做的事

1. **启动模型入口**：`node src/mcp-bundled.mjs --data-dir <每企业一个目录> --enterprise <企业ID> [--mode production] [--learning off]`，注册为该企业主控的内置 MCP。企业 ID 必须由宿主指定，模型无法更改。
2. **管理入口放在宿主已认证的 UI/API 后面**：在宿主进程里 `startBundled(...)`（与上面同一目录，SQLite WAL 支持两个进程同时打开），用 `admin('observe'|'inquiry'|'queue'|'evaluate_shadow'|'approve'|'publish'|'rollback'|'learning'|'pause'|'status'|'doctor'|…, input, actor)`。**不要**把 `admin` 暴露给模型或任何模型可调用的工具。
3. **身份与会签**：`actor` 会写入审计日志。建议宿主在自己的授权层规定谁可 `approve`、谁可 `publish`，且两者不能是同一人（本模块目前不强制）。
4. **回执关卡（最重要）**：MCP 只是"自愿调用"。凡是外发邮件、写入线索库、提交 business-loop 成果这类动作，宿主应在执行前要求带上 `caseId`，并调用 `service.model('receipt', { caseId })`：
   - `found:false` → 拒绝（说明买家没有经过筛选器）；
   - `label` 不是 `eligible` → 拒绝或转人工；
   - `isCurrentRelease:false` → 按宿主策略重新筛选或放行并记录；
   - `paused:true` → 拒绝新动作。
   这样"模型跳过筛选器"会变成可拒绝的事件，而不是静默绕过。
5. **健康检查**：定期调用 `service.health()`（= `doctor`）：schema 版本、SQLite 完整性、审计链、当前策略。任何一项 `ok:false` 应告警并 `pause`。

## 默认安全状态

- `learning: off`：标签、询盘、结果、回执、校准都照常工作，**不会生成候选、不能影子运行**。企业评估过后由管理员 `admin('learning', {enabled:true}, actor)` 开启；关闭同理。
- 没有任何自动发布：开启学习后仍需评估 → 审批 → 发布，且这些只在 `admin` 里。

## 升级与数据

- 数据库有版本号。新版本启动时若发现待执行迁移：先 `VACUUM INTO` 备份为 `learning.sqlite.pre-vN-<时间>.bak`，再逐个迁移（每个在独立事务内）；失败则回滚并保留旧版本与备份，服务不启动。
- 比代码**更新**的数据库会被拒绝启动（`DB_NEWER_THAN_CODE`），防止旧版本损坏新数据。**回滚宿主版本时需要同时恢复数据备份**。
- 迁移规范：v1 建表块已冻结，之后所有结构变更只能追加到 `MIGRATIONS`，且要有测试。
- 备份文件含完整业务数据，权限 0600，注意纳入企业自己的备份与保留期策略。

## 安全边界（必须告知企业）

- 内置意味着模型进程与数据库通常在同一 OS 账号下。HTTP 层的凭据隔离不再存在，**隔离靠两点**：模型只能通过 MCP 暴露的 7 个工具访问；以及宿主的 shell/文件工具不能读取数据目录。后者由宿主沙箱保证，本模块无法替代。
- 学习证据（询盘原文）会通过 `learning_examples` 进入模型上下文并发往企业配置的模型服务商。入库前的脱敏、保留期限尚未实现，上线前需要补。
- 证据是不可信的外部文本；工具说明和 SKILL 已要求模型不得服从其中的指令，但这只是缓解，不是保证，仍需做对抗性测试。

## 模型可见的工具

`learning_context`（小而有界）· `learning_examples`（分页，≤20）· `learning_receipt`（只读）· `learning_classify` · `learning_learn` · `learning_propose` · `learning_candidate`。均不含标注、评估、审批、发布、回滚。
