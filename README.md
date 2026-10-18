# GroupPilot：多账号群组消息平台

题目原文见 [docs/题目.md](docs/题目.md)。需求分析、难点拆解、设计决策与接口契约见 [docs/需求分析.md](docs/需求分析.md)。

后端为 Node.js + TypeScript + PostgreSQL（Fastify），控制台为 React 18 + TypeScript + Vite。题目里的两个外部服务（消息网关、Agent 服务）都做了可故障注入的 Mock；C2 另外实现了一个接 Claude 的真实 Agent 服务。

```
apps/
  server/        后端：账号、群与成员、消息时间线、出站队列、定时序列、Agent 接入、WS 推送
  web/           操作控制台（页面 1–5）
  mock-gateway/  消息网关模拟（HTTP + SSE），/_control 下可精确注入各种异常
  mock-agent/    Agent 服务模拟（tool use 协议），可脚本化坏响应
  llm-agent/     C2：接口与 2.2 完全相同、内部调用 Claude 的 Agent 服务
  e2e/           C3：Playwright 端到端测试
docs/            题目、需求分析与设计
```


## 跑起来

### 1. 准备

- Node.js ≥ 20.19，pnpm 10（`corepack enable` 即可）
- PostgreSQL ≥ 14。本机已有 PostgreSQL 时直接建库；没有的话用 `docker compose up -d` 起一个（账号密码 `postgres/postgres`）

```bash
pnpm install
```

```bash
createdb group_pilot
```

```bash
cp .env.example .env
```

按本机情况修改 `.env` 里的 `DATABASE_URL`（例如本机免密：`postgres://localhost:5432/group_pilot`）。

### 2. 迁移（可重复执行）

```bash
pnpm migrate
```

迁移会预置 8 个服务账号 `acc-01` … `acc-08`（初始 `idle`），以及两个用户 `admin/admin`（全部权限）、`viewer/viewer`（只读）。数据库没迁移或落后于代码时，后端会拒绝启动并提示先执行迁移。

### 3. 启动

```bash
pnpm dev
```

会同时启动四个进程：

| 进程 | 地址 |
|---|---|
| 控制台 | http://localhost:5173 |
| 后端 | http://localhost:3000（`/api/*`、`/ws`） |
| Mock 网关 | http://localhost:4001（控制面板 http://localhost:4001/_control） |
| Mock Agent | http://localhost:4002 |

### 4. 演示路径

1. 用 `admin/admin` 登录控制台，在「账号」页把几个账号「重连」。
2. 「群」页选群主、按顺序选成员（第一个会被提升为管理员）建群，页面上能看到 job 进度。
3. 打开群详情，打开「自动应答 Agent」开关。
4. 在 Mock 网关控制面板（http://localhost:4001/_control）给这个群发一条外部用户消息（可勾选带图片）。控制台的时间线会实时出现这条消息，接着 Agent 回复，「最近的 Agent 运行」里能点进每一步的详情。
5. 在群详情点「启动序列」：新建序列 → 填 vars / stepVars → 预检弹窗确认每个 key 的取值与来源 → 启动，页面显示每一步的进度。
6. 控制面板里还能禁写群、把账号标为停用 / 限流、断开 SSE、开重复事件，用来观察各种异常下的表现。也可以用 `CHAOS=1 pnpm --filter @gp/mock-gateway start` 让网关随机出错。

## 环境变量（后端）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | |
| `DATABASE_URL` | `postgres://localhost:5432/group_pilot` | |
| `GATEWAY_URL` | `http://localhost:4001` | 消息网关 |
| `AGENT_URL` | `http://localhost:4002` | Agent 服务 |
| `JWT_SECRET` | `dev-secret-change-me` | 生产环境必须修改 |
| `AGENT_TURN_TIMEOUT_MS` | `12000` | `/agent/turn` 每轮超时，限定在 10–15 秒 |
| `AGENT_AUDIT_TIMEOUT_MS` | `5000` | `/agent/audit` 单次超时 |
| `MEDIA_DIR` | `./media` | C1 媒体文件目录 |
| `MEDIA_RETENTION_DAYS` | `30` | 媒体文件保留天数 |
| `COOKIE_SECURE` | `false` | HTTPS 部署时设为 `true` |
| `INSTANCE_ID` | 随机 | 多实例部署时的实例标识（用于租约） |

## 测试

后端集成测试连接独立的测试库（默认 `postgres://localhost:5432/group_pilot_test`，可用 `TEST_DATABASE_URL` 覆盖），每个测试文件开始时会清空并重建 schema。Mock 网关与 Mock Agent 在测试进程内启动，不需要额外起服务。

```bash
createdb group_pilot_test
```

```bash
pnpm test
```

```bash
pnpm typecheck
```

覆盖情况：

