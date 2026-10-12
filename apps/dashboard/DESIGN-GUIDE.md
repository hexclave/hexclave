# Hexclave Dashboard Design Guide

This guide defines the source of truth for dashboard UI design and implementation.
It is intentionally written for both humans and AI agents.

If this guide conflicts with older examples in the codebase, follow this guide.

---

## 1) Core Principle (Non-Negotiable)

Always prefer components from `apps/dashboard/src/components/design-components`.

- Do not build new ad-hoc visual primitives (for example custom `GlassCard`, custom `ChartCard`, custom badge pills, custom pill toggles, custom list rows) if a design-components component exists.
- If the desired UI can be achieved by tweaking/customizing/extending a design-components component, do that instead of creating a page-local alternative.
- In all cases, default to design-components first; only use a non-design-components approach when there is absolutely no viable way to achieve the result with design-components.
- Use `@/components/ui/*` primitives only when no design-components equivalent exists, or when the design-components component intentionally wraps the primitive.
- Match existing design-components behavior:
  - hover-exit transitions (`transition-* duration-150 hover:transition-none`)
  - glassmorphic surfaces where appropriate
  - semantic variants for alerts/badges
  - async-safe click handlers via design-components primitives

---

## 2) Fast Decision Tree

Use this when implementing a new dashboard UI quickly:

1. Need a section container/card?
   - Use `DesignCard`.
   - For chart-heavy analytics surfaces (especially Recharts tooltips/overflow), use `DesignAnalyticsCard`.
2. Need user-facing status/info/warning/error message?
   - Use `DesignAlert`.
3. Need small semantic label (sent, failed, queued, active)?
   - Use `DesignBadge`.
4. Need user action button, especially async?
   - Use `DesignButton`.
5. Need text input/selectors in design-components surfaces?
   - Use `DesignInput` and `DesignSelectorDropdown`.
6. Need a segmented/pill switcher?
   - Use `DesignPillToggle`.
7. Need category tabs with count badges?
   - Use `DesignCategoryTabs`.
8. Need row/list item with action buttons/menu?
   - Use `DesignListItemRow` (or `DesignUserList` for user rows).
9. Need settings/property grid editor?
   - Use `DesignEditableGrid`.
10. Need interactive / sortable / searchable data table?
   - Use `DataGrid` + `useDataSource` + `createDefaultDataGridState` from `@hexclave/dashboard-ui-components`.
11. Need dropdown action/selector/toggle menu?
   - Use `DesignMenu`.
12. Need a focus-trapping modal/dialog (confirmation, rich modal, tester, form)?
   - Use `DesignDialog`.

---

## 3) Allowed Base UI Usage

`@/components/ui/*` can still be used for primitives that do not currently have a design-components equivalent:

- confirmation-pattern helpers like `ActionDialog` / `FormDialog` (these wrap an `onClick`/form submit lifecycle and remain useful when you only need a dressed-up confirm/submit prompt)
- side-sheets/popovers (`Sheet`, `Popover`, etc.)
- complex layout containers where design-components does not provide one
- highly specialized editor internals

For any general-purpose modal surface (rich detail dialogs, tester surfaces, data dialogs, settings popovers presented as modals), use `DesignDialog` instead of wiring `Dialog` + `DialogContent` + `DialogHeader` etc. by hand. `DesignDialog` is the canonical glassmorphic dialog surface for the dashboard — see §4.14 below.

When using a primitive directly:

- keep visual style compatible with design-components surfaces
- do not duplicate a design-components component API locally
- consider creating/extending a design-components component instead of repeating local patterns

---

## 3.1) Best Practices (Always Apply)

- Build with design-components primitives first, then add minimal page-level styling.
- Keep components composable: pass data/config via props instead of hardcoding display logic.
- Favor semantic APIs (`variant`, `color`, `gradient`) over raw class-heavy style forks.
- Use accessible defaults:
  - clear labels for icon-only controls
  - keyboard focus visibility (`focus-visible:*`)
  - semantic roles where applicable
- Keep behavior deterministic:
  - one visual language per screen
  - one status-color mapping across all routes
  - one interaction pattern per control type

---

## 3.2) Color System (Light + Dark Theme)

Use semantic tokens and design-components variants first. Avoid ad-hoc hardcoded colors unless there is a documented semantic reason.

