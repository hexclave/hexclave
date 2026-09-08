/** A report becomes customer-visible only after a staff member explicitly releases it. */
export const RELEASED_GROWTH_REPORT_FILTER = {
  publishedAt: { not: null },
  publishedByUserId: { not: null },
} as const;
