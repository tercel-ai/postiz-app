# Project 社交账号绑定与插件终端自动匹配方案

状态：设计草案，待审阅；尚未实现。  
创建日期：2026-10-13；更新日期：2026-10-14。  
范围：`postiz-app` 的 operation plan、post、Engage reply、automation，以及独立仓库 `../aisee-browser-extension` 的发送协议。

本次修订：重新对照后端及独立插件源码，补齐普通post请求防重、API/Temporal与插件共享发送保护、回复路由互斥、硬额度与生成目标的区别、插件提交日志与恢复、延迟/移除结果结算及灰度范围。以下机制均为拟议改造，不代表当前代码已有保障。

API修订原则：先核对现有controller、DTO及独立插件调用，再决定复用/扩展/新增。新增写操作优先POST，创建与修改按已有保存接口语义实现；已有PATCH/PUT/DELETE不因风格调整被删除或改义，兼容入口与新版请求共用服务层。

## 1. 建议采用的方案

每个 project 按「平台 × 操作类型」提前选择发送社交账号。operation plan、post、reply、automation 的业务配置只保存账号，不要求用户选择插件终端。生成、保存、排队时将账号固化到具体任务；服务端依据各终端上报的已核验登录会话，在领取时自动匹配执行终端，并在实际提交前再次验证平台身份。

账号复用现有 `Integration`，project 使用权限复用 `IntegrationProject`。新增终端、终端当前会话、project 默认账号绑定和发送尝试记录。operation plan 保存账号执行快照；post 和 reply 的账号绑定统一落到 `Post`。具体执行终端只保存到领取后的 `ExtensionSendAttempt`，不提前固定在计划或任务。`EngageSentReply.postId` 已关联 Post，无需再保存第二份账号字段。

社交账号列表 API 平铺返回每个账号及其关联终端 `terminals[]`、服务端计算的 `sendAvailability`；前端自行按平台分组、排序、折叠。终端页面用于展示、命名、状态诊断和撤销，不作为每次发送必选的业务配置。接口契约见 §7.2。

目标示例：

| AIsee 登录身份 | Project | 平台 | 操作 | 提前选择的账号 | 系统发现的可执行终端 |
| --- | --- | --- | --- | --- | --- |
| 同一用户 | A | X | post / reply | x1 | 浏览器 Profile 1 的插件 N1 |
| 同一用户 | B | X | post / reply | x2 | 浏览器 Profile 2 的插件 N2 |

当 N1 登录 x1、N2 登录 x2 时，N1 只可领取 x1 的授权任务，N2 只可领取 x2 的授权任务。N1 若切换成 x2，不再可执行 A/x1；若有另一个有效终端登录 x1，它可领取 A 尚未被领取的任务，否则 A 等待账号恢复。切换后的 N1 是否可领取 B/x2，还必须检查其登记者对 B 的权限。终端离线不阻止保存草稿和预约任务。

