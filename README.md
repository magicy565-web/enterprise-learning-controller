# Enterprise Learning Controller

> 实验性 v0.1.0 · 独立、可私有部署的 OpenMausBot 企业主控业务学习扩展模块。**非生产发行版。**

本仓库仅包含本模块的通用实现与隔离测试，不包含原有私有 `openmausbot-worker` 仓库的历史文件、客户数据、账户凭据或 OpenMausBot 上游本体。

## 最新分支增量：宿主执行前校验

在内置服务分支之上新增 `service.checkExecution(request, authenticatedActor)` / owner `check_execution`，核对企业、模式、买家输入、当前版本、人工反馈及暂停状态，并记录动作和 payload 哈希。查询回执本身不再作为宿主放行方式。关闭学习后，已有影子规则也停止生成新结果。

本分支已在 Linux / Node.js **24.22.1** 跑通 **125 项测试**及 HTTP + MCP 子进程端到端验证；无需 GitHub Actions。见 [本轮验证记录](docs/verification/receipt-gate.md) 和 [宿主接入契约](docs/EXECUTION-GATE.md)。下文及原 TEST-REPORT 中的 60 项 / Node 22 记录是初版历史验收；Windows、真实 OpenMausBot 接线和真实业务验证仍未执行。

## 快速验证

```sh
node --version   # 需要 >=22.16（推荐与现有 Worker 一致的 Node.js 24）
npm test
npm run verify -- --out ./local-verification.json
```

已在独立 Linux / Node.js 22.16.0 环境重新运行：60 项测试全部通过；端到端独立服务和 MCP 子进程的候选、评估、审批、发布、回滚测试通过。这些是合成数据工程测试，非真实外贸获客验证。Node.js 24 和 Windows 仍需独立验收。

核心安全约束：模型只能提出候选及查询已发布的规则；生产发布、审批和回滚需要独立 owner 权限；生产数据和测试数据隔离。勿将模型进程运行在能访问 owner 凭据的高权限 OS 账号下。安装脚本默认预览而不修改现有 Bot。

## 完整文档

- `docs/OPERATIONS.md`：实际操作流程与输入字段
- `docs/EXECUTION-GATE.md`：宿主执行前校验、拒绝原因、审计与并发边界
- `docs/SECURITY.md`：企业隔离、权限和部署注意事项
- `docs/TEST-REPORT.md`：已验证与未验证项
- `skills/enterprise-learning-controller.md`：主控指令模板

---

## 模块说明

为已有 OpenMausBot Chief/Otto 增加**可审计的买家筛选 SOP 学习闭环**。这是新增旁路服务，不替换 Harness、模型、原生任务运行器或 business-loop。

本版是可运行的工程实现，不是已经通过真实企业试运营的商业发行版。自动学习范围有意限定为“从多次人工纠正中提出买家角色筛选规则”，不是万能 Agent 自改代码，也没有训练模型权重。

## 已实现

> **作为宿主内置服务使用请看 `docs/BUNDLED.md`**（`src/bundled.mjs`、`src/mcp-bundled.mjs`：首次启动自动初始化与迁移、默认只观察不学习、管理操作由宿主传入已认证身份、回执校验接口）。`install.mjs` 与独立 HTTP sidecar 仍保留，适用于不内置的场景。

> 本分支新增：影子运行与前瞻性配对评估（`shadow`/`evaluate_shadow`）、每日审核队列与随机校准（`queue`）、客户回复/询盘结果登记（`outcome`）；上一分支：`extraction_error` 人工更正（区分抽取错误与策略错误）、`audit` 审计链校验、companyId 规范化。详见 `docs/OPERATIONS.md`。

* 人工反馈和原始证据持久化；重复事件幂等，冲突拒绝，企业实例绑定。
* 收到第三家独立公司的同类人工纠正后，自动生成受限候选；证据冲突时不泛化。
* 主控可用自己正在运行的模型调用 `learning_propose`；无需新增模型账号。模型只能提出受限策略，不能发布。
* 训练/holdout 按企业与证据来源隔离，独立评估、审批内容哈希、原子发布、版本回滚。
* `learning_classify` 实际执行当前已发布规则，保存版本固定的运行回执；旧 case 不被新版篡改。
* Loopback HTTP 服务、独立 model/owner 凭据、stdio MCP、管理员 CLI、原生 Bot 接入脚本。
* 从 business-loop 的已验收文本/JSON 成果导入**人工标签**，核对真实文件 SHA-256。文件验收不等于商业判断正确。

