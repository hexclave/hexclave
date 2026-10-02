"use client";

import { CodeBlock } from "@/components/code-block";
import {
  DesignEditableGrid,
  type DesignEditableGridItem,
  type DesignEditableGridSize,
  DesignListItemRow,
  DesignMenu,
  DesignSelectorDropdown,
  DesignUserList,
} from "@/components/design-components";
import { DesignAnalyticsCard, DesignAnalyticsCardHeader, DesignChartLegend } from "@/components/design-components/analytics-card";
import { Typography } from "@/components/ui";
import { cn } from "@/lib/utils";
import { typedEntries } from "@hexclave/shared/dist/utils/objects";
import {
  CheckCircle,
  Cube,
  Envelope,
  FileText,
  FlaskIcon,
  HardDrive,
  InfoIcon,
  MagnifyingGlassIcon,
  Package,
  PencilSimple,
  PulseIcon,
  Sliders,
  Sparkle,
  StackSimple,
  Tag,
  Trash,
} from "@phosphor-icons/react";
import {
  CursorBlastEffect,
  DataGrid,
  useDataSource,
  type DataGridColumnDef,
  type DataGridPaginationMode,
  type DataGridSelectionMode,
  createDefaultDataGridState,
  DesignAlert,
  DesignBadge,
  type DesignBadgeColor,
  type DesignBadgeContentMode,
  DesignButton,
  DesignCard,
  DesignCategoryTabs,
  DesignDialog,
  DesignDialogClose,
  type DesignDialogSize,
  type DesignDialogVariant,
  DesignInput,
  DesignPillToggle,
} from "@/components/design-components";
import { useMemo, useRef, useState } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

type ComponentId =
  | "alert"
  | "analytics-card"
  | "badge"
  | "button"
  | "card"
  | "category-tabs"
  | "cursor-blast"
  | "data-grid"
  | "data-table"
  | "dialog"
  | "editable-grid"
  | "input"
  | "list-item-row"
  | "menu"
  | "pill-toggle"
  | "selector-dropdown"
  | "user-list";

const COMPONENT_LIST: Array<{ value: ComponentId, label: string }> = [
  { value: "alert", label: "Alert" },
  { value: "analytics-card", label: "Analytics Card" },
  { value: "badge", label: "Badge" },
  { value: "button", label: "Button" },
  { value: "card", label: "Card" },
  { value: "category-tabs", label: "Category Tabs" },
  { value: "cursor-blast", label: "Cursor Blast Effect" },
  { value: "data-grid", label: "Data Grid" },
  { value: "data-table", label: "Data Table" },
  { value: "dialog", label: "Dialog" },
  { value: "editable-grid", label: "Editable Grid" },
  { value: "input", label: "Input" },
  { value: "list-item-row", label: "List Item Row" },
  { value: "menu", label: "Menu" },
  { value: "pill-toggle", label: "Pill Toggle" },
  { value: "selector-dropdown", label: "Selector Dropdown" },
  { value: "user-list", label: "User List" },
];

function isComponentId(value: string): value is ComponentId {
  return COMPONENT_LIST.some((c) => c.value === value);
}

// ─── Shared enums ────────────────────────────────────────────────────────────

type Gradient = "blue" | "cyan" | "purple" | "green" | "orange" | "default";
type Size3 = "sm" | "md" | "lg";

const GRADIENT_OPTIONS: Array<{ value: Gradient, label: string }> = [
  { value: "default", label: "Default" },
  { value: "blue", label: "Blue" },
  { value: "cyan", label: "Cyan" },
  { value: "purple", label: "Purple" },
  { value: "green", label: "Green" },
  { value: "orange", label: "Orange" },
];

const SIZE3_OPTIONS: Array<{ value: Size3, label: string }> = [
  { value: "sm", label: "Small" },
  { value: "md", label: "Medium" },
  { value: "lg", label: "Large" },
];

