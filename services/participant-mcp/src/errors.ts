export type McpServiceErrorCode =
  | "upstream_unavailable"
  | "upstream_timeout"
  | "upstream_rejected_request"
  | "upstream_not_found"
  | "upstream_rate_limited"
  | "upstream_response_too_large"
  | "invalid_upstream_response";

export class McpServiceError extends Error {
  readonly code: McpServiceErrorCode;
  readonly retryable: boolean;

  constructor(
    code: McpServiceErrorCode,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "McpServiceError";
    this.code = code;
    this.retryable = retryable;
  }
}
