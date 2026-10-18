// 状态 / 枚举值 → 中文标签与徽标色调。

export type Tone = 'green' | 'yellow' | 'red' | 'gray' | 'blue' | 'purple';

interface LabelDef {
  label: string;
  tone: Tone;
}

type LabelTable = Record<string, LabelDef>;

export const ACCOUNT_STATUS: LabelTable = {
  idle: { label: '空闲', tone: 'gray' },
  online: { label: '在线', tone: 'green' },
  rate_limited: { label: '限流中', tone: 'yellow' },
  disconnected: { label: '离线', tone: 'gray' },
  suspended: { label: '已停用', tone: 'red' },
  session_expired: { label: '会话失效', tone: 'red' },
};

export const GROUP_STATUS: LabelTable = {
  active: { label: '正常', tone: 'green' },
  unreachable: { label: '不可达', tone: 'red' },
  left: { label: '已退群', tone: 'gray' },
};

export const MEMBER_ROLE: LabelTable = {
  creator: { label: '群主', tone: 'purple' },
  admin: { label: '管理员', tone: 'blue' },
  member: { label: '成员', tone: 'gray' },
};

export const JOB_STATUS: LabelTable = {
  running: { label: '进行中', tone: 'yellow' },
  finished: { label: '已完成', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
};

export const JOB_TYPE: Record<string, string> = {
  create_group: '建群',
  leave_all: '全员退群',
};

export const DELIVERY_STATUS: LabelTable = {
  queued: { label: '排队中', tone: 'gray' },
  accepted: { label: '已受理', tone: 'blue' },
  sent: { label: '已发出', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  unknown: { label: '待确认', tone: 'yellow' },
  cancelled: { label: '已取消', tone: 'red' },
};

export const MESSAGE_SOURCE: LabelTable = {
  inbound: { label: '入站', tone: 'gray' },
  operator: { label: '操作员', tone: 'blue' },
  agent: { label: 'Agent', tone: 'purple' },
  sequence: { label: '序列', tone: 'yellow' },
};

export const AGENT_RUN_STATUS: LabelTable = {
  running: { label: '运行中', tone: 'yellow' },
  finished: { label: '已完成', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  blocked: { label: '审计阻断', tone: 'red' },
  cancelled: { label: '已取消', tone: 'gray' },
};

export const END_REASON: Record<string, string> = {
  final: '正常结束',
  budget_exhausted: '步数耗尽',
  wall_clock: '超出 60 秒时限',
  protocol_errors: '连续协议错误',
  audit_blocked: '审计无结论被阻断',
  cancelled: '已取消',
};

export const STEP_KIND: LabelTable = {
  tool_use: { label: '工具调用', tone: 'blue' },
  final: { label: '结束', tone: 'green' },
  protocol_error: { label: '协议错误', tone: 'red' },
};

export const AUDIT_VERDICT: LabelTable = {
  pass: { label: '通过', tone: 'green' },
  fail: { label: '拒绝', tone: 'red' },
  unavailable: { label: '无结论', tone: 'yellow' },
};

export const SEQ_RUN_STATUS: LabelTable = {
  running: { label: '运行中', tone: 'yellow' },
  finished: { label: '已完成', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  stopped: { label: '已停止', tone: 'gray' },
};

export const SEQ_STEP_STATUS: LabelTable = {
  pending: { label: '等待中', tone: 'gray' },
  accepted: { label: '已受理', tone: 'blue' },
  sent: { label: '已发出', tone: 'green' },
  skipped: { label: '已跳过', tone: 'yellow' },
  failed: { label: '失败', tone: 'red' },
};

export const ACCOUNT_ROLE: Record<string, string> = {
  admin: '管理员（群主/管理员发送）',
  member: '普通成员',
};

export function lookup(table: LabelTable, value: string | null | undefined): LabelDef {
  if (value === null || value === undefined || value === '') return { label: '—', tone: 'gray' };
  return table[value] ?? { label: value, tone: 'gray' };
}

/** 常见错误码的中文说明，与 code + message 一起展示。 */
export const ERROR_HINTS: Record<string, string> = {
  UNAUTHORIZED: '未登录或会话已失效',
  FORBIDDEN: '当前角色无权执行此操作',
  VALIDATION_ERROR: '请求参数不合法',
  NETWORK_ERROR: '网络错误',
  ACCOUNT_NOT_FOUND: '账号不存在',
  ILLEGAL_TRANSITION: '该状态转移不在转移表上',
  CAS_CONFLICT: '账号状态已被其他操作修改',
  ACCOUNT_NOT_ONLINE: '有账号不在线（建群要求所有账号 online）',
  ACCOUNT_NOT_IN_GROUP: '该账号不在这个群里',
  ACCOUNT_UNAVAILABLE: '该账号当前不可用（空闲 / 离线 / 终态）',
  SEQUENCE_ALREADY_RUNNING: '该群已有运行中的序列',
  UNRESOLVED_PLACEHOLDER: '存在无法解析的占位符',
  JOIN_TIMEOUT: '等待入群事件超时（10 秒）',
  INVITE_EXPIRED: '邀请链接已过期',
  INVITE_NOT_READY: '邀请链接尚未就绪',
  NO_PERMISSION: '无权限',
  OWNER_LEFT: '群主已退群',
  NOT_MEMBER_YET: '对方尚未入群',
  ACCOUNT_OFFLINE: '账号离线',
  ACCOUNT_SUSPENDED: '账号已被停用',
  SESSION_EXPIRED: '账号会话失效',
  NETWORK_TIMEOUT: '网关超时',
  GROUP_WRITE_FORBIDDEN: '群不可写',
  ACCOUNT_TERMINAL: '账号进入终态，消息已取消',
  GROUP_UNREACHABLE: '群不可达',
  NOT_FOUND: '资源不存在',
};

/** 建群 / 退群 job 的步骤说明。 */
export function describeJobStep(step: string): string {
  if (step === 'create') return '网关建群';
  if (step === 'invite') return '申请邀请链接';
  if (step === 'promote') return '提升管理员';
  const m = /^(join|leave):(.+)$/.exec(step);
  if (m) return m[1] === 'join' ? `账号 ${m[2]} 入群` : `账号 ${m[2]} 退群`;
  return step;
}
