/** Optional browser timing boundary; uncapped experiments never consult a wall clock. */
import type { SearchConfig, SearchRequest } from './types.js';

/** Zero or omission disables the cap; reject invalid values at public entry points. */
export function validatedTimeLimit(config: Pick<SearchConfig, 'timeLimitMs'>): number {
  const limit = config.timeLimitMs === undefined ? 0 : config.timeLimitMs;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0)
    throw new Error('Decision time limit must be a nonnegative finite number');
  return limit;
}

/** Reuse an enclosing decision's deadline rather than restarting the allowance for nested search. */
export function withDecisionDeadline(request: SearchRequest): SearchRequest {
  const limit = validatedTimeLimit(request.config);
  if (request.deadline !== undefined) {
    if (!Number.isFinite(request.deadline)) throw new Error('Invalid decision deadline');
    return request;
  }
  return limit > 0 ? { ...request, deadline: performance.now() + limit } : request;
}

/** Check only between complete bounded evaluations, keeping a fully evaluated legal fallback. */
export function deadlineExpired(deadline?: number): boolean {
  return deadline !== undefined && performance.now() >= deadline;
}
