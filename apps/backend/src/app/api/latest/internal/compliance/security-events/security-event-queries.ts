const SECURITY_EVENT_CATEGORY_EXPRESSION = `multiIf(
  event_type = '$sign-in-attempt', 'sign_in_attempt',
  event_type = '$permission-check', 'permission_check',
  event_type = '$user-restricted', 'user_restricted',
  'sign_up_rule'
)`;

export function buildSecurityEventsSummaryQuery(sharedWhere: string): string {
  return `
          SELECT
            tupleElement(facet, 1) AS kind,
            tupleElement(facet, 2) AS bucket,
            count() AS count
          FROM analytics_internal.events
          ARRAY JOIN [
            ('category', ${SECURITY_EVENT_CATEGORY_EXPRESSION}),
            ('outcome', concat(
              ${SECURITY_EVENT_CATEGORY_EXPRESSION},
              '.',
              COALESCE(
                NULLIF(CAST(data.outcome, 'Nullable(String)'), ''),
                if(CAST(data.action, 'Nullable(String)') = 'reject', 'denied', 'restricted')
              )
            )),
            ('reason', multiIf(
              event_type = '$sign-in-attempt', concat('sign_in_attempt.', NULLIF(CAST(data.failure_reason, 'Nullable(String)'), '')),
              event_type = '$permission-check', concat('permission_check.', NULLIF(CAST(data.permission_id, 'Nullable(String)'), '')),
              event_type = '$user-restricted', concat('user_restricted.', NULLIF(CAST(data.restricted_reason, 'Nullable(String)'), '')),
              concat('sign_up_rule.', NULLIF(CAST(data.action, 'Nullable(String)'), ''))
            ))
          ] AS facet
          ${sharedWhere}
            AND event_type IN ('$sign-in-attempt', '$permission-check', '$user-restricted', '$sign-up-rule-trigger')
          GROUP BY kind, bucket
          HAVING bucket IS NOT NULL
        `;
}

export function buildSecurityEventsOffendersQuery(sharedWhere: string): string {
  return `
          SELECT
            tupleElement(facet, 1) AS kind,
            tupleElement(facet, 2) AS value,
            count() AS count
          FROM analytics_internal.events
          ARRAY JOIN [
            ('email', NULLIF(CAST(data.email, 'Nullable(String)'), '')),
            ('ip', NULLIF(CAST(data.ip_info.ip, 'Nullable(String)'), '')),
            ('country', NULLIF(CAST(data.ip_info.country_code, 'Nullable(String)'), ''))
          ] AS facet
          ${sharedWhere}
            AND (
              (event_type = '$sign-in-attempt' AND CAST(data.outcome, 'Nullable(String)') = 'failed')
              OR event_type IN ('$permission-check', '$user-restricted')
              OR (event_type = '$sign-up-rule-trigger' AND CAST(data.action, 'Nullable(String)') IN ('reject', 'restrict'))
            )
            AND value IS NOT NULL
          GROUP BY kind, value
          ORDER BY kind ASC, count DESC
          LIMIT 10 BY kind
        `;
}
