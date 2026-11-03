// A request owns work for at most thirty minutes; retries create a new execution ID.
export const REQUEST_EXECUTION_MAX_AGE_MS = 1_800_000;
export const REQUEST_EXECUTION_EXPIRED_MESSAGE = "Request was interrupted or exceeded its deadline. Retry the request.";

export class RequestExecutionExpiredError extends Error {
  constructor() {
    super(REQUEST_EXECUTION_EXPIRED_MESSAGE);
    this.name = "RequestExecutionExpiredError";
  }
}
