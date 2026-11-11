# 接口与数据契约

服务端绑定一个企业，任何请求都不能通过传 `enterpriseId` 切换租户。
所有 HTTP 写请求都是 `POST /v1/owner` 或 `POST /v1/model`，JSON `{ "action": "...", "input": {...} }`；凭据由 Authorization Bearer 提供。管理 CLI 自动添加凭据。

## 反馈（observe）

下面只是字段说明示例，不在启动时导入，不代表真实买家数据。实际记录替换为企业已经核对的原文与标签。

```json
{
  "id": "review-001",
  "caseId": "case-001",
  "input": {
    "companyId": "buyer-domain.example",
    "role": "retailer",
    "intentConfirmed": null,
    "sourceRefs": ["operator-reviewed-source-reference"]
  },
  "label": "ineligible",
  "reason": "wrong_buyer_role",
  "split": "train",
  "kind": "real",
  "evidence": {
    "ref": "immutable-original-source-id",
    "text": "REPLACE WITH THE ACTUAL REVIEWED ORIGINAL TEXT"
  }
}
```

role：`retailer | distributor | importer | brand | unknown`。label：`eligible | ineligible | needs_review`。reason：`wrong_buyer_role | suitable_buyer | intent_not_verified | other`。
split：`train | holdout`，由独立审核人预先决定，不能为了得到好成绩事后挑选。kind=`real` 是管理员的来源声明，不是软件能认证的真实性证明；系统不会伪称可以从这个字段核验原文真的来自企业。

稳定 companyId 通常使用已人工规范的公司域名。软件进行大小写与格式规范化，不会自动识别不同域名背后是同一集团；这部分需要标注者控制。相同 case 标签不可覆盖。v0.1 不提供删除/撤销标签的公开接口；错误标签需要停用对应评估集并由维护人员做有审计的数据迁移，不能直接改数据库凑分数。

## 候选、审批、发布的输入

`evaluate`：`{"candidateId":"实际候选ID"}`。

`approve`：`{"candidateId":"实际候选ID","reportId":"实际评估ID","candidateHash":"learning_candidate 返回的 sha256"}`。

`publish`：`{"approvalId":"实际审批ID","expectedActive":"当前正式 release ID"}`。

`rollback`：`{"requestId":"稳定且唯一的回滚请求ID","expectedActive":"当前 release ID","targetReleaseId":"历史祖先 release ID"}`。

`pause`：`{"paused":true}`。恢复：`{"paused":false}`。

`status` / `context` / `learn`：空对象 `{}`。管理员 status 才可看到完整评估报告；模型 context 不包含 holdout。

管理员 identity 在 server.json 固定，不接受请求伪造 reviewer 字段；v0.1 是单管理员凭据，不提供多用户单点登录或多人会签。

## 主要失败码

| code | 处理 |
|---|---|
| ID_CONFLICT / CASE_CONFLICT | 不要换 ID 隐藏冲突，先核对原记录 |
| DATA_LEAKAGE | 一家公司或一份来源不能跨 train/holdout；重新准备独立案例 |
| INSUFFICIENT_EVIDENCE / CONFLICTING_FEEDBACK | 补充真实审核，不得编造样本或忽略正例 |
| BATCH_ALREADY_USED | 同一训练批次不重复试探评估集 |
| STALE_TRAINING | 有了新训练资料，重新生成候选 |
| STALE_EVALUATION | 证据集变更后重新评估，旧审批失效 |
| STALE_BASE / STALE_RELEASE | 重读当前正式版本，不强行覆盖 |
| EVALUATION_FAILED | 不可批准；保留旧版本 |
| PAUSED | 等管理员处理，不自行解除暂停 |
| configured-unverified | 仅配置读回，尚需原生模型实机验收 |

## 备份

初版采用冷备份：先停学习服务，确认进程退出，再整体备份该企业私有目录（含 SQLite/必要的 WAL 文件与凭据），权限保持仅管理员可读；在隔离目录恢复并核对企业 identity/mode。不要在运行时只复制 `learning.sqlite` 而遗漏 WAL。安装日志、源码包不包含数据库或凭据；不要把备份提交到 Git。
