# Engage 模块启动与部署检查清单 (Startup & Deployment Checklist)

**版本**: 1.3
**日期**: 2026-05-21
**状态**: 核心功能上线前置要求

> v1.3 修订：拆分"冷启动 / 升级现有运行环境"两条路径，§5 改为正确使用 `scripts/redeploy-orchestrator.sh`（build → terminate old workflows → pm2 restart），避免直接 `pnpm run pm2` 在已运行系统上重复初始化并触发 workflow nondeterminism。
>
> v1.2 修订：按"配置 → 依赖 → 模型 → 数据库 → 启动 → 验证"重排章节顺序；把 HuggingFace 镜像/预下载相关说明合并到同一章节，避免分散在 §1 与 §4 两处；补充每一步的可复制命令。
>
> v1.1 修订：根据代码实际情况，更正了 Prisma / pnpm 命令、API Key 变量名、HF 镜像生效条件，以及 Temporal workflow 注册时机的描述。

---

## 0. 总览：先判断是冷启动还是升级

**先判断你属于哪种场景**，两条路径的 §5 不一样：

| 场景 | 特征 | 走哪条路径 |
|---|---|---|
| **A. 冷启动** | 全新环境 / 首次部署 / 数据库无既有 Postiz 数据 | §0.A |
| **B. 升级现有运行环境**（**当前 Engage 上线属于此种**） | 系统已在跑、有 PM2 进程、有正在执行的 Temporal workflow | §0.B |

> ⚠️ **不要在已运行的系统上直接执行 `pnpm run pm2`** —— 该脚本会重新跑 `prisma-seed`、并行重启所有进程，并可能让旧 workflow 在新代码下触发 *nondeterminism* 错误。升级路径必须走 `scripts/redeploy-orchestrator.sh`。

### 0.A 冷启动路径

```bash
# 1. 编辑 .env，配置 ANTHROPIC_API_KEY（必填）
# 2. 安装依赖（postinstall 会自动跑 prisma generate）
pnpm install

# 3. (推荐) 预下载 NLP 意图模型，避免首启卡顿
pnpm dlx ts-node -r tsconfig-paths/register scripts/download-model.ts

# 4. 推送 Prisma schema（pm2-run 也会自动执行，这里仅供独立场景）
pnpm run prisma-db-push

# 5. 启动开发或生产编排
pnpm run pm2          # dev
# pnpm run pm2:prod   # prod

# 6. 按 §7 跑 Smoke Test 验证
```

### 0.B 升级现有运行环境路径（Engage 上线适用）

```bash
# 1. 拉取最新代码
git pull

# 2. 编辑 .env，新增 ANTHROPIC_API_KEY（若 .env.example 已变化也一并同步）

# 3. 安装新增依赖（postinstall 自动跑 prisma generate）
pnpm install

# 4. (推荐) 预下载 NLP 意图模型
pnpm dlx ts-node -r tsconfig-paths/register scripts/download-model.ts

# 5. 推送 Engage 新增表 / 字段（不会丢已有数据；--accept-data-loss 仅用于丢弃未引用列）
pnpm run prisma-db-push

# 6. 重新部署 orchestrator（build → terminate old workflows → pm2 restart）
bash scripts/redeploy-orchestrator.sh

# 7. 重启 backend / frontend（Engage 新增了路由与前端组件，必须重启才能加载）
pm2 restart backend frontend     # PM2 进程名以 .env 里的 PM2_*_NAME 为准

# 8. 按 §7 跑 Smoke Test 验证
```

后续章节是上面每一步的细化说明。

---

## 1. 环境变量配置 (.env)

Engage 同时使用 Anthropic（草稿生成 + 意图分类兜底）和本地 NLP 模型，必须先把 API Key 配好。

- [ ] **`ANTHROPIC_API_KEY`（或别名 `CLAUDE_API_KEY`，二选一）**：必填。
  - `EngageDraftService` 与 `EngageIntentClassifierService` 都会读取，优先取 `ANTHROPIC_API_KEY`，其次取 `CLAUDE_API_KEY`。
  - 建议优先使用 `ANTHROPIC_API_KEY`（Anthropic 官方 SDK 默认变量名）。

> HuggingFace 镜像 / NLP 模型预下载相关配置见 §3。

---

## 2. 安装依赖与 Prisma Client 生成

```bash
pnpm install
```

- [ ] `pnpm install` 会安装 `@xenova/transformers` 等新依赖。
- [ ] **`postinstall` 钩子会自动执行 `pnpm run prisma-generate`**，无需手动重跑。
- [ ] 仅在需要手动重跑 Prisma 客户端时：

  ```bash
  pnpm run prisma-generate
  ```

  ⚠️ **不要**使用 `pnpm --filter @postiz/nestjs-libraries prisma generate` —— `libraries/nestjs-libraries/` 下没有 `package.json`，不是独立的 pnpm 包，该命令会报 `No projects matched the filters`。

---

## 3. NLP 模型预下载（强烈推荐先于 §5 启动服务）

`EngageIntentClassifierService` 在模块初始化时会下载约 44MB 的 NLP 模型（`Xenova/nli-deberta-v3-small`）到 `~/.cache/huggingface/`。若不预下载，首次启动 Backend 或 Orchestrator 时 `onModuleInit` 会停留 30–60 秒（取决于网络）。