对用户称“插件终端”，内部模型仍命名为 ExtensionNode。首版终端是一个浏览器 profile 内的一次插件安装，ID 不能只用 chrome/arc/firefox 等浏览器名字。一台电脑上的不同浏览器、同浏览器的不同 profile 都可形成不同终端。Chrome、Firefox 可使用独立 profile；Arc 的 Space 必须关联不同 Profile 才隔离登录，共用 Profile 的多个 Space 不算不同会话环境。参考 [Chrome Profiles](https://support.google.com/chrome/answer/2364824/)、[Firefox Profiles](https://support.mozilla.org/en-US/kb/profile-management)、[Arc Profiles](https://resources.arc.net/hc/en-us/articles/19227964556183-Profiles-Separate-Work-Personal-Browsing)。

一个终端可以登录多个平台、运营多个 project；首版每个终端、每个平台只识别一个当前发送身份，不实现自动切号或 Firefox container 内多账号执行。平台即使保存多个登录账号，也必须核验本次发送的当前 actor。要并行运营同平台 x1/x2，使用隔离的浏览器/profile环境，不依赖插件本身保存多套 cookie。

账号与终端是动态关系：一个账号可以同时登录多个终端，一个终端可以承载多个平台账号。业务请求只选 integrationId；插件执行请求仍须认证终端身份，领取成功后锁定本次 attempt 的终端。终端不是仅用于显示的标签，但用户无需管理每个任务的终端路由。

同一个平台账号允许同时登录Chrome/Arc/Firefox等多个终端，它们复用一个Integration、分别记录NodeSession，不强制互相登出、不重复占用账号额度。发送协调以服务端持久状态为权威，同时防止同一业务发送重复执行和发送额度被并发重复使用；具体规则见§8.1。

## 2. 当前代码的事实与缺口

以下结论来自源码读取。链接是当前实现的定位点，不能将本方案描述的新能力理解为已有功能。

| 环节 | 当前实现 | 对本需求的影响 |
| --- | --- | --- |
| Project 账号关系 | [schema.prisma](../libraries/nestjs-libraries/src/database/prisma/schema.prisma) 的 `IntegrationProject` 已定义账号与 project 多对多关系、`disabled` 和 `engageEnabled` | 可以复用账号分配；不能把 organization 内所有账号当成当前 project 可用账号 |
| Plan 生成 | [operation-plan.service.ts](../libraries/nestjs-libraries/src/database/prisma/operation-plan/operation-plan.service.ts) 的 `_validateInput` 校验平台，`create` 根据 project、时间区间、平台匹配已有计划 | 没有账号选择；新增账号绑定时必须明确计划重试语义，不需增加业务终端选择 |
| Plan 落地 | [operation-plan.repository.ts](../libraries/nestjs-libraries/src/database/prisma/operation-plan/operation-plan.repository.ts) 的 `materializePlanPosts` 创建 `integrationId: null` 的 DRAFT；LinkedIn 类型依据 organization 已有 integration 决定 | 计划只有平台，没有发送身份；organization 级账号探测不能决定 project 的个人账号/公司页面目标 |
| Automation | [automation.dto.ts](../libraries/nestjs-libraries/src/automation/automation.dto.ts)、[automation.service.ts](../libraries/nestjs-libraries/src/automation/automation.service.ts) 的 `saveReplies` 和 overview 明确采用插件当前会话，不选账号；publishing DTO 有平台、窗口和 `publishMethod` | 配置可以决定何时发送，却不能确定目标账号，也没有基于账号会话自动匹配终端 |
| Post 领取 | [posts.controller.ts](../apps/backend/src/api/routes/posts.controller.ts) 的 `POST /posts/publish-due` 只有 `limit`；[posts.repository.ts](../libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts) 的 `claimDueExtensionPublishPosts` 按 organization 领取并写 `releaseId`/`claimedAt` | 同 organization 的插件竞争同一发送池，没有节点路由 |
| Post 账号校验 | [posts.service.ts](../libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts) 的 `getDuePublishPosts` 仅在已绑定 integration 时返回 `targetAccount` | 已有可复用的目标账号概念；无 integration 的 plan post 不携带目标账号 |
| Reply 领取 | [engage.controller.ts](../apps/backend/src/api/routes/engage.controller.ts) 的 `POST /engage/reply-due` 不接收节点；[engage-auto-reply.service.ts](../libraries/nestjs-libraries/src/engage/engage-auto-reply.service.ts) 的 `getDueReplies` 返回 project/platform/url/text 等字段 | 自动 reply 没有目标账号和节点；新生成回复的 `_draftOne` 返回分支还未写发送领取租约，必须统一经过领取流程 |
| Reply 保存 | [engage.service.ts](../libraries/nestjs-libraries/src/engage/engage.service.ts) 的 `saveDraft`、[engage.repository.ts](../libraries/nestjs-libraries/src/engage/engage.repository.ts) 的 `upsertDraft` 保存 Post 与 EngageSentReply；[engage.dto.ts](../libraries/nestjs-libraries/src/engage/dtos/engage.dto.ts) 的 `SaveDraftDto` 没有发送绑定 | 草稿保存时不能固化将来发送的账号 |
| Reply 账号列表 | `engage.repository.ts` 的 `listReplyAccountIntegrations` 查 organization 内账号，缺少 project 关系时将 `engageEnabled` 视为 true | 该列表不能直接作为严格 project 账号授权依据；应要求实际 IntegrationProject 关系 |
| 平台会话 | [integration.repository.ts](../libraries/nestjs-libraries/src/database/prisma/integrations/integration.repository.ts) 的 `recordExtensionSession` 将匹配账号标为 EXTENSION，同平台其他账号标为 API；[extension-session-report.dto.ts](../libraries/nestjs-libraries/src/dtos/integrations/extension-session-report.dto.ts) 没有节点字段 | N1 上报 x1 后，N2 上报 x2 会覆盖同平台账号的全局状态；无法表示两个同时在线的节点 |
| 发送归属 | `posts.service.ts` 的 `_attributeExtensionPublisher`、`engage.repository.ts` 的 `updateReplyUrl` 可在成功后补账号；[extension-session.utils.ts](../libraries/nestjs-libraries/src/database/prisma/integrations/extension-session.utils.ts) 可以使用最近的全局活跃会话归属 | 成功后推断无法保证事先选定身份；多节点时不能用最近上报账号代表任务执行账号 |
| 成功回传 | [mark-extension-published.dto.ts](../libraries/nestjs-libraries/src/dtos/posts/mark-extension-published.dto.ts)、`PublishExtensionReplyDto` 没有节点、attempt、lease 校验字段 | 当前回传不能证明是被指派且持有有效发送授权的节点完成 |
| 版本门槛 | [extension-version.guard.ts](../apps/backend/src/services/extension/extension-version.guard.ts) 无版本头时放行，读取门槛失败也放行 | 现有版本门槛适合升级提醒，不能充当严格节点授权守卫 |
| 账号列表 API | [integrations.controller.ts](../apps/backend/src/api/routes/integrations.controller.ts) 的 `GET /integrations/list` 平铺返回 integrations，外部字段为 id/identifier/display | 已有正确的平铺结构；新增终端与发送可用性字段即可，不增加后端平台分组或同义平台字段 |
| 插件账号登记 | `integration.service.ts` 的 `reportExtensionSession` 已能创建 Integration，但只在该平台 rows.length===0 时调用创建 | 已有保存 API；需要改为按本次实际账号是否存在判断，才能自动登记同平台第二个账号 |
| 账号唯一性 | `schema.prisma` 的 Integration 唯一键为 organizationId/internalId；`integration.repository.ts` 按该键 upsert并可更新providerIdentifier | 不同平台的相同handle/ID可能命中同一行；账号身份规则必须在多终端上线前修正 |
| 回复业务防重 | `engage.repository.ts` 的 upsertDraft按project/opportunity/state查已有行，注释明确没有防止并发重复创建的数据库唯一约束 | 每个Post一个attempt不等于同一业务回复只发一次；还需逻辑发送意图约束 |
| Project权限 | `project-validation.service.ts` 按organization对应owner检查project归属/有效性，不接收当前userId | 可复用归属验证，但不能当成已经存在用户级project ACL |
| 账号节奏 | `engage-auto-reply.service.ts` 使用org/platform的getLastPlatformWriteAt；warmup和社区计数也有org/platform查询 | 需要明确迁移原闸门，不能只增加新账号锁后继续让x1限制x2 |
| 回复API路由 | `SendReplyDto`没有publishMethod；sendReply/scheduleReply及批量方法显式传api；startWorkflow又用source!='engage'限定插件分支 | 增加DTO字段还不够，必须同步修改producer与工作流分流，否则extension回复仍可能进入Temporal |
| API重试 | [post.workflow.v1.0.1.ts](../apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.0.1.ts) 的平台activity默认最多3次重试，外层发送循环最多5次 | 现有Post领取挡不住同activity在平台成功但响应丢失后的重试；严格账号不能沿用无结果分类的发送重试 |
| 配额闸门 | `engage.service.ts`的_assertReplyPacing先按预约日期查数量；auto-reply另检查项目本地日dailyReplyLimit，plan budget默认只在启用ENGAGE_REPLY_BUDGET_GATE_ENABLED时用于新增生成 | 预约检查不是执行额度预占；生成目标、执行硬上限和计费不能合并成一个计数器 |
| 机会状态领取 | `engage.repository.ts`的claimOpportunityForReply按项目机会state的NEW/AUTO_QUEUED竞争，不含账号；cancelAndSendNow删除旧Post并重置机会 | 新账号级意图不能再由旧项目机会状态充当唯一发送锁；取消重发也不能删除已授权/未知结果记录 |

独立插件仓库的对应事实：

| 源文件（位于 `../aisee-browser-extension`） | 当前行为 |
| --- | --- |
| `src/utils/executor/api.ts` | 用 AIsee access token 调用后端；所读发送流程没有节点凭证 |
| `src/utils/executor/publish.runner.ts` | 用 `{ limit }` 领取 post，支持传递已有的 `targetAccount` |
| `src/utils/post-publish/account-guard.ts`、`queue.ts` | 有 post 账号守卫；没有目标账号、探测异常、不支持探测或部分未知身份时可放行；Dev.to、Quora 另有页面内身份校验 |
| `src/utils/executor/reply.runner.ts` | 用 `{}` 领取 reply；`DueReply` 没有目标账号或节点，将文本交给 `handlePostReply` |
| `src/pages/background/post-reply.ts` | 发送前检查是否已发、人工失败状态及 URL；可探测实际作者用于回填，缺少与指定发送账号对照的通用校验 |
| `src/utils/extension-session-report.ts` | 向 `/integrations/extension-session` 上报平台身份，没有节点维度 |
| `src/utils/account-scope.ts`、`account-owner.ts` | 已有 AIsee 用户切换后的本地数据隔离；这不是平台发送账号或节点路由 |
| `src/utils/post-publish/queue.ts` 的 persist/restoreFromStorage/retryPublishTask | persist不等待chrome.storage.local.set完成；中断publishing恢复为error；本地Retry按error及已发段数重排 | 严格模式必须等待日志持久化，并把提交未知与确定未提交分开，不能从旧error状态直接重放 |
| `src/pages/background/post-reply.ts`、`src/utils/reply.unconfirmed.ts` | 部分结果直接fetch旧回调；未确认回复另经扫描恢复；人工发送可绕过本地unattended间隔 | 只改executor/api.ts不能覆盖这些路径；严格任务统一认证、授权、结果日志及账号间隔 |
| `src/utils/executor/api.ts`、`src/utils/request.util.ts` | request.util未透传自定义headers；backendCall遇426设置全局停止，之后所有调用短路 | 节点头需落到实际HTTP请求；停新发送与继续核对/回报已发生结果必须分开 |

分析未读取或修改冻结目录 `apps/extension/`。本方案中的插件改动全部指向独立仓库。

### 2.1 已有账号保存调用链，继续复用

```text
Platform identity probe
  -> persistLoginSnapshot
  -> reportSessionSnapshot / buildSessionReport
  -> authenticated PATCH /integrations/extension-session
  -> IntegrationsController.reportExtensionSession
  -> IntegrationService.reportExtensionSession
  -> match existing Integration / createChannelFromExtensionSession
  -> createOrUpdateIntegration / recordExtensionSession
```

插件 [persistLoginSnapshot](../../aisee-browser-extension/src/utils/session-maintenance.ts) 保存本地快照后立即上报；[extension-session-report.ts](../../aisee-browser-extension/src/utils/extension-session-report.ts) 上报checkedAt及每个平台的platform/loggedIn/id/handle/name/picture。refresh、维护和部分重检均复用这条链路。服务端已做账号创建权限/额度检查、头像存储和账号展示信息修正，不应另建重复的“插件账号保存 API”。

现有IntegrationService原样将internalId传给repository，没有在中间加平台前缀；[buildExtensionSessionSeed](../libraries/nestjs-libraries/src/database/prisma/integrations/extension-session.utils.ts) 使用平台ID或handle作为internalId。因此“已存在账号保存调用”与“创建条件、唯一键仍有缺口”同时成立。本方案是在该现有API内增加终端维度与可靠身份契约，修正后端匹配/登记语义。

### 2.2 已有相关API盘点与复用决策

下表方法/路径和当前语义已经对照controller与DTO；“调整”栏均是拟实施设计。本表不要求改造所有历史API的HTTP方法。

| 当前API | 当前语义/关键字段 | 本方案调整 |
| --- | --- | --- |
| GET /integrations/list | organization账号列表，返回integrations数组，id/identifier/display | 原路径和organization范围保留，追加terminals/sendAvailability；不另建社交账号列表 |
| GET /integrations/integration-project/list?projectId=... | 已有project账号列表，含projectDisabled及项目postingTimes | 复用为project账号选择来源，追加同样的终端/可用性字段，不再给organization列表重复增加project过滤职责 |
| POST /integrations/integration-project | 按integrationId/projectId创建或更新关系；postingTimes、disabled | 保留upsert及既有字段；这是项目账号分配，不是默认账号选择，不能合并二者 |
| DELETE /integrations/integration-project | 解除项目账号分配 | 保留旧方法/语义；本轮不为所有历史DELETE新增POST别名 |
| POST /integrations/social/:integration/connect | 手工/OAuth连接并保存账号 | 保留，内部改用统一身份解析/唯一键；不另建账号创建API |
| PATCH /integrations/extension-session | 插件当前保存登录身份/匹配创建账号 | 保留，增加同路径POST兼容入口供新版使用，共用服务；节点与身份字段按协议模式验证 |
| GET /engage/reply-accounts?projectId=... | 现有回复账号数组；当前主要连接账号平台 | 保留数组及非敏感账号字段，追加terminals/sendAvailability；严格模式按实际项目关系筛选、扩展已验收的平台；输出改为明确DTO白名单 |
| POST /engage/reply-accounts/:integrationId | 写projectId/engageEnabled，创建或更新项目参与设置 | 保留，控制账号是否允许reply；不承担project默认账号选择 |
| GET /projects/:projectId/automation | overview、现有平台策略/队列状态 | 在现有overview追加默认账号及bindingRevision，不新增GET send-bindings |
| POST /projects/:projectId/automation/enabled | 保存master enabled；关闭时撤回尚未开始的计划QUEUE，手工post/reply不撤回 | 保留开关及uncommit语义，不顺带修改默认账号 |
| POST /projects/:projectId/automation/publishing | platforms/windows/enabled/commit/publishMethod | 可选accounts增量保存POST默认账号；已有平台/窗口/commit语义保留 |
| POST /projects/:projectId/automation/replies | autoReplyEnabled及完整policies映射 | 可选accounts增量保存REPLY默认账号；省略accounts不改变绑定，policies替换不隐式清账号 |
| POST /projects/:projectId/operation-plans | 生成计划；taskId/日期/platforms/keywords，dryRun query | 可选executionRoutes输入保存账号快照；继续生成接口，不借重试创建调用修改已有计划或收新费用 |
| GET /operation-plans/:id、GET /projects/:projectId/operation-plans/active | 现有详情/active查询 | 保留原响应字段，追加executionRoutes/executionRevision；详情按持久化project归属校验，不靠客户端省略project绕过 |
| POST /posts | 已有创建/编辑；type=draft/schedule/now，posts[].integration.id、value[].id、group等 | 直接复用账号字段和保存流程；新增可选revision/project绑定校验，不新增POST posts/save或同义integrationId字段 |
| POST /posts/schedule | posts:[{id,publishMethod?,date?}]，按ID批量DRAFT入队 | 增加item可选integrationId/expectedRevision以选账号并排队；已有账号省略时保留；不恢复已经移除的planId模式 |
| GET /posts/:id、GET /posts/publish-methods | 详情/现有发送能力查询 | 保留结构，追加只读执行信息；能力接口与严格账号能力映射，不再新建重复平台能力列表 |
| POST /engage/opportunities/:id/save-draft | projectId/draftContent/策略，当前无账号输入 | 增加可选integrationId/revision，复用草稿保存和ReplySendIntent；不新增reply/save |
| POST /engage/opportunities/:id/send-now、/schedule、/batch-send、/batch-schedule | 已有发送/预约操作，已有integrationId；schedule有scheduledAt | 增加可选publishMethod和已有草稿引用，extension分支进入统一队列；省略时保留原分支解析，不偷偷改成不同send path |
| PATCH /engage/sent/:id | 编辑已预约回复内容/时间 | 保留兼容入口；如新版UI需要POST，增加同路径POST别名，共用同一编辑服务及版本约束 |
| PUT /posts/:id/date | 修改日期 | 保留；新版需要时同路径增加POST别名，不新建一套日期修改逻辑 |
| POST /posts/publish-due、POST /engage/reply-due | 现有领取；post body为limit，reply当前无body | 保留路径、due/pacing结构；严格模式节点认证及账号匹配，追加attempt字段，不新增另一套任务池API |
| GET /posts/publish-due/count、GET /engage/reply-queue-status | 现有不领取的队列显示 | 追加节点/账号可执行计数与阻塞说明，仍GET且不产生claim |
| PATCH /posts/:id/extension-published、/extension-publish-failed、/extension-removed | 现有post成功/失败/移除回传 | 保留旧字段和响应，为旧任务/本地待报告记录提供受限兼容；严格记录须经统一attempt验证 |
| GET /engage/sent/:id/status | 现有轻量state/replyUrl及人工失败状态 | 保留，追加只读currentAttempt/sendBlockCode；不替代历史attempt核对查询 |
| PATCH /engage/sent/:id/publish-reply、/removed；POST /engage/sent/:id/failed、/unconfirmed | 现有回复成功/移除/失败/未知回传 | 保留方法与字段，统一适配结果服务；不同方法不能成为绕过严格attempt的入口 |
| PATCH /engage/sent/:id/reply-url、POST /engage/opportunities/:id/manual-reply | 人工已发送事实补录、后续URL补录 | 保留事实登记，不当成新发送授权；新protocol不能通过人工补录接口重新派发 |

依据：[IntegrationsController](../apps/backend/src/api/routes/integrations.controller.ts)、[PostsController](../apps/backend/src/api/routes/posts.controller.ts)、[EngageController](../apps/backend/src/api/routes/engage.controller.ts)、[AutomationController](../apps/backend/src/api/routes/automation.controller.ts)、[OperationPlanController](../apps/backend/src/api/routes/operation-plan.controller.ts)及各DTO。POST /posts通过现有内容ID/group编辑，不能随意改变这些字段的含义。

新接口只补现有能力缺口：终端登记/管理、已有计划执行快照的独立编辑、发送前授权/租约/逐段核验/统一attempt结果和恢复查询。project默认账号保存复用automation，删除上一稿拟新增的GET/PUT send-bindings；节点心跳复用账号上报的轻量模式，不必新增独立heartbeat endpoint。

## 3. 必须满足的业务约束

1. AIsee 用户身份负责登录与权限；organization 负责租户隔离；project 负责运营归属；Integration 负责平台身份；ExtensionNode 负责执行位置。这些标识不能互相替代。
2. 插件任务排队时必须有确定的 `organizationId + projectId + integrationId + targetAccount`；extensionNodeId 在领取时确定。草稿可未绑定账号，无账号任务不能进入执行队列；有账号但无在线终端的任务可以排队等待。
3. 账号必须分配给当前 project，并且 Integration 与 IntegrationProject 均未禁用；reply 还要求该关系的 `engageEnabled=true`。节点与账号同属该 organization，project 必须有效且调用者有权限。
4. 相同账号可分配给多个 project；post 与 reply 可选不同账号。首版每个「project/platform/action」只有一个默认账号，单条任务可覆盖为其他已授权账号，不随机选择或轮换账号。终端不在此默认绑定内。
5. 修改默认路由仅影响随后创建或显式重新绑定的任务。已排队任务不可在领取时重新读取默认路由并替换账号。
6. 保存与排队验证账号、project授权及目标平台身份；领取与发送开始再验证执行终端、会话和操作能力。没有可用终端是运行状态，不是缺少业务账号绑定。
7. 日志、历史记录保留选定账号、实际核验账号、执行节点与 attempt；成功后不能将选定账号覆盖成“最近活跃账号”。
8. 自动回复及默认人工回复共享业务发送意图，同project、同目标账号、同opportunity的默认回复最多一次；不同project/账号仍可各自回复。明确追加回复与默认回复使用不同意图。
9. 生成或保存计划不得隐式修改当前project自动回复账号。用户明确变更默认账号与已有任务改绑是两个分别授权的操作。

## 4. 数据模型

字段名是建议的实现契约，后续实现需补 Prisma relations、索引和迁移 SQL。本次仅产出设计，不执行迁移。

### 4.1 复用账号与 project 授权

`Integration` 仍是唯一平台账号实体，不另建一套“插件账号”。没有 OAuth 凭证的平台账号也可使用现有 extension-session 创建 channel 的能力登记；身份来源标记为 extension，不将空 OAuth 凭证伪装成 API 可用账号。

平台报告发现账号后可以登记 Integration，但不得自动授予任何 project 使用权限。project 分配仍由已授权用户完成。发送端只拿可展示身份字段，不返回 token、refreshToken 或平台 cookie。

`IntegrationProject` 的存在表示 project 可以使用账号；`disabled` 决定暂停；`engageEnabled` 决定能否用于 reply。修正当前 reply 账号列表中“没有关系也算允许”的默认行为。

#### 平台身份唯一规则

Integration继续表示一个确定的平台发布actor。新增必填的identityNamespace（先nullable回填），建议账号唯一键改为`(organizationId, providerIdentifier, identityNamespace, internalId)`，替换现有`(organizationId, internalId)`；平台ID必须按各平台规则规范化，不能统一把所有ID小写。首版支持平台的命名空间见§4.3；同handle在不同平台是不同账号，同平台不同ID命名空间不能直接比较或合并。

服务端从上述身份生成canonicalAccountKey，用于回复防重和账号写锁；同一个Integration的已确认身份别名仍映射同一key。若支持实例型平台，provider/namespace规则必须包含实例域，不能把不同站点相同ID合并。已有Post/IntegrationProject引用的Integration.id保持不变，不能用迁移重建账号来破坏历史。

新增版本化identityAliases和credentialSource元数据：别名仅在有可靠同一actor证据或受权限保护的账号关联流程后写入；SESSION_ONLY不得被当成可用OAuth凭证，API发布/refresh/私有metrics必须单独验证OAuth能力。插件报告只能更新允许的身份展示信息，不能覆写已有OAuth token/refreshToken或将disabled账号重新启用。

OAuth连接、插件上报、手工连接、refresh、findIntegrationByInternalId及所有upsert共同使用身份解析服务。已有账号跨namespace不能只因handle相同就自动合并；无足够证据时返回ACCOUNT_IDENTITY_UNRESOLVED，保存终端观察但不标为可发送。只有handle可用的平台将handle作为明确的handle命名空间身份；改handle或handle被复用不得静默改写旧发送历史，应重新核验/登记或显式关联。

#### 同平台新账号登记与额度

现有上报流程调整为：验证节点及观察证据 → 按provider/namespace/identity匹配具体账号 → 找到则更新允许字段及本节点会话 → 未找到且身份明确、创建权限和额度允许则创建 → 未找到但额度不足或身份不能确定则保存未匹配观察，返回ACCOUNT_REGISTRATION_LIMIT_REACHED或ACCOUNT_IDENTITY_UNRESOLVED。判定依据不是“平台已有几行”。

重复上报幂等；多个终端同时发现同一账号，由数据库唯一键保证只创建一个Integration，冲突后读取胜者。账号额度检查也必须在并发创建时原子执行，不能让两个节点各自看到余量后同时超额创建。成功登记不自动分配project，额度失败不丢失其他平台上报。

已有账号可更新profile/name或补缺失头像，但不因会话报告覆盖用户已自定义字段。租户内若历史上发生跨平台覆写，先保存审计证据、核对真实身份及引用，隔离无法恢复的记录；本次迁移不根据handle自动合并、删除或重新归属历史。

### 4.2 ExtensionNode：节点与生命周期

| 字段 | 用途 |
| --- | --- |
| `id`, `organizationId`, `registeredByUserId` | 服务端节点 ID、租户、登记者 |
| `installationId`, `name`, `browser` | profile 本地存储生成的安装 UUID、用户可读终端名称、插件上报的浏览器类型；UUID 不是凭证，浏览器名字不能代替 ID |
| `credentialHash`, `credentialVersion` | 服务端发放的随机节点密钥摘要及轮换代次；原文只在登记/轮换响应返回 |
| `status` | `ACTIVE / REVOKED`；在线与离线由心跳推导，不用同一字段混淆 |
| `revision` | 节点管理的乐观并发版本，命名/撤销修改递增，不与credentialVersion混用 |
| `lastSeenAt`, `extensionVersion`, `protocolVersion`, `capabilities` | 服务端接收时间、插件版本、协议版本、各平台可执行操作和身份校验能力 |

建议唯一键 `(organizationId, installationId)`。节点凭证与 AIsee 用户凭证联合使用：用户 token 证明当前 organization 身份与权限，节点密钥证明安装实例。首版节点同时绑定登记者，所有执行请求要求当前 userId 等于 registeredByUserId；同 organization 的其他用户可在权限范围内命名/撤销节点，但不能借用其执行凭证。换用户或 organization 时不复用原 nodeId：旧身份仍有效时先撤销旧节点，清理本地凭证及会话，生成新的 installationId 和节点并重新登记。若旧身份已失效，则停止旧本地执行，由原登记者或管理员撤销旧节点，不能用新用户身份越权撤销。

未领取 QUEUE 保持原账号绑定，新终端仅在新登记者具备对应 project 权限且会话匹配时可领取，不需要重新选择业务账号；已 RESERVED 的旧 attempt 必须撤销/过期后重新领取，SENDING/RECONCILING 继续核对，不转交新节点。节点重装同样新建 ID；注销清理凭证并停止领取。installationId 在同一次登记身份期间稳定，换 AIsee 身份时更换 UUID，旧凭证、本地 attempt及历史缓存不得跨身份复用。

终端名称由用户修改，例如“办公电脑 · Chrome · 运营A”；浏览器类型自动上报，电脑名称和 Profile 名称无法可靠获取时由用户补充。ID 保存在 profile 本地、不能经浏览器 sync 在不同安装共享；复制 profile 导致 ID/凭证克隆时需要重新登记，不能把它们视为独立终端。

在线心跳与平台身份探测分开：例如每60秒以POST /integrations/extension-session的platforms:[]轻量上报保持节点心跳，超过3分钟显示离线；空报告不探测平台、不清空既有会话、不刷新verifiedAt。现有有效due请求也可刷新终端lastSeenAt，不能把仅5分钟一次的reply轮询当成60秒心跳。阈值由配置控制，平台按能力刷新并在发送前现场验证；浏览器休眠后恢复先重建alarms并重新核验，不保证睡眠中持续心跳。

### 4.3 ExtensionNodeSession：节点当前平台身份

| 字段 | 用途 |
| --- | --- |
| `organizationId`, `extensionNodeId`, `platform` | 会话所在节点与平台；唯一键 `(extensionNodeId, platform)` |
| `integrationId?`, `accountIdentity` | 匹配到的 Integration；实际观察身份（ID、命名空间、handle 等） |
| `verificationStatus` | `VERIFIED / LOGGED_OUT / UNKNOWN / UNSUPPORTED` |
| `observedAt`, `receivedAt`, `verifiedAt`, `sessionRevision` | 客户端观察时间、服务端接收报告时间、服务端最后一次确认当前账号身份时间、节点平台会话版本 |
| `evidenceKind`, `probeId`, `identityObservedAt`, `verificationExpiresAt` | 现场/缓存/未知证据来源、一次实际探测ID、真实身份探测时间及服务端计算的核验有效期 |

只有服务端身份匹配成功才能写入 `integrationId`；请求里声称的 integrationId 不能直接成为匹配事实。每次身份改变、登出或核验失效时递增 `sessionRevision`。上报带节点内单调序号，拒绝乱序报告；重复序号幂等。插件重装通过新节点隔离序号。

成功核验身份才更新verifiedAt。普通心跳只更新终端lastSeenAt；UNKNOWN报告只更新receivedAt，不刷新verifiedAt。verificationExpiresAt决定核验有效期，不能仅凭新接收时间重新授予完整TTL。显式UNKNOWN立即不可执行，即使前一次核验尚未过期。换账号或登出时清除原关联和原verifiedAt，新账号重新核验后才建立关系。

新报告逐平台携带`verificationStatus`、`evidenceKind=LIVE_COOKIE_ID/LIVE_PAGE_ACTOR/CACHED/UNKNOWN`、probeId、identityObservedAt、identityNamespace、账号身份和reportSequence。保持旧platform/loggedIn/id/handle/name/picture字段，checkedAt仅兼容诊断。身份核验状态不得复用社交账号蓝标/付费认证等同名verified字段。

插件身份缓存复用原probeId、identityObservedAt和来源；重新包装快照、重传或读取缓存不得伪装成新探测。重复probeId不延长verifiedAt/verificationExpiresAt，新的reportSequence也不能替代新证据。服务端拒绝过旧、未来时间、乱序报告，按接收时间和实际观察年龄限制有效期；首次缓存报告不能取得比原观察更长的剩余TTL。时钟差异常则要求重新现场核验，不信任客户端时钟自动延期。

缓存可用于账号展示及在原核验有效期内发现候选终端；start必须要求当前attempt/segment现场探测并产生新probeId，不能只调用返回缓存的probeSessionAccount。新鲜度阈值及强制现场探测API纳入两仓库协议测试。

#### 身份与操作能力矩阵

以下是身份核验验收要求，不代表现有插件已经通过严格发送验证。上线前逐平台、逐POST/REPLY操作跑真实场景；只有通过者公布strictAccountVerification能力，其余只展示会话或返回CAPABILITY_UNSUPPORTED。

| 平台/actor | 身份契约 | 严格发送前置条件 |
| --- | --- | --- |
| X用户 | x.rest_id；handle仅展示/缺稳定ID时受限匹配 | 核验当前发送actor，验证切号后旧缓存不放行 |
| Reddit用户 | reddit.user_id，统一t2_与裸ID | 当前用户ID与目标一致，发帖/评论均适用 |
| LinkedIn个人 | 明确OAuth sub与浏览器member ID各自namespace | 有已验证别名映射或可靠同actor关联；不同namespace不比较裸ID |
| LinkedIn页面 | 页面actor ID，与个人actor区分 | 插件明确支持页面选择且现场核验页面actor，否则不派发 |
| Dev.to用户 | devto.user_id，cookie存在不等于命名身份 | 在实际提交页面识别expectedUserId，缓存/匿名cookie不放行 |
| Hacker News用户 | hackernews.handle，平台规则保持大小写语义 | 登录页/提交页确认目标username，不能只证明有cookie |
| Medium用户 | medium.user_id优先，缺稳定ID时medium.handle | 在可验证当前作者的页面确认actor，改handle需重新确认身份 |
| Quora用户 | quora.user_id或quora.profile_slug | 当前页面核验expectedSlug/ID，设备cookie不证明已登录 |

N1/x=x1 与 N2/x=x2 是两条独立记录，互不覆盖。节点会话只记录当前状态；任务快照、attempt 才记录历史。旧 `activeSessionClient` 可暂作展示兼容字段，不再用于节点路由或成功归属；若继续输出，只能作为多节点会话的汇总信息，不能维持“匹配一个、其余全部 API”的上报写法。

同一账号可以出现在多个终端会话中，不对 integrationId 设置终端全局唯一约束。登出或确认切成其他账号时清除原账号的当前关联；UNKNOWN 可保留最近一次匹配用于诊断，但不可当成可执行会话。账号 API 的 terminals[] 是这些会话的只读投影，不是用户手动建立的永久关系。

### 4.4 ProjectSendBinding：提前选择默认社交账号

| 字段 | 用途 |
| --- | --- |
| `id`, `organizationId`, `projectId`, `platform`, `action` | `action=POST / REPLY`；唯一键 `(organizationId, projectId, platform, action)` |
| `integrationId` | 明确选择的社交账号；不保存 extensionNodeId |
| `revision`, `updatedByUserId`, `updatedAt` | 乐观并发版本与变更审计 |

该表表达默认账号选择，不能替代 IntegrationProject 授权。默认绑定不放进 `replyPolicies`：那个 JSON 已承载回复与发布策略，账号外键、并发修改和统一查询需要独立模型。新增默认绑定不会创建账号与某一终端的永久绑定。

节点删除使用撤销/软删除；账号解除 project 分配不级联删除发送历史。绑定随授权丢失变为不可执行，并向用户说明原因。租户一致性由服务校验和同租户复合外键约束；不能仅依赖 UUID 难猜。project 是外部引用，继续由现有 ProjectValidationService 验证。

### 4.5 OperationPlan：执行绑定快照

新增 `executionRoutes Json?` 和 `executionRevision Int`，独立于 LLM 生成的 `planPayload` 和现有目标摘要 `data`。Json 使用固定版本 DTO，保存每个平台 POST/REPLY 的已验证账号、绑定来源及目标账号快照；客户端只能提交账号标识，快照由服务端构造。executionRoutes 名称保留，但只表示业务账号路由，不保存终端 ID。

LLM 不生成账号 ID、节点 ID或权限信息。计划内容生成与执行选择分开：内容可以先生成，但所有启用的执行操作在排队前必须完成绑定。提前选择时，生成前保存执行快照，materialize 时传给 Post，重复 materialize 不能重置用户已经编辑的路由。

当前 `create` 的内容幂等条件保持 project/日期/平台。改变执行账号不应重复收费生成同样文案：命中已有计划且请求路由不同，返回该计划并要求显式调用执行路由更新接口，不能忽略不同路由，也不能因重试悄悄改计划。执行更新带 `expectedRevision`，仅影响未排队、未开始的指定内容；已排队任务遵循单独重新绑定流程。

自动reply首版以ProjectSendBinding的REPLY账号为执行默认。计划提前选REPLY账号只保存“建议执行账号”快照；生成、保存、更新草稿或重试计划均不得修改project默认绑定。保存未来计划不会影响当前自动回复。

需要应用计划建议时，用户明确调用现有POST /projects/:projectId/automation/replies，携带accounts里的integrationId和该binding的expectedRevision；计划启用界面可提供独立的“应用建议回复账号”选择，默认不应用。该操作显示会影响随后新生成回复、不会改绑已有QUEUE；失败返回版本冲突并要求重新读取。计划status更新不承担隐式账号配置副作用。

计划控制目标/节奏，当前project默认决定新回复身份；旧计划快照不覆盖后续automation配置。首版不支持同project多个计划并行指定不同实际回复账号；要支持需另定义明确的plan执行归属。与POST快照不同，计划REPLY字段是建议，不是假称会被每条回复执行的承诺。

### 4.6 Post：具体发送任务的唯一绑定

保留 `integrationId`、`providerIdentifier`、`publishMethod`；新增：

- 不增加提前绑定的 `extensionNodeId`：未领取任务不指定执行终端；领取后的 ExtensionSendAttempt 保存终端，历史可通过 attempt查询。
- `sendTarget Json?`：版本化目标身份快照，含平台、Integration ID、可比账号 ID 的命名空间、handle、必要的发布 actor 信息。
- `routeRevision Int`：路由改变的版本；与内容修改版本共同用于发送授权。
- `contentRevision Int`：内容、媒体、目标 URL 或 thread 结构变化时递增；SENDING/RECONCILING 期间禁止改动，RESERVED 期间编辑必须撤销旧 attempt 并失效旧许可。
- `sendBlockCode?`：展示当前无法执行的原因；不新增 Post.state 枚举。
- `executionProtocol`：服务端写入LEGACY或ACCOUNT_BOUND_V1，区分旧任务和严格任务；客户端不能设置或降级。灰度后新排队任务使用严格协议，nullable旧值仅在迁移期按LEGACY处理。
- `sendOrigin`：服务端根据真实producer写入MANUAL或AUTOMATION，区分用户明确发送/预约和自动回复；客户端不能伪造。不能用source=engage、是否AI文案或QUEUE状态推断该来源。

`providerIdentifier` 从选定 Integration 得到，不再靠 organization 里是否存在某类账号推断。计划的 canonical platform 与执行 provider 明确映射：例如 `linkedin` 不等于插件具有 `linkedin-page` 发布能力。公司页面需要页面 actor ID 和明确能力验证；首版插件若不支持则返回 `NODE_CAPABILITY_UNSUPPORTED`，不能退成个人账号。

Post 根节点与整个 thread 使用同一账号和路由版本；领取后整个 attempt 固定一个终端，不逐段重新匹配。reply 仍经 EngageSentReply 关联 Post，统一使用这些字段；metrics 与历史继续读取 Post.integrationId。已确认历史不得因项目配置改变而改写。

普通post也需要**创建/排队请求幂等**：当前内容ID/group编辑和每Post唯一attempt不能防止POST /posts超时后重试创建两个root。新增可选requestId；严格模式中会新建并排队root的请求必须提供稳定requestId，或先保存有确定ID的DRAFT再按该ID预约。持久化请求记录以`organizationId + authenticatedProducer + operation + requestId`唯一，保存规范化请求摘要及返回的root/group ID；相同键和摘要返回原结果，不同摘要返回409。批量子项使用稳定itemKey，重复排队同一root/版本幂等。历史客户端的LEGACY草稿/发送兼容保留，严格队列缺键时明确报错，不假称已有group能防创建重试。

请求幂等不按文本或内容hash跨任务去重：用户明确再次发布相同内容仍可使用新键。计划materialize使用plan/content-slot键，周期发布使用原任务/周期键，安全重试复用原业务任务；账号改绑和内容编辑递增版本，不以新Post绕开未知结果。

### 4.7 ExtensionSendAttempt：领取与真实发送分开

为Post与reply共用发送尝试记录：`id, organizationId, postId, replySendIntentId?, extensionNodeId, integrationId, routeRevision, contentRevision, sessionRevision, leaseTokenHash, leaseExpiresAt, fencingVersion, state, startedAt, lastProgressAt, settledAt, actualAccount, outcome, result`。postId指root或单条reply；thread按Post ID保存分段结果。发送前持久化请求内容摘要、目标external post ID、目标actor与确定性request key。每个segment还保存permitId、submitBefore、执行确认及提交证据，见§7.4。

状态：`RESERVED → SENDING → SUCCEEDED / FAILED_FINAL / RECONCILING`；RESERVED 过期或在开始前被撤销则进入 `EXPIRED / CANCELLED`。明确未触发平台提交的失败可以安全终止并允许新 attempt。每个 root/reply 最多一个活动 attempt，用部分唯一索引或等效事务约束；旧 attempt 永久保留，fencingVersion 单调递增。

租约不再塞进 `Post.releaseId`。该字段恢复只表示真实平台发布 ID，新协议使用独立 attempt 租约。Temporal/API保留独立执行者和凭证，不借用节点attempt；但同账号的账号写状态、业务意图和硬额度必须共用，不能将“执行方式独立”理解为API不受并发保护。详见§8.2。

需要这一小层状态的原因是：只校验成功回调的 lease，挡不住旧节点已经发出平台请求。必须在平台副作用发生前授权；进入 SENDING 后发生超时属于结果不确定，不允许租约到期自动再次发送。

### 4.8 ReplySendIntent：跨Post的业务回复幂等

Post/attempt ID只标识记录和执行次数，不足以防止两条Post发送同一业务回复。新增ReplySendIntent，包含`id, organizationId, projectId, canonicalAccountKey, opportunityId, kind, occurrenceKey, postId?, status, createdAt`；唯一键为`(organizationId, projectId, canonicalAccountKey, opportunityId, kind, occurrenceKey)`，postId若存在则唯一，指向该意图的唯一可发送Post。

默认`kind=PRIMARY, occurrenceKey=""`，表示同project/目标账号/opportunity的默认回复。人工默认回复与automation共用它；不同project或不同账号保留独立意图。显式人工追加使用`kind=ADDITIONAL`及客户端幂等键，重复同一请求不能生成不同意图。automation不使用ADDITIONAL绕过防重。

账号已绑定的保存/生成流程原子获取或创建PRIMARY意图；未绑定草稿可以保存，但排队前必须归入意图，若已有另一条可发送Post则返回REPLY_INTENT_CONFLICT及有权限可见的已有记录，不各自创建attempt。自动生成先预留意图再扣生成额度；遇到人工DRAFT不覆盖、不转换成自动QUEUE。人工编辑、自动生成、API发送、插件发送和批量项共同经过该意图服务。

同一意图的安全重试复用intent和Post，新建attempt；SUCCEEDED保持防重，UNKNOWN保持阻塞，FAILED且确认未提交可重试，不能通过新Post ID绕过。成功/失败/人工补录/平台移除更新同一意图状态，历史不删除；外部人工发送确认必须如实记账，重复已发生的事实记录为冲突证据，不伪装成系统成功防重。普通post使用§4.6请求/任务幂等，不套用回复opportunity键。

意图中的opportunityId使用服务端解析后的canonical EngageOpportunity.id，不使用项目state ID、URL字符串或客户端别名。旧claimOpportunityForReply的项目机会状态保留为展示/流程汇总；它不再是严格发送互斥锁，也不能在一个账号已SCHEDULED/REPLIED后阻止另一个已授权账号的独立意图。候选选择、API及批量方法同步按账号意图判断，DISMISSED/EXPIRED、目标删除/禁回等机会有效性规则仍保留。cancelAndSendNow改为检查并安全取消旧执行、复用同Post/意图再排队；SENDING/UNKNOWN/部分发送不得删除旧Post或重置机会后新建发送。

意图状态至少区分GENERATING/RECOVERING/DRAFT/QUEUED/SENDING/SUCCEEDED/FAILED/UNKNOWN/CANCELLED；生成阶段保存generationTaskId、generationRevision、ownerTokenHash、reservationExpiresAt及modelStartedAt。获取唯一键不等于获得生成权：只有成功预留owner的producer可调用LLM，其他调用返回已有草稿/处理中；人工保存遇到有效GENERATING/RECOVERING不抢占并覆盖。所有保存Post/入队/状态修改校验ownerToken和generationRevision。

超时接管先以旧ownerToken/版本/到期条件CAS，将意图原子转RECOVERING、递增版本并授予恢复owner，立即失效旧producer保存与排队权；不能先退额度再失效旧owner。恢复owner再通过原generationTaskId幂等结算/释放预占，费用流程不放进长数据库事务。确认原生成及计费状态收敛后才用新taskId创建新预占、进入GENERATING和调用LLM；结算失败保持RECOVERING，不能继续生成或重复扣退。模型已调用但结果/费用未知时不得仅因超时退费并再次生成。

旧owner晚到结果只可作为原task的usage/结果审计证据提交给幂等结算服务，不获得写Post、排队或扣退额度的权限。若生产者仍持有效owner，明确生成失败/取消由CAS退出GENERATING至FAILED/CANCELLED，并通过原taskId结算；若已保存草稿则保留DRAFT。恢复owner本身超时可再次CAS接管RECOVERING，重复执行同一task结算不产生重复副作用；没有证据收敛时展示待核对原因，不留下无解释的GENERATING。

账号改绑未开始回复时，必须原子检查并转入新账号意图，终止旧意图的未发送占位；目标账号已有PRIMARY则拒绝。SENDING/RECONCILING或已发送意图不可这样转移。历史多条重复回复先核对并保留事实，升级后不把重复Post同时入队。

## 5. 统一绑定解析与权限

增加 `SendBindingService`，所有 producer 和 executor 使用同一验证逻辑，避免 plan、post、reply、automation 各实现一套规则。

对未固化任务，解析优先级为：显式单条选择 → 本次计划的 POST 执行快照（如果是计划 post）→ project 当前默认绑定。已固化任务只读自己的 route；不会重新解析默认值。reply 默认读取 project REPLY 绑定，规则见 §4.5。

保存/排队验证：调用者/project 权限 → 账号租户与平台 → 实际 IntegrationProject 关系及开关 → 目标身份快照完整。账号已授权但暂未登录任何可用终端时也允许排队，返回等待状态。领取/开始再验证当前终端登记者权限、终端租户、撤销状态、在线会话与操作能力；API 发送则使用其独立凭证规则。

保存账号及其目标快照一次完成，请求携带 `expectedRevision`，并发修改返回 409。客户端业务 DTO 不接受 extensionNodeId；终端选择是领取事务的职责。同租户且登录了相同平台账号不意味着有权执行所有 project：必须检查当前终端登记者的有效角色/project权限，不能单靠 NodeSession匹配授予权限。

### 5.1 首版权限粒度与现有代码对应

首版不新增用户级project ACL，文中的“project执行权限”具体指：当前用户是该organization有效成员，具有对应发送功能权限，ProjectValidationService确认project属于该organization对应AIsee owner且有效，账号已通过IntegrationProject分配到该project。registeredByUserId使用认证中间件解析出的本地User.id，不使用客户端传入用户ID；ProjectValidationService的ownerUserId不是终端登记者ID。

角色规则必须显式配置：普通有效成员可登记/管理自己的终端并执行上述已授权任务，organization管理员可命名/撤销本组织终端；任何角色都不能借用另一用户终端凭证执行。账号/project绑定修改沿用该功能的授权规则。新增节点管理/发送操作使用能力guard，当前PoliciesGuard/PermissionsService中的套餐和额度检查不能代替成员身份与角色验证。

后台claim/start没有request.projectId时，也根据任务projectId调用同一归属/有效性检查。成员退出/终端撤销从本地当前数据拒绝执行；外部project有效性查询失败则暂停，已有ProjectValidationService的短缓存意味着外部停用有有限延迟，不能宣称即时取消。成功结果回传属于已发生事实结算，不把project失效当成丢弃结果理由，仍要求attempt节点认证或受限核对授权。

如果以后需要组织成员只能访问部分project，再新增用户级project ACL及userId维度缓存；不能将该未来能力写成现有assertProjectAccess已支持。

## 6. 各业务流程的行为

### 6.1 Operation plan

1. 展示每个平台 POST、REPLY 的 project 默认账号及当前可执行状态，支持提前修改账号；关联终端作为只读说明，不提供必选终端下拉框。
2. 生成请求接受执行选择，由服务端校验并保存快照；LLM只处理运营内容。未选完整也可生成内容草稿，返回UNBOUND状态；生成/保存不修改project默认回复账号。
3. materialize 将 POST 路由写入每条新 Post 与 thread；重复 materialize 保留现有内容编辑和路由选择。
4. automation 自动 commit 必须经过统一绑定校验。缺少 route 的 post 保留 DRAFT，返回逐项失败，不能成为“随便哪个浏览器都可以发”的 QUEUE。
5. 调整计划发送账号无需重新生成文案；明确显示更新影响的 DRAFT 数量和不能更新的已排队/已发送数量。

### 6.2 Post 编辑、立即发送、预约与批量发送

编辑器提前选择账号，保存时固化。预约与立即发送共享相同校验；立即发送只是 publishDate=now 的队列任务，由持有该账号有效会话的授权终端自动领取。当前网页未安装插件也可以提交任务；无可用终端时显示等待，不换成其他社交账号。

如保留同浏览器桥接快速发送，网页只传任务 ID与唤醒提示，插件仍走后端 claim/start，不能仅凭网页传来的文本直接发送。收到唤醒的插件只有在本终端会话匹配目标账号、权限有效且赢得 CAS 领取时才能执行；避免网页广播导致多个插件发送。

批量接口返回逐项结果；一个任务缺失绑定不影响其他有效任务。thread 以根节点为一个发送单元，子节点继承同一 route。

### 6.3 Reply 草稿、立即发送与 automation

SaveDraftDto 支持提前选择账号；没有选择可保存 DRAFT，但点击发送/预约前必须完整。所有平台统一账号选择，不让非 X 平台默认使用当前网页所在浏览器的任意身份。前端展示所选账号关联的终端及发送可用性，不提前绑定终端。

手动插件发送将同一草稿转为QUEUE并写sendOrigin=MANUAL，再由节点claim/start；自动producer写AUTOMATION。保留AI生成、编辑、计费和已发送记录，人工明确发送AI草稿仍是MANUAL。现有sendReply/scheduleReply/batch实际上硬编码api，DTO也没有publishMethod；新增可选字段，省略仍按旧api语义，显式extension才进入回复队列。API与extension共用意图，响应继续区分已确认与QUEUED，同一回复不能同时走两种执行方式。

同步修改startWorkflow及执行入口：以持久化publishMethod和任务类型判定，EXTENSION回复交给reply-due，EXTENSION普通post交给publish-due，均不得启动Temporal；API交给API执行器，不被任何插件due返回。source=engage仍可用于业务归属，不能继续将所有Engage任务强制判成API；publish-due仍排除reply，避免把评论发成新帖。数据库读取/路由判定失败时不启动另一发送路径，严格任务等待重试读取。方法切换仅限明确未开始任务，原子取消旧执行及版本化重排；工作流terminate或HTTP超时不等于平台请求已停止。

批量回复逐项持久化意图/Post/执行记录，再触发各项外部发送；当前batchSendReply在后项失败时删除前项Post并回滚机会的逻辑不能用于已发送或未知项。已确认项保留事实与计费事件，未知项保留保护，明确未开始项可安全取消；不因整批请求失败重新发送整批。各接口原有成功数组/对象包装按§7.6保留，逐项失败/处理中信息使用原本支持的字段或任务/意图查询展示，不为新增机制统一重包所有旧批量响应。

automation 新回复在扣生成额度前检查 project REPLY 账号绑定完整且授权有效，并检查是否至少有一个具备操作能力、身份匹配且有 project 执行权限的可用终端；所有匹配终端不可用时首版暂停新增自动生成，避免持续生成积压。这个检查不预占或固定生成后的执行终端，实际生成完成后仍须 claim。人工生成草稿、手动预约已有内容可离线进行。

`queueAutoReply/upsertDraft`通过ReplySendIntent服务把账号、意图及QUEUE原子保存，默认人工回复和自动回复不能各自创建一条可发送Post。新生成和已有QUEUE都经同一claim；消除_draftOne直接返回未领取回复的特殊路径。生成完成时再验证binding版本；配置已改变则保留草稿并说明，不用旧检查结果直接排队。

### 6.4 Automation 设置

overview在publishing/replies各平台项追加accountBinding及通道状态，不另起postBinding/replyBinding同义结构。既有POST publishing/replies保存accounts，账号与开关在同一事务写入，随后commit逐项返回；accounts-only保存不触发原平台集合变更、对齐或commit。

启用的执行平台必须有完整账号绑定，已有无绑定配置可以读、关停、补绑定，但不能继续派发。仅修改策略时保留绑定；清除某项绑定必须显式操作，并禁止在仍开启该操作时清除。切换 project 后重置页面选择和缓存；下拉列表只列项目已分配账号，在账号项中展示关联终端和可用状态。账号列表采用平铺 API，页面的发布窗口/回复策略仍可按平台组织；不要求将所有业务 API 都改成相同布局。

## 7. 插件领取、执行与回传协议

保留现有 `/posts/publish-due`、`/engage/reply-due` 路径并统一升级为带节点认证的协议；不将前端发送的 nodeId 当成身份。下面接口/字段为建议契约，均尚未实现。

### 7.1 登记与会话

```http
POST  /extension/nodes/register
GET   /extension/nodes
POST  /extension/nodes/save
POST  /integrations/extension-session
PATCH /integrations/extension-session    (existing compatibility entry)
```

register 需要当前用户的合法 organization 权限，返回 `nodeId` 和一次性可见 node secret。节点调用使用当前 AIsee access token，加 `X-Extension-Node-Id`、`X-Extension-Node-Token` 与协议版本；服务端检查 node secret 摘要、credentialVersion、租户、当前 userId 与 registeredByUserId 一致、撤销状态及权限。Web 账号管理请求不携带 node secret。

POST nodes/save使用`{ id, expectedRevision, name?, status? }`管理已登记节点；首版status只允许ACTIVE→REVOKED，撤销无法直接恢复，重新登记走受限流程。登记/发密钥与普通展示字段保存分开，save不修改organizationId、registeredByUserId或credential。命名/撤销由统一角色规则校验，重复同一操作幂等；不为这两种修改再分别增加PATCH/revoke接口。

会话上报按认证节点写入自己的 NodeSession，增加报告序号和平台能力。不能更新其他节点会话，也不能凭请求里的任意 integrationId 指定当前身份。

新版使用POST同路径，既有PATCH保留，两者调用同一会话保存服务。逐平台结果返回integrationId?、registrationStatus=EXISTING/CREATED/LIMIT_REACHED/IDENTITY_UNRESOLVED/NOT_APPLICABLE、sessionRevision及verificationExpiresAt。登出或无账号观察时为NOT_APPLICABLE；platforms:[]仅更新已认证节点心跳，不清会话。账号额度不足不拒绝整批报告，也不阻止已有账号刷新。严格请求携带§4.3观察契约；旧payload按兼容模式记录，不产生严格可执行会话。

响应追加results数组，legacy字段保持。旧PATCH读不读response body的行为不变；POST/PATCH切换不决定授权强度，决定因素是服务器协议模式、节点认证和持久化任务标记。不能把POST无条件当新版、PATCH无条件当旧版来绕过校验。

服务端相同报告序号/请求ID只返回原处理结果，不新增账号、不刷新身份有效期。注册节点和保存社交账号是两种操作：register只发节点凭证，不创建社交账号；平台会话上报继续承担已授权账号发现/登记。

### 7.2 绑定与项目 API

```http
GET  /projects/:projectId/automation
POST /projects/:projectId/automation/publishing
POST /projects/:projectId/automation/replies
POST /projects/:projectId/operation-plans
POST /projects/:projectId/operation-plans/:id/execution-routes    (new)
```

前四个接口已存在，直接扩展；最后一个POST仅用于不重新生成的执行快照编辑，与现有复数operation-plans路径及project scope一致。请求带expectedRevision及明确受影响草稿选择，核对plan确实属于路径project，禁止借本接口调用LLM/重复扣费。业务账号使用integrationId，不接收extensionNodeId；目标快照由服务端创建。

automation overview在各平台追加`accountBinding: { integrationId, revision } | null`和通道状态，统一承载默认账号读取。publishing/replies DTO新增可选accounts增量映射；POST保存同时支持创建默认选择和修改已有选择，无需再新增send-bindings读写接口。示例为replies只更新账号：

```json
{
  "accounts": {
    "x": {
      "integrationId": "account_x1",
      "expectedRevision": 0
    }
  }
}
```

每项expectedRevision=0表示当前没有绑定，否则必须匹配既有revision；配置冲突返回409。省略accounts或某平台保持不变，显式integrationId:null才清除，并校验该操作已关闭。原platforms/policies的完整替换语义继续只作用于平台开关/策略，不能因旧客户端不认识accounts而清掉账号选择。

publishing DTO将platforms放宽为可选，仅为支持accounts-only保存；旧请求明确发送platforms时行为不变，显式[]仍表示关掉全部发布平台。省略platforms时保留当前平台集合，不生成自动commit或停用事件；其他开关/commit字段若显式提供，仍按已有规则处理。replies允许只提供accounts而不报Nothing to update；仅账号保存不自动打开reply/scan/master开关。

accountBinding的写入与本次策略修改在同一事务校验；后续队列commit仍逐项返回结果。账户配置中断与队列提交失败不能伪装成整体成功。旧客户端未提供版本字段的纯开关/策略保存保持旧校验，但绝不能覆盖默认账号；新增账号修改必须提供版本。

现有 create post、save draft、automation DTO 增加可选账号绑定输入；新协议的 extension 排队操作要求完整账号与目标快照。前端拿到账号、routeRevision、发送状态和只读终端信息，不返回密钥。

#### 社交账号列表：平铺返回，前端按平台组织

扩展现有 `GET /integrations/list` 的 `{ integrations: [...] }` 响应，复用既有账号字段，每项增加 `sendAvailability` 和 `terminals[]`。不要改成 `{ x: [...], reddit: [...] }`，不额外提供后端平台分组结构。

字段名必须沿用实际 API：Integration 内部字段是 providerIdentifier，但现有 controller 对外使用 `identifier`，账号主键为 `id`，展示 handle/profile 为 `display`。因此本接口保留 `id/identifier/display`，不新增同义的 integrationId/platform/handle/providerIdentifier。任务 DTO 仍使用已有 integrationId 名称；内外字段映射由服务端明确维护。

示例以下只展示既有字段子集和新字段，未展示的既有字段继续保留；接口不会按照示例删减当前响应：

```json
{
  "integrations": [
    {
      "id": "account_x1",
      "identifier": "x",
      "display": "x1",
      "sendAvailability": "AVAILABLE",
      "terminals": [
        {
          "terminalId": "terminal_1",
          "name": "办公电脑 · Chrome · 运营A",
          "browser": "chrome",
          "connectionStatus": "ONLINE",
          "sessionStatus": "VERIFIED",
          "lastSeenAt": "2026-10-14T03:00:00Z",
          "verifiedAt": "2026-10-14T02:59:50Z"
        }
      ]
    },
    {
      "id": "account_x2",
      "identifier": "x",
      "display": "x2",
      "sendAvailability": "WAITING_FOR_TERMINAL",
      "terminals": []
    }
  ]
}
```

`terminalId` 是 ExtensionNode.id 的展示 DTO 名称，不是另一套实体。terminals[] 可含多个终端，表示当前或尚未被明确登出/切号的最近匹配会话；离线或未知不表示仍可发送。已确认登出/切号时，从原账号的 terminals[] 移除当前关联，历史仍保留在审计记录中，不能继续显示“已登录原账号”。

终端字段语义：

| 字段 | 规则 |
| --- | --- |
| `name` | 用户可编辑终端名，缺省名称使用浏览器类型加短 ID；不猜测无法读取的电脑/Profile名称 |
| `browser` | 插件上报的浏览器类型，仅用于展示，不作为唯一键或授权证据 |
| `connectionStatus` | `ONLINE / OFFLINE / REVOKED`，根据服务端心跳有效期和撤销状态计算 |
| `sessionStatus` | `VERIFIED / STALE / UNKNOWN`；VERIFIED 必须身份匹配且核验未过期，旧成功记录不能无限维持 VERIFIED |
| `lastSeenAt` | 服务端最后接收该终端心跳时间 |
| `verifiedAt` | 服务端最后一次接受新的现场身份核验的接收时间，可为null；UNKNOWN、缓存包装、重复probeId或普通心跳不能刷新；有效期仍以verificationExpiresAt为准 |

账号关联视图可以展示经权限允许的离线/撤销终端；撤销项仅作诊断，不参与可用性计算。没有关联时返回 terminals: []。身份登出/不支持的原始状态由终端详情提供，不把已登出的终端冒充当前登录关联。

sendAvailability由后端统一计算，描述所请求操作的插件发送通道可用性。先过滤掉无执行权限的终端，再按以下顺序归并，多终端混合故障也使用同一规则：

1. 账号或项目关系被禁用 → ACCOUNT_DISABLED。
2. 存在未撤销、在线、会话匹配且新鲜核验有效、具备所需操作能力的终端 → AVAILABLE。
3. 没有未撤销且在线的授权关联终端 → WAITING_FOR_TERMINAL。
4. 有在线授权关联终端，但其中没有该账号的新鲜有效核验会话 → SESSION_UNVERIFIED。
5. 有在线、新鲜有效核验的授权关联终端，但全部缺少所需操作能力 → CAPABILITY_UNSUPPORTED。

例如一个终端离线但曾VERIFIED、另一个在线但STALE，结果为SESSION_UNVERIFIED；一个在线且核验有效但不支持操作、另一个离线且支持，结果为CAPABILITY_UNSUPPORTED。terminals提供逐终端原因，任何终端完整满足条件时都优先返回AVAILABLE。

organization账号管理继续用GET /integrations/list，表示允许查看的组织账号与通道状态，不代表某project已分配。项目账号选择复用GET /integrations/integration-project/list?projectId=...；回复参与管理复用GET /engage/reply-accounts?projectId=...，后者仍保留原数组及既有字段命名，不强制转换成organization列表的包装。三个接口共用终端投影/可用性计算，不复写三份匹配逻辑。

项目列表可增加可选action=post|reply及平台过滤，action省略默认post，reply使用IntegrationProject.engageEnabled并只返回授权账号；这些参数为拟新增，当前实现尚未支持。sendAvailability固定表示extension通道，OAuth/API状态保持已有字段。按每个接口的真实organization/project/user上下文检查终端执行资格，organization列表不虚构用户级project ACL。平台分组由前端完成，不能改变现有返回包装或账号字段来实现分组。

AVAILABLE 是读取时的通道快照，不保证任务现在就会提交；具体任务还受 publishDate、automation开关、配额、账号节奏及发送前重新授权约束。前端直接展示后端的状态，不自行用时间戳推导另一套发送资格。平台过滤由后端按需提供，平台分组/排序/折叠由前端按 identifier处理。

账号管理页、账号选择器显示终端名称及状态；任务详情显示账号，并在领取后显示实际执行终端。`GET /extension/nodes` 则按终端展示其平台会话，用于诊断和管理。两种视图共用 NodeSession及可用性服务，不维护第二套手工关系。账号与终端查询均执行 organization/user/project权限校验，不能通过账号 ID读到其他租户的终端；不会返回节点 secret、OAuth token或cookie。批量加载当前页账号关联，避免每个账号调用一次终端接口。

### 7.3 Claim：按社交账号自动匹配执行终端

插件用认证终端身份请求 due；服务端从该终端的有效 NodeSession识别可发送账号，再筛选目标 integrationId匹配的到期任务。账号可能对应多个终端，首版不设固定首选终端；符合条件的轮询者竞争同一任务的 CAS，只有胜者创建活动 attempt，并在该 attempt固定 extensionNodeId。执行选择不是账号随机轮换，也不是用户提前指定终端。

保留 `{ due, pacing }` 响应结构，任务统一新增：

```json
{
  "postId": "post_a",
  "projectId": "project_a",
  "integrationId": "integration_x1",
  "extensionNodeId": "node_n1",
  "routeRevision": 3,
  "contentRevision": 2,
  "sessionRevision": 5,
  "attemptId": "attempt_a",
  "preflightChallenge": "opaque_challenge",
  "leaseToken": "opaque_secret",
  "leaseExpiresAt": "2026-10-14T03:05:00Z",
  "fencingVersion": 1,
  "targetAccount": {
    "id": "123456",
    "idNamespace": "x.rest_id",
    "handle": "x1"
  }
}
```

Post 保留原 `id/platform/segments` 等字段；reply 保留 `sentReplyId/opportunityId/url/text`，增加其关联 postId 和同一套执行字段。

claim返回contentRevision、sessionRevision和第0段的preflightChallenge/challengeExpiresAt。挑战绑定attempt、segmentIndex、fencingVersion及认证节点；插件现场探测后，用新probeId、实际观察时间、证据种类及challenge上报会话，再以服务端确认版本调用start。同身份持续VERIFIED的新证据不递增sessionRevision，更新核验时间；缓存/重复报告不延期，UNKNOWN恢复VERIFIED递增版本。start原子消费已被现场证据确认且未过期的本段挑战，不能自行猜版本或复用其他任务/段的挑战。

候选查询和 CAS必须约束 organization、目标 integrationId、routeRevision、内容版本、project/账号授权、当前终端登记者执行权限、完整发送身份、状态、到期时间和活动 attempt条件。创建 attempt时固定认证节点及 sessionRevision；start再校验当前会话，防止读取与领取之间的切号。不能先按 organization 抢占，再在内存里过滤账号不匹配的任务。严格节点身份缺失时返回授权/协议错误，不回退无账号约束的 organization池。

reply还校验ReplySendIntent的唯一可发送postId和状态，并在claim/start事务中锁定同一意图；不能只按postId防并发。候选查询不满足权限/身份就不创建attempt，数据库活动意图和活动attempt约束共同防止两Post、两节点竞态。

严格reply-due分两个持久化来源lane：MANUAL按用户scheduledAt/发送指令、账号授权、project有效性及既有业务额度/账号安全节奏领取，不依赖autoReplyEnabled或automation master；AUTOMATION另受master/reply开关及自动策略约束。不能直接沿用getAutoReplyConfigs先过滤整个项目，再让手动QUEUE消失。两lane共用意图/attempt防重；LEGACY来源不明确时保持原池或隔离核对，不能只凭QUEUE/engage猜测为手动以绕开开关。

未匹配身份、离线、撤销等原因不消耗领取租约。状态/计数接口分别提供“该节点可执行”和“该 project 等待”，只读操作不能 claim。

新版due增加可选requestId，严格领取要求提供；以组织/认证节点/领取操作/requestId持久化请求回执和候选结果，原样重试只返回原attempt集合，不额外领取。claim响应丢失不会令重试再占一批任务。租约密钥只存摘要不足以重放领取回执，需短期加密保存可恢复响应或采用等效安全重放机制，过期后只返回已过期状态；不得记录明文密钥到日志。该回执重放只恢复RESERVED领取信息，**不恢复start的提交许可**；start重复请求仍按§7.4只读返回现状。普通GET不得公开leaseToken/可重放submit许可。

尚未领取的任务不持有终端，可随在线会话变化自动匹配。RESERVED过期/撤销且确定尚未开始时可由另一个匹配终端新建 attempt；进入 SENDING/RECONCILING 后禁止自动切换终端重发，先按 §7.5核对结果。任务目标账号始终不变。

### 7.4 Start：平台提交前再次授权

```http
POST /extension/send-attempts/:attemptId/start
POST /extension/send-attempts/:attemptId/renew
POST /extension/send-attempts/:attemptId/segments/:index/preflight
POST /extension/send-attempts/:attemptId/segments/:index/start
POST /extension/send-attempts/:attemptId/outcome
GET  /extension/send-attempts/:attemptId
POST /extension/send-attempts/:attemptId/stop-confirmation
```

插件获得本地 write gate 后，在实际提交页面验证当前 actor。身份匹配以平台专用规则处理：同命名空间的稳定 ID 优先；只有确实缺少可比 ID 且 handle 可可靠验证时才用规范化 handle。稳定 ID明确不符时不能靠同名显示信息放行；LinkedIn 的 OAuth sub 与浏览器 ID 不同命名空间时不能简单比较字符串。公司页面另验证 actor。

未知、登出、探测失败、能力不支持均停止在平台提交之前。允许先开页面做核验，但不能先点击发送再探测作者。post 复用并加强现有 account-guard，reply 共用同一规则；自动发送与人工点击均适用。

start 带 leaseToken、fencingVersion、route/content/session revision 和现场实际身份。服务端重查 project、授权、节点、route、内容版本、会话、租约、配额及账号写锁，在一个事务中 CAS `RESERVED → SENDING`，持久化发送指纹，再给一次发送许可。只有首次成功的 transition 可授予发送许可；start 重试如果已经 SENDING，只能返回已有状态，不得再次授予可发送的许可。

start成功返回一个segment的短有效期许可`permitId, submitBefore, serverNow, attemptId, segmentIndex, fencingVersion`，绑定当前节点、账号、内容摘要及新鲜现场证据。submitBefore可配置，例如30秒，独立于RESERVED的长领取租约；已发许可不通过renew延长。这里的一次性是受控插件执行保证，不能声称平台理解服务端permitId。

插件在注入提交操作前持久化许可和执行阶段；页面内最终actor及许可截止时间检查紧邻submit，发送命令不得保存成之后随意重放的消息。每次worker恢复、页面/浏览器唤醒、网络恢复先检查许可有效性与本地执行日志：过期或不确定则停止，不恢复平台提交。使用serverNow校准的时间和本地单调经过时间判断短截止期，时钟异常则停止。

许可收到后在受控操作内立即提交；无法可靠现场验证actor或停止过期命令的poster不发布严格能力。服务端和本地fencing不能撤回已在途的平台请求，也不能完全排除用户在浏览器外部切账号或暂停提交指令的竞态；边界是阻止已知错配及受控重放，并对不确定结果停止重试。

#### 插件必须改造的提交边界

严格模式不能只在runner调用start后原样进入旧poster。每个平台poster/注入脚本都接收permit绑定的attempt/segment/账号/内容摘要及截止期；上传、开页和填表可先准备，最终submit前再次核验actor/许可，CAS占用本地permit执行权并等待提交日志写入完成。每段最多触发一次平台提交，禁止同许可被页面消息、桥接和alarm重复消费；本地执行日志的key包含AIsee owner/node/attempt/segment/permit，worker与页面脚本有一致的消费/去重规则。

日志至少记录PREPARED、SUBMITTING（在可能触发请求前）、CONFIRMED或UNKNOWN及平台证据，采用可等待并校验写入成功的持久化；不能沿用当前queue.persist的fire-and-forget写法。存储失败/满额则不提交。worker重启、脚本失联、fetch/点击超时或普通异常，若已进入SUBMITTING一律按UNKNOWN处理；旧ok=false、error、segmentsPublished=0、neverSent提示本身都不是可靠未提交证据。只有执行适配器能证明尚未触发任何提交且已停止，才报告definitely_not_submitted。UI Retry、retryPublishTask、interrupted-recovery及reply.unconfirmed统一读服务端attempt，仅重报/核对结果，不从本地error直接重放；扫描查无结果不解除保护。

人工桥接/popup发送同样领取和start，不能继续使用unattended=false跳过账号安全间隔。本地compose触发插件实际提交前也应经已有post/reply保存接口建立账号/project明确的任务，再走受控协议；没有合法任务时仅允许填表草稿、由用户在平台页面自主提交，该外部人工行为不在后端协调保障内。thread可释放浏览器本地write gate，让其他账号/读取操作继续，但服务端账号锁不释放，当前账号的下一段仍等待其授权。

若 start 响应丢失，插件不能猜测许可并继续发，也不能重复提交；查询 attempt 状态进入 reconciliation。租约到期后且未进入 SENDING 的 RESERVED，先 CAS 标为 EXPIRED，再创建新 attempt 重新领取，旧 token/fencingVersion失效；SENDING 超时不重新授权，转 RECONCILING。renew 不允许超期旧 attempt 复活。

单条 reply/post 的 start 授权一次提交；thread 的首次 start 只授权第 0 段，并持有账号执行锁。每段维护独立的 `PENDING / AUTHORIZED / CONFIRMED / NOT_SUBMITTED / UNKNOWN` 状态和一次性许可。上一段确认且账号共享间隔已满足后，下一段调用 segments/:index/start，重新验证实际 actor 与权限、预占该段平台写配额，并 CAS 授予该段唯一许可。重复请求返回已有状态，不再次授予提交许可；任何一段许可响应丢失或结果未知均暂停，不继续下一段。账号锁在 thread 等待段间间隔时仍属于该 attempt，不能让别的节点插入发送。

每段许可有独立submitBefore和现场挑战；下一段重新验证，不能将root许可当成无限期thread发送权。上一段confirmed的outcome响应或GET attempt返回nextSegmentIndex和preflightAvailableAt，不产生发送或领取副作用。到达账号段间可执行时间后，插件POST segments/:index/preflight取得挑战；重复请求返回同一个尚未过期且未消费的挑战。挑战过期可在该段仍PENDING时CAS轮换，使旧挑战失效；已AUTHORIZED不得借此重新取提交许可。

插件取得下一段challenge后重新现场探测/上报，再调用segments/:index/start；不得复用root挑战或在间隔等待前取得证据后无限期沿用。preflight只准备核验挑战，不授予提交许可；GET查询只返回状态。许可过期表示不得再开始该段，不证明该段此前未提交；已可能触发submit的状态仍进入RECONCILING。

### 7.5 Outcome：身份、幂等与未知结果

outcome 包含 attempt、当前节点凭证、leaseToken、fencingVersion、实发账号、平台 ID/URL、分段结果及 `confirmed / definitely_not_submitted / unknown`。所有成功、失败、移除、未确认回传都使用这一 envelope，现有 post/reply endpoint 内部适配同一服务。旧版 URL 补录属于人工修复，不能替代新的发送授权。

服务端只接受该 attempt 的节点及预定账号对应结果，不能因为仍持有同 organization token 就覆盖别的节点任务。重复相同结果幂等；已成功的冲突结果返回 409，不覆盖历史。合法 SENDING 或 RECONCILING attempt 的延迟确认结果可以落账，即使普通领取期限已过；其记录和 token 保留用于核对。旧 leaseToken 不要求仍处在普通领取期限，但必须对应这个未被替换的已开始 attempt；结果回传不具备重新授权发送的效果。

结算区分发送结果与后续平台状态：UNKNOWN可单调收敛为CONFIRMED或有证据的NOT_SUBMITTED；较晚重复unknown不能把已确认结果降回UNKNOWN。CONFIRMED后可追加removed/gone、URL/平台ID补录或metrics证据，仍保持已发送、意图成功和COMMITTED次数，不重新扣费、释放次数或创建attempt。移除事件可以发生在SUCCEEDED之后，原节点或受限核对者按历史attempt/segment验证；它不是相互冲突的“第二次发送结果”。相同事件键同摘要幂等，不同摘要返回409并保留证据；已结算NOT_SUBMITTED后迟到成功是安全冲突，按下文冻结核对，不能忽略。

回传账号不符时，记录安全事件与实际平台证据，标为 RECONCILING/需人工处理，不伪装成预定账号成功，不允许自动重发。成功更新 Post、EngageSentReply、分段和现有计费使用幂等事务/事件键，避免重复扣费。

插件必须持久化 attempt 与结果，网络恢复后只重试 outcome，不重试平台提交。thread 每段提交结果在本地持久化，并在继续下一段前报告；已成功部分保留，未知段停止整个任务。不自动重发 root；部分发送后不能修改 thread 路由，人工恢复必须以已确认分段为依据。

thread 的中间段 outcome 只结算该段并保持整个 attempt=SENDING，直到全部段确认才标为 SUCCEEDED、释放账号锁。后续段确定未提交的失败可终止为 FAILED_FINAL 并记录部分成功，已确认段保留已消费配额，其余未用预占释放；任何未知段让整个 attempt=RECONCILING，已消费和该未知段的预占继续保留。

FAILED_FINAL不代表整个thread从未发送；持久化hasConfirmedSegments及各段事实。首版部分thread只提供结果核对/补录，不提供从root重试或自动续发；用户在平台手工补完后可受限记录事实。retryPost、预约和本地Retry必须同时检查分段历史，不能只按ERROR/FAILED状态放行。将来支持受控续发时需要明确从首个未提交段接续及已确认父段引用，不能复用从第0段开始的旧重试。

RECONCILING接受经上述身份校验的晚到确认或受权限保护的人工核对。人工流程记录核对者、证据与结论：确认已提交则补平台结果及结算额度；确认未提交且确认旧执行无法再提交，才终止attempt、释放预占并允许显式新attempt；证据不足继续UNKNOWN。完成最终结算才释放账号锁。已撤销/换用户节点不恢复执行凭证，由受限核对流程导入结果。

人工核对复用POST outcome，增加显式mode=RECONCILIATION及evidence/expectedResolutionRevision；缺省mode=EXECUTOR仍要求原节点/lease/fencing。核对模式使用当前用户身份、独立的发送核对管理能力、持久化组织/project归属、审计及结果版本校验，不要求伪造旧node secret，也不能只靠body中的mode越过执行认证。普通终端无该能力不能自称人工核对；核对模式不发许可或改路由，NOT_SUBMITTED仍须满足下述停止证据条件。GET attempt为有权核对者返回脱敏证据/状态，不返回节点密钥或可重放许可；无需另增公开核对API。

安全重试必须同时满足：旧短许可已失效；旧执行者已持久化停止确认（覆盖该attempt及segment，确认尚未submit、没有待执行页面命令或在途请求），或经人工可验证的等效隔离与平台结果核对；所有相关段有明确未提交/已提交结果。单纯“现在没搜到帖子”、节点离线、账户撤销或等待租约超时都不足以证明未提交。不能确认停止或平台请求仍可能在途时保持RECONCILING，不提供绕过检查的强制重试。

旧执行报告一旦与已核对结论冲突，立即记录完整证据、冻结相关意图/后续attempt并人工核对，不能覆盖已结算结果或自动再发。停止确认接口只返回收敛状态，不授予新发送许可；后端保留所有旧attempt证据。恢复流程及管理界面是上线必要功能，不能只新增UNKNOWN状态而没有处置路径。

本方案保证受控领取和发送授权，不能承诺跨浏览器/平台的 exactly-once。平台没有统一幂等发送接口时，提交后崩溃可能无法知道是否成功；正确选择是停止并核对，而不是用租约到期当作“肯定没发”。

### 7.6 新增API清单与兼容边界

#### 仅新增以下缺失能力

| 新增方法/路径 | 必要性与行为 |
| --- | --- |
| POST /extension/nodes/register | 当前没有终端凭证登记；按安装身份登记，不能复用账号connect来发节点密钥 |
| GET /extension/nodes | 当前没有终端及其会话管理视图；复用会话投影，仍只读 |
| POST /extension/nodes/save | 命名/撤销已登记节点，版本化修改；不混入注册密钥操作 |
| POST /integrations/extension-session | 现有PATCH同路径的新增方法入口；新版账号保存/心跳，业务处理复用现有服务 |
| POST /projects/:projectId/operation-plans/:id/execution-routes | 当前只有计划生成，没有不收费重新生成的执行选择编辑；按project和版本校验 |
| POST /extension/send-attempts/:attemptId/start | 当前status probe只检查已发送，不具备一次发送授权；原子start不可用查询或成功回调替代 |
| POST /extension/send-attempts/:attemptId/renew | 续租未过期的本节点RESERVED；不能重新授予提交许可或延长已发短许可 |
| POST /extension/send-attempts/:attemptId/segments/:index/preflight | 准备下一段现场核验挑战，不授权提交 |
| POST /extension/send-attempts/:attemptId/segments/:index/start | 现场证据验证后逐段授权，不能把root许可覆盖整个thread |
| POST /extension/send-attempts/:attemptId/outcome | 新版统一汇报确认/明确未提交/未知/移除和逐段结果；内部适配原post/reply落账服务 |
| GET /extension/send-attempts/:attemptId | 历史/当前attempt恢复查询，不仅是Post当前状态；不能用getPost当前PUBLISHED推断某段旧attempt已结算 |
| POST /extension/send-attempts/:attemptId/stop-confirmation | 旧执行者停止证据，禁止自动授予重试权 |

其中2个GET、10个POST；extension-session只是增加HTTP方法入口，不新增业务路径。原草案的send-bindings、独立heartbeat及PATCH节点管理接口不再新增。节点和attempt接口的组织身份来自认证，所有记录ID都做归属检查；attempt不能靠body声明另一个postId归属。

leaseExpiresAt只管理RESERVED领取期限；进入SENDING后使用lastProgressAt和独立执行超时规则，有效的分段preflight/start/outcome更新进度，正常段间等待纳入超时计算。不能让旧领取期限到达就中断正常thread，亦不能靠普通renew复活RECONCILING或重新授权已开始segment。

outcome新入口有必要：原post/reply回调字段和状态语义各不相同，缺少段级许可与UNKNOWN处理。新协议使用一个POST统一envelope，避免为每个旧PATCH回调再增加重复POST路径；旧回调仍保留，并进入同一结果适配服务。业务落账、计费、metrics、平台移除语义不复制实现。新版严格result新增attempt/node/lease/fencing/probe和段信息，旧releaseURL/releaseId/segments、reply url/author字段保持对应映射；具体资源由持久化attempt决定，不信任body随意指定。

已有PATCH /engage/sent/:id和PUT /posts/:id/date只在新版编辑器实际使用时加同路径POST别名。未涉及的keywords、tracked-account、group、plug等历史接口保持原方法，不为统一风格进行整库路由重命名。

#### 请求与响应兼容

1. 旧非敏感字段名称、类型、数组/对象包装和省略语义保持；新增DTO字段可选，对严格执行的条件要求由服务端协议模式决定。POST /posts复用posts[].integration.id；不要让旧客户端同时补两个同义账号字段。普通POST upsert不能因为换方法变成追加创建，每个具体接口按已有业务ID/版本/幂等键决定新增或修改。
2. 原publishMethod缺省行为按各现有入口保留；新版UI显式选择extension后才进入该分支，API任务仍走原发送路径且不得被插件due返回。新严格模式需要完整账号时，优先保留已绑定账号或解析已授权project默认；没有合法账号返回SEND_BINDING_REQUIRED，不能为“兼容”退回当前任意浏览器身份。
3. 现有`{ due, pacing }`、`{ integrations }`、reply-account数组和批量scheduled/failed字段不改变；新版新增字段旧客户端可忽略。reply extension排队返回可读QUEUED状态和Post/intent ID，旧API成功返回不被伪装成已确认平台成功；任何新增结果字段不能让客户端误以为排队就是已发送。
4. POST/PATCH同路径入口使用同一DTO解析和服务；新增node headers纳入backend main.ts的CORS allowedHeaders，GET/POST与既有方法全部保留，OpenAPI列出两个入口。不能仅更换method而忘记节点凭证、字段转换或限流设置。
5. 所有可重试POST使用requestId/业务意图ID/报告序号/expectedRevision等对应幂等机制；网络超时原样重试，不因重试换ID。新版上报POST遇到已确认的404/405可退回旧PATCH记录会话；遇到超时/5xx/426不猜测换协议，尤其不能重试平台提交。旧后端不支持节点协议时显示需要后端升级，不声称严格能力可用。

   幂等键与expectedRevision作用不同：版本校验不等于响应丢失后能安全重试。配置/改绑/编辑先检查请求回执，同键同摘要返回原保存结果，再检查版本；未使用幂等键的旧写请求重试遇409时重新读状态，不重复产生副作用。register响应丢失的同键重试只重放受限、短期加密的登记响应；不能为同installation反复创建节点/轮换活跃密钥，回执不可恢复时明确进入受认证的登记恢复流程，并保留旧执行记录供核对。

6. 账号列表明确输出DTO白名单：当前reply-account repository使用Integration对象展开，需核对并去掉token/refreshToken等凭证字段，不能把原始对象展开理解为兼容要求。id/name/profile/providerIdentifier/engageEnabled等客户端所需非敏感字段保留；组织/项目列表各自原包装保持。凭证移除属于明确的安全例外，实施时审计调用方并记录变化，不在新terminals信息中重新暴露它们。

7. 仅按record ID的旧schedule、post/reply编辑/回传入口，使用数据库中的organization/project/account归属完成授权，不能因body省略projectId而跳过；分组批量项分别校验。纯GET的状态追加不会赋予新的修改权限。

8. 插件HTTP传输层同时改造backendCall与fetchRequestUtil，让节点/协议headers真实透传；post-reply的直接fetch及reply.unconfirmed/queue已有backendCall调用统一适配节点和attempt协议。426/版本停止状态只禁止登记新执行、claim/start及平台提交，仍允许通过独立兼容且认证的GET attempt、outcome和stop-confirmation核对已发生事实。后端相应把版本门槛与结果结算协议校验分开，不能用fail-open版本guard放行新发送，也不能让全局升级短路永久丢弃已发生结果。失效用户凭证/已撤销节点仍走受限人工导入，不借结算豁免恢复发送权限。

#### 旧插件与严格任务隔离

兼容不表示允许旧插件执行新账号绑定任务。上线前先扩展schema/服务端，保留旧路径及LEGACY任务池；新版插件登记并以POST上报，待其身份能力验收后按organization/project开启ACCOUNT_BOUND_V1。

POST due在服务端按节点协议和任务executionProtocol选择：无节点认证的旧请求只可能看到尚未关闭的LEGACY池；严格请求只领取完整账号及有效会话匹配的严格任务。关闭某租户旧执行时对旧请求明确返回升级要求；缺version header也不能获得严格任务。不能只用新版客户端header当分池依据，更不能在同一批due中混入两个协议。

既有成功/失败/移除/PATCH回调处理时先读记录协议：LEGACY历史任务按受限旧规则和原字段落账；严格任务无论从POST outcome还是旧PATCH进来，都必须验证其attempt/node/lease/fencing，不允许通过换method或省略字段绕过。人工URL补录仍是事实核对，不改变发送权。

灰度前先停止新旧双派发，核对旧已领取/本地待报告任务，再将确认未开始且已明确选账号的旧QUEUE升级。未知旧结果隔离核对，不自动迁移为可重试新任务。回滚只暂停严格池，不能把它降级给旧插件。支持旧调用方的GET读取、DRAFT保存、已发生结果结算和手工/API路径可以保留，不因严格自动发送限制被一刀切删除。

## 8. 多项目共用账号时的节奏与配额

节点本地 write gate 只保护当前浏览器。一个账号可以在多个节点上登录，因此账号节奏不能只以 `(node, platform)` 或 `(project, platform)` 计算。

保留 project/day 的目标和现有生成额度逻辑；在提交授权时加账号级共享写权限：按 `(organizationId, canonical platform account identity)` 串行化post/reply/thread的发送，记录lastWriteAt、活动执行与不确定状态。使用共享`AccountWriteState`行和Prisma事务/CAS，活动owner包含executionKind=EXTENSION/API及持久化executionId，不只保存节点attemptId；不要通过直接数据库SQL实现或部署。

迁移必须同步替换旧闸门，不能保留org/platform限制后再叠加账号锁。维护明确清单：

| 当前逻辑 | 新粒度/行为 |
| --- | --- |
| getLastPlatformWriteAt(org, platform)、旧claimedAt时钟 | 同canonicalAccountKey的真实发送开始/分段写时钟；RESERVED领取不计为平台写 |
| getFirstSentReplyAt(org, platform)、warmup | 按canonicalAccountKey的已确认发送历史；账号x2不能继承x1的成熟度 |
| account daily cap与在途预占 | 按canonicalAccountKey；多个project/终端共享同一账号预算 |
| countTodayRepliesByChannel及_exhaustedChannels | 账号×社区窗口，保留社区规则；如另设organization总社区上限则作为独立命名策略 |
| project min-gap、plan目标及关键词目标 | 继续按project/platform，缩窄账号规则，不取代账号限制 |
| 插件platform-throttle持久缓存 | 本地按已核验账号身份分区；切号不继承上个账号时钟；服务端账号写锁仍是跨终端权威 |
| Automation overview和reply-queue-status | 与上述新查询使用同一粒度，不能展示旧org/platform推导的等待时间 |

账号日预算使用统一配置的账号timezone或UTC作为账号窗口；各project策略保留自身既有窗口规则：auto-reply的dailyReplyLimit当前按schedule.timezone本地日，API的plan/keyword target当前按UTC日，不能宣称所有旧查询已使用project时区。每个预算维度显式记录timezone/window规则，首版保留对应既有语义；共享账号额度不随请求project改变日边界。生成额度继续按现有计费维度，不能误改成每账号额度。无可靠账号归属的旧历史只进入组织报表/隔离核对，不随意归给当前默认账号；新账号warmup采用保守起始值并说明原因。

**先区分目标与硬额度**：账号/社区安全上限是所有受控发送共享的硬闸门；项目dailyReplyLimit按适用的自动/人工策略独立，MANUAL不因automation关闭而停发。plan dailyTarget/keywordTargets在现有auto driver中是默认关闭的新增生成gate，已排队回复不再次按生成目标领取；API现有_assertProjectDailyTarget却将有效target用于发送/预约准入，缺plan为uncapped。首版分别保持这些lane语义，把规则标为GENERATION_TARGET或SEND_HARD_LIMIT及适用producer，不把生成目标一律改成所有Start的硬上限。实际启用的SEND_HARD_LIMIT才原子预占；生成目标使用生成意图占位，和现金credits、发送次数分别记账。所有新增规则在配置中标明单位、窗口和适用lane，不能悄悄开启ENGAGE_REPLY_BUDGET_GATE_ENABLED，也不能用“已经扣生成费”绕过账号安全上限。

post、reply 和 thread 段共用账号写间隔；reply 日上限、社区上限和 warmup 使用账号归属统计，并保留项目自身更窄的规则。配额预占与 start 原子完成：已发送和在途预占都计入判断，明确未提交时释放，未知结果保持占用直到核对。平台移除仍算真实发送行为，计费是否收取保持既有产品规则。首版不增加 project 间公平分配，但不能声称用“查 count 后发送”已经消除了并发超发。

统计单位明确区分：project 的 plan/post 数量按 root、Engage 回复目标按单条业务回复；平台账号写次数按实际提交段计数，thread continuation 也消耗平台写额度及适用的回复额度。不能把一个多段 thread 当成一次平台写来绕过账号上限。实现时在配置和统计 DTO 中明确每个上限的单位。

账号锁在活动 thread 或不确定 attempt 期间阻止其他节点交错写入；lease 过期不能解除未知发送保护。人工确认结果后再释放，不能仅因节点撤销就自动判定未发送。

### 8.1 同账号多终端与防“双花”机制

这里的“双花”包括重复执行同一次业务发送，以及并发请求重复使用同一份额度；允许多浏览器登录不意味着每个插件各自获得一份任务或预算。首版以PostgreSQL持久状态、Prisma事务、唯一约束和CAS条件更新协调，浏览器本地锁或可选Redis锁仅作辅助，不作为发送资格/额度的最终依据。

| 层次 | 防止的问题 | 权威约束 |
| --- | --- | --- |
| 社交账号登记 | 三个终端为同一账号创建三份Integration | 统一平台身份解析、账号唯一键，三个NodeSession指向同一Integration |
| 业务意图 | 两条不同Post代表同一次默认回复 | ReplySendIntent唯一键及唯一可发送postId；重试复用意图 |
| 任务领取 | N1/N2同时领取同一root或reply | 领取事务与活动attempt唯一约束，仅一名胜者；fencingVersion跨attempt递增 |
| 账号执行 | N1发post、N2发reply同时使用x1 | canonicalAccountKey对应的账号写状态；同账号活动发送/thread串行化，共享间隔 |
| 发送额度 | 两请求均读到剩余1次后各发送1次 | 发送授权事务内创建额度预占，确认发送与在途预占一起计入上限 |
| 结果/计费 | 重复回调重复扣费或重复释放 | attempt/segment/计费业务事件键、状态CAS及幂等结算 |

#### 事务边界

1. **Claim事务**：校验并锁定业务意图及任务版本，原子创建唯一活动attempt并固定节点；败者返回未领取。不调用平台、不消费发送次数，也不把领取时间当成真实平台写时钟。多个不同任务可以处于RESERVED，发送权另由账号状态控制。
2. **Start事务**：外部project核验、页面探测、token刷新等先在事务外完成，事务内重查本地权限/任务/账号/现场证据版本及上述校验的有效期，CAS取得账号执行权，检查预算并唯一预占，消费本段challenge，将RESERVED转SENDING或授权下一PENDING段，持久化请求指纹及一次性许可。任一步失败全部回滚，不返回提交许可。统一按账号状态→任务/意图→执行/segment→排序后的预算键访问相关行；没有账号状态访问的claim/配置事务只获取所需后缀，不能锁意图后反向申请账号状态。懒建预算行也须唯一键与原子upsert/CAS；外部网络调用不进入数据库事务，冲突重试不重复授予许可。
3. **Outcome事务**：验证attempt、节点、fencing及结果幂等键，原子写入对应Post/回复/分段状态及业务意图、结算预占、更新账号进度和可释放状态。同一个结果只完成一次状态迁移，重复请求返回已经结算的结果，不再次扣减或释放。

这里的事务只覆盖本地数据库状态。平台提交和外部计费服务不在数据库事务中；外部计费沿用既有服务，通过持久化结算事件及稳定业务键重试，不能宣称跨服务事务已经实现。确认结果先可靠保存，费用回传失败只重试计费事件，不能重新发送平台内容。生成额度与平台发送次数是不同账本，不混为同一个扣费操作。

#### 额度预占与结算

发送预占需要持久化记录，至少包含organizationId、canonicalAccountKey、intent/post、executionKind/executionId（插件对应attemptId）、segmentIndex、quotaDimension、policyId/version、windowStart/windowEnd、units、state及结算事件键。唯一键包含execution/segment/额度维度/窗口，重复start不能生成第二份预占。账号日上限、社区额度和启用的project执行硬上限各自有预算维度，不能混用生成目标；预占与对应预算版本/CAS检查在同一授权事务完成，不能先COUNT后另行发送。不同账号仍可能竞争同一project/社区/组织预算，必须对所有实际共享预算行排序并原子检查，不能只靠账号锁保护这些维度。

预算bucket唯一键按真实作用域定义：账号为组织/账号/维度/窗口，账号社区额度再含canonicalChannelKey，project额度为组织/project/平台/维度/窗口。policyId/version是审计元数据，不能因请求来自不同project或策略版本变化而另开一份同账号额度；账号硬上限从统一账号策略解析，项目更窄规则另用project预算。root/业务回复数量仅在对应根段预占一次，后续段只预占实际平台写次数及适用的评论额度，不再次消费整条业务数量。

当前countAccountSentRepliesToday/countProjectSentRepliesToday将QUEUE与PUBLISHED都纳入publishDate窗口，不是纯已发送计数。迁移不能把所有旧QUEUE导入COMMITTED，或把它们同时作为count和HELD重复计算；预约准入/积压展示仍可单独统计预计窗口的QUEUE，执行账本只计已确认事实及已获提交授权的HELD。无活动许可的普通QUEUE/RESERVED不占发送次数，start才做权威预占；未知旧任务先隔离核对，不按QUEUE状态猜测未发送。

预算不变量为`confirmedUnits + heldUnits + requestedUnits <= limit`。成功确认将HELD原子转换COMMITTED，held减少且confirmed增加；明确未提交并满足安全停止条件时转换RELEASED；未知结果保持HELD。重复确认/释放不再改变计数，原窗口记录永久可审计。跨日不自动释放旧UNKNOWN预占；新增窗口不能解除账号上仍未收敛的发送保护。预算日界与§8账号timezone一致。

窗口以**服务端本段授权时间**确定，预约时的scheduledAt检查只作准入估算；执行延期到另一日必须重查实际授权窗口。预占保存不可变窗口，晚到确认、跨日结算仍结算原窗口，不能按收到outcome当天再扣一次；额度口径为授权提交次数，平台实际创建时间另作历史事实统计。submitBefore限制为各适用预算窗口结束前的安全截止，跨界还未授权的下一段使用新窗口；已在途请求跨界完成仍保留原预占。timezone/限额修改版本化，已发许可/HELD不改归属；调低到confirmed+held以下时阻止新增授权，保留真实已用/预占和超限说明，不修改账本来伪造不变量。

同窗口限额更新不重建bucket/重置计数；账号timezone变更首版只在旧窗口结束、无活动/未知执行且随后第一个完整新时区窗口开始时生效，过渡空档暂停新增授权，不能创建与旧窗口重叠的新预算来重获额度。上述不变量是新增授权的准入条件；调低上限、迁移补入历史或事后核实外部发送可能产生真实超限，仍须如实结算并阻止新增，不能拒绝保存已经发生的事实。

计数以预占账本为唯一执行权威，不能同时将同一结果的Post统计和COMMITTED预占各加一次。上线时对可确定账号/段/窗口的已发送历史幂等建立COMMITTED基线，与结果重放共用稳定结果键；不确定历史隔离。发生错账号提交时保留目标预算及实际actor证据、冻结相关执行，核对后按实际已发送事实处理额度，不因ACCOUNT_MISMATCH直接释放并自动再发。

platform removal仍计入实际发送次数，收费是否发生沿用既有产品规则。不同project合法独立回复仍消耗同一个账号预算；不同账号x1/x2有各自预算。普通post、reply及thread各维度计量按§8执行，每段只结算自己的一份预占。

#### 多浏览器竞态与故障切换

例：x1在Chrome/N1、Arc/N2、Firefox/N3同时登录。三个终端均可报告会话并参与领取，但同任务只有一个活动attempt；不同任务即使分别被领取，只有取得账号发送权的终端可提交，其他终端等待间隔/执行权，不能因各浏览器本地锁都空闲就同时提交。

RESERVED尚未授予平台提交许可，到期或安全取消后可新建attempt交给其他匹配终端；SENDING已获得许可，超时进入RECONCILING并保留账号保护及未知额度预占，不自动重新授权。账号锁/领取租约到期、节点离线或终端切号都不是“已经发送失败”的证明。

恢复发送必须按§7.5确认旧执行不会再提交且结果明确，安全重试仍复用业务意图。fencing只能拒绝旧节点改后端状态，不能阻止已经在途的浏览器平台请求；插件必须同时遵守短许可截止、持久化执行日志、恢复后不重放submit。平台无统一幂等发送能力时不承诺外部exactly-once，UNKNOWN阶段停止重试就是重复发送保护的一部分。

账户通道AVAILABLE仍只代表有匹配在线会话；账号忙、额度暂时预占或等待结果核对通过已有queue-status/任务详情的阻塞原因展示，不把所有正常登录终端标为离线。账号核对期间可以继续接收心跳/结果报告，但不能发放同账号的新提交许可。

### 8.2 API/Temporal及灰度执行也必须共享保护

一个Integration可能同时有OAuth/API能力和多个插件会话。不同任务的API与插件写入同账号时，共用AccountWriteState、意图、执行硬预算和结算账本；API不需要节点密钥或浏览器probe，使用后端凭证和provider actor核验，但不能跳过提交授权。新增内部ApiSendExecution及分段记录（或等效共用执行表），保存post/intent、工作流执行ID、route/content版本、授权指纹、fencing及确定/未知结果，不新增公开API。节点attempt与API执行分别保留身份模型，共享服务实现账号竞争和额度结算。

Temporal的纯读/预备/结算activity可以幂等重试；postSocial/postComment等外部副作用必须先获取该段唯一授权，已授权或UNKNOWN时重新执行activity只能读状态/核对，不能再次调用平台。平台若有可靠幂等键，按原业务段键使用并核对；没有则请求超时或activity丢响应进入UNKNOWN，禁用现有通用activity及外层循环的自动发送重试。只有确认未提交并旧执行已停止才创建安全的新执行；workflow terminate、retryPost清releaseId、cancelAndSendNow删Post或同任务切到另一发送方式都不能解除未知保护。已有API成功响应和publishMethod缺省保持，保护尚未适配时返回明确等待/阻塞，不静默切成extension。

灰度范围必须按canonicalAccountKey覆盖其所有project、节点、API/Temporal和LEGACY执行。按project开启严格任务可以保留，但同账号旧发送入口必须同步接入共享保护，或先停止领取/提交并结清旧执行；不能一边在A启严格锁，一边让B/旧插件用同账号绕过。已有睡眠中Temporal workflow和插件本地队列也需纳入清单，不只是后台due查询。旧活动发送无法确认时隔离账号核对，不能直接terminate后将它重新放入严格队列。若API适配未完成，首版只启用已确认无API/旧执行旁路的账号，不宣称整个账号已经具有全链路防重。

## 9. 配置变更与失败展示

| 情况 | 任务处理 | 用户可见结果 |
| --- | --- | --- |
| 缺少账号 | DRAFT 可保存，排队失败 | `SEND_BINDING_REQUIRED` |
| 账号未分配到 project / 已禁用 | 不领取，不开始 | `ACCOUNT_NOT_ASSIGNED` / `ACCOUNT_DISABLED` |
| 没有该账号可用终端 | 保留 QUEUE和预约，等待匹配终端 | `WAITING_FOR_TERMINAL`；终端详情区分 OFFLINE/REVOKED |
| 已领取 attempt的节点撤销 / 离线 | RESERVED可撤销/过期重领；SENDING/RECONCILING核对，禁止自动转发 | `NODE_REVOKED` / `NODE_OFFLINE` |
| 节点当前账号错配 / 身份未知 | 不提交，不消费发送额度 | `ACCOUNT_MISMATCH` / `SESSION_UNVERIFIED` |
| 会话过期 / 平台操作不支持 | 等待刷新或更换合法 route | `SESSION_STALE` / `NODE_CAPABILITY_UNSUPPORTED` |
| 路由或内容被并发编辑 | start 拒绝旧快照 | `ROUTE_CHANGED` / `CONTENT_CHANGED` |
| 旧租约 / 旧 token / 旧节点 | 不允许开始或覆盖结果 | `LEASE_EXPIRED` / `ATTEMPT_NOT_OWNED` |
| 提交结果不确定 | RECONCILING，自动发送暂停 | `SEND_OUTCOME_UNKNOWN` |
| 已登录账号因额度未能登记 | 保留本节点观察，允许其他账号继续刷新 | `ACCOUNT_REGISTRATION_LIMIT_REACHED` |
| 账号身份命名空间/别名不能可靠关联 | 不创建猜测关系，不派发 | `ACCOUNT_IDENTITY_UNRESOLVED` |
| 默认回复已有同一业务意图 | 返回已有记录/冲突，不能另建可发送Post | `REPLY_INTENT_CONFLICT` |
| 短发送许可过期 | 本地停止提交；已可能提交者核对，不直接重试 | `SEND_PERMIT_EXPIRED` |

修改 project 默认账号不会改写 QUEUE；显示仍使用旧账号的数量。需要换账号时显式重新绑定：未领取 QUEUE 可原子更新 route；RESERVED先撤销旧 attempt、递增 fencing/routeRevision；SENDING/RECONCILING/已部分发送/已发送禁止改绑，先核对结果。更换执行终端无需改默认账号或Post；只允许未领取或已确认未开始的任务重新竞争领取。解绑账号或撤销节点不能假设已开始发送被远程取消。

保持已核实的automation行为：master关闭或publishing关闭时，现有_uncommitPlanPosts将未开始计划QUEUE退回DRAFT；移除发布平台只撤回该平台计划任务；手工post及Engage回复不被这个撤回扫描包含。重新启用按原规则重新commit。严格实现改为检查attempt/意图，而不是只看旧releaseId/claimedAt；RESERVED安全取消后才能退回DRAFT，SENDING/RECONCILING/部分发送跳过并返回原因。无需为该既有能力新增“召回API”。

reply或automation开关关闭只停止sendOrigin=AUTOMATION的新回复生成/领取，不暂停MANUAL的用户预约/发送；MANUAL仍遵守账号授权、project有效性、业务额度及安全节奏。已开始真实发送继续结果核对；账号绑定修改本身不触发撤回/重排。权限失效与账号解绑在start阻止新副作用，但已授权外部请求可能在进行，不能承诺即时取消。

## 10. 实施顺序与迁移

1. **身份与模型**：先审计既有Integration身份及引用，回填namespace并准备新唯一键；统一OAuth/手工/插件匹配和所有按internalId查找。增加节点、会话、project binding、Post route、Plan executionRoutes、ReplySendIntent、attempt、ApiSendExecution、共享AccountWriteState、额度预算/预占、请求回执与结算事件。提供migration SQL/Prisma，新增字段先nullable，实际应用由用户/流水线执行。
2. **复用上报与可见状态**：现有extension-session增加POST入口、保留PATCH，共用节点身份/证据/逐平台保存；空platforms作心跳。按具体账号创建并原子计额度，不覆盖OAuth/其他节点。org/project/reply三个已有列表按原包装追加terminals/可用状态。
3. **配置和producer**：统一权限和账号默认；计划保存无project默认副作用，应用建议走显式版本化操作；回复先获得业务意图再生成/保存/排队。所有新QUEUE原子写完整账号route，自动/人工/API/插件共享防重。
4. **执行与原闸门迁移**：两种due按当前终端核验账号匹配，CAS胜者固定attempt；新回复同样claim。实现短许可/现场证据、可等待的提交日志、结果分类及单调结算、停止确认与核对；同步改造reply路由、所有直接fetch及本地Retry，426仍可结算。API/Temporal按§8.2接入共享保护或阻止未适配旁路；按§8替换原org/platform间隔、warmup、社区计数及UI状态查询，区分生成目标与发送硬额度。
5. **旧任务处理与切换**：先暂停旧协议领取，等待已领取任务结算；对无法确定是否已提交的旧任务隔离核对。已发送历史不重写；无绑定 DRAFT可明确批量套用默认；旧 QUEUE必须用户确认社交账号，不能根据“最近活跃会话”自动填充账号。终端由新协议领取时匹配，不要求用户逐条选节点。
6. **启用严格协议**：升级独立插件，确认严格账号能力；对执行 endpoint 要求节点认证与协议版本。旧插件缺身份、旧请求缺节点凭证均拒绝领取和开始，不依赖现有 fail-open 版本 guard 保证正确性。
7. **清理**：停止新插件租约使用 releaseId，保留旧结果受限 reconciliation 导入；更新旧文档和误导性代码注释。

灰度按organization或project选择完整新链路，同时按§8.2覆盖共享账号的所有执行入口；同一任务不能在新旧执行池同时可见。部署先扩展schema，再部署后端、工作流和新版插件，核对已有API/旧插件执行后启用严格领取。回滚暂停严格任务执行、保留记录；不能把严格绑定任务重新放进旧organization共享池，也不能在同账号仍有UNKNOWN时恢复旧API/插件发送。

身份唯一键迁移需先列出旧记录的provider/namespace映射、冲突及无法判定项，保留原Integration.id和所有FK；重复报告、同名跨平台、OAuth/浏览器别名必须用离线数据测试验证。无法判定记录隔离，不能自动删除真实账号或把历史归到新账号。业务意图升级同样先核对旧重复Post，不借唯一索引部署删除历史。所有唯一约束应用与索引文件由部署流程执行，不由代理操作数据库。

数据库限制：不运行 `prisma db push`、`prisma db execute` 或直接 SQL。后续实现只准备 schema 和 `libraries/nestjs-libraries/src/database/prisma/migrations/` 下的迁移文件，并向用户说明应用步骤；实际应用前确认项目数据库是 `aisee_postiz_dev`。

## 11. 实现文件与文档对齐

| 范围 | 需要修改的入口 |
| --- | --- |
| 数据模型 | `schema.prisma`、身份唯一键迁移、ReplySendIntent、节点/binding/attempt/ApiSendExecution/AccountWriteState、预算/预占、请求回执和结算事件repository及migration SQL |
| Project 授权 | 成员/角色能力guard、`projects/project-validation.service.ts`、ProjectAuthGuard、IntegrationProject；按§5.1不虚构现有用户级ACL；backend main.ts保留旧CORS方法并加入节点协议headers |
| 账号发现/匹配 | 保留extension-session调用链；IntegrationService、repository及所有internalId查找/upsert、OAuth/refresh/手工连接、身份namespace/别名及额度原子创建 |
| Plan | `operation-plan.service.ts`、`operation-plan.repository.ts`、`operation-plan.controller.ts` 及输入 DTO |
| Publishing | `posts.service.ts`（含startWorkflow/retryPost/changeDate分流与保护）、`posts.repository.ts`、post create/schedule/outcome DTO、`posts.controller.ts` |
| Reply | `engage.service.ts`、`engage.repository.ts`、`engage-auto-reply.service.ts`、`engage.controller.ts`、`engage.dto.ts` |
| Automation | 扩展现有automation DTO/controller/service的accounts和revision；保持policies/platforms替换及uncommit/commit语义，accounts-only不触发开关副作用 |
| 会话 | `integration.service.ts`、`integration.repository.ts`、`extension-session-report.dto.ts`、节点认证 guard |
| 账号/终端查询 | `integrations.controller.ts` 的 `/list`、IntegrationService、节点会话批量查询、统一通道可用性计算；保持现有字段命名和平铺结构 |
| 业务防重/恢复 | 请求幂等服务、ReplySendIntentService、自动/人工/API/插件producer及cancelAndSendNow/机会状态、attempt查询/停止确认/人工核对界面、旧许可冲突证据 |
| API/Temporal执行 | `apps/orchestrator/src/activities/post.activity.ts`、`workflows/post-workflows/post.workflow.v1.0.1.ts`及provider调用适配、ApiSendExecution、共用账号/预算/结算服务；已有workflow版本与活动发送迁移清单 |
| 账号节奏 | engage-auto-reply driver、repository的间隔/warmup/社区计数、账号配额预占与timezone、overview/queue status、本地platform-throttle账号分区 |
| 当前前端 | post 编辑/预约入口、Engage reply 编辑与发送入口、reply-accounts、project 切换缓存；本仓库 `engage/automation/page.tsx` 是扫描面板，不能误认为已有完整运营 Automation 账号 UI |
| 独立插件 | `executor/api.ts`、`request.util.ts`、`publish.runner.ts`、`reply.runner.ts`、`post-publish/queue.ts`、`account-guard.ts`、`interrupted-recovery.ts`、`reply.unconfirmed.ts`、`pages/background/post-reply.ts`及各poster/注入脚本、`extension-session-report.ts`、`session-maintenance.ts`、本地owner/提交日志/缓存隔离、对应shared DTO |

共享协议目前两仓库各有类型副本，需同一 protocolVersion 和契约测试覆盖；只修改后端类型不会自动更新独立插件。

实施后同步更新 [automation-api.md](automation-api.md)、[operation-plan-api.md](operation-plan-api.md)、[post-publish-api.md](post-publish-api.md)、[extension-post-publish-protocol.md](extension-post-publish-protocol.md)、[extension-reply-and-auth.md](extension-reply-and-auth.md)、[Engage API](engage/api.md)、[project-scoped-post-engage-design.md](project-scoped-post-engage-design.md)，以及独立插件 README/发布说明。特别删除“Automation 不选账号”“无绑定默认当前会话”“租约到期就可安全再次发送”的新链路说明。本草案不修改当前 API 文档，以免让待审阅能力被误认为已上线。

## 12. 验收与测试

实现时必须跑所有非冻结目录的完整测试套件，报告通过/失败数量；独立插件运行自己的完整套件，并做两 profile 的真实流程验证。当前提交只新增设计文档，不代表实现测试已通过。

最低验收场景：

1. 同一用户、同 organization：A选x1、B选x2；N1登录x1、N2登录x2时，plan post、手动post、手动reply、自动reply只由会话匹配的授权终端发送，业务DTO不需nodeId。
2. N1 与 N2 交替上报，不改变对方会话；重复/乱序/伪造节点报告被正确处理。
3. 缺 IntegrationProject、跨 organization、project失效或账号禁用时，账号绑定/发送被拒绝；节点撤销则不参与领取，不能让本身合法账号无法保存预约；任何客户端伪造 targetAccount无效。
4. N1从x1切成x2后，不发生原x1任务的平台submit；新的x2任务只有在权限有效、身份核验且claim/start成功后才可执行。登出、探测失败或无法取得可比身份时不提交；Dev.to/Quora页面核验也不能绕过同一规则。
5. 默认绑定变化不影响已有 QUEUE；显式改绑未发送任务后旧 attempt 不能 start。SENDING 和部分 thread 不可改绑。
6. 两节点同时领取只有一个有效 attempt；新生成回复不能未经 claim 直接发；start 重试、start 响应丢失、租约超时均不能再次授予相同发送许可。
7. 实发成功但回传断网只重试 outcome；未知结果不自动重发；晚到合法结果可结算；不同节点/不同账号/冲突结果不能覆盖。
8. 同账号跨 project/跨节点 post 与 reply 共用账号间隔，配额预占原子；不同账号互不误用账号配额。thread 部分发送可见且不重发 root。
9. Plan 改账号不重复生成或扣费；重复 materialize 不覆盖编辑；LinkedIn personal/page 不由 organization 全局账号自动决定。
10. 手动/API发送与 extension模式互斥；远端匹配终端可完成当前网页提交任务；Web广播不能直接触发多个插件提交。
11. 旧插件即使缺少版本头也无法领取严格任务；新旧池不同时派发同一任务；回滚不会退回随机浏览器账号发送。
12. 历史、metrics、reply 计费仍正确按 Post.integrationId 归属；URL-less 成功、平台移除、重复回传均保持准确历史与幂等。
13. 同账号同时在多个终端在线时terminals[]展示全部授权关联，但只有一个终端赢得任务claim；RESERVED安全过期后可换终端，SENDING/未知结果不可自动换终端重发。
14. N1切成x2时，从x1当前关联移除且仅能领取x2的授权任务；x1在另一终端有效登录时可领取原x1未领取任务，目标账号无需修改。
15. `/integrations/list` 保留平铺integrations及id/identifier/display，新增字段不破坏现有调用方；不重复新增platform/providerIdentifier分组字段。前端平台分组与排序不影响后端权限/领取规则。
16. 终端在线但会话UNKNOWN/STALE不算AVAILABLE；普通心跳不刷新verifiedAt；无终端返回空数组，离线/撤销只显示诊断状态；所有账号关联查询不泄漏跨租户/未授权终端。
17. projectId/action过滤与sendAvailability计算使用同一执行权限、能力、新鲜度规则；AVAILABLE只是通道快照，start依然重新校验配额/节奏/任务状态。批量查询无账号级N+1。
18. 插件现有保存API继续可用：首个x1登记后另一个终端上报x2可登记；重复/并发上报同账号只创建一行；额度不足仍保存观察和返回逐项原因，不丢其他平台结果。
19. 不同平台相同handle/裸ID不覆盖provider；OAuth与已可靠关联浏览器身份复用同一Integration，未知namespace不误合并。上报不覆盖OAuth凭证、用户自定义字段或禁用设置。
20. 两个并发人工保存、人工与automation竞争、两Post两终端竞争都不能让PRIMARY回复发两次；不同project/账号合法独立回复，ADDITIONAL请求重试幂等，改绑新账号遇到已有PRIMARY则冲突。
21. 保存未来计划、重试生成或修改REPLY快照不改变当前默认；显式应用建议校验binding版本并只影响新回复，旧QUEUE不变。
22. 缓存读取、旧probe重传、快照重新包装不延长核验；过旧/未来观察被拒绝。start必须使用本attempt新现场证据，各平台严格能力用真实切号测试确认。
23. 旧许可收到后进程暂停、管理者暂时查不到帖子、节点撤销、许可过期或start响应丢失：无停止/结果证据时不允许新attempt；旧执行恢复不重放过期submit，晚到冲突冻结核对。
24. 同organization退出成员、角色变更、失效project、另一user冒用节点均拒绝start；已发生结果仍可受限结算。首版不声称支持用户级project ACL。
25. x1发送不阻塞x2；x1成熟度不授给x2；同x1跨项目/终端共享日边界、间隔和额度。原org/platform闸门及本地切号时钟已按新粒度迁移，UI等待时间与执行一致。
26. 生成owner超时先CAS失效再接管；计费失败保持RECOVERING，旧owner晚到不能保存/排队或重复扣退。生成失败/取消可明确退出，恢复owner重试原task结算幂等。
27. thread下一段由outcome/attempt查询发现索引与可执行时间，再POST preflight获取绑定段/版本/节点的挑战；GET不改执行状态。过期轮换失效旧挑战，已AUTHORIZED不能重新授权，root证据不能用于下一段submit。
28. 旧PATCH session与新POST同payload调用同一保存服务；空platforms心跳不清会话/延长身份；CORS与OpenAPI支持新节点headers及旧方法，POST请求404/405回退不绕过严格执行。
29. 三个原账号列表保留各自数组/对象包装、scope、字段；org列表不替代project列表，reply-account参与开关不被误当默认账号选择。automation旧客户端省略accounts或完整替换policies不清绑定。
30. publishing旧请求显式platforms/[]保持原行为，accounts-only省略platforms不commit/对齐/退队；master/feature关闭仍安全uncommit计划任务，不误撤回手工post/reply或已经SENDING任务。
31. 新旧due按持久化executionProtocol隔离；旧PATCH回调不能绕过严格attempt验证，旧待报告LEGACY结果可结算；POST生成plan不是更新plan的幂等入口，执行编辑只用project-scoped新POST。
32. POST编辑/date别名与旧PATCH/PUT保持相同业务ID、revision及幂等效果；API默认路由不静默改变，extension返回QUEUED不被误报成已平台成功。当前Post/轻量reply状态不能替代历史attempt查询。
33. 手动回复与自动回复按服务端sendOrigin进入不同领取lane；关闭automation/reply不阻止用户明确预约的MANUAL，但权限失效/账号禁用仍阻止。AI文案人工发送不被误判自动，旧QUEUE不能通过猜测来源绕过开关。
34. x1同时登录N1/N2/N3只创建一份Integration及三份独立会话；N1退出不清N2/N3，账号额度不重复计入，列表可展示全部终端。
35. 三节点对同任务并发claim/start只有一个有效执行者和一次本段许可；两个不同任务同账号竞争也不能同时提交，post/reply/thread共享账号保护。
36. 同一预算窗口只剩1次时，用并发事务屏障验证两个start至多一个取得预占/许可；事务回滚、冲突重试及重复start不会留下孤儿预占或重复扣减。
37. 重复成功/失败/释放/outcome及外部计费重试幂等；confirmed与held转换保持预算不变量，UNKNOWN和跨日不自动释放，平台移除仍计发送次数。
38. 平台成功而响应丢失、旧节点迟到、锁到期、额度已预占但提交未知时，只能结算/核对，不因另一个浏览器在线而重发；已停止且确认未提交才能释放并安全接管。
39. POST /posts及批量新建/排队响应丢失后同键重试返回同一root/子项；同键不同摘要409，显式新键允许有意再次发布同文案；plan/周期producer使用稳定业务键。
40. 同账号API post、API reply与多个插件任务并发时只有一个提交执行权，共享硬预算；Temporal activity/外层重试、工作流终止、retryPost、cancelAndSendNow不能重发未知结果或删除证据。不同project灰度不能留下同账号LEGACY旁路。
41. reply发送DTO省略publishMethod保持旧api语义，显式extension进入reply-due且不启动Temporal；publish-due不把reply当post；数据库路由读取失败不自动切执行方式。不同账号意图不再被项目机会SCHEDULED/REPLIED状态错误互斥。
42. 多个账号竞争同一project硬预算也不超额；生成目标、默认关闭的plan gate与SEND_HARD_LIMIT保持各lane语义，已付费QUEUE不再次消费生成额度；API/自动本地日与UTC策略的窗口明确。
43. 预约跨日执行、午夜thread段、迟到确认、timezone修改及降低上限使用不可变预占窗口/策略版本；同一发送事实不被Post统计及账本重复计数，移除不退还发送次数。
44. 存储写入失败/满额、日志提交前后worker崩溃、页面消息重复、网络超时及扫描查无记录：只有可靠未提交证据才可安全重试；SUBMITTING/UNKNOWN不变回普通可重试error。部分thread的FAILED_FINAL禁止root重试。
45. CONFIRMED后迟到unknown不回退；成功后移除、URL-less后补URL和重复事件不再次扣费或释放预占；NOT_SUBMITTED后迟到成功冻结核对。已有426升级状态允许认证的结果结算/停止确认，禁止新提交。
46. claim/register响应丢失的同键重试不新增任务/节点或轮换活跃密钥；回执加密且过期后只返回恢复/过期状态。start重试不重放提交许可；节点headers实际透传，旧直接fetch、人工bridge及popup均受控。

## 13. 建议审阅的产品决策

草案按以下选择落地，供审阅时调整：

- 默认以两个浏览器 profile 实现同平台多账号，不做插件自动切号。
- 每个project/platform分别设置POST、REPLY默认社交账号，允许二者相同；plan/post/reply/automation不提供必选终端配置。
- 可以先生成未绑定账号的计划/草稿；排队前必须绑定账号，有账号但无可用终端时可以预约等待。
- 首版计划控制回复目标，project REPLY binding 控制新回复身份；不支持同一 project 多计划同时指定不同回复账号。
- 默认绑定变更不自动迁移已排队任务；重新绑定是显式操作。
- 身份无法可靠确认时暂停发送；支持的平台范围由真实身份核验与 actor 能力决定。
- 将发送前授权、未知结果保护和账号级并发保护作为多节点上线的必要条件。
- 账号列表平铺返回terminals[]与服务端sendAvailability，平台分组、排序、折叠由前端完成；复用真实现有字段identifier，不另增同义platform字段。
- 终端名称用户可编辑；一个账号可关联多个终端，实际执行终端在claim胜出时固定于attempt，不在Post提前绑定。
- 复用插件现有账号上报API，修正具体账号登记条件与身份唯一规则，不新增重复保存入口。
- 默认回复采用PRIMARY业务意图防重，显式人工追加另建幂等意图；保存计划不修改project默认，应用建议是独立操作。
- 首版权限是organization成员/操作能力加project归属，不引入尚未存在的用户级project ACL；平台严格能力必须逐项验收。
- 未知结果恢复同时要求旧执行已停止及明确结果证据，不用平台暂时查无记录作为唯一重试依据。
- API先复用既有列表、automation、post/reply保存/预约与due；新增写入口使用POST，旧PATCH/PUT/DELETE按业务兼容保留，共用服务而非重命名整库路由。
- 同账号可多终端登录，防重复发送/额度并发使用以数据库持久约束为权威；未知结果保留保护，锁到期不是重试授权，外部exactly-once不作无依据承诺。
- 保留API默认与既有返回包装，同时要求同账号API/Temporal共享执行保护；未完成适配的旁路账号不启用严格多终端发送。首版部分thread仅核对/补录，不自动续发或从root重试。

本轮交付仅为该方案。后续在审阅通过后实施业务代码、插件协议、数据库迁移文件与测试。
