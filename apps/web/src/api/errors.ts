// 统一的 API 错误：后端错误体为 { error: { code, message, requestId, ...业务字段 } }。

export interface ApiErrorInit {
  status: number;
  code: string;
  message: string;
  requestId?: string | null;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  /** 除 code / message / requestId 以外的业务字段，例如 stepIndex、key。 */
  readonly details: Record<string, unknown>;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId ?? null;
    this.details = init.details ?? {};
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export function hasCode(e: unknown, code: string): boolean {
  return isApiError(e) && e.code === code;
}

/** 根据响应状态码与原始响应体文本构造 ApiError（纯函数，便于单测）。 */
export function parseErrorBody(status: number, statusText: string, bodyText: string): ApiError {
  let parsed: unknown = undefined;
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = undefined;
    }
  }
  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    const err = (parsed as { error: unknown }).error;
    if (err && typeof err === 'object') {
      const { code, message, requestId, ...rest } = err as Record<string, unknown>;
      return new ApiError({
        status,
        code: typeof code === 'string' && code ? code : `HTTP_${status}`,
        message: typeof message === 'string' ? message : statusText || `HTTP ${status}`,
        requestId: typeof requestId === 'string' ? requestId : null,
        details: rest,
      });
    }
  }
  const snippet = bodyText ? bodyText.slice(0, 200) : '';
  return new ApiError({
    status,
    code: `HTTP_${status}`,
    message: snippet || statusText || `HTTP ${status}`,
  });
}

export function networkError(cause: unknown): ApiError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new ApiError({ status: 0, code: 'NETWORK_ERROR', message: `无法连接服务器：${msg}` });
}

/** 把任意错误转换成「code + message」展示用结构。 */
export function describeError(e: unknown): { code: string; message: string; requestId: string | null; details: Record<string, unknown> } {
  if (isApiError(e)) {
    return { code: e.code, message: e.message, requestId: e.requestId, details: e.details };
  }
  if (e instanceof Error) {
    return { code: 'CLIENT_ERROR', message: e.message, requestId: null, details: {} };
  }
  return { code: 'CLIENT_ERROR', message: String(e), requestId: null, details: {} };
}