## 运行要求

零第三方 npm 依赖。最低 Node.js 22.16；与现有 Worker 同机部署时建议沿用已验证的 Node.js 24。此次实际测试环境是 Node.js 22.16.0/Linux；没有在 Windows、Node 24 或你的腾讯云实例上复跑。使用内置 `node:sqlite`，该测试版本会提示 ExperimentalWarning。

从仓库根目录：

```sh
cd enterprise-learning-controller
npm test
npm run verify -- --out ./isolated-e2e-evidence.json
```

`verify` 创建自己独占的临时 test 数据库，启动真正的本地 HTTP 服务和 stdio MCP 子进程，运行反馈→候选→评估→审批→发布→下一次分类→回滚，然后删除自己的临时目录。**全部案例为合成测试资料，不能当成获客效果或真实客户案例。** 输出文件已存在会停止，不覆盖。

Windows PowerShell 可用 `npm.cmd test` / `npm.cmd run verify -- --out .\isolated-e2e-evidence.json`。这不是已完成 Windows 实机验收的声明。

## 启动一个空企业实例

只初始化空库与初始规则，不添加测试公司、不发邮件、不建立自动获客活动。

```sh
node src/cli.mjs init --dir ./state/my-export-team --enterprise my-export-team --port 8892
node src/server.mjs --config ./state/my-export-team/server.json
```

生产模式默认初始 policy 包含四类已知买家角色，`requireIntent=false`。**它只是尚未定制的起点，不是适合所有企业的建议。** 企业应在初始化时用 `--policy company-policy.json` 提供自己的起始规则：

```json
{"allowedRoles":["importer","distributor"],"requireIntent":true}
```

初始化永远不覆盖现有目录。生产模式拒绝 `kind: synthetic` 数据；隔离开发使用不同目录并显式加 `--test`。同一个数据库不能切换企业或模式。端口仅监听 `127.0.0.1`，不直接暴露公网。

另一个终端查看：

```sh
node src/cli.mjs status --client ./state/my-export-team/owner-client.json
```

`server.json` 保存服务配置和凭据摘要；`model-client.json` 只有模型权限；`owner-client.json` 才有人工审核权限。不要把 owner 文件或数据库给 Bot。

## 接入现有 Otto / Chief

脚本使用本仓库 `connect-magazine-tools.mjs` 实际采用的 Bot/MCP API。优先复用唯一的空闲 Chief；有多个 Chief 时必须通过 `--bot` 指定，不创建新的主控。

```sh
node src/install.mjs --url http://127.0.0.1:8799 \
  --client /absolute/path/model-client.json
```

这一步只预览，不写配置。确认后：

```sh
node src/install.mjs --url http://127.0.0.1:8799 \
  --client /absolute/path/model-client.json \
  --apply --journal /absolute/path/new-install-journal.json
```

远程宿主使用 HTTPS，凭据由 `--token-file` 读取，不写在命令行里。脚本需要在 OpenMausBot 所在主机运行，因为注册的是本地 stdio 命令和本地路径。测试服务只能配合 `--allow-test` 接入隔离宿主。

已指定的 Bot 本身不是 Chief 时，脚本默认不提升其权限；确需晋升时才显式使用 `--make-chief`，该操作可能改变原生同作用域的 Chief 指派。优先直接复用现有 Otto。脚本不改 `defaultBot`、模型、运行权限或其他 Bot，也不改变首页导航。

脚本保留原 SOUL 和已有 MCP 选择，新增受管理的指令块与 Bot 专属 MCP。重复运行不重复添加；检测到手工改动会停止。原生 API 没有本模块可用的事务式 compare-and-swap，所以安装时仍应暂停其他配置编辑。部分失败保留 journal，不自动删除别人可能正在使用的连接。`configured-unverified` 只表示配置读回一致；**不是原生模型联调通过**。

接入后，在隔离主控对话里要求读取 `learning_context`，核对企业身份，再用授权的资料调用 `learning_classify`。该步骤此次没有在你的实际 OpenMausBot 上执行。

## 人工反馈与学习

管理员在 JSON 文件中提供一条已审核反馈；字段见 `docs/OPERATIONS.md`。证据必须是实际读取的原文，企业标签由有权审核的人给出。

