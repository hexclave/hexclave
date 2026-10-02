/**
 * The public view combines current span writes with retained legacy events.
 */
export function pageViewTelemetrySubquery(): string {
  return `(
    SELECT
      user_id,
      started_at,
      data
    FROM default.page_views
  )`;
}
