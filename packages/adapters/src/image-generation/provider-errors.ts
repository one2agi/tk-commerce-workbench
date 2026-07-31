import { externalFailure, type ExternalFailure } from "@tk/contracts";

export function plannerRateLimited(): ExternalFailure {
  return externalFailure("retryable", "image_planner_rate_limited", "Image planner is temporarily unavailable");
}

export function plannerAuthFailed(): ExternalFailure {
  return externalFailure("fatal", "image_planner_auth_failed", "Image planner authentication failed");
}

export function plannerRetryable(code = "image_planner_retryable"): ExternalFailure {
  return externalFailure("retryable", code, "Image planner request failed");
}

export function plannerTimeout(): ExternalFailure {
  return externalFailure("retryable", "image_planner_timeout", "Image planner request timed out");
}

export function plannerSchemaInvalid(): ExternalFailure {
  return externalFailure("retryable", "image_planner_schema_invalid", "Image planner returned invalid schema");
}