```sh
node src/cli.mjs observe --client /private/owner-client.json --input reviewed-case.json
```

训练反馈入库后自动尝试受限学习。两条、不独立或互相矛盾的反馈不会形成新的角色排除规则。模型也可调用 `learning_learn` 查询/重试；结果未知时重复同一 ID 不重复生成。学习步骤失败不会抹掉已经提交的人工反馈。

当前自动归纳只处理 `wrong_buyer_role`：至少三家不同公司、不同原文和不同来源的否定反馈，且没有对应正例，才能建议移除一个角色。`learning_propose` 还支持有证据地增加 `requireIntent`。不允许扩大目标范围或放松原有 intent 要求。

不能通过一段自由文本让模型上传任意 JavaScript、改预算、改发信规则或添加工具权限。

## 评估、审批与发布

```sh
node src/cli.mjs evaluate --client /private/owner-client.json --input evaluation-request.json
node src/cli.mjs approve  --client /private/owner-client.json --input approval-request.json
node src/cli.mjs publish  --client /private/owner-client.json --input publication-request.json
```

生产模式至少需要 20 家独立 holdout 公司，其中正、负例各至少 5 家。test 模式使用 6 家且两类各至少 3 家，只为验证工程链路。要求准确数改善、合适目标召回不下降、错误推荐不增加。**这些是试点门槛，不代表统计显著性或销售提升。** 一批训练资料只能产生一个候选，避免模型连续试探同一个 holdout；完整 holdout 不向模型返回。

审批绑定 candidate hash、report hash、数据集 hash 和当前 baseline。审批后变更证据或基线会阻止发布。新版本只影响新 case，旧 case 可重读但不能改变输入。

```sh
node src/cli.mjs rollback --client /private/owner-client.json --input rollback-request.json
node src/cli.mjs pause    --client /private/owner-client.json --input pause-request.json
```

回滚创建一条新的发布记录，不删除历史、不恢复旧数据库、不撤销已经发生的外部业务动作。暂停阻止新分类和新发布，仍允许紧急回滚。

## 与原有 business-loop 协作

不使用原 `business-cli event` 写学习结果：那个接口是添加业务任务。使用专门的人工审核导入器：

```sh
node src/import-review.mjs --progress /mandate/execution-progress.json \
  --task buyers --artifact /mandate/artifacts/buyers.json \
  --feedback /private/reviewed-label.json --client /private/owner-client.json
```

只读取 accepted 任务且校验 evidence.sha256。仅支持不超过 12 KB 的 UTF-8 文本/JSON 证据；大报告先在现有流程生成独立可验收摘录。该命令不改原任务和文件，不自动把文件验收结果当成“有效买家”，也不把模型自评当成人工标签。

当前接入是 MCP 与受管理的主控指令，加上显式人工审核导入器；**没有改造原业务中心审核 UI，也没有声称所有旧 Worker 已被强制改走这个筛选器**。调用 `learning_classify` 的业务路径会得到确定性版本回执；旧路径必须在实际集成时逐条接入并验收。

## 安全和发布边界

阅读 `docs/SECURITY.md`。HTTP/MCP 权限隔离不等于操作系统隔离：拥有 Full shell 或 sudo 的 Bot 可能直接读管理员文件。生产必须让学习服务运行在独立非特权账号下，数据库与 owner 凭据不可由 Bot 进程访问，Bot 只能获得 model-client 的副本。systemd 文件只是待环境验证的部署示例，未自动安装。

本版不自动开启上游 Skill Review，不把业务 policy 写进普通可编辑记忆。原生 Memory/Dream 可继续用于非权威事实提醒，但价格、权限、审批和正式 policy 以企业权威系统与本服务正式发布记录为准。

## 项目与验证边界

核对的原仓库基线：`magicy565-web/openmausbot-worker@311881a6cbe78d54c0ecdeb4cc11ea5bba8d9a8b`。

交付只新增 `workspace/openmausbot-worker/enterprise-learning/`，不改生产配置、不改原生 runtime、不读取客户邮箱或真实渠道凭据。原仓库全量测试、实际模型调用、腾讯云部署、Windows 打包及真实业务评估均尚未执行。本包测试的原生安装 API 是明确标注的协议测试夹具，不冒充完整 OpenMausBot 端到端验收。