### Theme token usage priority

1. Use component variants (`DesignAlert`, `DesignBadge`, `DesignCard` gradient, tab/toggle gradients).
2. Use semantic Tailwind tokens (`bg-background`, `text-foreground`, `text-muted-foreground`, `border-border`).
3. Use opacity layers for subtle surfaces (for example `bg-foreground/[0.03]`).

### Surface and text rules

- Primary surfaces: `bg-background` + subtle ring/border.
- Secondary/muted surfaces: low-opacity foreground overlays.
- Primary text: `text-foreground`.
- Secondary text: `text-muted-foreground`.
- Never use pure black/white hardcoded utility values for app UI text/surfaces.

### Semantic state colors

- Success: green/emerald (`DesignAlert variant="success"`, `DesignBadge color="green"`)
- Error: red (`DesignAlert variant="error"`, `DesignBadge color="red"`)
- Warning: orange/amber (`DesignAlert variant="warning"`, `DesignBadge color="orange"`)
- Info: blue/cyan (`DesignAlert variant="info"`, `DesignBadge color="blue"` or `"cyan"`)

### Light vs dark guidance

- Ensure every custom color choice has dark-mode readability.
- In dark mode, reduce high-contrast fills and rely on low-opacity tints + rings.
- Keep contrast high for text and medium for non-critical chrome.

---

## 3.3) Typography System

Keep typography concise and consistent. Prefer existing design-components/header patterns.

### Recommended scale and usage

- Page title: `text-xl sm:text-2xl font-semibold tracking-tight`
- Section heading: `text-xs font-semibold uppercase tracking-wider`
- Body/default control text: `text-sm`
- Secondary metadata: `text-xs text-muted-foreground`
- Micro labels/badges: `text-[10px]` to `text-[11px]`

### Typography rules

- Use uppercase tracking only for section labels and compact metadata headings.
- Avoid introducing new arbitrary font sizes when an existing size serves the purpose.
- Keep line-length short in cards and alerts for scanability.
- For numeric/stat values, use tabular numerals where needed.

---

## 3.4) Spacing and Layout Guidelines

Use a compact, repeatable spacing rhythm.

### Spacing rhythm

- `gap-1` (4px): tight icon/text coupling
- `gap-2` (8px): compact control spacing
- `gap-3` (12px): standard row spacing
- `gap-4` (16px): section-internal spacing
- `gap-5` (20px): larger section grouping

### Padding rhythm

- `p-2` / `px-3 py-2`: compact controls
- `p-3`: standard compact blocks
- `p-4` to `p-5`: card content/major sections

### Layout rules

- Use `rounded-2xl` for major containers/cards.
- Use `rounded-xl` for controls (inputs, toggles, small cards).
- Preserve visual hierarchy:
  - page spacing > section spacing > control spacing
- Avoid mixing unrelated spacing scales inside a single component.

---

## 3.5) Animation and Micro-Interactions

Motion should feel immediate, subtle, and informative.

### Core motion rules

- No hover-enter delay transitions.
- Use hover-exit transitions: `transition-* duration-150 hover:transition-none`.
- Keep interaction transitions short and subtle.
- Do not use large animated movement in dense admin surfaces.

### Duration guidance

- `50ms-100ms`: very small icon feedback
- `150ms`: standard hover/focus/press recovery
- `200ms-300ms`: layout/state transitions (panel collapse, sheet-like reveals)
- `>300ms`: only ambient/non-critical effects

### Micro-interaction patterns

- Hover:
  - text brightens slightly
  - ring/shadow intensifies subtly
- Press:
  - instant feedback (no delayed press animation)
- Focus:
  - visible `focus-visible` ring on all interactive elements
- Loading:
  - use design-components built-in loading states (`DesignButton`, tabs/toggles with async)
  - never freeze the UI without feedback

### Motion accessibility

- Respect `prefers-reduced-motion` for non-essential effects.
- Keep micro-interactions understandable without relying on animation alone.

---

## 3.6) Best-Practice Checklist (Visual + UX)

