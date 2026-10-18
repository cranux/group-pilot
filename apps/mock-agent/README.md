# @gp/mock-agent

模拟题目 2.2 的 Agent 服务（Anthropic Messages API 的 tool use 形状）。默认是一个确定性的「大脑」，也可以按 run 脚本化每一轮响应来制造坏 JSON、未知工具、超时等协议问题。

## 运行

```bash
pnpm --filter @gp/mock-agent dev       # PORT 默认 4002
CHAOS=1 pnpm --filter @gp/mock-agent start
```

| 环境变量 | 说明 |
|---|---|
| `PORT` | 默认 `4002` |
| `HOST` | 默认 `0.0.0.0` |
| `CHAOS=1` | 默认大脑的随机坏行为：10% markdown 围栏包裹 JSON、5% 前后夹文字、5% 调未知工具、5% 重复上一个 `tool_use.id`、3% 用同一个 `idempotency_key` 再调一次 `send_message`，另有独立的 5% 慢 8s |
| `DEFAULT_DELAY_MS` | 默认响应延迟 |
| `LOG=1` | 打开 fastify 请求日志 |

## 进程内启动（集成测试）

```ts
import { startMockAgent } from '@gp/mock-agent';

const agent = await startMockAgent({ port: 0 });
await agent.close();
```

`startMockAgent(opts?: { port?, host?, defaultDelayMs?, chaos?, logger? })`，`port: 0` 为随机端口，`host` 默认 `127.0.0.1`。另导出 `defaultBrain`、`defaultAudit`、`applyChaos`、`validateTools` 等纯函数。

## 业务端点

### `POST /agent/turn { runId, tools, messages }`

1. 校验 `tools`：必须恰好是 `get_recent_messages`、`send_message`、`kick_user`、`finish`；每个都有 `name`、非空 `description`、`input_schema`（`type: 'object'`，`properties` 与固定入参一致，属性类型若给出须匹配：`limit` 为 number / integer，其余为 string，`required` 覆盖全部入参）。否则 `400 { code: 'TOOLS_INVALID', message }`。缺 `runId` 或 `messages` 为空 → `400 INVALID_REQUEST`。
2. 先查该 `runId` 的脚本队列，再查全局队列；都没有则走默认大脑。
3. 默认大脑（根据 `messages` 历史推断进度）：
   - assistant 消息超过 10 条 → `finish`；
   - 没调过 `get_recent_messages` → `get_recent_messages { limit: 20 }`；
   - 没调过 `send_message` / `kick_user` → 看最后一条触发消息：匹配 `/广告|spam|kick/i` 且 `policy.autoKickEnabled` 且发送者不在 `ownPlatformUserIds` → `kick_user { platform_user_id, reason: 'spam detected' }`；否则 `send_message { text: '[bot] 收到：' + 前 100 字, idempotency_key: 'reply-' + msgId }`；没有触发消息 → `finish`；
   - 否则 `finish { summary }`（中文简述读了几条消息、发了什么 / 踢了谁、哪些工具返回了错误码）。
4. `tool_use.id` 为全局自增 `tu_<n>`，跨 run 唯一，reset 后也不归零。

### `POST /agent/audit { text, groupId }`

脚本队列优先；默认：文本含「违禁」或 `forbidden`（不区分大小写）→ `{ verdict: 'fail', reason }`，否则 `{ verdict: 'pass', reason: 'ok' }`。

## 控制接口

| 端点 | 说明 |
|---|---|
| `POST /_control/turn-script { runId?, responses: ScriptedResponse[] }` | 有 `runId` 追加到该 run 的队列，否则追加到全局队列；返回 `{ runId, queued }` |
| `POST /_control/audit-script { responses: ScriptedResponse[] }` | 追加到审计队列 |
| `GET /_control/scripts` | 查看剩余队列 |
| `GET /_control/config` / `PATCH /_control/config { defaultDelayMs?, chaos? }` | |
| `GET /_control/requests?kind=turn\|audit&runId=` | `[{ at, kind, runId, groupId, body, responseStatus, responseBody, source, chaos?, clientAborted? }]`；挂起时 `responseStatus` 为 null；`clientAborted` 表示客户端在响应写完前断开（例如后端超时） |
| `DELETE /_control/requests` | 清空请求日志 |
| `GET /_control/state` | 配置、各队列长度、日志条数 |
| `POST /_control/reset` | 清空脚本队列、请求日志，恢复**启动时**配置 |

```ts
type ScriptedResponse = {
  status?: number;          // 默认 200
  body?: string;            // 原样返回（最高优先级：坏 JSON / 围栏 / 夹文字）
  json?: unknown;           // 序列化后返回（例如缺 stop_reason、两个块）
  toolUse?: { name: string; input: unknown; id?: string };  // → 合法 tool_use 响应，id 缺省自动生成
  endTurn?: string;         // → { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
  delayMs?: number;         // turn 缺省用 defaultDelayMs，audit 缺省 0
  noResponse?: boolean;     // 挂起不响应
};
```

只给 `status`（非 2xx）时返回 `{ code: 'SCRIPTED_ERROR', message }`；只给 `delayMs`（或 2xx 的 `status`）时延迟后返回默认大脑 / 默认审计的结果。

示例（S6：坏 JSON → 未知工具 → 正常结束）：

```json
{ "runId": "<runId>", "responses": [
  { "body": "```json\n{\"stop_reason\":\"tool_use\"}\n```" },
  { "toolUse": { "name": "delete_group", "input": {} } },
  { "toolUse": { "name": "finish", "input": { "summary": "done" } } }
] }
```
