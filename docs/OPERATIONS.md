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

稳定 companyId 通常使用已人工规范的公司域名。软件进行大小写、末尾点号与开头 `www.` 的规范化，不会自动识别不同域名背后是同一集团；这部分需要标注者控制。相同 case 标签不可覆盖。v0.1 不提供删除/撤销标签的公开接口；错误标签需要停用对应评估集并由维护人员做有审计的数据迁移，不能直接改数据库凑分数。

### 抽取错误更正（extraction_error）

`input` 必须等于模型当时实际运行时使用的输入。如果审核员发现是**模型抽取错了**（例如把进口商抽成 `retailer`），不要标 `wrong_buyer_role`，而是：`reason: "extraction_error"`，并在 `corrected` 字段给出人工核实后的完整 buyer 对象（同一 companyId，内容必须与 `input` 不同），`label` 针对核实后的事实。

```json
{ "reason": "extraction_error", "label": "eligible",
  "input":     { "companyId": "x.example", "role": "retailer", "intentConfirmed": null, "sourceRefs": ["..."] },
  "corrected": { "companyId": "x.example", "role": "importer", "intentConfirmed": null, "sourceRefs": ["..."] } }
```

学习、冲突检测和 holdout 评估一律使用核实后的事实（有 `corrected` 用它，否则用 `input`）；`extraction_error` 记录不会成为"该角色不对"的证据，但核实为合格的角色会像正例一样阻止对该角色的排除。没有 `corrected` 字段的旧记录行为不变。

## 审计链校验

`node src/cli.mjs audit --client /private/owner-client.json` 重算整条审计哈希链，返回 `{ok, count, headHash}`，或 `ok:false` 加 `reason`（`sequence_gap` / `broken_link` / `hash_mismatch` / `head_mismatch`）。`status` 也会附带该结果。它能发现单条修改、中间删除和尾部截断；**不能**防止拥有数据库写权限的管理员重写整条链（见 SECURITY.md）。

## 日常运行：影子验证、审核队列与结果信号

适用于每天有持续人工标注（例如业务员每天审核 30–50 条）的实例。固定 holdout 在持续标注下会不断"过期"，所以增加前瞻性验证：

1. **影子运行** `shadow` `{"candidateId":"…"}`：候选版本与现行版本并行判断，只用现行结果，候选结果仅内部记录，**绝不返回给 Bot**。停止：`{"candidateId":null}`。
2. **每日审核队列** `queue` `{"size":40,"seed":"2026-11-12"}`：返回今天要审的 caseId 及分层。至少 10% 是从全部待审案例中均匀随机抽取（用于无偏估计准确率）；其余优先"现行与候选有分歧"的案例，再是 `needs_review`。排序由 `seed+caseId` 的哈希决定，可复现；已发出的案例不会重复发出。业务员审完后照常 `observe`。
3. **前瞻性配对评估** `evaluate_shadow` `{"candidateId":"…"}`：只统计候选开始影子运行**之后**产生、且已被人工标注的案例；候选自身证据涉及的公司排除，同一公司只计一次；在人工核实后的事实上比较两版，只看分歧案例并做精确符号检验（单侧 p≤0.05）。另要求合格买家召回不下降、误报不增加；生产模式至少 100 个前瞻标注案例、10 个有结论的分歧（测试模式 6 / 3）。通过后走原有 `approve` → `publish`；影子报告是固定快照，之后继续到来的新标签不会使审批失效。
4. **结果信号** `outcome` `{"id":"…","caseId":"…","event":"customer_reply|valid_inquiry|invalid_inquiry","note":"…"}`：登记客户回复、业务员确认的有效/无效询盘。`status` 的 `outcomes` 按"策略版本 × 筛选结果"汇总案例数、回复数、有效询盘数及 95% 区间。**仅用于归因观察，不作为发布闸门**：回复和询盘有延迟且噪声大。
5. **询盘判断** `inquiry`：业务员对一条真实询盘的判断。字段：`id, caseId, verdict(valid|invalid), reason(仅 invalid), text(询盘内容), ref(CRM 来源ID)`，可选 `reviewer, kind, split, corrected`。买家输入取自系统已记录的 case，调用方不能传。映射规则：`valid` → 合格买家；`invalid + wrong_buyer_role` → 角色不对；`invalid + no_purchase_intent` → 意向未核实；`not_target_product / spam_or_irrelevant / duplicate / other` **只记为结果，不进入学习**（它们不说明买家筛选规则有误）。若同时给了 `corrected`，记为抽取错误。split 默认按公司哈希稳定分配（约 20% holdout）。同一 case 只能有一个买家标签；重复提交同一 id 安全。批量导入见 `scripts/import-inquiries.mjs`，试跑流程见 `docs/TRIAL-RUNBOOK.md`。
6. `status.calibration`：只用随机分层案例计算的端到端准确率及 95% Wilson 区间——模型抽取加现行规则对比业务员标签。

要点：配对检验只依赖分歧案例，几十到上百个分歧即可得出结论，远少于直接比较准确率所需的样本。其效力仍取决于业务员标签的一致性。

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
