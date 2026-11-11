# Enterprise Learning Controller v0.1 — 实现与验收记录

## 交付结论

已实现可运行的“人工业务反馈 → 自动候选 → 独立评估 → 人工审批 → 正式发布 → 下一次执行使用新规则 → 回滚”闭环。
当前自动学习范围是买家角色筛选规则，不是自动训练大模型或任意修改生产代码。没有创建真实客户记录、联系买家、调用付费模型或变更生产服务。

原仓库核对基线：`magicy565-web/openmausbot-worker@311881a6cbe78d54c0ecdeb4cc11ea5bba8d9a8b`。
新增路径：`workspace/openmausbot-worker/enterprise-learning/`。
本地开发分支：`feat/enterprise-learning-controller-v0.1`。**没有推送到 GitHub，没有部署腾讯云，没有修改原有主控配置。**

## 已实现的软件

| 组件 | 实际能力 |
|---|---|
| SQLite 事件与发布库 | 企业实例绑定、幂等反馈、来源哈希、不可变候选/评估/审批、原子版本指针 |
| 受限学习器 | 至少三家独立公司同类纠正、无正例冲突时，自动提出角色排除候选 |
| 模型提案入口 | 复用主控模型，通过 MCP 提交受约束 policy；禁止权限/预算/代码字段 |
| 评估器 | 独立 holdout、公司与来源去重、新旧规则比较、召回与误判保护 |
| 发布与回滚 | 独立 owner 权限、哈希绑定审批、数据集变动失效、祖先版本回滚 |
| 版本固定分类器 | 实际运行已发布规则；旧 case 保留旧版、新 case 使用新版 |
| 接入与操作 | loopback HTTP、stdio MCP、管理 CLI、原生配置安装器、business-loop 成果人工反馈导入 |

## 实际运行的测试

测试环境：Linux，Node.js `v22.16.0`，内置 SQLite，无新增 npm 依赖。

```
node --test test/*.test.mjs
# tests 60
# pass 60
# fail 0
# cancelled 0
# skipped 0
```

所有测试只使用隔离临时目录、临时端口和明确标注的合成夹具。覆盖：重复请求、越权、企业/mode 混用、训练与评估泄漏、冲突反馈、过期审批、发布写入故障、版本固定、回滚幂等、重启保留、MCP stdio 子进程、HTTP 真实请求以及安装脚本幂等/并发编辑保护。

原生安装测试使用按已读取仓库接口实现的**API 契约夹具**。它检验本补丁怎样调用接口，不证明真实 OpenMausBot 版本或模型已经接通。

## 单独执行的端到端验证

时间：`2026-11-11T03:14:35.305Z`。

实际使用：持久 SQLite、loopback HTTP 服务、独立 stdio MCP 子进程。
数据：3 家合成训练公司、6 家独立合成评估公司。不是实际商业样本。

| 阶段 | 同类零售商的分类结果 |
|---|---|
| 初始已发布规则 | eligible |
| 人工反馈后生成候选 | 正式规则不变 |
| 独立评估与人工审批后发布 | ineligible |
| 回滚至此前规则 | eligible |

这个专门构造的测试集上，旧规则答对 3/6、新规则答对 6/6，正例召回没有下降。**该数字只证明程序链路按预期工作，不代表真实准确率、泛化能力、询盘提升或收入增长。**

确切版本、candidate/report/approval ID 见 `verification/e2e-evidence.json`；日志见 `verification/node-test.log` 和 `verification/e2e-run.log`。

## 未完成或未验证

* 没有在用户的实际 OpenMausBot、腾讯云或 Windows 环境运行；没有进行真实模型联调。
* 没有执行原仓库全量回归；本次只运行新增模块测试。补丁是新增旁路模块，不改既有 runtime。
* 还没有把所有旧 Worker 路径强制改成使用本筛选器；目前提供主控 MCP/指令接入与显式人工反馈导入。
* 没有真实企业 holdout、试运营或商业效果数据。
* HTTP 身份分离通过测试，但真实 OS 用户/文件/sudo 隔离须在部署环境验收；同账号 Full shell 不在这个 HTTP 边界的保护内。
* systemd 文件是待验证的部署示例，不是已安装服务。Node.js 24 兼容性尚未在本环境实际复跑。

## 交付文件

源码 ZIP、Git patch、这份记录。补丁仅新增 enterprise-learning 目录，可先 `git apply --check` 再在独立分支应用。现有数据、邮箱凭据、模型凭据、主控和生产服务均不随补丁迁移或覆盖。