- [ ] Uses design-components primitives before custom wrappers.
- [ ] Uses semantic variants/colors instead of custom status styles.
- [ ] Works in both light and dark themes with readable contrast.
- [ ] Uses approved typography scale and hierarchy.
- [ ] Uses consistent spacing rhythm (`gap-2/3/4`, `p-3/4/5`).
- [ ] Uses snappy hover-exit transitions and clear focus rings.
- [ ] Provides clear loading/disabled/empty/error states.

---

## 4) Component-by-Component Contract

This section is prescriptive: use these components with these props for these scenarios.

### 4.1 `DesignCard`

File: `apps/dashboard/src/components/design-components/card.tsx`

Use for:

- page sections
- grouped controls
- analytics panels
- list containers
- glassmorphic blocks used in email/project pages

Props you should use most:

- `title`, `icon`, optional `subtitle` for section headers
- `gradient`: `"blue" | "cyan" | "purple" | "green" | "orange" | "default"`
- `glassmorphic` (optional explicit override)
- `contentClassName` for content spacing overrides

Important behavior:

- If `title` is provided, `icon` is required by type.
- Layout is auto-derived:
  - `title + subtitle` -> full header
  - `title only` -> compact header
  - no title -> body-only card
- `useGlassmorphicDefault()` makes nested components default to glassmorphic behavior.

Default recommendation:

- for dashboard sections, use `glassmorphic` style (either explicit or via nesting context)
- use `gradient="default"` unless there is semantic reason for colored tint

### 4.1.1 `DesignAnalyticsCard` (and chart helpers)

File: `apps/dashboard/src/components/design-components/analytics-card.tsx`

Use for:

- chart-heavy analytics shells on overview and metrics surfaces
- cards where chart tooltips need to escape clipping/stacking issues
- previously duplicated glass analytics wrappers (`ChartCard`, `GlassCard` clones)

Exports:

- `DesignAnalyticsCard`
- `DesignAnalyticsCardHeader`
- `DesignChartLegend`
- `useInfiniteListWindow`
- `DesignInfiniteScrollList`

`DesignAnalyticsCard` props:

- `gradient`: `"blue" | "cyan" | "purple" | "green" | "orange" | "slate"`
- `className`

Rules:

- prefer `DesignAnalyticsCard` over local chart wrappers for overview/analytics cards
- keep chart implementation local (Recharts config, data transforms), but keep shell/legend/list plumbing shared
- use `DesignChartLegend` instead of hand-rolled dot/label legend rows when layout matches
- use `useInfiniteListWindow` for incremental scrolling lists in analytics/list tabs

### 4.2 `DesignAlert`

File: `apps/dashboard/src/components/design-components/alert.tsx`

Use for:

- save success/failure
- warning states (for example SMTP/provider configuration warnings)
- informational notices

Props:

- `variant`: `"default" | "success" | "error" | "warning" | "info"`
- `title`
- `description`
- `glassmorphic` when rendered on glass surfaces

Rules:

- use semantic variant instead of custom alert class combinations
- keep title short and actionable
- put longer explanation in `description`

### 4.3 `DesignBadge`

File: `apps/dashboard/src/components/design-components/badge.tsx`

Use for:

- status chips (sent, failed, queued, draft, active)
- small semantic labels in headers and lists

Props:

- `label`
- `color`: `"blue" | "cyan" | "purple" | "green" | "orange" | "red"`
- `icon` (optional)
- `size`: `"sm" | "md"`
- `contentMode`: `"both" | "text" | "icon"`

Rules:

- choose color by meaning, not preference
- use `contentMode="icon"` only when `icon` is provided
- for icon-only badges, accessibility is already handled via `aria-label`

### 4.4 `DesignButton`

File: `apps/dashboard/src/components/design-components/button.tsx`

Use for:

- all primary/secondary actions in dashboard surfaces
- async submit/save/delete actions

Props:

- `variant`: `"default" | "destructive" | "outline" | "secondary" | "ghost" | "link" | "plain"`
- `size`: `"default" | "sm" | "lg" | "icon"`
- `onClick` (can be async)
- `loading` (optional controlled mode)
- `loadingStyle`: `"spinner" | "disabled"`
- `asChild` if composition with links/triggers is needed

Rules:

- prefer `DesignButton` over base `Button` for async behavior and consistent loading semantics
- do not hand-roll loading spinners for standard button actions

### 4.5 `DesignInput`

File: `apps/dashboard/src/components/design-components/input.tsx`

Use for:

