// 有序多选（建群表单的成员选择：顺序有意义，第一个 = 管理员）。

export function toggleOrdered<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export function moveItem<T>(list: readonly T[], item: T, delta: number): T[] {
  const i = list.indexOf(item);
  if (i < 0) return [...list];
  const j = Math.max(0, Math.min(list.length - 1, i + delta));
  if (i === j) return [...list];
  const out = [...list];
  out.splice(i, 1);
  out.splice(j, 0, item);
  return out;
}

export function removeItem<T>(list: readonly T[], item: T): T[] {
  return list.filter((x) => x !== item);
}

/** 建群请求的客户端校验，返回错误信息列表（空 = 通过）。 */
export function validateCreateGroup(
  creatorAccountId: string,
  memberAccountIds: readonly string[],
  onlineIds: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  if (!creatorAccountId) errors.push('请选择群主');
  if (memberAccountIds.length === 0) errors.push('至少选择 1 个成员');
  if (creatorAccountId && memberAccountIds.includes(creatorAccountId)) errors.push('成员不能包含群主');
  if (new Set(memberAccountIds).size !== memberAccountIds.length) errors.push('成员不能重复');
  const offline = [creatorAccountId, ...memberAccountIds].filter((id) => id && !onlineIds.has(id));
  if (offline.length) errors.push(`以下账号当前不在线：${[...new Set(offline)].join('、')}`);
  return errors;
}
