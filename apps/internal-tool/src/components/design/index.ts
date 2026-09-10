/**
 * Local design primitives for the internal tool. They deliberately mirror the dashboard's
 * design-components (same tokens, same glassmorphic surfaces, same badge/button palettes) without
 * importing them: the internal tool is a separate Next app with its own Tailwind build, and pulling
 * in `@hexclave/dashboard-ui-components` would drag along the dashboard's provider stack. Keep the
 * visuals here in sync with apps/dashboard/DESIGN-GUIDE.md.
 */
export { cn } from "./cn";
export { Badge, type BadgeColor } from "./badge";
export { Button, type ButtonVariant, Divider, FieldLabel, Input, Pill, Select, Textarea } from "./controls";
export { BarRow, type ChartColor, chartColors, chartTrackClass, LegendItem } from "./charts";
export { SortHeader, tableClasses } from "./table";
export { SelectionCheckbox, SelectionToolbar } from "./selection";
export { Alert, Card, EmptyState, MetricCard, Tooltip } from "./surfaces";
export { Resizer, useResizableWidth } from "./resize";
