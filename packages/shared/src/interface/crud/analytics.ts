import type { Json } from "../../utils/json";

export type AnalyticsQueryOptions = {
  query: string,
  params?: Record<string, Json>,
  timeout_ms?: number,
  include_all_branches?: boolean,
};

export type AnalyticsQueryResponse = {
  result: Record<string, Json>[],
  query_id: string,
};
