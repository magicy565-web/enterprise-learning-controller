# 威胁边界与生产上线检查

本模块采用权限分离，而不是依靠“请不要越权”的提示词：model Bearer 只到 /v1/model，owner Bearer 才能评估/标注/发布。模型 MCP 不暴露 owner 操作。模型不能写传入的任意代码，policy 只有 allowedRoles 与 requireIntent 两个受约束字段。

但是 HTTP 边界不能挡住同一个 OS 账号的 Full shell、管理员凭据被泄漏、root、恶意管理员、未受限本机 MCP。生产前必须：

1. 学习服务账号与 OpenMausBot/Worker 执行账号不同；Bot 不得有 sudo 或读取服务私有目录的能力。
2. DB、owner-client、server 配置仅学习服务/授权管理员可读。只复制 model-client 到 Bot 可读目录。不要把整个 state 目录挂载到 Agent sandbox。
3. 用实际 Bot 进程验证：owner 文件读失败，DB 读失败，model token 对 owner API 返回 401；不能通过另一个不受限制工具绕过。
4. 配对、原生 Bot 身份、模型引擎、来源许可及人工审核人由部署者验证；本包未替代上游权限系统。
5. 业务模块的真实外发、价格计算、付款和权限变更仍由现有服务的硬权限负责。本版既不执行这些动作，也不能用更好的离线分数授权它们。

服务仅监听 127.0.0.1；拒绝浏览器 Origin 与非预期 Host；无 cookie 或 CORS 信任；不跟随 HTTP 重定向。凭据随机生成，owner/model 不同。API 返回凭据之外的业务内容；stdio stdout 仅输出 JSON-RPC。

SHA-256 是内容/版本一致性校验，不证明网页内容真实、不证明人工标签正确，也不提供抵抗数据库管理员篡改的第三方公证。简单密钥模式扫描只是辅助措施，导入前仍需要脱敏。

holdout 以独立公司、原文摘要和来源去重；原生模型看不到 holdout 标签。本版只能限制按训练批次的候选数量，不是防止恶意管理员长期反复测试的统计评估平台。真实效果需进一步前瞻性试运行。

候选、报告、审批和发布记录在 SQLite 事务内追加；正式版本指针原子更新。运行中的 case 固定 release，回滚不会重写历史或触发邮件重发。数据集变化使旧评估失效。

默认不打开原生 Skill Review 或自动共享 Skills。正式规则保存在受保护服务中，不借普通 MEMORY.md 授权。未经实际接线的旧业务路径不会因此自动变安全，需要逐条验收。