function isGradient(v: string): v is Gradient {
  return GRADIENT_OPTIONS.some((o) => o.value === v);
}
function isSize3(v: string): v is Size3 {
  return SIZE3_OPTIONS.some((o) => o.value === v);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function PropField({ label, children }: { label: string, children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <span className="block text-[10px] font-medium uppercase tracking-[0.12em] leading-none text-muted-foreground/80">
        {label}
      </span>
      {children}
    </div>
  );
}

function BoolToggle({
  value,
  onChange,
  on = "On",
  off = "Off",
}: {
  value: boolean,
  onChange: (v: boolean) => void,
  on?: string,
  off?: string,
}) {
  return (
    <div className="max-w-[132px]">
      <DesignSelectorDropdown
        value={value ? "true" : "false"}
        onValueChange={(nextValue) => onChange(nextValue === "true")}
        options={[
          { value: "true", label: on },
          { value: "false", label: off },
        ]}
        size="sm"
      />
    </div>
  );
}

function GlassmorphicToggle({
  value,
  onChange,
}: {
  value: boolean | undefined,
  onChange: (v: boolean | undefined) => void,
}) {
  return (
    <div className="max-w-[132px]">
      <DesignSelectorDropdown
        value={value === undefined ? "default" : value ? "true" : "false"}
        onValueChange={(v) => onChange(v === "default" ? undefined : v === "true")}
        options={[
          { value: "default", label: "Default" },
          { value: "true", label: "On" },
          { value: "false", label: "Off" },
        ]}
        size="sm"
      />
    </div>
  );
}

// ─── Demo data ───────────────────────────────────────────────────────────────

type DemoProduct = {
  id: string,
  name: string,
  category: string,
  price: number,
  status: "active" | "draft" | "archived",
};

const DEMO_PRODUCTS: DemoProduct[] = [
  { id: "1", name: "Widget Pro", category: "Hardware", price: 29.99, status: "active" },
  { id: "2", name: "Gadget Lite", category: "Accessories", price: 14.99, status: "draft" },
  { id: "3", name: "Tool Max", category: "Software", price: 49.99, status: "archived" },
  { id: "4", name: "Sensor Hub", category: "Hardware", price: 79.99, status: "active" },
];

const BADGE_PALETTE_LABELS = {
  zinc: "Zinc (neutral)",
  blue: "Blue",
  cyan: "Cyan",
  purple: "Purple",
  green: "Green",
  orange: "Orange",
  red: "Red",
} as const satisfies Record<DesignBadgeColor, string>;

const BADGE_PALETTE: readonly DesignBadgeColor[] = typedEntries(BADGE_PALETTE_LABELS).map(([color]) => color);

const STATUS_BADGE: Record<DemoProduct["status"], { label: string, color: DesignBadgeColor }> = {
  active: { label: "Active", color: "green" },
  draft: { label: "Draft", color: "orange" },
  archived: { label: "Archived", color: "red" },
};

const DEMO_PRODUCT_COLUMNS: DataGridColumnDef<DemoProduct>[] = [
  {
    id: "name",
    header: "Name",
    accessor: "name",
    width: 180,
    type: "string",
    renderCell: ({ value }) => <span className="text-sm font-medium text-foreground">{String(value)}</span>,
  },
  {
    id: "category",
    header: "Category",
    accessor: "category",
    width: 150,
    type: "string",
    renderCell: ({ value }) => <span className="text-sm text-muted-foreground">{String(value)}</span>,
  },
  {
    id: "price",
    header: "Price",
    accessor: "price",
    width: 120,
    type: "number",
    renderCell: ({ value }) => (
      <span className="text-sm text-muted-foreground">
        ${Number(value).toFixed(2)}
      </span>
    ),
  },
  {
    id: "status",
    header: "Status",
    accessor: "status",
    width: 120,
    type: "singleSelect",
    valueOptions: [
      { value: "active", label: "Active" },
      { value: "draft", label: "Draft" },
      { value: "archived", label: "Archived" },
    ],
    renderCell: ({ value }) => {
      const s = String(value) as DemoProduct["status"];
      return <DesignBadge label={STATUS_BADGE[s].label} color={STATUS_BADGE[s].color} size="sm" />;
    },
  },
];

const DEMO_USERS = [
  { name: "Ada Lovelace", email: "ada@example.com", time: "Active 1h ago", color: "cyan" as const },
  { name: "Grace Hopper", email: "grace@example.com", time: "Active 3h ago", color: "blue" as const },
  { name: "Alan Turing", email: "alan@example.com", time: "Active 5h ago", color: "cyan" as const },
];

const DEMO_ANALYTICS_POINTS = [
  { date: "Feb 28", new: 31, retained: 51, reactivated: 7, visitors: 1260, revenueCents: 18200, movingAvg: 89, highlightedAvg: 96 },
  { date: "Mar 01", new: 34, retained: 54, reactivated: 8, visitors: 1330, revenueCents: 19600, movingAvg: 92, highlightedAvg: 97 },
  { date: "Mar 02", new: 37, retained: 57, reactivated: 9, visitors: 1390, revenueCents: 20800, movingAvg: 94, highlightedAvg: 98 },
  { date: "Mar 03", new: 40, retained: 59, reactivated: 10, visitors: 1450, revenueCents: 21900, movingAvg: 97, highlightedAvg: 99 },
  { date: "Mar 04", new: 42, retained: 58, reactivated: 11, visitors: 1510, revenueCents: 22800, movingAvg: 97, highlightedAvg: 101 },
  { date: "Mar 05", new: 37, retained: 61, reactivated: 9, visitors: 1470, revenueCents: 22400, movingAvg: 98, highlightedAvg: 102 },
  { date: "Mar 06", new: 45, retained: 64, reactivated: 12, visitors: 1620, revenueCents: 24300, movingAvg: 101, highlightedAvg: 104 },
  { date: "Mar 07", new: 49, retained: 66, reactivated: 10, visitors: 1675, revenueCents: 25700, movingAvg: 104, highlightedAvg: 105 },
  { date: "Mar 08", new: 43, retained: 63, reactivated: 8, visitors: 1590, revenueCents: 23600, movingAvg: 102, highlightedAvg: 104 },
  { date: "Mar 09", new: 52, retained: 70, reactivated: 13, visitors: 1740, revenueCents: 26900, movingAvg: 108, highlightedAvg: 107 },
  { date: "Mar 10", new: 46, retained: 68, reactivated: 12, visitors: 1710, revenueCents: 26200, movingAvg: 109, highlightedAvg: 108 },
  { date: "Mar 11", new: 55, retained: 74, reactivated: 15, visitors: 1835, revenueCents: 28400, movingAvg: 113, highlightedAvg: 110 },
];

// ─── Data Grid demo data ────────────────────────────────────────────────────

type DemoGridUser = {
  id: string,
  name: string,
  email: string,
  role: "admin" | "editor" | "viewer",
  status: "active" | "inactive" | "pending",
  signUps: number,
};

const DEMO_GRID_USERS: DemoGridUser[] = [
  { id: "1", name: "Alice Anderson", email: "alice@company.io", role: "admin", status: "active", signUps: 1240 },
  { id: "2", name: "Bob Brown", email: "bob@gmail.com", role: "editor", status: "active", signUps: 870 },
  { id: "3", name: "Carol Chen", email: "carol@outlook.com", role: "viewer", status: "pending", signUps: 310 },
  { id: "4", name: "David Davis", email: "david@company.io", role: "editor", status: "inactive", signUps: 2100 },
  { id: "5", name: "Eve Evans", email: "eve@hey.com", role: "admin", status: "active", signUps: 4500 },
  { id: "6", name: "Frank Fisher", email: "frank@gmail.com", role: "viewer", status: "active", signUps: 95 },
  { id: "7", name: "Grace Garcia", email: "grace@company.io", role: "editor", status: "pending", signUps: 1800 },
  { id: "8", name: "Hank Harris", email: "hank@outlook.com", role: "viewer", status: "active", signUps: 620 },
];

const DEMO_GRID_COLUMNS: DataGridColumnDef<DemoGridUser>[] = [
  {
    id: "name",
    header: "Name",
    accessor: "name",
    width: 180,
    type: "string",
    renderCell: ({ value }) => (
      <div className="flex items-center gap-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs font-semibold flex-shrink-0">
          {String(value).charAt(0).toUpperCase()}
        </div>
        <span className="truncate font-medium">{String(value)}</span>
      </div>
    ),
  },
  { id: "email", header: "Email", accessor: "email", width: 200, type: "string" },
  {
    id: "role",
    header: "Role",
    accessor: "role",
    width: 120,
    type: "singleSelect",
    valueOptions: [
      { value: "admin", label: "Admin" },
      { value: "editor", label: "Editor" },
      { value: "viewer", label: "Viewer" },
    ],
    renderCell: ({ value }) => {
      const colors: Record<string, string> = {
        admin: "bg-purple-500/10 text-purple-600 dark:text-purple-400 ring-1 ring-purple-500/20",
        editor: "bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-1 ring-blue-500/20",
        viewer: "bg-foreground/[0.04] text-muted-foreground ring-1 ring-foreground/[0.06]",
      };
      return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium ${colors[String(value)] ?? ""}`}>
          {String(value)}
        </span>
      );
    },
  },
  {
    id: "status",
    header: "Status",
    accessor: "status",
    width: 110,
    type: "singleSelect",
    valueOptions: [
      { value: "active", label: "Active" },
      { value: "inactive", label: "Inactive" },
      { value: "pending", label: "Pending" },
    ],
    renderCell: ({ value }) => {
      const dot: Record<string, string> = {
        active: "bg-emerald-500",
        inactive: "bg-foreground/20",
        pending: "bg-amber-500",
      };
      return (
        <div className="flex items-center gap-1.5">
          <div className={`h-1.5 w-1.5 rounded-full ${dot[String(value)] ?? ""}`} />
          <span className="text-xs capitalize">{String(value)}</span>
        </div>
      );
    },
  },
  {
    id: "signUps",
    header: "Sign-ups",
    accessor: "signUps",
    width: 110,
    type: "number",
    align: "right",
    renderCell: ({ value }) => (
      <span className="tabular-nums font-medium">{Number(value).toLocaleString()}</span>
    ),
  },
];

// ─── Main ────────────────────────────────────────────────────────────────────

export default function PageClient() {
  const [selected, setSelected] = useState<ComponentId>("button");

  // Alert
  const [alertVariant, setAlertVariant] = useState<"default" | "success" | "error" | "warning" | "info">("success");
  const [alertTitle, setAlertTitle] = useState("Order placed");
  const [alertDesc, setAlertDesc] = useState("Your order has been confirmed.");

  // Analytics Card
  const [analyticsCardGradient, setAnalyticsCardGradient] = useState<"blue" | "cyan" | "purple" | "green" | "orange" | "slate">("blue");
  const [analyticsCardShowHeader, setAnalyticsCardShowHeader] = useState(true);
  const [analyticsCardShowLegend, setAnalyticsCardShowLegend] = useState(true);
  const [analyticsCardType, setAnalyticsCardType] = useState<"none" | "line" | "bar" | "stacked-bar" | "composed" | "donut">("stacked-bar");
  const [analyticsCardTooltipType, setAnalyticsCardTooltipType] = useState<"none" | "default" | "stacked" | "composed" | "visitors" | "revenue" | "donut">("stacked");
  const [analyticsCardHighlightMode, setAnalyticsCardHighlightMode] = useState<"none" | "bar-segment" | "series-hover" | "dot-hover" | "mixed">("bar-segment");
  const [analyticsCardMovingAverage, setAnalyticsCardMovingAverage] = useState(true);
  const [analyticsCardSevenDayAverage, setAnalyticsCardSevenDayAverage] = useState(true);
  const [analyticsCardMovingAverageDataKey, setAnalyticsCardMovingAverageDataKey] = useState("movingAvg");
  const [analyticsCardSevenDayAverageDataKey, setAnalyticsCardSevenDayAverageDataKey] = useState("highlightedAvg");
  const [analyticsCardHoveredIndex, setAnalyticsCardHoveredIndex] = useState<number | null>(null);

  // Badge
  const [badgeLabel, setBadgeLabel] = useState("In stock");
  const [badgeColor, setBadgeColor] = useState<DesignBadgeColor>("green");
  const [badgeSize, setBadgeSize] = useState<"sm" | "md">("md");
  const [badgeIcon, setBadgeIcon] = useState(true);
  const [badgeSpin, setBadgeSpin] = useState(false);
  const [badgeContentMode, setBadgeContentMode] = useState<DesignBadgeContentMode>("both");

  // Button
  const [btnLabel, setBtnLabel] = useState("Buy now");
  const [btnVariant, setBtnVariant] = useState<"default" | "secondary" | "outline" | "destructive" | "ghost" | "link" | "plain">("default");
  const [btnSize, setBtnSize] = useState<"default" | "sm" | "lg" | "icon">("default");
  const [btnLoading, setBtnLoading] = useState(false);

  // Card
  const [cardTitle, setCardTitle] = useState("Featured Bundle");
  const [cardSubtitle, setCardSubtitle] = useState("Save 20% this week.");
  const [cardGradient, setCardGradient] = useState<Gradient>("default");
  const [cardGlass, setCardGlass] = useState<boolean | undefined>(true);
  const [cardShowActions, setCardShowActions] = useState(false);

  // Category Tabs
  const [tabSize, setTabSize] = useState<"sm" | "md">("sm");
  const [tabGlass, setTabGlass] = useState<boolean | undefined>(false);
  const [tabGradient, setTabGradient] = useState<Gradient>("blue");
  const [tabSelected, setTabSelected] = useState("all");
  const [tabShowBadge, setTabShowBadge] = useState(true);

  // Cursor Blast
  const blastPreviewRef = useRef<HTMLDivElement>(null);
  const [blastEnabled, setBlastEnabled] = useState(true);
  const [blastLifetime, setBlastLifetime] = useState(720);
  const [blastMaxActive, setBlastMaxActive] = useState(18);
  const [blastRageThreshold, setBlastRageThreshold] = useState(3);
  const [blastRageWindow, setBlastRageWindow] = useState(600);
  const [blastRageRadius, setBlastRageRadius] = useState(60);

  // Data Grid
  const [dgSelectionMode, setDgSelectionMode] = useState<DataGridSelectionMode>("none");
  const [dgRowHeight, setDgRowHeight] = useState(44);
  const [dgShowToolbar, setDgShowToolbar] = useState(true);
  const [dgStickyTop, setDgStickyTop] = useState<"default" | "local">("default");
  const [dgState, setDgState] = useState(() => createDefaultDataGridState(DEMO_GRID_COLUMNS));
  const dgData = useDataSource({ data: DEMO_GRID_USERS, columns: DEMO_GRID_COLUMNS, getRowId: (r: DemoGridUser) => r.id, sorting: dgState.sorting, quickSearch: dgState.quickSearch, pagination: dgState.pagination, paginationMode: "client" });

  // Data Table
  const [tableClickableRows, setTableClickableRows] = useState(false);
  const [tableLastRowClick, setTableLastRowClick] = useState("");
  const [tableShowToolbar, setTableShowToolbar] = useState(true);
  const [dtState, setDtState] = useState(() => createDefaultDataGridState(DEMO_PRODUCT_COLUMNS));
  const dtData = useDataSource({ data: DEMO_PRODUCTS, columns: DEMO_PRODUCT_COLUMNS, getRowId: (r: DemoProduct) => r.id, sorting: dtState.sorting, quickSearch: dtState.quickSearch, pagination: dtState.pagination, paginationMode: "client" });

  // Dialog
  const [dialogShape, setDialogShape] = useState<"confirm" | "rich" | "wide">("confirm");
  const [dialogSize, setDialogSize] = useState<DesignDialogSize>("md");
  const [dialogVariant, setDialogVariant] = useState<DesignDialogVariant>("glassmorphic");
  const [dialogTitle, setDialogTitle] = useState("Heads up");
  const [dialogDescription, setDialogDescription] = useState("This is a lightweight confirmation modal.");
  const [dialogShowFooter, setDialogShowFooter] = useState(true);
  const [dialogShowIcon, setDialogShowIcon] = useState(true);
  const [dialogHideTopClose, setDialogHideTopClose] = useState(false);
  const [dialogUseCustomHeader, setDialogUseCustomHeader] = useState(false);
  const [dialogNoBodyPadding, setDialogNoBodyPadding] = useState(false);
  const [dialogAccentClassNames, setDialogAccentClassNames] = useState(false);

  // Editable Grid
  const [gridCols, setGridCols] = useState<1 | 2>(2);
  const [gridMode, setGridMode] = useState<"basic" | "full">("basic");
  const [gridSize, setGridSize] = useState<DesignEditableGridSize>("sm");
  const [gridEditMode, setGridEditMode] = useState(false);
  const [gridDeferredSave, setGridDeferredSave] = useState(false);
  const [gridHasChanges, setGridHasChanges] = useState(false);
  const [gridShowModified, setGridShowModified] = useState(false);
  const [gridActionLog, setGridActionLog] = useState("");

  // Input
  const [inputPlaceholder, setInputPlaceholder] = useState("Search products...");
  const [inputSize, setInputSize] = useState<Size3>("md");
  const [inputIcon, setInputIcon] = useState(false);
  const [inputPrefix, setInputPrefix] = useState(false);
  const [inputType, setInputType] = useState<"text" | "password">("text");
  const [inputDisabled, setInputDisabled] = useState(false);

  // List Item Row
  const [listTitle, setListTitle] = useState("Premium Support Plan");
  const [listSubtitle, setListSubtitle] = useState("3 seats remaining");
  const [listSize, setListSize] = useState<"sm" | "lg">("lg");
  const [listWithIcon, setListWithIcon] = useState(true);
  const [listClickable, setListClickable] = useState(false);
  const [listShowEditBtn, setListShowEditBtn] = useState(true);
  const [listShowMenuBtn, setListShowMenuBtn] = useState(true);
  const [listLastAction, setListLastAction] = useState("");

  // Menu
  const [menuVariant, setMenuVariant] = useState<"actions" | "selector" | "toggles">("actions");
  const [menuSelectorValue, setMenuSelectorValue] = useState("all");
  const [menuToggles, setMenuToggles] = useState<Record<string, boolean>>({ opt1: true, opt2: false, opt3: true });
  const [menuTrigger, setMenuTrigger] = useState<"button" | "icon">("button");
  const [menuTriggerLabel, setMenuTriggerLabel] = useState("Open Menu");
  const [menuLabel, setMenuLabel] = useState("Actions");
  const [menuAlign, setMenuAlign] = useState<"start" | "center" | "end">("start");
  const [menuWithIcons, setMenuWithIcons] = useState(true);
  const [menuActionStyle, setMenuActionStyle] = useState<"default" | "destructive">("destructive");
  const [menuLastAction, setMenuLastAction] = useState("");

  // Pill Toggle
  const [pillSize, setPillSize] = useState<Size3>("md");
  const [pillGlass, setPillGlass] = useState<boolean | undefined>(false);
  const [pillShowLabels, setPillShowLabels] = useState(true);
  const [pillWithIcons, setPillWithIcons] = useState(true);
  const [pillSelected, setPillSelected] = useState("a");

  // Selector Dropdown
  const [selSize, setSelSize] = useState<Size3>("sm");
  const [selDisabled, setSelDisabled] = useState(false);
  const [selValue, setSelValue] = useState("option-a");
  const [selPlaceholder, setSelPlaceholder] = useState("Select");
  const [selDisableOptionB, setSelDisableOptionB] = useState(false);

  // User List
  const [userClickable, setUserClickable] = useState(true);
  const [userShowAvatar, setUserShowAvatar] = useState(true);
  const [userGradient, setUserGradient] = useState<"blue-purple" | "cyan-blue" | "none">("blue-purple");
  const [userLastClick, setUserLastClick] = useState("");

  // ─── Demo editable grid items ────────────────────────────────────────────

  const editableItems = useMemo<DesignEditableGridItem[]>(() => {
    const baseItems: DesignEditableGridItem[] = [
      {
        itemKey: "display-name",
        type: "text",
        icon: <FileText className="h-4 w-4" />,
        name: "Display Name",
        description: "The customer-facing name for this product.",
        value: "Widget Pro",
        readOnly: false,
        onUpdate: async () => {
          await new Promise((r) => setTimeout(r, 400));
          setGridActionLog("Updated text value");
        },
      },
      {
        itemKey: "active",
        type: "boolean",
        icon: <StackSimple className="h-4 w-4" />,
        name: "Active",
        description: "Controls whether this product can be purchased.",
        value: true,
        readOnly: false,
        trueLabel: "Yes",
        falseLabel: "No",
        onUpdate: async () => {
          await new Promise((r) => setTimeout(r, 400));
          setGridActionLog("Updated boolean value");
        },
      },
      {
        itemKey: "category",
        type: "dropdown",
        icon: <Sliders className="h-4 w-4" />,
        name: "Category",
        description: "Used to organize this product in the catalog.",
        value: "hardware",
        options: [
          { value: "hardware", label: "Hardware" },
          { value: "software", label: "Software" },
          { value: "accessories", label: "Accessories" },
        ],
        readOnly: false,
        onUpdate: async () => {
          await new Promise((r) => setTimeout(r, 400));
          setGridActionLog("Updated dropdown value");
        },
      },
      {
        itemKey: "price",
        type: "custom",
        icon: <Tag className="h-4 w-4" />,
        name: "Price",
        description: "Current base price before discounts.",
        children: <span className="text-sm text-foreground">$29.99</span>,
      },
    ];

    if (gridMode === "full") {
      return [
        ...baseItems,
        {
          itemKey: "custom-dropdown",
          type: "custom-dropdown",
          icon: <Sparkle className="h-4 w-4" />,
          name: "Custom Dropdown",
          description: "A composed control with custom popover content.",
          triggerContent: <span>Open custom panel</span>,
          popoverContent: <div>Custom content</div>,
          disabled: false,
        },
        {
          itemKey: "custom-button",
          type: "custom-button",
          icon: <Cube className="h-4 w-4" />,
          name: "Custom Button",
          description: "Runs a custom action with built-in loading behavior.",
          onClick: () => setGridActionLog("Clicked custom button"),
          children: <span>Run action</span>,
          disabled: false,
        },
      ];
    }

    return baseItems;
  }, [gridMode]);

  // ─── Preview renderer ────────────────────────────────────────────────────

  function renderPreview() {
    if (selected === "alert") {
      return (
        <div className="w-full max-w-lg">
          <DesignAlert
            variant={alertVariant}
            title={alertTitle}
            description={alertDesc}
          />
        </div>
      );
    }
    if (selected === "analytics-card") {
      const demoLegendItems = [
        { key: "new", label: "New", color: "hsl(152, 38%, 52%)" },
        { key: "retained", label: "Retained", color: "hsl(221, 42%, 55%)" },
        { key: "reactivated", label: "Reactivated", color: "hsl(36, 55%, 58%)" },
      ];
      const maxTotal = Math.max(
        ...DEMO_ANALYTICS_POINTS.map((point) => point.new + point.retained + point.reactivated),
        1,
      );
      const hoveredIndex = analyticsCardHoveredIndex ?? 0;
      const hoveredPoint = DEMO_ANALYTICS_POINTS[hoveredIndex] ?? DEMO_ANALYTICS_POINTS[0];
      const tooltipLeftPercent = ((hoveredIndex + 0.5) / DEMO_ANALYTICS_POINTS.length) * 100;
      const movingAverageValue = hoveredPoint[analyticsCardMovingAverageDataKey as keyof typeof hoveredPoint];
      const sevenDayAverageValue = hoveredPoint[analyticsCardSevenDayAverageDataKey as keyof typeof hoveredPoint];
      const movingAverageIsNumber = typeof movingAverageValue === "number";
      const sevenDayAverageIsNumber = typeof sevenDayAverageValue === "number";
      const showTooltip = analyticsCardTooltipType !== "none" && analyticsCardType !== "none";
      return (
        <div className="w-full max-w-md" style={{ minHeight: 220 }}>
          <DesignAnalyticsCard
            gradient={analyticsCardGradient}
            className="h-full min-h-[220px] flex flex-col"
            chart={{
              type: analyticsCardType,
              tooltipType: analyticsCardTooltipType,
              highlightMode: analyticsCardHighlightMode,
              averages: {
                movingAverage: analyticsCardMovingAverage,
                sevenDayAverage: analyticsCardSevenDayAverage,
                movingAverageDataKey: analyticsCardMovingAverageDataKey,
                sevenDayAverageDataKey: analyticsCardSevenDayAverageDataKey,
              },
            }}
          >
            {analyticsCardShowHeader && (
              <DesignAnalyticsCardHeader label="Daily Active Users" />
            )}
            {analyticsCardShowLegend && (
              <DesignChartLegend items={demoLegendItems} />
            )}
            <div className="flex-1 min-h-0 px-4 pb-4 pt-2 flex flex-col">
              <div
                className="flex-1 min-h-0 rounded-lg bg-foreground/[0.02] p-2 relative"
                onMouseLeave={() => setAnalyticsCardHoveredIndex(null)}
              >
                {analyticsCardType === "none" && (
                  <div className="h-full flex items-center justify-center">
                    <Typography variant="secondary" className="text-xs text-center">
                      No chart selected
                    </Typography>
                  </div>
                )}
                {analyticsCardType === "donut" && (
                  <div className="h-full flex items-center justify-center">
                    <div
                      className="relative h-28 w-28 rounded-full bg-[conic-gradient(hsl(152,38%,52%)_0_35%,hsl(221,42%,55%)_35%_78%,hsl(36,55%,58%)_78%_100%)]"
                      onMouseEnter={() => setAnalyticsCardHoveredIndex(0)}
                    >
                      <div className="absolute inset-[18px] rounded-full bg-background/95" />
                    </div>
                  </div>
                )}
                {analyticsCardType !== "none" && analyticsCardType !== "donut" && (
                  <div
                    className="h-full min-h-0 grid gap-1.5 items-end"
                    style={{ gridTemplateColumns: `repeat(${DEMO_ANALYTICS_POINTS.length}, minmax(0, 1fr))` }}
                  >
                    {DEMO_ANALYTICS_POINTS.map((point, index) => {
                      const total = point.new + point.retained + point.reactivated;
                      const totalHeightPercent = Math.max((total / maxTotal) * 100, 12);
                      const retainedPercent = (point.retained / total) * 100;
                      const newPercent = (point.new / total) * 100;
                      const reactivatedPercent = (point.reactivated / total) * 100;
                      const isHovered = hoveredIndex === index;
                      const dimBySeriesHover = (analyticsCardHighlightMode === "series-hover" || analyticsCardHighlightMode === "mixed")
                        && analyticsCardHoveredIndex !== null
                        && !isHovered;
                      return (
                        <div
                          key={point.date}
                          className={cn("flex flex-col items-center gap-1", dimBySeriesHover && "opacity-45")}
                          onMouseEnter={() => setAnalyticsCardHoveredIndex(index)}
                        >
                          <div className="h-20 w-full flex items-end justify-center">
                            {analyticsCardType === "stacked-bar" && (
                              <div
                                className={cn(
                                  "w-full rounded-sm overflow-hidden flex flex-col-reverse transition-all duration-150",
                                  (analyticsCardHighlightMode === "bar-segment" || analyticsCardHighlightMode === "mixed") && isHovered && "ring-1 ring-foreground/30"
                                )}
                                style={{ height: `${totalHeightPercent}%` }}
                              >
                                <div className="w-full bg-[hsl(152,38%,52%)]" style={{ height: `${newPercent}%` }} />
                                <div className="w-full bg-[hsl(221,42%,55%)]" style={{ height: `${retainedPercent}%` }} />
                                <div className="w-full bg-[hsl(36,55%,58%)]" style={{ height: `${reactivatedPercent}%` }} />
                              </div>
                            )}
                            {analyticsCardType === "bar" && (
                              <div
                                className={cn(
                                  "w-full rounded-sm bg-[hsl(221,42%,55%)] transition-all duration-150",
                                  (analyticsCardHighlightMode === "bar-segment" || analyticsCardHighlightMode === "mixed") && isHovered && "ring-1 ring-foreground/30"
                                )}
                                style={{ height: `${totalHeightPercent}%` }}
                              />
                            )}
                            {analyticsCardType === "line" && (
                              <div className="w-full flex justify-center">
                                <div className={cn(
                                  "h-2.5 w-2.5 rounded-full bg-[hsl(210,84%,64%)] ring-2 ring-[hsl(210,84%,64%)]/30 transition-all duration-150",
                                  (analyticsCardHighlightMode === "dot-hover" || analyticsCardHighlightMode === "mixed") && isHovered && "scale-125"
                                )} />
                              </div>
                            )}
                            {analyticsCardType === "composed" && (
                              <div className="relative w-full h-full flex items-end justify-center">
                                <div className="w-full rounded-sm bg-[hsl(221,42%,55%)]/50" style={{ height: `${Math.max(totalHeightPercent * 0.8, 10)}%` }} />
                                <div className="absolute bottom-0 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-[hsl(268,82%,66%)] ring-2 ring-[hsl(268,82%,66%)]/30" />
                              </div>
                            )}
                          </div>
                          <span className="text-[9px] text-muted-foreground">{point.date.slice(-2)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {showTooltip && analyticsCardHoveredIndex !== null && (
                  <div
                    className="absolute z-20 -top-2 -translate-x-1/2 -translate-y-full rounded-xl bg-white/95 border border-black/[0.08] shadow-lg ring-1 ring-black/[0.06] px-3 py-2 min-w-[170px] dark:bg-background/95 dark:border-white/[0.08] dark:ring-white/[0.08]"
                    style={{ left: `${tooltipLeftPercent}%` }}
                  >
                    <div className="text-[10px] font-medium text-muted-foreground">{hoveredPoint.date}</div>
                    {(analyticsCardTooltipType === "stacked" || analyticsCardTooltipType === "composed" || analyticsCardTooltipType === "default") && (
                      <div className="mt-1.5 space-y-1">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-muted-foreground">New</span>
                          <span className="font-medium tabular-nums">{hoveredPoint.new}</span>
                        </div>
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-muted-foreground">Retained</span>
                          <span className="font-medium tabular-nums">{hoveredPoint.retained}</span>
                        </div>
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-muted-foreground">Reactivated</span>
                          <span className="font-medium tabular-nums">{hoveredPoint.reactivated}</span>
                        </div>
                      </div>
                    )}
                    {analyticsCardTooltipType === "visitors" && (
                      <div className="mt-1.5 flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground">Visitors</span>
                        <span className="font-medium tabular-nums">{hoveredPoint.visitors.toLocaleString()}</span>
                      </div>
                    )}
                    {analyticsCardTooltipType === "revenue" && (
                      <div className="mt-1.5 flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground">Revenue</span>
                        <span className="font-medium tabular-nums">${Math.round(hoveredPoint.revenueCents / 100)}</span>
                      </div>
                    )}
                    {analyticsCardTooltipType === "donut" && (
                      <div className="mt-1.5 flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground">Segment share</span>
                        <span className="font-medium tabular-nums">35% / 43% / 22%</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
                <span>
                  {analyticsCardMovingAverageDataKey}:{" "}
                  {analyticsCardMovingAverage
                    ? (movingAverageIsNumber ? movingAverageValue : "invalid key")
                    : "off"}
                </span>
                <span>
                  {analyticsCardSevenDayAverageDataKey}:{" "}
                  {analyticsCardSevenDayAverage
                    ? (sevenDayAverageIsNumber ? sevenDayAverageValue : "invalid key")
                    : "off"}
                </span>
              </div>
            </div>
          </DesignAnalyticsCard>
        </div>
      );
    }
    if (selected === "badge") {
      const badgeIconProp = badgeContentMode === "icon"
        ? CheckCircle
        : (badgeIcon ? CheckCircle : undefined);
      return (
        <div className="flex flex-col items-center gap-4">
          <DesignBadge
            label={badgeLabel || "Badge"}
            color={badgeColor}
            size={badgeSize}
            icon={badgeIconProp}
            iconClassName={badgeSpin ? "animate-spin" : undefined}
            contentMode={badgeContentMode}
          />
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {BADGE_PALETTE.map((color) => (
              <DesignBadge key={color} label={color} color={color} size="sm" />
            ))}
          </div>
        </div>
      );
    }
    if (selected === "button") {
      return (
        <DesignButton
          variant={btnVariant}
          size={btnSize}
          loading={btnLoading}
        >
          {btnSize === "icon"
            ? <Sparkle className="h-4 w-4" />
            : btnLabel || "Button"}
        </DesignButton>
      );
    }
    if (selected === "card") {
      // Title/icon/subtitle props are conditional: when a title is provided,
      // icon is required by the DesignCard type system.
      const titleProps = cardTitle
        ? {
          title: cardTitle,
          icon: Package,
          ...(cardSubtitle ? { subtitle: cardSubtitle } : {}),
          ...(cardShowActions
            ? {
              actions: (
                <DesignButton variant="secondary" size="sm" className="h-8 px-3 text-xs gap-1.5">
                  <Sliders className="h-3.5 w-3.5" />
                  Configure
                </DesignButton>
              )
            }
            : {}),
        } satisfies { title: React.ReactNode, icon: React.ElementType, subtitle?: React.ReactNode, actions?: React.ReactNode }
        : {};
      return (
        <div className="w-full max-w-md">
          <DesignCard
            {...titleProps}
            gradient={cardGradient}
            glassmorphic={cardGlass}
          >
            <Typography variant="secondary" className="text-sm">
              Highlight pricing, benefits, or key product details here.
            </Typography>
          </DesignCard>
        </div>
      );
    }
    if (selected === "category-tabs") {
      return (
        <DesignCategoryTabs
          categories={[
            { id: "all", label: "All Items", count: 24 },
            { id: "active", label: "Active", count: 12 },
            { id: "draft", label: "Drafts", count: 8 },
            { id: "archived", label: "Archived", count: 4 },
          ]}
          selectedCategory={tabSelected}
          onSelect={setTabSelected}
          showBadge={tabShowBadge}
          size={tabSize}
          glassmorphic={tabGlass}
          gradient={tabGradient}
          trailing={(
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
              + Install apps
            </span>
          )}
        />
      );
    }
    if (selected === "cursor-blast") {
      return (
        <div className="flex flex-col items-center gap-3">
          {blastEnabled && (
            <CursorBlastEffect
              containerRef={blastPreviewRef}
              blastLifetimeMs={blastLifetime}
              maxActiveBlasts={blastMaxActive}
              rageClickThreshold={blastRageThreshold}
              rageClickWindowMs={blastRageWindow}
              rageClickRadiusPx={blastRageRadius}
            />
          )}
          <Typography variant="secondary" className="text-sm text-center max-w-xs select-none">
            {blastEnabled
              ? "Rage-click inside the preview area to trigger the blast effect."
              : "Enable the effect to see cursor blasts."}
          </Typography>
        </div>
      );
    }
    if (selected === "data-grid") {
      return (
        <div className="w-full max-w-3xl">
          <DataGrid<DemoGridUser>
            columns={DEMO_GRID_COLUMNS}
            rows={dgData.rows}
            getRowId={(row) => row.id}
            totalRowCount={dgData.totalRowCount}
            isLoading={dgData.isLoading}
            state={dgState}
            onChange={setDgState}
            selectionMode={dgSelectionMode}
            rowHeight={dgRowHeight}
            toolbar={dgShowToolbar ? undefined : false}
            stickyTop={dgStickyTop === "local" ? 80 : undefined}
            maxHeight={400}
          />
        </div>
      );
    }
    if (selected === "dialog") {
      const dialogTriggerLabel = dialogShape === "rich"
        ? "Open trigger history"
        : dialogShape === "wide"
          ? "Open tester"
          : "Open confirmation";
      const dialogIcon = dialogShowIcon
        ? (dialogShape === "rich" ? PulseIcon : dialogShape === "wide" ? FlaskIcon : InfoIcon)
        : null;
      const headerContent = dialogShape === "rich" ? (
        <div className="rounded-xl bg-foreground/[0.02] ring-1 ring-foreground/[0.06] p-3 space-y-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold truncate flex-1 min-w-0">Allow @stack.dev signups</span>
            <DesignBadge label="Allow" color="green" size="sm" />
            <DesignBadge label="Enabled" color="green" size="sm" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg bg-background/60 ring-1 ring-foreground/[0.06] p-2">
              <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">Last 24h</span>
              <span className="text-sm font-semibold tabular-nums">12</span>
            </div>
            <div className="rounded-lg bg-background/60 ring-1 ring-foreground/[0.06] p-2">
              <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">All-time</span>
              <span className="text-sm font-semibold tabular-nums">3</span>
            </div>
            <div className="rounded-lg bg-background/60 ring-1 ring-foreground/[0.06] p-2 flex items-center justify-center">
              <span className="text-[10px] text-muted-foreground">sparkline</span>
            </div>
          </div>
        </div>
      ) : undefined;

      let body: React.ReactNode;
      if (dialogShape === "rich") {
        body = (
          <>
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent triggers</span>
            <div className="rounded-xl ring-1 ring-foreground/[0.06] bg-background/60 divide-y divide-foreground/[0.06]">
              {["jordan@stack.dev", "ops@stack.dev", "pat@stack.dev"].map((email) => (
                <div key={email} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="truncate">{email}</span>
                  <DesignBadge label="2m ago" color="blue" size="sm" />
                </div>
              ))}
            </div>
          </>
        );
      } else if (dialogShape === "wide") {
        body = (
          <>
            <DesignAlert
              variant="info"
              description="Use a wider size for forms and tester surfaces. The body region is scrollable."
            />
            <DesignCard>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <DesignInput placeholder="Email" />
                <DesignInput placeholder="Country (e.g. US)" />
              </div>
            </DesignCard>
          </>
        );
      } else {
        body = (
          <p className="text-sm">
            Body content lives in the scrollable region between the header and the footer.
            Use it for short messages, inline forms, or detail views.
          </p>
        );
      }

      const footer = dialogShowFooter ? (
        dialogShape === "wide" ? (
          <>
            <DesignDialogClose asChild>
              <DesignButton variant="secondary" size="sm">Cancel</DesignButton>
            </DesignDialogClose>
            <DesignButton size="sm">Run test</DesignButton>
          </>
        ) : (
          <DesignDialogClose asChild>
            <DesignButton variant="secondary" size="sm">Close</DesignButton>
          </DesignDialogClose>
        )
      ) : undefined;

      const customHeader = dialogUseCustomHeader ? (
        <div className="flex items-center gap-3 px-6 py-4 bg-gradient-to-r from-indigo-500/15 via-fuchsia-500/10 to-transparent border-b border-foreground/[0.06]">
          <div className="h-8 w-8 rounded-full bg-foreground/10 grid place-items-center text-xs font-semibold">JD</div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">Custom header block</div>
            <div className="text-xs text-muted-foreground truncate">Renders instead of the default title/description region.</div>
          </div>
        </div>
      ) : undefined;
      return (
        <DesignDialog
          size={dialogSize}
          variant={dialogVariant}
          icon={dialogIcon}
          title={dialogTitle || "Dialog"}
          description={dialogDescription || undefined}
          headerContent={headerContent}
          customHeader={customHeader}
          footer={footer}
          hideTopCloseButton={dialogHideTopClose}
          noBodyPadding={dialogNoBodyPadding}
          className={dialogAccentClassNames ? "ring-2 ring-indigo-500/40" : undefined}
          overlayClassName={dialogAccentClassNames ? "bg-indigo-950/40" : undefined}
          headerClassName={dialogAccentClassNames ? "bg-indigo-500/5" : undefined}
          bodyClassName={dialogAccentClassNames ? "bg-foreground/[0.02]" : undefined}
          footerClassName={dialogAccentClassNames ? "bg-foreground/[0.02]" : undefined}
          trigger={<DesignButton size="sm">{dialogTriggerLabel}</DesignButton>}
        >
          {body}
        </DesignDialog>
      );
    }
    if (selected === "data-table") {
      return (
        <div className="w-full max-w-2xl">
          <DataGrid
            columns={DEMO_PRODUCT_COLUMNS}
            rows={dtData.rows}
            getRowId={(row) => row.id}
            totalRowCount={dtData.totalRowCount}
            isLoading={dtData.isLoading}
            state={dtState}
            onChange={setDtState}
            toolbar={tableShowToolbar ? undefined : false}
            onRowClick={tableClickableRows ? (row) => setTableLastRowClick(row.name) : undefined}
            maxHeight={400}
          />
          {tableLastRowClick && (
            <Typography variant="secondary" className="text-xs mt-2">
              Last row click: {tableLastRowClick}
            </Typography>
          )}
        </div>
      );
    }
    if (selected === "editable-grid") {
      return (
        <div className="w-full max-w-3xl">
          <div className="overflow-hidden rounded-2xl border border-black/[0.1] bg-white shadow-sm dark:border-white/[0.1] dark:bg-zinc-950">
            <div className="p-4 sm:p-5">
              <DesignEditableGrid
                columns={gridCols}
                deferredSave={gridDeferredSave}
                editMode={gridEditMode}
                externalModifiedKeys={gridShowModified ? new Set(["display-name", "category"]) : undefined}
                hasChanges={gridHasChanges}
                items={editableItems}
                onDiscard={gridDeferredSave ? () => {
                  setGridActionLog("Discarded deferred changes");
                  setGridHasChanges(false);
                } : undefined}
                onSave={gridDeferredSave ? async () => {
                  await new Promise((resolve) => setTimeout(resolve, 400));
                  setGridActionLog("Saved deferred changes");
                  setGridHasChanges(false);
                } : undefined}
                size={gridSize}
              />
              {gridActionLog && (
                <Typography className="mt-3 text-xs" variant="secondary">
                  Last action: {gridActionLog}
                </Typography>
              )}
            </div>
          </div>
        </div>
      );
    }
    if (selected === "input") {
      return (
        <div className="w-full max-w-xs">
          <DesignInput
            type={inputType}
            size={inputSize}
            disabled={inputDisabled}
            placeholder={inputPlaceholder}
            leadingIcon={inputPrefix ? undefined : (inputIcon ? <MagnifyingGlassIcon className="h-3 w-3" /> : undefined)}
            prefixItem={inputPrefix ? "$" : undefined}
          />
        </div>
      );
    }
    if (selected === "list-item-row") {
      const listButtons = [
        ...(listShowEditBtn ? [{
          id: "edit",
          label: "Edit",
          onClick: () => setListLastAction("edit"),
        }] : []),
        ...(listShowMenuBtn ? [{
          id: "more",
          label: "Options",
          display: "icon" as const,
          onClick: [
            { id: "duplicate", label: "Duplicate", onClick: () => setListLastAction("duplicate") },
            { id: "delete", label: "Delete", itemVariant: "destructive" as const, onClick: () => setListLastAction("delete") },
          ],
        }] : []),
      ];
      return (
        <div className="w-full max-w-lg space-y-2">
          <DesignListItemRow
            icon={listWithIcon ? Cube : undefined}
            title={listTitle}
            subtitle={listSubtitle || undefined}
            size={listSize}
            onClick={listClickable ? () => setListLastAction("row clicked") : undefined}
            buttons={listButtons.length > 0 ? listButtons : undefined}
          />
          {listLastAction && (
            <Typography variant="secondary" className="text-xs pl-1">
              Last action: {listLastAction}
            </Typography>
          )}
        </div>
      );
    }
    if (selected === "menu") {
      if (menuVariant === "selector") {
        return (
          <DesignMenu
            variant="selector"
            trigger={menuTrigger}
            align={menuAlign}
            triggerLabel={
              menuTriggerLabel || (
                [
                  { id: "all", label: "All" },
                  { id: "active", label: "Active" },
                  { id: "drafts", label: "Drafts" },
                ].find((o) => o.id === menuSelectorValue)?.label ?? "Select"
              )
            }
            label={menuLabel}
            options={[
              { id: "all", label: "All" },
              { id: "active", label: "Active" },
              { id: "drafts", label: "Drafts" },
            ]}
            value={menuSelectorValue}
            onValueChange={setMenuSelectorValue}
          />
        );
      }
      if (menuVariant === "toggles") {
        return (
          <DesignMenu
            variant="toggles"
            trigger={menuTrigger}
            triggerLabel={menuTriggerLabel}
            align={menuAlign}
            label={menuLabel}
            options={[
              { id: "opt1", label: "Name", checked: !!menuToggles.opt1 },
              { id: "opt2", label: "Status", checked: !!menuToggles.opt2 },
              { id: "opt3", label: "Price", checked: !!menuToggles.opt3 },
            ]}
            onToggleChange={(id, checked) => setMenuToggles((prev) => ({ ...prev, [id]: checked }))}
          />
        );
      }
      return (
        <DesignMenu
          variant="actions"
          trigger={menuTrigger}
          triggerLabel={menuTriggerLabel}
          align={menuAlign}
          label={menuLabel}
          withIcons={menuWithIcons}
          items={[
            { id: "edit", label: "Edit", icon: <PencilSimple className="h-4 w-4" />, onClick: () => setMenuLastAction("edit") },
            { id: "email", label: "Send email", icon: <Envelope className="h-4 w-4" />, onClick: () => setMenuLastAction("send-email") },
            { id: "delete", label: "Delete", icon: <Trash className="h-4 w-4" />, itemVariant: menuActionStyle, onClick: () => setMenuLastAction("delete") },
          ]}
        />
      );
    }
    if (selected === "pill-toggle") {
      return (
        <DesignPillToggle
          options={[
            { id: "a", label: "Phone", ...(pillWithIcons ? { icon: Envelope } : {}) },
            { id: "b", label: "Tablet", ...(pillWithIcons ? { icon: HardDrive } : {}) },
            { id: "c", label: "Desktop", ...(pillWithIcons ? { icon: Sparkle } : {}) },
          ]}
          selected={pillSelected}
          onSelect={setPillSelected}
          size={pillSize}
          glassmorphic={pillGlass}
          showLabels={pillShowLabels}
        />
      );
    }
    if (selected === "selector-dropdown") {
      return (
        <div className="w-48">
          <DesignSelectorDropdown
            value={selValue}
            onValueChange={setSelValue}
            options={[
              { value: "option-a", label: "Option A" },
              { value: "option-b", label: "Option B", disabled: selDisableOptionB },
              { value: "option-c", label: "Option C" },
            ]}
            placeholder={selPlaceholder}
            size={selSize}
            disabled={selDisabled}
          />
        </div>
      );
    }
    // user-list
    return (
      <div className="w-full max-w-sm">
        <DesignUserList
          users={DEMO_USERS}
          showAvatar={userShowAvatar}
          gradient={userGradient}
          onUserClick={userClickable ? (user) => setUserLastClick(user.name) : undefined}
        />
        {userLastClick && (
          <Typography variant="secondary" className="text-xs mt-2">
            Last clicked user: {userLastClick}
          </Typography>
        )}
      </div>
    );
  }

  // ─── Controls renderer ───────────────────────────────────────────────────

  function renderControls() {
    if (selected === "alert") {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 items-end">
          <PropField label="Variant">
            <DesignSelectorDropdown
              value={alertVariant}
              onValueChange={(v) => {
                if (v === "default" || v === "success" || v === "error" || v === "warning" || v === "info") {
                  setAlertVariant(v);
                  return;
                }
                throw new Error(`Unknown alert variant "${v}"`);
              }}
              options={[
                { value: "default", label: "Default" },
                { value: "success", label: "Success" },
                { value: "error", label: "Error" },
                { value: "warning", label: "Warning" },
                { value: "info", label: "Info" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Title">
            <DesignInput size="sm" value={alertTitle} onChange={(e) => setAlertTitle(e.target.value)} />
          </PropField>
          <PropField label="Description">
            <DesignInput size="sm" value={alertDesc} onChange={(e) => setAlertDesc(e.target.value)} />
          </PropField>
        </div>
      );
    }
    if (selected === "analytics-card") {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 items-end">
          <PropField label="Gradient">
            <DesignSelectorDropdown
              value={analyticsCardGradient}
              onValueChange={(v) => {
                if (v === "blue" || v === "cyan" || v === "purple" || v === "green" || v === "orange" || v === "slate") {
                  setAnalyticsCardGradient(v);
                  return;
                }
                throw new Error(`Unknown analytics card gradient "${v}"`);
              }}
              options={[
                { value: "blue", label: "Blue" },
                { value: "cyan", label: "Cyan" },
                { value: "purple", label: "Purple" },
                { value: "green", label: "Green" },
                { value: "orange", label: "Orange" },
                { value: "slate", label: "Slate" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Chart Type">
            <DesignSelectorDropdown
              value={analyticsCardType}
              onValueChange={(v) => {
                if (v === "none" || v === "line" || v === "bar" || v === "stacked-bar" || v === "composed" || v === "donut") {
                  setAnalyticsCardType(v);
                  return;
                }
                throw new Error(`Unknown analytics chart type "${v}"`);
              }}
              options={[
                { value: "none", label: "None" },
                { value: "line", label: "Line" },
                { value: "bar", label: "Bar" },
                { value: "stacked-bar", label: "Stacked Bar" },
                { value: "composed", label: "Composed" },
                { value: "donut", label: "Donut" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Tooltip Type">
            <DesignSelectorDropdown
              value={analyticsCardTooltipType}
              onValueChange={(v) => {
                if (v === "none" || v === "default" || v === "stacked" || v === "composed" || v === "visitors" || v === "revenue" || v === "donut") {
                  setAnalyticsCardTooltipType(v);
                  return;
                }
                throw new Error(`Unknown analytics tooltip type "${v}"`);
              }}
              options={[
                { value: "none", label: "None" },
                { value: "default", label: "Default" },
                { value: "stacked", label: "Stacked" },
                { value: "composed", label: "Composed" },
                { value: "visitors", label: "Visitors" },
                { value: "revenue", label: "Revenue" },
                { value: "donut", label: "Donut" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Highlight Mode">
            <DesignSelectorDropdown
              value={analyticsCardHighlightMode}
              onValueChange={(v) => {
                if (v === "none" || v === "bar-segment" || v === "series-hover" || v === "dot-hover" || v === "mixed") {
                  setAnalyticsCardHighlightMode(v);
                  return;
                }
                throw new Error(`Unknown analytics highlight mode "${v}"`);
              }}
              options={[
                { value: "none", label: "None" },
                { value: "bar-segment", label: "Bar Segment" },
                { value: "series-hover", label: "Series Hover" },
                { value: "dot-hover", label: "Dot Hover" },
                { value: "mixed", label: "Mixed" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Header">
            <DesignPillToggle
              options={[{ id: "yes", label: "Show" }, { id: "no", label: "Hide" }]}
              selected={analyticsCardShowHeader ? "yes" : "no"}
              onSelect={(v) => setAnalyticsCardShowHeader(v === "yes")}
              size="sm"
            />
          </PropField>
          <PropField label="Legend">
            <DesignPillToggle
              options={[{ id: "yes", label: "Show" }, { id: "no", label: "Hide" }]}
              selected={analyticsCardShowLegend ? "yes" : "no"}
              onSelect={(v) => setAnalyticsCardShowLegend(v === "yes")}
              size="sm"
            />
          </PropField>
          <PropField label="Moving Avg">
            <DesignPillToggle
              options={[{ id: "yes", label: "On" }, { id: "no", label: "Off" }]}
              selected={analyticsCardMovingAverage ? "yes" : "no"}
              onSelect={(v) => setAnalyticsCardMovingAverage(v === "yes")}
              size="sm"
            />
          </PropField>
          <PropField label="7-Day Avg">
            <DesignPillToggle
              options={[{ id: "yes", label: "On" }, { id: "no", label: "Off" }]}
              selected={analyticsCardSevenDayAverage ? "yes" : "no"}
              onSelect={(v) => setAnalyticsCardSevenDayAverage(v === "yes")}
              size="sm"
            />
          </PropField>
          <PropField label="Moving Avg Key">
            <DesignInput
              size="sm"
              value={analyticsCardMovingAverageDataKey}
              onChange={(e) => setAnalyticsCardMovingAverageDataKey(e.target.value)}
            />
          </PropField>
          <PropField label="7-Day Avg Key">
            <DesignInput
              size="sm"
              value={analyticsCardSevenDayAverageDataKey}
              onChange={(e) => setAnalyticsCardSevenDayAverageDataKey(e.target.value)}
            />
          </PropField>
        </div>
      );
    }
    if (selected === "badge") {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 items-end">
          <PropField label="Label">
            <DesignInput size="sm" value={badgeLabel} onChange={(e) => setBadgeLabel(e.target.value)} />
          </PropField>
          <PropField label="Color">
            <DesignSelectorDropdown
              value={badgeColor}
              onValueChange={(v) => {
                const color = BADGE_PALETTE.find((candidate) => candidate === v);
                if (color == null) throw new Error(`Unknown badge color "${v}"`);
                setBadgeColor(color);
              }}
              options={BADGE_PALETTE.map((color) => ({ value: color, label: BADGE_PALETTE_LABELS[color] }))}
              size="sm"
            />
          </PropField>
          <PropField label="Size">
            <DesignSelectorDropdown
              value={badgeSize}
              onValueChange={(v) => {
                if (v === "sm" || v === "md") {
                  setBadgeSize(v);
                  return;
                }
                throw new Error(`Unknown badge size "${v}"`);
              }}
              options={[
                { value: "sm", label: "Small" },
                { value: "md", label: "Medium" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Content">
            <DesignSelectorDropdown
              value={badgeContentMode}
              onValueChange={(v) => {
                if (v === "both" || v === "text" || v === "icon") {
                  setBadgeContentMode(v);
                  return;
                }
                throw new Error(`Unknown badge content mode "${v}"`);
              }}
              options={[
                { value: "both", label: "Both" },
                { value: "text", label: "Text only" },
                { value: "icon", label: "Icon only" },
              ]}
              size="sm"
            />
          </PropField>
          {badgeContentMode === "both" && (
            <PropField label="Icon">
              <BoolToggle value={badgeIcon} onChange={setBadgeIcon} on="Show" off="Hide" />
            </PropField>
          )}
          {(badgeContentMode === "icon" || (badgeContentMode === "both" && badgeIcon)) && (
            <PropField label="Spin icon">
              <BoolToggle value={badgeSpin} onChange={setBadgeSpin} on="Spin" off="Static" />
            </PropField>
          )}
        </div>
      );
    }
    if (selected === "button") {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 items-end">
          <PropField label="Label">
            <DesignInput size="sm" value={btnLabel} onChange={(e) => setBtnLabel(e.target.value)} />
          </PropField>
          <PropField label="Variant">
            <DesignSelectorDropdown
              value={btnVariant}
              onValueChange={(v) => {
                if (v === "default" || v === "secondary" || v === "outline" || v === "destructive" || v === "ghost" || v === "link" || v === "plain") {
                  setBtnVariant(v);
                  return;
                }
                throw new Error(`Unknown button variant "${v}"`);
              }}
              options={[
                { value: "default", label: "Default" },
                { value: "secondary", label: "Secondary" },
                { value: "outline", label: "Outline" },
                { value: "destructive", label: "Destructive" },
                { value: "ghost", label: "Ghost" },
                { value: "link", label: "Link" },
                { value: "plain", label: "Plain" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Size">
            <DesignSelectorDropdown
              value={btnSize}
              onValueChange={(v) => {
                if (v === "default" || v === "sm" || v === "lg" || v === "icon") {
                  setBtnSize(v);
                  return;
                }
                throw new Error(`Unknown button size "${v}"`);
              }}
              options={[
                { value: "default", label: "Default" },
                { value: "sm", label: "Small" },
                { value: "lg", label: "Large" },
                { value: "icon", label: "Icon" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Loading">
            <BoolToggle value={btnLoading} onChange={setBtnLoading} />
          </PropField>
        </div>
      );
    }
    if (selected === "card") {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4 items-end">
          <PropField label="Title">
            <DesignInput size="sm" value={cardTitle} onChange={(e) => setCardTitle(e.target.value)} placeholder="(empty = body only)" />
          </PropField>
          <PropField label="Subtitle">
            <DesignInput size="sm" value={cardSubtitle} onChange={(e) => setCardSubtitle(e.target.value)} placeholder="(empty = compact header)" />
          </PropField>
          <PropField label="Gradient">
            <DesignSelectorDropdown
              value={cardGradient}
              onValueChange={(v) => {
                if (!isGradient(v)) throw new Error(`Unknown gradient "${v}"`);
                setCardGradient(v);
              }}
              options={GRADIENT_OPTIONS}
              size="sm"
            />
          </PropField>
          <PropField label="Glassmorphic">
            <GlassmorphicToggle value={cardGlass} onChange={setCardGlass} />
          </PropField>
          <PropField label="Header Actions">
            <BoolToggle
              value={cardTitle ? cardShowActions : false}
              onChange={(next) => {
                if (!cardTitle) return;
                setCardShowActions(next);
              }}
              on="Show"
              off="Hide"
            />
          </PropField>
        </div>
      );
    }
    if (selected === "category-tabs") {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 items-end">
          <PropField label="Size">
            <DesignSelectorDropdown
              value={tabSize}
              onValueChange={(v) => {
                if (v !== "sm" && v !== "md") throw new Error(`Unknown tab size "${v}"`);
                setTabSize(v);
              }}
              options={[
                { value: "sm", label: "Small" },
                { value: "md", label: "Medium" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Gradient">
            <DesignSelectorDropdown
              value={tabGradient}
              onValueChange={(v) => {
                if (!isGradient(v)) throw new Error(`Unknown gradient "${v}"`);
                setTabGradient(v);
              }}
              options={GRADIENT_OPTIONS}
              size="sm"
            />
          </PropField>
          <PropField label="Glassmorphic">
            <GlassmorphicToggle value={tabGlass} onChange={setTabGlass} />
          </PropField>
          <PropField label="Show Badge">
            <BoolToggle value={tabShowBadge} onChange={setTabShowBadge} on="Yes" off="No" />
          </PropField>
        </div>
      );
    }
    if (selected === "cursor-blast") {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 items-end">
          <PropField label="Enabled">
            <BoolToggle value={blastEnabled} onChange={setBlastEnabled} />
          </PropField>
          <PropField label="Lifetime (ms)">
            <DesignInput
              size="sm"
              type="text"
              value={String(blastLifetime)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isNaN(n) && n > 0) setBlastLifetime(n);
              }}
            />
          </PropField>
          <PropField label="Max Active">
            <DesignInput
              size="sm"
              type="text"
              value={String(blastMaxActive)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isNaN(n) && n > 0) setBlastMaxActive(n);
              }}
            />
          </PropField>
          <PropField label="Rage Threshold">
            <DesignInput
              size="sm"
              type="text"
              value={String(blastRageThreshold)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isNaN(n) && n > 0) setBlastRageThreshold(n);
              }}
            />
          </PropField>
          <PropField label="Rage Window (ms)">
            <DesignInput
              size="sm"
              type="text"
              value={String(blastRageWindow)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isNaN(n) && n > 0) setBlastRageWindow(n);
              }}
            />
          </PropField>
          <PropField label="Rage Radius (px)">
            <DesignInput
              size="sm"
              type="text"
              value={String(blastRageRadius)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isNaN(n) && n > 0) setBlastRageRadius(n);
              }}
            />
          </PropField>
        </div>
      );
    }
    if (selected === "data-grid") {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 items-end">
          <PropField label="Selection Mode">
            <DesignSelectorDropdown
              value={dgSelectionMode}
              onValueChange={(v) => {
                if (v === "none" || v === "single" || v === "multiple") {
                  setDgSelectionMode(v);
                  return;
                }
                throw new Error(`Unknown selection mode "${v}"`);
              }}
              options={[
                { value: "none", label: "None" },
                { value: "single", label: "Single" },
                { value: "multiple", label: "Multiple" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Row Height">
            <DesignInput
              size="sm"
              type="text"
              value={String(dgRowHeight)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isNaN(n) && n >= 24) setDgRowHeight(n);
              }}
            />
          </PropField>
          <PropField label="Toolbar">
            <BoolToggle value={dgShowToolbar} onChange={setDgShowToolbar} on="Shown" off="Hidden" />
          </PropField>
          <PropField label="Sticky top">
            <DesignSelectorDropdown
              value={dgStickyTop}
              onValueChange={(v) => {
                if (v === "default" || v === "local") {
                  setDgStickyTop(v);
                  return;
                }
                throw new Error(`Unknown sticky top mode "${v}"`);
              }}
              options={[
                { value: "default", label: "Default (0px)" },
                { value: "local", label: "Local (80px)" },
              ]}
              size="sm"
            />
          </PropField>
        </div>
      );
    }
    if (selected === "data-table") {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 items-end">
          <PropField label="Toolbar">
            <BoolToggle value={tableShowToolbar} onChange={setTableShowToolbar} on="Shown" off="Hidden" />
          </PropField>
          <PropField label="Row Click">
            <BoolToggle value={tableClickableRows} onChange={setTableClickableRows} on="Enabled" off="Disabled" />
          </PropField>
        </div>
      );
    }
    if (selected === "dialog") {
      const sizeOptions: Array<{ value: DesignDialogSize, label: string }> = [
        { value: "sm", label: "Small" },
        { value: "md", label: "Medium" },
        { value: "lg", label: "Large" },
        { value: "xl", label: "XL" },
        { value: "2xl", label: "2XL" },
        { value: "3xl", label: "3XL" },
        { value: "4xl", label: "4XL" },
        { value: "5xl", label: "5XL" },
        { value: "6xl", label: "6XL" },
        { value: "7xl", label: "7XL" },
        { value: "full", label: "Full" },
      ];
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 items-end">
          <PropField label="Shape">
            <DesignSelectorDropdown
              value={dialogShape}
              onValueChange={(v) => {
                if (v === "confirm" || v === "rich" || v === "wide") {
                  setDialogShape(v);
                  if (v === "confirm") {
                    setDialogSize("md");
                    setDialogTitle("Heads up");
                    setDialogDescription("This is a lightweight confirmation modal.");
                  } else if (v === "rich") {
                    setDialogSize("2xl");
                    setDialogTitle("Rule trigger history");
                    setDialogDescription("3 total triggers for this rule");
                  } else {
                    setDialogSize("5xl");
                    setDialogTitle("Test sign-up rules");
                    setDialogDescription("Simulate a sign-up request to see which rules trigger.");
                  }
                  return;
                }
                throw new Error(`Unknown dialog shape "${v}"`);
              }}
              options={[
                { value: "confirm", label: "Confirmation" },
                { value: "rich", label: "Rule trigger history" },
                { value: "wide", label: "Open tester" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Size">
            <DesignSelectorDropdown
              value={dialogSize}
              onValueChange={(v) => {
                const match = sizeOptions.find((o) => o.value === v);
                if (!match) throw new Error(`Unknown dialog size "${v}"`);
                setDialogSize(match.value);
              }}
              options={sizeOptions}
              size="sm"
            />
          </PropField>
          <PropField label="Variant">
            <DesignSelectorDropdown
              value={dialogVariant}
              onValueChange={(v) => {
                if (v === "glassmorphic" || v === "plain") {
                  setDialogVariant(v);
                  return;
                }
                throw new Error(`Unknown dialog variant "${v}"`);
              }}
              options={[
                { value: "glassmorphic", label: "Glassmorphic" },
                { value: "plain", label: "Plain" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Title">
            <DesignInput size="sm" value={dialogTitle} onChange={(e) => setDialogTitle(e.target.value)} />
          </PropField>
          <PropField label="Description">
            <DesignInput size="sm" value={dialogDescription} onChange={(e) => setDialogDescription(e.target.value)} placeholder="(empty = none)" />
          </PropField>
          <PropField label="Header Icon">
            <BoolToggle value={dialogShowIcon} onChange={setDialogShowIcon} on="Show" off="Hide" />
          </PropField>
          <PropField label="Footer">
            <BoolToggle value={dialogShowFooter} onChange={setDialogShowFooter} on="Show" off="Hide" />
          </PropField>
          <PropField label="Top-right Close">
            <BoolToggle value={!dialogHideTopClose} onChange={(v) => setDialogHideTopClose(!v)} on="Show" off="Hide" />
          </PropField>
          <PropField label="Custom Header">
            <BoolToggle value={dialogUseCustomHeader} onChange={setDialogUseCustomHeader} on="On" off="Off" />
          </PropField>
          <PropField label="No Body Padding">
            <BoolToggle value={dialogNoBodyPadding} onChange={setDialogNoBodyPadding} on="On" off="Off" />
          </PropField>
          <PropField label="Accent classNames">
            <BoolToggle value={dialogAccentClassNames} onChange={setDialogAccentClassNames} on="On" off="Off" />
          </PropField>
        </div>
      );
    }
    if (selected === "editable-grid") {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 items-end">
          <PropField label="Columns">
            <DesignSelectorDropdown
              value={String(gridCols)}
              onValueChange={(v) => {
                if (v === "1" || v === "2") {
                  setGridCols(Number(v) as 1 | 2);
                  return;
                }
                throw new Error(`Unknown column count "${v}"`);
              }}
              options={[
                { value: "1", label: "1 Column" },
                { value: "2", label: "2 Columns" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Mode">
            <DesignSelectorDropdown
              value={gridMode}
              onValueChange={(v) => {
                if (v === "basic" || v === "full") {
                  setGridMode(v);
                  return;
                }
                throw new Error(`Unknown grid mode "${v}"`);
              }}
              options={[
                { value: "basic", label: "Basic items" },
                { value: "full", label: "All item types" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Size">
            <DesignSelectorDropdown
              value={gridSize}
              onValueChange={(v) => {
                if (v === "sm" || v === "md") {
                  setGridSize(v);
                  return;
                }
                throw new Error(`Unknown grid size "${v}"`);
              }}
              options={[
                { value: "sm", label: "Small" },
                { value: "md", label: "Medium" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Edit Mode">
            <BoolToggle value={gridEditMode} onChange={setGridEditMode} />
          </PropField>
          <PropField label="Deferred Save">
            <BoolToggle value={gridDeferredSave} onChange={setGridDeferredSave} />
          </PropField>
          <PropField label="Has Changes">
            <BoolToggle value={gridHasChanges} onChange={setGridHasChanges} on="True" off="False" />
          </PropField>
          <PropField label="Modified Dots">
            <BoolToggle value={gridShowModified} onChange={setGridShowModified} on="Show" off="Hide" />
          </PropField>
        </div>
      );
    }
    if (selected === "input") {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 items-end">
          <PropField label="Placeholder">
            <DesignInput size="sm" value={inputPlaceholder} onChange={(e) => setInputPlaceholder(e.target.value)} />
          </PropField>
          <PropField label="Size">
            <DesignSelectorDropdown
              value={inputSize}
              onValueChange={(v) => {
                if (!isSize3(v)) throw new Error(`Unknown size "${v}"`);
                setInputSize(v);
              }}
              options={SIZE3_OPTIONS}
              size="sm"
            />
          </PropField>
          <PropField label="Leading Icon">
            <BoolToggle value={inputIcon} onChange={setInputIcon} />
          </PropField>
          <PropField label="Prefix Item">
            <BoolToggle
              value={inputPrefix}
              onChange={(v) => {
                setInputPrefix(v);
                if (v) {
                  setInputIcon(false);
                }
              }}
            />
          </PropField>
          <PropField label="Type">
            <DesignSelectorDropdown
              value={inputType}
              onValueChange={(v) => {
                if (v === "text" || v === "password") {
                  setInputType(v);
                  return;
                }
                throw new Error(`Unknown input type "${v}"`);
              }}
              options={[
                { value: "text", label: "Text" },
                { value: "password", label: "Password" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Disabled">
            <BoolToggle value={inputDisabled} onChange={setInputDisabled} on="Yes" off="No" />
          </PropField>
        </div>
      );
    }
    if (selected === "list-item-row") {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 items-end">
          <PropField label="Size">
            <DesignSelectorDropdown
              value={listSize}
              onValueChange={(v) => {
                if (v === "sm" || v === "lg") {
                  setListSize(v);
                  return;
                }
                throw new Error(`Unknown list size "${v}"`);
              }}
              options={[
                { value: "sm", label: "Small" },
                { value: "lg", label: "Large" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Title">
            <DesignInput size="sm" value={listTitle} onChange={(e) => setListTitle(e.target.value)} />
          </PropField>
          <PropField label="Subtitle">
            <DesignInput size="sm" value={listSubtitle} onChange={(e) => setListSubtitle(e.target.value)} placeholder="(empty = none)" />
          </PropField>
          <PropField label="With Icon">
            <BoolToggle value={listWithIcon} onChange={setListWithIcon} on="Yes" off="No" />
          </PropField>
          <PropField label="Clickable">
            <BoolToggle value={listClickable} onChange={setListClickable} on="Yes" off="No" />
          </PropField>
          <PropField label="Text Button">
            <BoolToggle value={listShowEditBtn} onChange={setListShowEditBtn} on="Show" off="Hide" />
          </PropField>
          <PropField label="Menu Button">
            <BoolToggle value={listShowMenuBtn} onChange={setListShowMenuBtn} on="Show" off="Hide" />
          </PropField>
        </div>
      );
    }
    if (selected === "menu") {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 items-end">
          <PropField label="Variant">
            <DesignSelectorDropdown
              value={menuVariant}
              onValueChange={(v) => {
                if (v === "actions" || v === "selector" || v === "toggles") {
                  setMenuVariant(v);
                  return;
                }
                throw new Error(`Unknown menu variant "${v}"`);
              }}
              options={[
                { value: "actions", label: "Actions" },
                { value: "selector", label: "Selector" },
                { value: "toggles", label: "Toggles" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Trigger">
            <DesignSelectorDropdown
              value={menuTrigger}
              onValueChange={(v) => {
                if (v === "button" || v === "icon") {
                  setMenuTrigger(v);
                  return;
                }
                throw new Error(`Unknown menu trigger "${v}"`);
              }}
              options={[
                { value: "button", label: "Button" },
                { value: "icon", label: "Icon" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Align">
            <DesignSelectorDropdown
              value={menuAlign}
              onValueChange={(v) => {
                if (v === "start" || v === "center" || v === "end") {
                  setMenuAlign(v);
                  return;
                }
                throw new Error(`Unknown menu align "${v}"`);
              }}
              options={[
                { value: "start", label: "Start" },
                { value: "center", label: "Center" },
                { value: "end", label: "End" },
              ]}
              size="sm"
            />
          </PropField>
          <PropField label="Trigger Label">
            <DesignInput size="sm" value={menuTriggerLabel} onChange={(e) => setMenuTriggerLabel(e.target.value)} />
          </PropField>
          <PropField label="Group Label">
            <DesignInput size="sm" value={menuLabel} onChange={(e) => setMenuLabel(e.target.value)} />
          </PropField>
          <PropField label="With Icons">
            <BoolToggle value={menuWithIcons} onChange={setMenuWithIcons} />
          </PropField>
          <PropField label="Delete Style">
            <DesignSelectorDropdown
              value={menuActionStyle}
              onValueChange={(v) => {
                if (v === "default" || v === "destructive") {
                  setMenuActionStyle(v);
                  return;
                }
                throw new Error(`Unknown menu item style "${v}"`);
              }}
              options={[
                { value: "default", label: "Default" },
                { value: "destructive", label: "Destructive" },
              ]}
              size="sm"
            />
          </PropField>
          {menuLastAction && (
            <PropField label="Last Action">
              <Typography variant="secondary" className="text-xs h-8 inline-flex items-center">
                {menuLastAction}
              </Typography>
            </PropField>
          )}
        </div>
      );
    }
    if (selected === "pill-toggle") {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 items-end">
          <PropField label="Size">
            <DesignSelectorDropdown
              value={pillSize}
              onValueChange={(v) => {
                if (!isSize3(v)) throw new Error(`Unknown size "${v}"`);
                setPillSize(v);
              }}
              options={SIZE3_OPTIONS}
              size="sm"
            />
          </PropField>
          <PropField label="Glassmorphic">
            <GlassmorphicToggle value={pillGlass} onChange={setPillGlass} />
          </PropField>
          <PropField label="With Icons">
            <BoolToggle value={pillWithIcons} onChange={setPillWithIcons} on="Yes" off="No" />
          </PropField>
          <PropField label="Show Labels">
            <BoolToggle value={pillShowLabels} onChange={setPillShowLabels} on="Show" off="Hide" />
          </PropField>
        </div>
      );
    }
    if (selected === "selector-dropdown") {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 items-end">
          <PropField label="Size">
            <DesignSelectorDropdown
              value={selSize}
              onValueChange={(v) => {
                if (!isSize3(v)) throw new Error(`Unknown size "${v}"`);
                setSelSize(v);
              }}
              options={SIZE3_OPTIONS}
              size="sm"
            />
          </PropField>
          <PropField label="Disabled">
            <BoolToggle value={selDisabled} onChange={setSelDisabled} on="Yes" off="No" />
          </PropField>
          <PropField label="Placeholder">
            <DesignInput size="sm" value={selPlaceholder} onChange={(e) => setSelPlaceholder(e.target.value)} />
          </PropField>
          <PropField label="Disable Option B">
            <BoolToggle value={selDisableOptionB} onChange={setSelDisableOptionB} on="Yes" off="No" />
          </PropField>
        </div>
      );
    }
    // user-list
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 items-end">
        <PropField label="User Clickable">
          <BoolToggle value={userClickable} onChange={setUserClickable} on="Yes" off="No" />
        </PropField>
        <PropField label="Show Avatar">
          <BoolToggle value={userShowAvatar} onChange={setUserShowAvatar} on="Show" off="Hide" />
        </PropField>
        <PropField label="Avatar Gradient">
          <DesignSelectorDropdown
            value={userGradient}
            onValueChange={(v) => {
              if (v === "blue-purple" || v === "cyan-blue" || v === "none") {
                setUserGradient(v);
                return;
              }
              throw new Error(`Unknown gradient "${v}"`);
            }}
            options={[
              { value: "blue-purple", label: "Blue → Purple" },
              { value: "cyan-blue", label: "Cyan → Blue" },
              { value: "none", label: "None" },
            ]}
            size="sm"
          />
        </PropField>
      </div>
    );
  }

  // ─── Code generation ─────────────────────────────────────────────────────

  function escapeAttr(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function getComponentCode(): string {
    if (selected === "alert") {
      return `<DesignAlert
  variant="${alertVariant}"
  title="${escapeAttr(alertTitle)}"
  description="${escapeAttr(alertDesc)}"
/>`;
    }
    if (selected === "analytics-card") {
      const headerSnippet = analyticsCardShowHeader
        ? `\n  <DesignAnalyticsCardHeader label="Daily Active Users" />`
        : "";
      const legendSnippet = analyticsCardShowLegend
        ? `\n  <DesignChartLegend\n    items={[\n      { key: "new", label: "New", color: "hsl(152, 38%, 52%)" },\n      { key: "retained", label: "Retained", color: "hsl(221, 42%, 55%)" },\n      { key: "reactivated", label: "Reactivated", color: "hsl(36, 55%, 58%)" },\n    ]}\n  />`
        : "";
      return `<DesignAnalyticsCard
  gradient="${analyticsCardGradient}"
  chart={{
    type: "${analyticsCardType}",
    tooltipType: "${analyticsCardTooltipType}",
    highlightMode: "${analyticsCardHighlightMode}",
    averages: {
      movingAverage: ${analyticsCardMovingAverage},
      sevenDayAverage: ${analyticsCardSevenDayAverage},
      movingAverageDataKey: "${escapeAttr(analyticsCardMovingAverageDataKey)}",
      sevenDayAverageDataKey: "${escapeAttr(analyticsCardSevenDayAverageDataKey)}",
    },
  }}
>${headerSnippet}${legendSnippet}
  {/* chart content */}
</DesignAnalyticsCard>`;
    }
    if (selected === "badge") {
      const iconProp = badgeContentMode === "icon"
        ? 'icon={CheckCircle}'
        : (badgeIcon ? "icon={CheckCircle}" : "icon={undefined}");
      const hasIcon = badgeContentMode === "icon" || (badgeContentMode === "both" && badgeIcon);
      const spinProp = hasIcon && badgeSpin ? '\n  iconClassName="animate-spin"' : "";
      return `<DesignBadge
  label="${escapeAttr(badgeLabel || "Badge")}"
  color="${badgeColor}"
  size="${badgeSize}"
  contentMode="${badgeContentMode}"
  ${iconProp}${spinProp}
/>`;
    }
    if (selected === "button") {
      const child = btnSize === "icon"
        ? "<Sparkle className=\"h-4 w-4\" />"
        : `"${escapeAttr(btnLabel || "Button")}"`;
      return `<DesignButton
  variant="${btnVariant}"
  size="${btnSize}"
  loading={${btnLoading}}
>
  ${child}
</DesignButton>`;
    }
    if (selected === "card") {
      const glassProp = cardGlass === undefined ? "" : `\n  glassmorphic={${cardGlass}}`;
      const titleProps = cardTitle
        ? `\n  icon={Package}\n  title="${escapeAttr(cardTitle)}"`
          + (cardSubtitle ? `\n  subtitle="${escapeAttr(cardSubtitle)}"` : "")
          + (cardShowActions
            ? "\n  actions={\n    <DesignButton variant=\"secondary\" size=\"sm\" className=\"h-8 px-3 text-xs gap-1.5\">\n      <Sliders className=\"h-3.5 w-3.5\" />\n      Configure\n    </DesignButton>\n  }"
            : "")
        : "";
      return `<DesignCard${titleProps}
  gradient="${cardGradient}"${glassProp}
>
  <Typography variant="secondary" className="text-sm">
    Highlight pricing, benefits, or key product details here.
  </Typography>
</DesignCard>`;
    }
    if (selected === "category-tabs") {
      return `<DesignCategoryTabs
  categories={[
    { id: "all", label: "All Items", count: 24 },
    { id: "active", label: "Active", count: 12 },
    { id: "draft", label: "Drafts", count: 8 },
    { id: "archived", label: "Archived", count: 4 },
  ]}
  selectedCategory="${escapeAttr(tabSelected)}"
  onSelect={setSelectedCategory}
  showBadge={${tabShowBadge}}
  size="${tabSize}"${tabGlass === undefined ? "" : `\n  glassmorphic={${tabGlass}}`}
  gradient="${tabGradient}"
  trailing={
    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
      + Install apps
    </span>
  }
/>`;
    }
    if (selected === "cursor-blast") {
      return `<CursorBlastEffect
  containerRef={containerRef}
  blastLifetimeMs={${blastLifetime}}
  maxActiveBlasts={${blastMaxActive}}
  rageClickThreshold={${blastRageThreshold}}
  rageClickWindowMs={${blastRageWindow}}
  rageClickRadiusPx={${blastRageRadius}}
/>`;
    }
    if (selected === "data-grid") {
      return `<DataGrid<DemoGridUser>
  columns={DEMO_GRID_COLUMNS}
  rows={dgData.rows}
  getRowId={(row) => row.id}
  totalRowCount={dgData.totalRowCount}
  isLoading={dgData.isLoading}
  state={dgState}
  onChange={setDgState}
  selectionMode="${dgSelectionMode}"
  rowHeight={${dgRowHeight}}
  toolbar={${dgShowToolbar ? "undefined" : "false"}}
  stickyTop={${dgStickyTop === "local" ? "80" : "undefined"}}
  maxHeight={400}
/>`;
    }
    if (selected === "dialog") {
      const dialogTriggerLabel = dialogShape === "rich"
        ? "Open trigger history"
        : dialogShape === "wide"
          ? "Open tester"
          : "Open confirmation";
      const iconImport = dialogShowIcon
        ? (dialogShape === "rich" ? "PulseIcon" : dialogShape === "wide" ? "FlaskIcon" : "InfoIcon")
        : null;
      const iconProp = iconImport ? `\n  icon={${iconImport}}` : `\n  icon={null}`;
      const descProp = dialogDescription ? `\n  description="${escapeAttr(dialogDescription)}"` : "";
      const variantProp = dialogVariant === "glassmorphic" ? "" : `\n  variant="${dialogVariant}"`;
      const hideCloseProp = dialogHideTopClose ? `\n  hideTopCloseButton` : "";
      const headerContentProp = dialogShape === "rich"
        ? `\n  headerContent={\n    <div className=\"rounded-xl bg-foreground/[0.02] ring-1 ring-foreground/[0.06] p-3 space-y-3\">\n      {/* summary card: title row + 3 stat tiles */}\n    </div>\n  }`
        : "";
      const footerProp = dialogShowFooter
        ? (dialogShape === "wide"
          ? `\n  footer={\n    <>\n      <DesignDialogClose asChild>\n        <DesignButton variant=\"secondary\" size=\"sm\">Cancel</DesignButton>\n      </DesignDialogClose>\n      <DesignButton size=\"sm\">Run test</DesignButton>\n    </>\n  }`
          : `\n  footer={\n    <DesignDialogClose asChild>\n      <DesignButton variant=\"secondary\" size=\"sm\">Close</DesignButton>\n    </DesignDialogClose>\n  }`)
        : "";
      const bodySnippet = dialogShape === "rich"
        ? `\n  <span className=\"text-xs font-semibold uppercase tracking-wider text-muted-foreground\">Recent triggers</span>\n  {/* recent triggers list */}`
        : dialogShape === "wide"
          ? `\n  <DesignAlert variant=\"info\" description=\"Wide-form body content\" />\n  {/* tester form */}`
          : `\n  <p className=\"text-sm\">Body content lives here.</p>`;
      const customHeaderProp = dialogUseCustomHeader
        ? `\n  customHeader={\n    <div className=\"flex items-center gap-3 px-6 py-4 ...\">\n      {/* custom header content; replaces title/description region */}\n    </div>\n  }`
        : "";
      const noBodyPaddingProp = dialogNoBodyPadding ? `\n  noBodyPadding` : "";
      const classNameProps = dialogAccentClassNames
        ? `\n  className=\"ring-2 ring-indigo-500/40\"\n  overlayClassName=\"bg-indigo-950/40\"\n  headerClassName=\"bg-indigo-500/5\"\n  bodyClassName=\"bg-foreground/[0.02]\"\n  footerClassName=\"bg-foreground/[0.02]\"`
        : "";
      return `<DesignDialog
  size="${dialogSize}"${variantProp}${iconProp}
  title="${escapeAttr(dialogTitle || "Dialog")}"${descProp}${headerContentProp}${customHeaderProp}${footerProp}${hideCloseProp}${noBodyPaddingProp}${classNameProps}
  trigger={<DesignButton size="sm">${escapeAttr(dialogTriggerLabel)}</DesignButton>}
>${bodySnippet}
</DesignDialog>`;
    }
    if (selected === "data-table") {
      return `<DataGrid
  columns={DEMO_PRODUCT_COLUMNS}
  rows={dtData.rows}
  getRowId={(row) => row.id}
  totalRowCount={dtData.totalRowCount}
  isLoading={dtData.isLoading}
  state={dtState}
  onChange={setDtState}
  toolbar={${tableShowToolbar ? "undefined" : "false"}}
  onRowClick={${tableClickableRows ? "(row) => setTableLastRowClick(row.name)" : "undefined"}}
  maxHeight={400}
/>`;
    }
    if (selected === "editable-grid") {
      const itemsSnippet = gridMode === "full"
        ? `[
    { itemKey: "display-name", type: "text", icon: <FileText />, name: "Display Name", value: "Widget Pro", onUpdate: handleUpdate },
    { itemKey: "active", type: "boolean", icon: <StackSimple />, name: "Active", value: true, trueLabel: "Yes", falseLabel: "No", onUpdate: handleUpdate },
    { itemKey: "category", type: "dropdown", icon: <Sliders />, name: "Category", value: "hardware", options: [...], onUpdate: handleUpdate },
    { itemKey: "price", type: "custom", icon: <Tag />, name: "Price", children: <span>$29.99</span> },
    { itemKey: "custom-dropdown", type: "custom-dropdown", icon: <Sparkle />, name: "Custom Dropdown", triggerContent: <span>Open custom panel</span>, popoverContent: <div>...</div> },
    { itemKey: "custom-button", type: "custom-button", icon: <Cube />, name: "Custom Button", onClick: handleClick, children: <span>Run action</span> },
  ]`
        : `[
    { itemKey: "display-name", type: "text", icon: <FileText />, name: "Display Name", value: "Widget Pro", onUpdate: handleUpdate },
    { itemKey: "active", type: "boolean", icon: <StackSimple />, name: "Active", value: true, trueLabel: "Yes", falseLabel: "No", onUpdate: handleUpdate },
    { itemKey: "category", type: "dropdown", icon: <Sliders />, name: "Category", value: "hardware", options: [...], onUpdate: handleUpdate },
    { itemKey: "price", type: "custom", icon: <Tag />, name: "Price", children: <span>$29.99</span> },
  ]`;
      return `<DesignEditableGrid
  items={${itemsSnippet}}
  columns={${gridCols}}
  size="${gridSize}"
  editMode={${gridEditMode}}
  deferredSave={${gridDeferredSave}}
  hasChanges={${gridHasChanges}}
  onSave={${gridDeferredSave ? "handleSave" : "undefined"}}
  onDiscard={${gridDeferredSave ? "handleDiscard" : "undefined"}}
  externalModifiedKeys={${gridShowModified ? 'new Set(["display-name", "category"])' : "undefined"}}
/>`;
    }
    if (selected === "input") {
      const leading = inputPrefix
        ? "prefixItem=\"$\""
        : (inputIcon ? "leadingIcon={<MagnifyingGlassIcon className=\"h-3 w-3\" />}" : "leadingIcon={undefined}");
      return `<DesignInput
  type="${inputType}"
  size="${inputSize}"
  disabled={${inputDisabled}}
  placeholder="${escapeAttr(inputPlaceholder)}"
  ${leading}
/>`;
    }
    if (selected === "list-item-row") {
      const btnEntries: string[] = [];
      if (listShowEditBtn) {
        btnEntries.push(`    { id: "edit", label: "Edit", onClick: () => handleEdit() }`);
      }
      if (listShowMenuBtn) {
        btnEntries.push(`    {\n      id: "more",\n      label: "Options",\n      display: "icon",\n      onClick: [\n        { id: "duplicate", label: "Duplicate", onClick: () => handleDuplicate() },\n        { id: "delete", label: "Delete", itemVariant: "destructive", onClick: () => handleDelete() },\n      ],\n    }`);
      }
      const buttonsProp = btnEntries.length > 0
        ? `\n  buttons={[\n${btnEntries.join(",\n")},\n  ]}`
        : "";
      const iconProp = listWithIcon ? "\n  icon={Cube}" : "";
      const subtitleProp = listSubtitle ? `\n  subtitle="${escapeAttr(listSubtitle)}"` : "";
      const clickProp = listClickable ? "\n  onClick={() => handleRowClick()}" : "";
      return `<DesignListItemRow${iconProp}
  title="${escapeAttr(listTitle)}"${subtitleProp}
  size="${listSize}"${clickProp}${buttonsProp}
/>`;
    }
    if (selected === "menu") {
      if (menuVariant === "selector") {
        return `<DesignMenu
  variant="selector"
  trigger="${menuTrigger}"
  align="${menuAlign}"
  triggerLabel={selectedOption?.label ?? "Select"}
  label="${escapeAttr(menuLabel)}"
  options={[
    { id: "all", label: "All" },
    { id: "active", label: "Active" },
    { id: "drafts", label: "Drafts" },
  ]}
  value="${escapeAttr(menuSelectorValue)}"
  onValueChange={setSelectedOption}
/>`;
      }
      if (menuVariant === "toggles") {
        return `<DesignMenu
  variant="toggles"
  trigger="${menuTrigger}"
  triggerLabel="${escapeAttr(menuTriggerLabel)}"
  align="${menuAlign}"
  label="${escapeAttr(menuLabel)}"
  options={[
    { id: "opt1", label: "Name", checked: ${menuToggles.opt1} },
    { id: "opt2", label: "Status", checked: ${menuToggles.opt2} },
    { id: "opt3", label: "Price", checked: ${menuToggles.opt3} },
  ]}
  onToggleChange={(id, checked) => setToggles((prev) => ({ ...prev, [id]: checked }))}
/>`;
      }
      return `<DesignMenu
  variant="actions"
  trigger="${menuTrigger}"
  triggerLabel="${escapeAttr(menuTriggerLabel)}"
  align="${menuAlign}"
  label="${escapeAttr(menuLabel)}"
  withIcons={${menuWithIcons}}
  items={[
    { id: "edit", label: "Edit", icon: <PencilSimple className="h-4 w-4" />, onClick: () => {} },
    { id: "email", label: "Send email", icon: <Envelope className="h-4 w-4" />, onClick: () => {} },
    { id: "delete", label: "Delete", icon: <Trash className="h-4 w-4" />, itemVariant: "${menuActionStyle}", onClick: () => {} },
  ]}
/>`;
    }
    if (selected === "pill-toggle") {
      const iconSuffix = pillWithIcons ? ", icon: Envelope" : "";
      const iconSuffix2 = pillWithIcons ? ", icon: HardDrive" : "";
      const iconSuffix3 = pillWithIcons ? ", icon: Sparkle" : "";
      return `<DesignPillToggle
  options={[
    { id: "a", label: "Phone"${iconSuffix} },
    { id: "b", label: "Tablet"${iconSuffix2} },
    { id: "c", label: "Desktop"${iconSuffix3} },
  ]}
  selected="${pillSelected}"
  onSelect={setPillSelected}
  size="${pillSize}"${pillGlass === undefined ? "" : `\n  glassmorphic={${pillGlass}}`}
  showLabels={${pillShowLabels}}
/>`;
    }
    if (selected === "selector-dropdown") {
      return `<DesignSelectorDropdown
  value="${escapeAttr(selValue)}"
  onValueChange={setSelValue}
  options={[
    { value: "option-a", label: "Option A" },
    { value: "option-b", label: "Option B", disabled: ${selDisableOptionB} },
    { value: "option-c", label: "Option C" },
  ]}
  placeholder="${escapeAttr(selPlaceholder)}"
  size="${selSize}"
  disabled={${selDisabled}}
/>`;
    }
    // user-list
    return `<DesignUserList
  users={users}
  showAvatar={${userShowAvatar}}
  gradient="${userGradient}"
  onUserClick={${userClickable ? "(user) => handleUserClick(user)" : "undefined"}}
/>`;
  }

  // ─── Layout ──────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 w-full">
      <div className="mx-auto w-full max-w-5xl px-4 sm:px-6 py-8 sm:py-10 space-y-7 sm:space-y-8">

        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <Typography type="h2" className="text-xl font-semibold tracking-tight">
              Playground
            </Typography>
            <Typography variant="secondary" className="text-[13px]">
              Explore and configure every design-language component.
            </Typography>
          </div>
          <div className="w-full sm:w-64 shrink-0">
            <DesignSelectorDropdown
              value={selected}
              onValueChange={(v) => {
                if (!isComponentId(v)) throw new Error(`Unknown component "${v}"`);
                setSelected(v);
              }}
              options={COMPONENT_LIST}
              size="md"
            />
          </div>
        </div>

        {/* Preview */}
        <div
          className="relative rounded-2xl border border-black/[0.08] dark:border-white/[0.09] bg-gradient-to-b from-black/[0.03] to-black/[0.05] dark:from-white/[0.02] dark:to-white/[0.04] p-2 sm:p-3 overflow-hidden"
          style={{
            backgroundImage:
              "radial-gradient(circle, hsl(var(--foreground) / 0.05) 1px, transparent 1px)",
            backgroundSize: "18px 18px",
          }}
        >
          <div
            ref={blastPreviewRef}
            className="relative w-full rounded-xl border border-black/[0.08] dark:border-white/[0.1] bg-white/85 dark:bg-[hsl(240,12%,9%)] shadow-sm flex items-center justify-center p-3 sm:p-4"
          >
            {renderPreview()}
          </div>
        </div>

        {/* Controls */}
        <div className="space-y-2">
          <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">
            Props
          </span>
          <div className="rounded-xl border border-black/[0.08] dark:border-white/[0.09] bg-background/85 backdrop-blur-sm p-4 sm:p-5">
            {renderControls()}
          </div>
        </div>

        {/* Code */}
        <div className="space-y-2">
          <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/70">
            Code
          </span>
          <CodeBlock
            language="tsx"
            content={getComponentCode()}
            title="Component with current props"
            icon="code"
            compact
            neutralBackground
          />
        </div>
      </div>
    </div>
  );
}
