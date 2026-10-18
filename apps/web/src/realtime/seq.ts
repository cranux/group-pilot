/**
 * WS 事件 seq 去重（纯逻辑）。
 *
 * - 首次连接：不带 sinceSeq，以服务端回的 latestSeq 作为起点；
 * - 重连：带 sinceSeq = lastSeq，由服务端补发，lastSeq 保持不变；
 * - 只处理 seq > lastSeq 的帧，其余（重复补发）丢弃。
 */
export class SeqTracker {
  private last: number | null = null;

  get lastSeq(): number | null {
    return this.last;
  }

  /** 重连时要发给服务端的 sinceSeq；首次连接返回 undefined。 */
  sinceSeqForReconnect(): number | undefined {
    return this.last === null ? undefined : this.last;
  }

  /**
   * 认证成功时调用。
   * @param latestSeq 服务端当前最大 seq（可能缺省）
   * @param resumed 本次是否带着 sinceSeq 续传
   */
  onAuthenticated(latestSeq: unknown, resumed: boolean): void {
    const latest = toSeq(latestSeq);
    if (latest === null) return;
    if (!resumed || this.last === null) {
      this.last = latest;
      return;
    }
    // 续传：保持 lastSeq，让补发的帧通过。
    // 服务端 seq 比我们记得的还小，说明服务端数据被重置，以服务端为准。
    if (latest < this.last) this.last = latest;
  }

  /** 返回 true 表示这帧是新的、应当处理。 */
  accept(seqValue: unknown): boolean {
    const seq = toSeq(seqValue);
    if (seq === null) return false;
    if (this.last !== null && seq <= this.last) return false;
    this.last = seq;
    return true;
  }
}

export function toSeq(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}
