/** Standard error contract (MASTER 8.5): {code, message_key, field_errors, retryable, correlation_id}. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    public fieldErrors: Record<string, string> = {},
    public retryable = false,
    public details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export const notFound = (what = 'RESOURCE') => new AppError(404, `${what}_NOT_FOUND`);
// Foreign resources are reported as not found, never as forbidden, so existence does not leak (M57).
export const forbidden = () => new AppError(403, 'FORBIDDEN');
export const unauthorized = () => new AppError(401, 'UNAUTHENTICATED');
export const conflict = (code: string, details?: Record<string, unknown>) => new AppError(409, code, {}, false, details);
export const badRequest = (code: string, fieldErrors: Record<string, string> = {}) => new AppError(400, code, fieldErrors);
export const unprocessable = (code: string, details?: Record<string, unknown>) => new AppError(422, code, {}, false, details);
