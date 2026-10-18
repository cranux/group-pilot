export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message ?? code);
  }
}

export const Errors = {
  validation: (message: string, extra: Record<string, unknown> = {}) =>
    new AppError(400, 'VALIDATION_ERROR', message, extra),
  unauthorized: (message = '未登录或登录已失效') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = '没有权限执行该操作') => new AppError(403, 'FORBIDDEN', message),
  notFound: (code: string, message: string) => new AppError(404, code, message),
  conflict: (code: string, message: string, extra: Record<string, unknown> = {}) =>
    new AppError(409, code, message, extra),
  unprocessable: (code: string, message: string, extra: Record<string, unknown> = {}) =>
    new AppError(422, code, message, extra),
  badGateway: (code: string, message: string, extra: Record<string, unknown> = {}) =>
    new AppError(502, code, message, extra),
};

/** PostgreSQL 唯一约束冲突 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}