### 3.1 推荐：在启动服务前预下载

```bash
pnpm dlx ts-node -r tsconfig-paths/register scripts/download-model.ts
```

- [ ] 看到 `downloaded` 日志即代表缓存就绪。
- [ ] 后续启动会直接命中缓存，秒级完成。

### 3.2 国内网络环境镜像配置

**当前代码不读取 `HF_ENDPOINT` 环境变量**，直接设置该变量**不会生效**。若首次下载失败，二选一：

1. 在 `libraries/nestjs-libraries/src/engage/engage-intent-classifier.service.ts` 的 `onModuleInit` 顶部加入：

   ```ts
   import { env } from '@xenova/transformers';
   env.remoteHost = 'https://hf-mirror.com';
   ```

   预下载脚本 `scripts/download-model.ts` 如需走镜像，也按同样方式在脚本顶部设置 `env.remoteHost`。

2. 在部署前把模型缓存预置/挂载到 `~/.cache/huggingface/`。**Docker 部署推荐**：把宿主机的 `~/.cache/huggingface/` 挂载为 volume，避免每次容器重建都重新下载。

### 3.3 若选择不预下载

- [ ] 观察首次启动日志，进程在 `onModuleInit` 处停留 30–60 秒是**正常现象**，请勿强行终止。

---

## 4. 数据库结构升级

Engage 引入了 8 张新表，且对 `Post`、`Organization`、`Integration` 等既有表做了字段扩展。

```bash
pnpm run prisma-db-push
```

- [ ] 项目当前使用 **`prisma db push`** 而非 `prisma migrate`。
- [ ] `pm2-run` / `pm2-run:prod` 启动序列已自动包含此步，独立执行 §5 启动命令时无需重复跑。
- [ ] `libraries/nestjs-libraries/src/database/prisma/migrations/` 下虽然存有 `add-engage-tables.sql` 等 SQL 历史文件，但**未通过** `prisma migrate deploy` 应用 —— 切勿混用两套流程，否则 `_prisma_migrations` 表与实际 schema 会失同步。

---

## 5. 启动 / 重新部署服务

按 §0 选择的场景走对应小节：

### 5.A 冷启动：`pnpm run pm2`

```bash
# 开发模式
pnpm run pm2

# 生产模式
pnpm run pm2:prod
```

`pm2-run` 脚本会按顺序执行：
1. `ensure-pm2-names.sh`（清理旧进程名）
2. `prisma-db-push`（即 §4，幂等可重复）
3. `prisma-seed`（AI pricing 种子数据）
4. 并行启动 backend / frontend / orchestrator
5. `pm2 logs`

### 5.B 升级现有运行环境：`redeploy-orchestrator.sh` + `pm2 restart`

Engage 上线属于此场景。**不要直接跑 `pnpm run pm2`**：
- 它会重跑 `ensure-pm2-names.sh`，可能把已有 PM2 进程名清空 / 重排；
- 它会重跑 `prisma-seed`（AI pricing），对线上是冗余写入；
- 它通过 `pnpm run --parallel pm2` 重启所有进程，但**先做了 db-push 才重启 orchestrator**，期间旧 orchestrator 仍在用旧 workflow 代码运行新 schema，可能短暂报错。

正确做法：

```bash
# 1) Orchestrator：用脚本完成 build → terminate old workflows → pm2 restart
bash scripts/redeploy-orchestrator.sh
```

`scripts/redeploy-orchestrator.sh` 内部按顺序执行（详见脚本注释）：
1. `pnpm build` —— 失败则不动 workflow，安全；
2. `npx ts-node scripts/terminate-workflows.ts --execute` —— 在 `TEMPORAL_NAMESPACE`（来自 `.env`）中终止旧 workflow，避免新代码 replay 旧历史时 nondeterminism；
3. `pm2 restart $PM2_ORCHESTRATOR_NAME`（来自 `.env`，默认 `orchestrator`）；
4. Orchestrator 启动后由 `infinite.workflow.register.ts` 自动重新注册常驻 workflow（含本次新增的 `engageDataTicksWorkflow`）。

```bash
# 2) Backend / Frontend：Engage 新增了 /engage 路由、controller、前端组件，必须重启
pm2 restart backend frontend
# 实际进程名以 .env 中的 PM2_BACKEND_NAME / PM2_FRONTEND_NAME 为准，可用 `pm2 ls` 查看
```

- [ ] 重启后用 `pm2 logs <name> --lines 30 --nostream` 检查无 `nondeterminism` / Prisma 报错。
- [ ] 在 Temporal UI 中确认 `engageDataTicksWorkflow` 重新出现在 Running 列表（详见 §6）。

### 5.C 仅希望终止 Engage 相关历史 workflow

若曾经有 stale 的 `engage-scan-*` / `engage-tracked-*` / `engage-metrics-*`，可在 `scripts/terminate-workflows.ts` 中按 workflowId 前缀过滤后单独跑。**不要在生产 namespace 上无差别 terminate**，会误杀业务 workflow。

---

## 6. Temporal 工作流注册（启动时机各不相同）

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

## 7. 功能隔离性验证 (Smoke Test)

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