- text fields inside design-components surfaces
- compact filter fields and inline settings inputs

Props:

- `size`: `"sm" | "md" | "lg"`
- `prefixItem` for fixed prefix UI
- `leadingIcon` for icon-leading input
- regular input props (placeholder, value, onChange, disabled, etc.)

Rules:

- use `prefixItem` for prefixed values (domains/paths/currency symbols)
- use `leadingIcon` for search or query fields

### 4.6 `DesignSelectorDropdown`

File: `apps/dashboard/src/components/design-components/select.tsx`

Use for:

- standard single-select dropdowns in dashboard settings and filters

Props:

- `value`
- `onValueChange`
- `options: { value, label, disabled? }[]`
- `placeholder`
- `size`: `"sm" | "md" | "lg"`
- `disabled`

Rules:

- prefer this instead of raw `Select` in feature pages unless custom behavior is required

### 4.7 `DesignPillToggle`

File: `apps/dashboard/src/components/design-components/pill-toggle.tsx`

Use for:

- segmented controls
- viewport switches
- compact mode switches

Props:

- `options: { id, label, icon? }[]`
- `selected`
- `onSelect`
- `size`: `"sm" | "md" | "lg"`
- `gradient`
- `showLabels` (set false for icon-only controls)
- `glassmorphic`

Rules:

- do not create custom inline pill toggle components if this fits
- use `showLabels={false}` only with clear icons and tooltip-friendly labels

### 4.8 `DesignCategoryTabs`

File: `apps/dashboard/src/components/design-components/tabs.tsx`

Use for:

- top-level category switching with optional count badges

Props:

- `categories: { id, label, count?, badgeCount? }[]`
- `selectedCategory`
- `onSelect`
- `showBadge`
- `size`: `"sm" | "md"`
- `gradient`
- `glassmorphic`

Rules:

- use for category-level navigation, not micro toggles
- if there are no category counts and control is small, `DesignPillToggle` may be better

### 4.9 `DesignMenu`

File: `apps/dashboard/src/components/design-components/menu.tsx`

Use for:

- standard row/card action menus
- selector menu (radio group)
- toggles menu (checkbox items)

Variants and required props:

- `variant="actions"` with `items`
- `variant="selector"` with `options`, `value`, `onValueChange`
- `variant="toggles"` with `options`, `onToggleChange`

Common shared props:

- `trigger`: `"button" | "icon"`
- `triggerLabel`
- `triggerIcon`
- `align`
- `label`
- `withIcons`

Rules:

- prefer this over local `DropdownMenu` wrappers for common action menus

### 4.10 `DesignListItemRow` and `DesignUserList`

File: `apps/dashboard/src/components/design-components/list.tsx`

Use for:

- structured list rows with optional per-row actions
- user activity/user list rows

`DesignListItemRow` props:

- `title`, optional `subtitle`
- `icon`
- `size`: `"sm" | "lg"`
- `buttons` (direct actions or menu actions)
- `onClick`

`DesignUserList` props:

- `users: { name, email, time, color? }[]`
- `onUserClick`
- `showAvatar`
- `gradient`: `"blue-purple" | "cyan-blue" | "none"`

Rules:

- use `size="sm"` for dense lists
- use `size="lg"` for card-like list entries
- replace custom row/card list items with this unless layout is truly unique

### 4.11 `DesignEditableGrid`

File: `apps/dashboard/src/components/design-components/editable-grid.tsx`

Use for:

- key/value settings editors
- mixed-type setting controls
- deferred save/discard patterns

Props:

- `items` (typed union: `text`, `boolean`, `dropdown`, `custom-dropdown`, `custom-button`, `custom`)
- shared item metadata: `itemKey`, `icon`, `name`, optional `description` and `tooltip`
- `columns`: `1 | 2`
- `size`: `"sm" | "md"`
- `deferredSave`, `hasChanges`, `onSave`, `onDiscard`
- `externalModifiedKeys`

Rules:

- prefer this for config forms that are row-based and editable inline
- layout is a flat label/value grid (no per-field cards); editable values use white controls in light mode
- use deferred save mode when many fields should be committed together
- text values enter an explicit edit state; Enter saves and Escape cancels
- omit `onUpdate` or set `readOnly` for a non-editable value
- use `description` for persistent context and `tooltip` only for secondary details
- `custom-dropdown` owns its popover; provide both `triggerContent` and `popoverContent`
- for page-local editable triggers outside the typed union, reuse `designEditableGridControlClassName` / `designEditableGridPopoverClassName`

