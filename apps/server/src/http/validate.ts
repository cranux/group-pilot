import type { z } from 'zod';
import { Errors } from '../lib/errors.js';

export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw Errors.validation(issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '), { issues });
  }
  return result.data;
}
