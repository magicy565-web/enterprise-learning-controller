# 真实 Bot 试跑手册（约两周）

目标：在不改变任何外发、预算、权限的前提下，验证三件事：Bot 确实通过本服务判断买家；业务员的每日判断能流入系统；候选规则能用前瞻数据被验证。**本手册由开发方编写，未在你的真实 OpenMausBot 上执行过**，每一步都需要你在目标环境实际确认。

## 阶段 0：准备（半天）
1. 学习服务用**独立非特权账号**（例如 `elc-data`）运行；Bot 的执行账号不能读该账号的目录。初始化时用企业自己的起始规则：
   `node src/cli.mjs init --dir /var/lib/enterprise-learning/<企业> --enterprise <企业ID> --policy company-policy.json --port 8892`
   （production 模式；**不要**用 `--test`。）
2. 只把 `model-client.json` 复制给 Bot 账号可读的位置；`owner-client.json` 与数据库只留给管理员。
3. **以 Bot 的 OS 账号**运行接入前检查，全部 PASS 才继续：
   `node scripts/preflight.mjs --model-client /path/model-client.json --owner-client /var/lib/enterprise-learning/<企业>/owner-client.json --db /var/lib/enterprise-learning/<企业>/learning.sqlite`
   若报告"能读 owner-client.json / 数据库"，说明 Bot 能自批自发，**必须先修权限**。用与服务相同的账号运行该脚本一定会 FAIL，这是预期的，请务必换成 Bot 账号。
4. 预览接入（不写配置）：`node src/install.mjs --url http://127.0.0.1:8799 --client /path/model-client.json`，核对将修改的 Bot、指令块哈希。确认后加 `--apply --journal <新文件>`。接入后在**隔离的主控对话**里让 Bot 读取 `learning_context` 并核对企业身份。

## 阶段 1：只观察（第 1–3 天）——不启用任何学习
- Bot 每个买家判断必须经 `learning_classify`。**每天核对**：Bot 产出的买家数 vs 服务里的 case 数（`status` 与 Bot 日志）。差距大说明有旧路径绕过了筛选器，需要逐条接入后再继续。
- 每天跑 `queue`（`size` 30–50，`seed` 用当天日期），业务员按清单审核。
- 业务员对询盘的判断导出成 CSV，先 dry-run 再 `--apply`：
  `node scripts/import-inquiries.mjs --csv today.csv --client owner-client.json` → 确认无误后加 `--apply`。
- 看 `status.calibration`：随机分层的端到端准确率及区间。这是基线。**样本小时区间很宽，不要过度解读。**

## 阶段 2：启用学习（第 4–10 天）
- 业务员判断入库后会自动尝试受限学习。出现候选后：`shadow` 开始影子运行 → 继续每日队列 → 积累前瞻案例后 `evaluate_shadow`。
- 通过后由**拥有 owner 凭据的人**人工审核 diff 和报告，再 `approve` → `publish`。每次发布后观察 3 天再决定下一个。

## 阶段 3：复盘（第 11–14 天）
- 对比发布前后的 `calibration`、`needs_review` 比例、`outcomes`（回复/有效询盘按版本）。回复和询盘有延迟，两周内通常**不足以**得出效果结论，只用于发现明显异常。

## 立即暂停（`pause`）并排查的情形
- `status.audit.ok` 为 false，或任何 `INTEGRITY_ERROR`。
- 预检失败，或发现 Bot 读到了 owner 凭据 / 数据库。
- Bot 出现不经本服务的买家判断路径，且无法立即接入。
- 业务员反馈系统推荐明显偏离（先暂停再看数据，不要先发布新版）。

## 已知缺口（试跑中需要人工兜底）
- `queue` 只返回 caseId，不含公司和证据；需要管理员把 caseId 与 Bot 产出关联后分发给业务员。
- owner 凭据只有一个，审批和发布没有多人会签；`reviewer` 字段是自报，未认证。
- 回复/询盘按版本的统计不是因果结论。
- 旧 Worker 路径没有被强制改走筛选器。
