/**
 * Stable error codes. Agents branch on `code`, so never rename these.
 * Every error maps to a 4xx status: Pocket gateways treat 5xx as supplier
 * failure, retry elsewhere and do not pay for the relay.
 */
export const ERROR_STATUS = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  UNSUPPORTED: 422,
  UPSTREAM_UNAVAILABLE: 424,
  INTERNAL_ERROR: 422,
  RATE_LIMITED: 429,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly field: string | undefined;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, opts: { field?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.field = opts.field;
    this.retryable = opts.retryable ?? (code === 'UPSTREAM_UNAVAILABLE' || code === 'RATE_LIMITED');
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  toBody(): ErrorBody {
    const error: ErrorBody['error'] = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.field !== undefined) error.field = this.field;
    return { error };
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; retryable: boolean; field?: string };
}