### 4.12 `DataGrid` + `useDataSource` + `createDefaultDataGridState`

Package: `@hexclave/dashboard-ui-components`

Use for:

- interactive, sortable, searchable data tables
- any table with more than ~20 rows or that needs pagination, column visibility, quick search, or CSV export

Canonical pattern:

```tsx
import { DataGrid, useDataSource, createDefaultDataGridState, type DataGridColumnDef } from "@hexclave/dashboard-ui-components";

const columns: DataGridColumnDef<MyRow>[] = [
  { id: "name", header: "Name", accessor: "name", width: 200, type: "string" },
  { id: "status", header: "Status", accessor: "status", width: 120, type: "singleSelect",
    valueOptions: [{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }],
    renderCell: ({ value }) => <DesignBadge label={String(value)} color={value === "active" ? "green" : "red"} size="sm" /> },
];

const [gridState, setGridState] = useState(() => createDefaultDataGridState(columns));
const gridData = useDataSource({
  data: myRows,
  columns,
  getRowId: (row) => row.id,
  sorting: gridState.sorting,
  quickSearch: gridState.quickSearch,
  pagination: gridState.pagination,
  paginationMode: "client",
});

<DataGrid
  columns={columns}
  rows={gridData.rows}
  getRowId={(row) => row.id}
  totalRowCount={gridData.totalRowCount}
  isLoading={gridData.isLoading}
  state={gridState}
  onChange={setGridState}
  toolbar={false}       // set to false to hide; omit for default toolbar
  onRowClick={(row) => handleClick(row)}
  maxHeight={400}
/>
```

Key props:

- `columns` (`DataGridColumnDef[]`): column definitions with `id`, `header`, `accessor`, `type`, optional `renderCell`, optional `cellOverflow`
- `rows` (`TRow[]`): always `gridData.rows` from `useDataSource`, NEVER your raw array
- `getRowId` (`(row) => RowId`): unique row identifier (`RowId` is `string`)
- `state` / `onChange`: fully controlled grid state (sorting, pagination, search, visibility)
- `totalRowCount`: total rows for pagination display
- `toolbar`: `false` to hide, omit for default, or render function for custom
- `onRowClick`: optional row click handler
- `maxHeight`: max pixel height before scrolling
- `rowHeight`: number (default 44) for fixed height, or `"auto"` for dynamic row measurement
- `estimatedRowHeight`: estimated row height for the virtualizer when `rowHeight="auto"` (default 44)

Cell overflow:

- `cellOverflow: "truncate"` (default): single-line with text-overflow ellipsis
- `cellOverflow: "wrap"`: content wraps naturally; rows grow when `rowHeight="auto"`
- Use `cellOverflow: "wrap"` for badge lists, permission chips, multi-line text
- Use default truncate for UUIDs, emails, dates, single-line text

```tsx
const columns: DataGridColumnDef<MyRow>[] = [
  { id: "userId", header: "User ID", width: 130 },                            // truncates (default)
  { id: "auth", header: "Auth methods", width: 150, cellOverflow: "wrap",     // badges wrap, row grows
    renderCell: ({ row }) => (
      <div className="flex flex-wrap gap-1">
        {row.authTypes.map((t) => <Badge key={t}>{t}</Badge>)}
      </div>
    ),
  },
];

<DataGrid columns={columns} rowHeight="auto" estimatedRowHeight={48} ... />
```

Rules:

- always initialize state with `createDefaultDataGridState(columns)` — never build the state object by hand
- always use `useDataSource` to process data — the grid does not sort/filter/paginate on its own
- columns must be stable across renders (define outside component or wrap in `useMemo`)
- `renderCell` must be a pure function — no React hooks inside it
- read the full JSDoc on the `DataGrid` component for iron rules and advanced usage

### 4.13 `CursorBlastEffect`

File: `apps/dashboard/src/components/design-components/cursor-blast-effect.tsx`

Use for:

- optional high-feedback interactions (playground/internal prototyping)

Props:

