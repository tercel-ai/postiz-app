# 多节点发送 API 职责与文档归属

更新：2026-10-20。本索引供后端、插件及平台管理端联调，避免把所有已实现 API 都当作 aisee-app 的接入任务。它不改变任何接口或权限。

## 文档放在哪里

| 文档 | 读者及维护内容 |
| --- | --- |
| [aisee-app 前端改造指南](../../aisee-app/docs/aisee-app-multi-node-integration.md) | 页面改动、调用顺序、代码入口、验收 |
| [aisee-app 前端接口手册](../../aisee-app/docs/aisee-app-multi-node-integration-reference.md) | 前端实际业务调用、字段来源、响应处理；不是完整后端协议 |
| [组织发送模式](organization-sending-modes.md) | 系统能力、组织状态机、切换保护、平台调用回执及异常处置 |
| [账号与节点设计](project-account-extension-node-binding-design.md) | 账号绑定、节点与执行协议、并发、许可、配额和存储设计 |
| [可选账号策略](project-account-optional-identity-implementation.md) | REQUIRED/OPTIONAL、首次领取绑定及服务端保护 |
| [管理端页面](../../aisee-manage/app/pages/post/config/sending/index.tsx) | 平台系统开关、账号选择政策的展示与修改实现 |

两份前端文档继续放 aisee-app/docs，内容只服务前端交付；后台设计不复制过去，也不让前端从历史协议中猜当前调用顺序。

## 接口属于谁的接入范围

| 接口/能力 | 本轮主要调用方 | aisee-app 是否需要额外接入 |
| --- | --- | --- |
| 项目 sending-context | aisee-app | 是，统一初始化；已聚合模式、预选策略、账号、上报节点和默认 |
| 项目 sending-accounts/save | aisee-app | 是，项目默认保存；不要求客户端版本字段 |
| 原 Post / Engage 业务接口、已保存内容入队、业务状态/重试 | aisee-app | 适配现有入口，保持原记录身份；详见前端手册 |
| GET/POST /sending/mode | aisee-app 组织设置、插件 Options | 组织设置需要；不是平台超管接口，不需要每个编辑器重复读取 |
| GET/POST/PUT /admin/settings/sending.account_bound_enabled | aisee-manage | 否，平台能力开关；平台超管权限 |
| GET/POST/PUT /admin/settings/sending.account_selection_policy | aisee-manage | 否，平台 REQUIRED/OPTIONAL 政策；不是组织自主/受控开关 |
| /extension/send-protocol | 插件 | 新前端初始化不需要；不再作为 sending-context 前的必调步骤 |
| /user/send-preferences | 已有个人策略调用方/后端聚合 | 本轮不新增个人设置 UI；项目上下文已返回当前有效预选要求 |
| GET /projects/:id/sending-accounts、组织 sending-accounts | 兼容调用方、独立默认配置能力 | 本轮项目页面用上下文读取；组织全局默认 UI 暂不做 |
| GET /integrations/list、项目账号列表、reply-accounts 查询 | 原账号管理/兼容调用方 | 保留已有用途；不要求新选择器重复拼装这些 GET |
| 账号关联项目、回复权限保存 | 原授权业务 | 保留用户明确授权流程，选择器不自动授予权限 |
| /extension/nodes 的注册、凭据核验、节点会话上报 | 插件及其诊断/节点管理调用方 | 本轮不接，账号列表展示用上下文 terminals；不生成节点身份或传凭据 |
| /extension/send-attempts 的 claim/renew/preflight/start/outcome 等 | 插件执行器 | 不接；网页业务入队不等于拥有平台写入许可 |
| /sending/executions 的查询/对账 | 有对应权限的运维工具 | 不用于普通 Post/Reply 页面；页面读无凭据业务摘要 |
| /sending/mode/autonomous-effects 及 resolve | 组织管理员异常处置工具 | 当前前端范围未包含，不因模式设置自动新增人工对账 UI |

“本轮不接”不是删除已有功能或改变权限。上表按接入职责分类，具体授权以控制器和服务为准。

## 前端保留哪些安全信息

按接口分别约定：已保存 Reply 入队只需 sentReplyId 和可选 integrationId，后台以原草稿/任务防重，首次入队采用服务器当前保存的内容；不要求前端传版本或请求标识。Post 创建、项目默认保存、模式保存等接口仍按各自契约自动携带标识/版本，不能一概删除或强塞到所有请求。前端保留原记录 ID 与业务 allowedActions，区分请求重试和重新发送，不以新建内容绕过待确认结果。

## 本次整理修正

- 删除前端文档中“先读插件协议，再分散查询账号/策略/默认”的旧流程，统一以项目上下文为入口。
- 前端指南只保留页面任务，接口手册只保留真实业务请求及逐字段解释。
- 不把平台系统配置、节点注册、执行/对账当成 aisee-app 开发任务。
- 保留组织管理员模式设置，以及已有账号授权、手动发送确认、自动化和自主发送业务；不因文档收口改变功能。
- 现有计划提交的旧 planId 适配属于业务兼容项，不能作为新增多节点底层协议依赖。
