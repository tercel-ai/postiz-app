# Engage 模块启动与部署检查清单 (Startup & Deployment Checklist)

**版本**: 1.1
**日期**: 2026-05-21
**状态**: 核心功能上线前置要求

> v1.1 修订：根据代码实际情况，更正了 Prisma / pnpm 命令、API Key 变量名、HF 镜像生效条件，以及 Temporal workflow 注册时机的描述。

---

## 1. 环境配置更新 (.env)

Engage 模块使用了 AI 辅助草稿生成和本地 NLP 意图识别，必须确保以下配置：

- [ ] **`ANTHROPIC_API_KEY`（或别名 `CLAUDE_API_KEY`，二选一）**：必填。`EngageDraftService` 与 `EngageIntentClassifierService` 都会读取，优先取 `ANTHROPIC_API_KEY`，其次取 `CLAUDE_API_KEY`。建议优先使用 `ANTHROPIC_API_KEY`（Anthropic 官方 SDK 默认变量名）。
- [ ] **国内网络环境的 HuggingFace 模型下载**：**当前代码不读取 `HF_ENDPOINT` 环境变量**，直接设置该变量**不会生效**。若首次启动下载 44MB 意图模型失败，可二选一：
  - 在 `engage-intent-classifier.service.ts` 的 `onModuleInit` 顶部加入 `@xenova/transformers` 的 `env.remoteHost = 'https://hf-mirror.com'`；或
  - 在部署前把模型缓存预置/挂载到 `~/.cache/huggingface/`（Docker 部署推荐用 volume 复用）。

---

## 2. 依赖安装与代码生成

由于引入了新包和修改了数据库模型，必须执行：

- [ ] `pnpm install`：安装 `@xenova/transformers` 等新依赖。**`postinstall` 钩子会自动执行 `pnpm run prisma-generate`**，无需手动重跑。
- [ ] （仅当需要手动重跑 Prisma 客户端时）：`pnpm run prisma-generate`。
  - ⚠️ **不要**使用 `pnpm --filter @postiz/nestjs-libraries prisma generate` —— `libraries/nestjs-libraries/` 下没有 `package.json`，不是独立的 pnpm 包，该命令会报 `No projects matched the filters`。

---

## 3. 数据库结构升级

Engage 引入了 8 张新表，且对 `Post`、`Organization`、`Integration` 等既有表进行了字段扩展。

- [ ] **开发与生产环境统一**：`pnpm run prisma-db-push`
  - 项目当前使用 **`prisma db push`** 而非 `prisma migrate`；`pm2-run` / `pm2-run:prod` 启动序列已自动包含此步。
  - `libraries/nestjs-libraries/src/database/prisma/migrations/` 下虽然存有 `add-engage-tables.sql` 等 SQL 历史文件，但未通过 `prisma migrate deploy` 应用 —— 切勿混用两套流程，否则 `_prisma_migrations` 表与实际 schema 会失同步。

---

## 4. 首次冷启动注意事项 (NLP 模型下载)

`EngageIntentClassifierService` 在模块初始化时会尝试下载约 44MB 的 NLP 模型（`Xenova/nli-deberta-v3-small`）。

- [ ] **观察日志**：首次启动 Backend 或 Orchestrator 时，进程可能会在 `onModuleInit` 处停留 30-60 秒。
- [ ] **耐心等待**：这是正常的后台模型下载过程（缓存至 `~/.cache/huggingface/`），请勿强行终止进程。后续启动直接命中缓存，秒级完成。
- [ ] **Docker 部署建议**：把宿主机的 `~/.cache/huggingface/` 挂载为 volume，避免每次容器重建都重新下载。

---

## 5. Temporal 工作流注册（启动时机各不相同）

Engage 包含 4 个核心异步工作流，**它们的启动时机不同**，部署后 Temporal UI 看到的内容会随用户操作变化。请勿误以为冷启动后必须立即看到全部 4 个：

| Workflow | 启动机制 | 何时出现在 Temporal UI |
|---|---|---|
| `engageDataTicksWorkflow` | `infinite.workflow.register.ts` 在 Orchestrator 启动时全局注册一个常驻实例 | ✓ **Orchestrator 冷启动后立即可见** |
| `engageScanWorkflow` | `EngageService._startEngageWorkflowsForOrg()` 在用户保存配置时按 `engage-scan-{orgId}` 启动 | 用户首次完成 `/engage/settings` 配置后 |
| `engageTrackedAccountsWorkflow` | 同上，workflowId 为 `engage-tracked-{orgId}` | 同上 |
| `engageMetricsSyncWorkflow` | `EngageService.startMetricsSyncForReply()` 在每次回帖创建后按 `engage-metrics-{sentReplyId}` 启动 | 每次成功发出 Engage 回帖后 |

**冷启动检查**（默认 Temporal UI: `http://localhost:8233`）：

- [ ] **冷启动后**：仅 `engageDataTicksWorkflow` 应出现在 Running 列表。
- [ ] **完成首次 `/engage/settings` 配置后**：`engage-scan-{orgId}` 与 `engage-tracked-{orgId}` 出现。
- [ ] **发出首条 Engage 回帖后**：`engage-metrics-{sentReplyId}` 出现。

---

## 6. 功能隔离性验证 (Smoke Test)

在正式使用前，请手动执行以下校验以确保系统稳定性：

- [ ] **原有业务校验**：使用 Calendar 排期发送一篇普通 Post（`source='calendar'`），确保发帖逻辑与统计未受影响。
- [ ] **Engage 激活**：在 `/engage/settings` 中开启一个 X 账号，添加关键字并触发首次扫描；确认 Temporal UI 里 `engage-scan-{orgId}` 已启动。
- [ ] **数据隔离纯净度**：发送一个 Engage 回帖后，分别检查以下接口确实**不含** Engage 数据：
  - `GET /dashboard/summary`
  - `GET /dashboard/traffics`
  - `GET /dashboard/posts-trend`
  - `GET /dashboard/impressions`
  - `GET /dashboard/post-engagement`

  以上接口在 `dashboard.repository.ts` 已加 `source: { notIn: ['engage'] }` 过滤；若结果包含 Engage 帖子说明过滤失效，需立刻排查。

- [ ] **共用配额验证（产品决策：Engage 共用普通帖配额）**：
  - 发出一条 Engage 回帖后，检查用户的月度发帖计数（`countPostsFromDay`）应**包含**此回帖 —— 这是设计意图，不是 bug。
  - 若触发 overage，检查 AiseeCredit 扣费记录的 `data.source` 字段应为 `'engage'`（而非旧版本硬编码的 `'calendar'`）。
