# @gp/mock-gateway

模拟题目 2.1 的消息网关（HTTP + SSE）。状态全在内存，默认带「正常但真实」的时延，所有异常都能通过 `/_control/*` 精确注入。

## 运行

```bash
pnpm --filter @gp/mock-gateway dev      # PORT 默认 4001
CHAOS=1 pnpm --filter @gp/mock-gateway start
```

| 环境变量 | 说明 |
|---|---|
| `PORT` | 默认 `4001` |
| `HOST` | 默认 `0.0.0.0` |
| `PUBLIC_URL` | 生成 `inviteLink` / `mediaUrl` 用的对外地址，默认等于监听地址 |
| `CHAOS=1` | 随机故障：重复事件概率 0.3、乱序窗口 800ms、send 5% 返回 504（其中一半实际在 2s 内落地）、2% 请求 503、约每 60s 断一次 SSE、邀请链接 TTL 随机 5–30s |
| `FAST=1` | 使用 `FAST_TIMING` |
| `LOG=1` | 打开 fastify 请求日志 |

浏览器打开 `http://localhost:4001/_control` 是演示用的控制面板。

## 进程内启动（集成测试）

```ts
import { startMockGateway, FAST_TIMING } from '@gp/mock-gateway';

const gw = await startMockGateway({ port: 0, config: { timing: FAST_TIMING } });
// gw.url / gw.port
await gw.close();
```

`startMockGateway(opts?: { port?, host?, config?: DeepPartial<GatewayConfig>, publicUrl?, logger? })`，`port: 0` 为随机端口，`host` 默认 `127.0.0.1`。另导出 `FAST_TIMING`、`DEFAULT_TIMING`、`DEFAULT_CONFIG`、`ENDPOINTS` 及相关类型。

## 业务端点（题目 2.1）

错误体统一为扁平结构 `{ code, message, ...额外字段 }`。

| 端点 | 要点 |
|---|---|
| `POST /accounts/:accountId/connect` → `{ platformUserId }` | `platformUserId = 'pu_' + accountId` |
| `POST /accounts/:accountId/disconnect` → `{}` | |
| `POST /groups { creatorAccountId }` → `{ groupId }` | 创建者立即是成员和群主，不推 `member_joined` |
| `POST /groups/:groupId/invite` → `{ inviteLink, readyAfterMs }` | 未就绪 `409 INVITE_NOT_READY`，过期 / 未知 `410 INVITE_EXPIRED` |
| `POST /groups/:groupId/join { accountId, inviteLink }` → `202` | `joinDelayMs` 后入群，再过 `memberEventLagMs` 推 `member_joined`；已是成员 `409 ALREADY_MEMBER` |
| `POST /groups/:groupId/promote { byAccountId, accountId }` → `{}` | 非群主 `403 NO_PERMISSION`；未入群 `409 NOT_MEMBER_YET` |
| `POST /groups/:groupId/kick { byAccountId, targetPlatformUserId }` → `{ kicked: true }` | 立即移除，`kickDelayMs` 后才响应；`409 OWNER_LEFT` / `403 NO_PERMISSION` / `409 NOT_MEMBER` |
| `POST /groups/:groupId/leave { accountId }` → `{}` | 群主退群后标记 ownerLeft |
| `GET /groups/:groupId/members` → `[{ platformUserId }]` | |
| `POST /groups/:groupId/send { accountId, clientMsgId, text }` → `202` | 校验顺序：终态 → 离线 → 限流（`429`，并重置窗口）→ 禁写 sync → 不在群；落地后推 `message_sent` 与 `message`；不按 `clientMsgId` 去重 |
| `GET /groups/:groupId/messages/by-client-id/:clientMsgId` | `200 { msgId, sentAt }`（最早一条）/ `404 NOT_FOUND` |
| `GET /media/:id` | 文件字节；过期后 `404` |
| `GET /events?since=<eventId>` | SSE；`since` 独占；也接受 `Last-Event-ID` 头；每 15s 一次 `: ping` |

终态账号的任何请求：`suspended → 403 ACCOUNT_SUSPENDED`，`session_expired → 401 SESSION_EXPIRED`。离线账号的 send / join / promote（by）/ kick（by）/ leave / createGroup（creator）→ `409 ACCOUNT_OFFLINE`。未知群 → `404 GROUP_NOT_FOUND`，缺字段 → `400 VALIDATION_ERROR`。

## 控制接口（`/_control`，不受 unavailable / chaos 影响）