- 题目 2.4 的 S1–S8 各有对应用例：受理与发出、事件重复、自己消息回流、限流、Agent 同 key 重试、Agent 坏响应、序列并发启动、序列预检。
- 账号转移表与 CAS 并发、终态联动、504 的各种结局与只重发一次、查询接口不可用、群禁写。
- 写库失败时事件不丢并推 inconsistency、事件流断开与服务停机后的补拉。
- 建群的 INVITE_NOT_READY / INVITE_EXPIRED / ALREADY_MEMBER / JOIN_TIMEOUT，job 中途重启，leave-all 部分失败。
- Agent 的协议错误、超时、审计 fail / 阻塞、kick 与 504、取消、步数与墙钟上限，以及 run 进行中重启后用同一 runId 继续。
- 序列的取值规则、排期、跳过、限流顺延、重启重排、群不可写时 stopped。
- refresh token 轮换与重用作废、logout 立即失效、WS sinceSeq 补发、媒体下载与清理。
- 前端的纯逻辑（single-flight 续期、转移表、时间线合并、seq 去重等）。

端到端测试（C3）。它默认复用已经在跑的 `pnpm dev`，没在跑就自己拉起四个进程；浏览器使用本机安装的 Chrome（`channel: 'chrome'`，可用 `PW_CHANNEL` 换成别的）：

```bash
pnpm e2e
```

## C2：接入真实 LLM

`apps/llm-agent` 对外接口与 2.2 完全相同，内部用 Anthropic Messages API 的 tool use，默认模型 `claude-opus-5-5`，可用 `LLM_MODEL` 修改。凭据按 Anthropic SDK 的默认顺序解析，例如 `ANTHROPIC_API_KEY`。

```bash
ANTHROPIC_API_KEY=<你的 key> pnpm llm-agent
```

服务监听 4003 端口。后端只需要改 `AGENT_URL` 即可切换；真实模型更慢，建议把超时放宽到上限：

```bash
AGENT_URL=http://localhost:4003 AGENT_TURN_TIMEOUT_MS=15000 AGENT_AUDIT_TIMEOUT_MS=10000 pnpm --filter @gp/server dev
```

实现要点：

- **追加式历史。** 后端每轮只保存返回给它的那一个块。服务按 runId 记住 Claude 每轮的完整内容（含 thinking 块），下次请求时按 `tool_use.id` 换回去，保证发给 Claude 的历史是追加式的（preserved thinking 的前缀校验要求如此）。
- **每轮恰好一个块。** `disable_parallel_tool_use` 保证每轮最多一个工具调用；有 tool_use 时只返回它，否则把文本合并成一个 text 块。
- **拒绝与审计。** 开启了服务端 `fallbacks: "default"`，被安全分类器拒绝时由服务端按拒绝类别自动换模型重试；如果仍然拒绝，转成 `end_turn` 文本。审计用结构化输出拿 `verdict`，审计请求本身被拒绝时按 `fail` 处理。
- **effort。** 默认 `LLM_EFFORT=low`，因为后端每轮只等 10–15 秒。

## 关键设计（摘要）

详细说明见 [docs/需求分析.md](docs/需求分析.md)。

- **重启前后都成立。** 所有定时器、队列、游标、进度都在 PostgreSQL 里。后台工作者靠行锁、`SKIP LOCKED` 与租约协调，可以多实例部署，任何时刻崩溃都能接着做。
- **网关事件。** 先按 `eventId` 写入收件箱（原文存 text，天然去重），再逐条在保存点里处理：失败的回滚、记录、退避重试并推 `inconsistency`，后续事件照常处理。重连游标回退到 2 秒乱序窗口之前，成员事件用 `last_event_id` 抵御乱序。
- **出站消息。** 先落库再发送，发送前记录在途状态。504、超时、崩溃都按「结果未知」处理：查 by-client-id，确认未发出才用同一 `clientMsgId` 重发一次。自己的消息回流时合并成一行。
- **推送一致性。** 所有状态变化与推送事件在同一事务提交。写事件时持有事务级 advisory lock，使 `seq` 顺序等于提交顺序，`sinceSeq` 补发不会漏。
- **Agent run。** 历史、步数、连续协议错误、累计活跃时长、待执行工具及其阶段都落库。发消息在审计通过后与幂等键同一事务入队；kick 前先落阶段，恢复时以网关成员列表为准，已产生的效果不会再执行一次。
- **单运行约束。** 「同一群至多一个 running」（agent run 与序列运行）都由部分唯一索引保证。

## 已知限制

- 网关建群接口没有幂等键。如果崩溃恰好发生在「网关已建群、本地还没落库」的那一次 HTTP 往返里，网关会多出一个空群。
- C2 服务的会话状态在内存里。服务重启后会退回「只回放返回过的那个块」，这在 API 上仍然合法，只是失去之前的 thinking 内容。