- `blastLifetimeMs`
- `maxActiveBlasts`
- `rageClickThreshold`
- `rageClickWindowMs`
- `rageClickRadiusPx`
- `containerRef`

Rules:

- keep as optional enhancement, not required UX
- avoid distracting overuse in production-critical flows

### 4.14 `DesignDialog`

File: `packages/dashboard-ui-components/src/components/dialog.tsx` (re-exported through `@/components/design-components`)

Use for:

- any focus-trapping modal in the dashboard (confirmations, rich detail dialogs, tester surfaces, settings forms presented as modals)
- replacing hand-wired `Dialog` + `DialogContent` + `DialogHeader` combinations from `@hexclave/ui`

Props you should use most:

- `trigger`: element wrapped in a `DialogTrigger`. Skip when controlling externally via `open`/`onOpenChange`/`defaultOpen`.
- `size`: `"sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl" | "6xl" | "7xl" | "full"` (defaults to `"lg"`).
- `variant`: `"glassmorphic"` (default) or `"plain"`. `glassmorphic` applies the dashboard's blurred surface + dimmed overlay.
- `icon`: a Phosphor icon component (or `null` to skip the chip).
- `title` / `description`: standard header text. `title` is automatically wired into `DialogTitle` for a11y.
- `headerContent`: rich content rendered below the icon/title block — use this for embedded summary cards, metric tiles, or status pills inside the header.
- `customHeader`: complete override of the header region. You become responsible for rendering an accessible `DialogTitle`.
- `footer`: footer node rendered in a styled bottom bar. Wrap close buttons in `DesignDialogClose asChild` (re-exported by the same module).
- `noBodyPadding`: disable the default `px-6 py-4` padding for full-bleed body content.
- `hideTopCloseButton`: hide the top-right "X" rendered by `DialogContent` for fully custom close affordances.
- `bodyClassName` / `headerClassName` / `footerClassName` / `overlayClassName` / `className`: fine-grained class overrides for each region.

Re-exports (import these from the same module — do not mix with `@hexclave/ui` for the same dialog):

- `DesignDialogClose` (alias of `DialogClose`)
- `DesignDialogTrigger` (alias of `DialogTrigger`)
- `DesignDialogTitle` / `DesignDialogDescription`
- `DesignDialogRoot` (alias of `Dialog`) for the rare cases that need raw `Dialog.Root` semantics

Rules:

- Do not write `Dialog` + `DialogContent` + `DialogHeader` + `DialogBody` + `DialogFooter` directly when building a full-page modal — use `DesignDialog`.
- When refactoring an existing dialog, preserve any `headerContent` summary cards, sparklines, or stat tiles by passing them via the `headerContent` prop rather than crafting a `customHeader` from scratch.
- Footer slot already provides border + background + responsive flex; don't re-add wrapping divs with the same styling.
- Use the smallest `size` that fits your content. `md`/`lg` for confirmations, `2xl`/`3xl` for detail dialogs with summary cards, `5xl`+ for tester/forms.

Common shapes (for AI agents):

```tsx
// Confirmation
<DesignDialog
  trigger={<DesignButton size="sm">Open</DesignButton>}
  icon={InfoIcon}
  title="Heads up"
  description="You're about to do something."
  footer={
    <DesignDialogClose asChild>
      <DesignButton variant="secondary" size="sm">Close</DesignButton>
    </DesignDialogClose>
  }
>
  <p className="text-sm">Body content.</p>
</DesignDialog>

// Rich modal with summary card
<DesignDialog
  open={open}
  onOpenChange={setOpen}
  size="2xl"
  icon={PulseIcon}
  title="Rule trigger history"
  description="3 total triggers"
  headerContent={<SummaryCard />}
  footer={
    <DesignDialogClose asChild>
      <DesignButton variant="secondary" size="sm">Close</DesignButton>
    </DesignDialogClose>
  }
>
  {/* recent triggers list */}
</DesignDialog>

// Wide tester / form
<DesignDialog
  trigger={<DesignButton size="sm">Open tester</DesignButton>}
  size="5xl"
  icon={FlaskIcon}
  title="Test sign-up rules"
  description="Simulate a sign-up request."
  footer={
    <>
      <DesignDialogClose asChild>
        <DesignButton variant="secondary" size="sm">Cancel</DesignButton>
      </DesignDialogClose>
      <DesignButton size="sm">Run test</DesignButton>
    </>
  }
>
  <TesterForm />
</DesignDialog>
```

