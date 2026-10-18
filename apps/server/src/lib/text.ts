/** 按字符截断（不拆代理对） */
export function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

export function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  // 去掉被截断的半个多字节字符
  return buf.toString('utf8').replace(/�+$/, '');
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