| 端点 | 说明 |
|---|---|
| `POST /_control/faults` | 追加故障规则（见下），返回带 `id` 的规则 |
| `GET /_control/faults` / `DELETE /_control/faults` | 查看 / 清空 |
| `GET /_control/config` / `PATCH /_control/config` | 查看 / 深合并 `GatewayConfig`（数组整体替换）；切到 `unavailable: true` 时会断开现有 SSE |
| `POST /_control/accounts/:accountId/status { status, push? }` | `suspended` / `session_expired`；移出所有群并逐个推 `member_left`；`push` 默认 true，推 `account_status` |
| `POST /_control/accounts/:accountId/rate-limit { retryAfterSeconds }` | 立即进入限流窗口 |
| `POST /_control/accounts/:accountId/redeliver` | 该账号发过的所有消息以新 eventId、原 msgId / sentAt 重推 `message`，返回 `{ count, eventIds }` |
| `POST /_control/groups/:groupId/forbid { mode }` | `'sync'`（send 同步 403）/ `'async'`（推 `message_failed`）/ `null` |
| `POST /_control/groups/:groupId/external-join { platformUserId }` | 外部用户入群（推 `member_joined`），返回 `{ joined }` |
| `POST /_control/groups/:groupId/external-leave { platformUserId }` | 外部用户（或任意成员）离群（推 `member_left`），返回 `{ left }` |
| `POST /_control/groups/:groupId/external-message { platformUserId, text, withMedia?, mediaTtlMs?, sentAt? }` | 推一条 `message`，返回 `{ msgId, eventId, mediaUrl? }`；`withMedia` 生成一张 16×16 PNG；`sentAt` 可指定（测试排序用） |
| `POST /_control/groups/:groupId/expire-invites` | 让该群现有邀请链接立即过期 |
| `POST /_control/events { type, data }` | 推任意事件，返回 `{ eventId }` |
| `GET /_control/events?since=&type=&limit=` | 事件历史（JSON） |
| `POST /_control/sse/drop` | 断开所有 SSE 连接，返回 `{ dropped }` |
| `GET /_control/requests?endpoint=&accountId=&groupId=&clientMsgId=` | 请求日志 `[{ at, endpoint, method, path, body, status, accountId, accountIds, groupId, clientMsgId }]`；`status` 为 null 表示未响应（挂起） |
| `DELETE /_control/requests` | 清空请求日志 |
| `GET /_control/messages?groupId=` | 已落地消息（含 `clientMsgId`、`senderAccountId`） |
| `GET /_control/state` | 账号、群（成员、群主、promoted、ownerLeft、forbid）、统计、当前配置 |
| `POST /_control/reset` | 清空账号、群、消息、媒体、故障规则、请求日志与未完成的定时任务，恢复**启动时**配置；保留 eventId 计数器与事件历史 |
| `GET /_control` | HTML 控制面板 |

### 故障规则

```ts
{
  endpoint: 'connect' | 'disconnect' | 'createGroup' | 'invite' | 'join' | 'promote' | 'kick' | 'leave'
          | 'members' | 'send' | 'byClientId' | 'media',
  match?: { accountId?, groupId?, clientMsgId? },  // accountId 匹配请求涉及的任一账号（含 byAccountId / creatorAccountId）
  times?: number,          // 默认 1；-1 = 一直生效
  status: number,
  body?: object,           // 缺省按状态码给出（504 → NETWORK_TIMEOUT，503 → SERVICE_UNAVAILABLE，500 → INTERNAL_ERROR…）；有 code 无 message 时自动补 message
  delayMs?: number,        // 返回前延迟
  noResponse?: boolean,    // 挂起，直到客户端断开
  apply?: boolean,         // 仍执行真实操作（send 照样落地、kick 照样移除、leave 照样退群…）
  applyDelayMs?: number,   // apply 的 send 从收到请求起多少 ms 后落地（覆盖 messageSentDelayMs）
}
```

规则在「路由 + body 校验 + 终态 / 离线 + 群存在」之后、正常处理之前匹配，按添加顺序取第一条。

常用组合：

```jsonc
// S5：第一次 send 回 504，1.5s 后落地
{ "endpoint": "send", "status": 504, "apply": true, "applyDelayMs": 1500 }
// kick 504 但已移除
{ "endpoint": "kick", "status": 504, "apply": true }
// leave 500（没退成）
{ "endpoint": "leave", "status": 500 }
// by-client-id 查询不可用 3 秒
{ "endpoint": "byClientId", "status": 503, "times": -1 }   // 之后 DELETE /_control/faults
```

## 实现说明

- 消息落地时若发送账号已变终态，推 `message_failed { code: 'ACCOUNT_SUSPENDED' | 'SESSION_EXPIRED' }`；若群已被禁写（sync 或 async），推 `message_failed { code: 'GROUP_WRITE_FORBIDDEN' }`。
- 重复 / 乱序只作用在每个 SSE 连接的输出侧：重复是同一帧连写两次；乱序是把一条事件扣住（≤ `reorderWindowMs`，上限 1000ms），让下一条先发，因此只会交换相邻两条。
- 群 id（`g_n`）、消息 id（`m_n`）、媒体 id 在 reset 后继续递增，避免与仍在运行的后端里的旧数据冲突。
- 自动限流 `config.rateLimit`：同一账号在 `windowMs` 内通过限流检查的 send 达到 `maxPerWindow` 后，下一次返回 `429` 并进入 `retryAfterSeconds` 的限流窗口。