---

## 5) Route-Specific Guidance (Project + Email Surfaces)

Reference surfaces:

- `apps/dashboard/src/app/(main)/(protected)/projects/[projectId]`
- `apps/dashboard/src/app/(main)/(protected)/projects/[projectId]/emails`
- `apps/dashboard/src/app/(main)/(protected)/projects/[projectId]/email-drafts`
- `apps/dashboard/src/app/(main)/(protected)/projects/[projectId]/email-templates`
- `apps/dashboard/src/app/(main)/(protected)/projects/[projectId]/email-themes`

Current pattern in these pages often uses custom card/header/pill components. New and refactored code should standardize to design-components primitives as follows.

### 5.0 `/projects/[projectId]/(overview)` analytics surfaces

Use:

- chart/list shells: `DesignAnalyticsCard`
- compact chart headers: `DesignAnalyticsCardHeader`
- stacked chart legends: `DesignChartLegend`
- incremental list rendering: `useInfiniteListWindow` (or `DesignInfiniteScrollList` where it fits)

Avoid:

- page-local `ChartCard` wrappers
- duplicated `IntersectionObserver` list window logic per card

### 5.1 `/projects/[projectId]/emails`

Use:

- section containers: `DesignCard` (`title`, `icon`, optional `subtitle`, `gradient`)
- alerts: `DesignAlert` (`variant` by state)
- status chips: `DesignBadge` (`green` for sent, `red` for failed)
- actions: `DesignButton`
- table: `DataGrid` + `useDataSource` + `createDefaultDataGridState`

Avoid:

- custom `GlassCard`
- custom status-badge component
- raw `Alert` unless special composition is required

### 5.2 `/projects/[projectId]/email-drafts` (list)

Use:

- list container: `DesignCard`
- row items: `DesignListItemRow` (`size="lg"` for card rows or `size="sm"` for dense list)
- row menus: `DesignMenu` with `variant="actions"`
- empty state action: `DesignButton`

Avoid:

- custom `DraftCard` for standard list row behavior

### 5.3 `/projects/[projectId]/email-drafts/[draftId]` (editor)

Use:

- status/sync alerts: `DesignAlert`
- scope/status chips: `DesignBadge`
- editor side controls: `DesignButton`, `DesignSelectorDropdown`, `DesignInput` as needed

Keep:

- specialized editor layout systems if no design-components equivalent exists

### 5.4 `/projects/[projectId]/email-templates`

Use:

- template item containers: `DesignCard` (`gradient` per semantic section)
- alerts/warnings: `DesignAlert`
- actions: `DesignButton`
- template row action menu: `DesignMenu`

Avoid:

- inline repeated glass class blocks for each template card

### 5.5 `/projects/[projectId]/email-templates/[templateId]`

Use:

- save/error notices: `DesignAlert`
- top actions: `DesignButton`
- state tags: `DesignBadge` where needed

### 5.6 `/projects/[projectId]/email-themes`

Use:

- section containers: `DesignCard`
- viewport/device selector: `DesignPillToggle`
- status messages: `DesignAlert`
- theme state badges: `DesignBadge`
- actions: `DesignButton`, `DesignMenu`

Avoid:

- custom `ViewportSelector` if `DesignPillToggle` supports the same behavior

### 5.7 `/projects/[projectId]/email-themes/[themeId]`

Use:

- state feedback: `DesignAlert`
- actions: `DesignButton`
- optional segmented controls: `DesignPillToggle`

---

## 6) Semantic Mapping Rules

Use consistent semantic color/variant mapping across all pages:

- Success/completed/sent -> `DesignAlert variant="success"` and `DesignBadge color="green"`
- Error/failed -> `DesignAlert variant="error"` and `DesignBadge color="red"`
- Warning/attention -> `DesignAlert variant="warning"` and `DesignBadge color="orange"`
- Info/neutral updates -> `DesignAlert variant="info"` and `DesignBadge color="blue"` or `"cyan"`

Gradient mapping for cards/tabs/toggles:

- Blue: primary navigation/state
- Cyan: analytics/activity
- Purple: templates/themes or creative tools
- Green: success/completion
- Orange: warnings/caution
- Default: neutral/system sections

---

## 7) Interaction and Motion Rules

These rules must be preserved in custom styling and overrides:

- no hover-enter delays
- use hover-exit transitions: `transition-* duration-150 hover:transition-none`
- keep controls snappy and readable
- avoid heavy animation in dense admin workflows

For async actions:

- prefer design-components primitives that already handle async/loading
- do not swallow async errors; use existing alert-aware async utilities through design-components primitives

---

## 8) AI-Readable Implementation Checklist

Use this checklist before opening a dashboard UI PR:

- [ ] Replaced ad-hoc cards with `DesignCard` where possible.
- [ ] Replaced ad-hoc alerts with `DesignAlert`.
- [ ] Replaced ad-hoc badges/status pills with `DesignBadge`.
- [ ] Replaced ad-hoc segmented controls with `DesignPillToggle` or `DesignCategoryTabs`.
- [ ] Replaced ad-hoc row/list cards with `DesignListItemRow` or `DesignUserList`.
- [ ] Used `DesignButton` for async actions.
- [ ] Used `DesignSelectorDropdown`/`DesignInput` for standard field controls.
- [ ] Used `DataGrid` + `useDataSource` + `createDefaultDataGridState` for interactive tables.
- [ ] Did not introduce duplicate local wrappers for components already in design-components.
- [ ] Kept hover/motion behavior aligned with this guide.

---

## 9) Quick Snippets (Canonical)

### Section Card

```tsx
<DesignCard
  title="Email Log"
  subtitle="View and manage email sending history"
  icon={Envelope}
  gradient="default"
>
  {/* content */}
</DesignCard>
```

### Semantic Alert

```tsx
<DesignAlert
  variant="error"
  title="Failed to send email"
  description="Please verify provider configuration and try again."
/>
```

### Status Badge

```tsx
<DesignBadge
  label="Sent"
  color="green"
  icon={CheckCircle}
  size="sm"
/>
```

### Viewport Toggle

```tsx
<DesignPillToggle
  options={[
    { id: "desktop", label: "Desktop", icon: Desktop },
    { id: "tablet", label: "Tablet", icon: DeviceTablet },
    { id: "mobile", label: "Mobile", icon: DeviceMobile },
  ]}
  selected={viewport}
  onSelect={setViewport}
  size="sm"
  gradient="default"
/>
```

### Category Tabs

```tsx
<DesignCategoryTabs
  categories={[
    { id: "all", label: "All", count: 42 },
    { id: "failed", label: "Failed", count: 3 },
  ]}
  selectedCategory={category}
  onSelect={setCategory}
  gradient="blue"
/>
```

---

## 10) Anti-Patterns (Do Not Introduce)

- Creating local `GlassCard`/`ChartCard` components instead of `DesignCard` or `DesignAnalyticsCard`.
- Creating local status pills instead of `DesignBadge`.
- Creating local segmented/pill selectors instead of `DesignPillToggle`.
- Using raw `Alert`/`Button` in standard dashboard surfaces where `DesignAlert`/`DesignButton` should be used.
- Using `DesignDataTable` or raw `DataTable` instead of `DataGrid` + `useDataSource` + `createDefaultDataGridState`. `DesignDataTable` is deprecated; all new and migrated tables use `DataGrid`.
- Repeating large inline class strings for common design-components patterns.

---

## 11) Migration Priority for Existing Email Surfaces

When touching existing email/project pages, migrate in this order:

1. Cards/surfaces (`DesignCard` / `DesignAnalyticsCard` for chart-heavy shells)
2. Alerts (`DesignAlert`)
3. Badges (`DesignBadge`)
4. Toggles/tabs (`DesignPillToggle` / `DesignCategoryTabs`)
5. Rows/lists (`DesignListItemRow`)
6. Buttons/menus (`DesignButton` / `DesignMenu`)
7. Tables/forms (`DataGrid`, `DesignInput`, `DesignSelectorDropdown`, `DesignEditableGrid`)

This order yields the biggest consistency win first.

---

## 12) Maintenance Rule

Whenever a new reusable visual pattern is introduced in dashboard features:

- add or extend a design-components component first
- then document the component contract and preferred usage here
- avoid introducing permanent page-local UI primitives that duplicate design-components behavior


