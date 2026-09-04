"use client";

import {
  DesignBadge,
  DesignEditableGrid,
  DesignButton,
  DesignInput,
  DesignMenu,
  DesignSelectorDropdown,
  type DesignBadgeColor,
  type DesignEditableGridItem,
} from "@/components/design-components";
import { Link, StyledLink } from "@/components/link";
import { ItemDialog } from "@/components/payments/item-dialog";
import { useRouter } from "@/components/router";
import {
  ActionCell,
  Alert,
  AvatarCell,
  AvatarCellSkeleton,
  Badge,
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  SimpleTooltip,
  Skeleton,
  toast,
  Typography,
} from "@/components/ui";
import { createDefaultDataGridState, DataGrid, useDataGridUrlState, useDataSource, type DataGridColumnDef } from "@hexclave/dashboard-ui-components";
import { useUpdateConfig } from "@/components/config-update";
import { ArrowLeftIcon, Check, ClockIcon, CopyIcon, CurrencyDollarIcon, FolderOpenIcon, GiftIcon, HardDriveIcon, PackageIcon, PencilSimpleIcon, PlusIcon, PuzzlePieceIcon, ShoppingCartIcon, StackIcon, TagIcon, TrashIcon, UsersIcon, X } from "@phosphor-icons/react";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { CreateCheckoutDialog } from "@/components/payments/create-checkout-dialog";
import type { CustomerType } from "@/components/payments/customer-selector";
import type { CompleteConfig } from "@hexclave/shared/dist/config/schema";
import type { Transaction, TransactionEntry } from "@hexclave/shared/dist/interface/crud/transactions";
import type { DayInterval } from "@hexclave/shared/dist/utils/dates";
import { fromNow } from "@hexclave/shared/dist/utils/dates";
import { prettyPrintWithMagnitudes } from "@hexclave/shared/dist/utils/numbers";
import { typedEntries } from "@hexclave/shared/dist/utils/objects";
import { Suspense, useMemo, useRef, useState } from "react";
import { PageLayout } from "../../../page-layout";
import { useAdminApp, useProjectId } from "../../../use-admin-app";
import { CreateProductLineDialog } from "../create-product-line-dialog";
import {
  createNewEditingPrice,
  editingPriceToPrice,
  PriceEditDialog,
  priceToEditingPrice,
  type EditingPrice,
} from "../price-edit-dialog";
import { createFreePrice, DEFAULT_INTERVAL_UNITS, generateUniqueId, intervalLabel, isFreePrices, shortIntervalLabel, type Price, type Product } from "../utils";

const CUSTOMER_TYPE_COLORS = {
  user: 'bg-blue-500/15 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400 ring-blue-500/30',
  team: 'bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400 ring-emerald-500/30',
  custom: 'bg-amber-500/15 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400 ring-amber-500/30',
} as const;

const CUSTOMER_TYPE_BADGE_COLORS = new Map<string, DesignBadgeColor>([
  ["user", "blue"],
  ["team", "green"],
  ["custom", "orange"],
]);

function getCustomerTypeBadgeColor(customerType: string): DesignBadgeColor {
  return CUSTOMER_TYPE_BADGE_COLORS.get(customerType) ?? "blue";
}

export default function PageClient({ productId }: { productId: string }) {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const config = project.useConfig();
  const updateConfig = useUpdateConfig();
  const product: Product | undefined = Object.hasOwn(config.payments.products, productId)
    ? config.payments.products[productId]
    : undefined;

  if (product == null) {
    return (
      <PageLayout title="Product Not Found">
        <div className="flex flex-col items-center justify-center py-12 gap-4">
          <PackageIcon className="h-12 w-12 text-muted-foreground/50" />
          <Typography className="text-muted-foreground">Product not found</Typography>
          <Button variant="outline" asChild>
            <Link href={`/projects/${adminApp.projectId}/payments/products`}>
              Back to Products
            </Link>
          </Button>
        </div>
      </PageLayout>
    );
  }

  return <ProductPage productId={productId} product={product} config={config} />;
}

type ProductPageProps = {
  productId: string,
  product: Product,
  config: CompleteConfig,
};

function ProductPage({ productId, product, config }: ProductPageProps) {
  const router = useRouter();
  const productLineId = product.productLineId;
  const productLineName = productLineId && productLineId in config.payments.productLines ? config.payments.productLines[productLineId].displayName || productLineId : null;
  const canGoBack = typeof window !== 'undefined' && window.history.length > 1;

  return (
    <PageLayout>
      <div className="flex flex-col gap-6">
        {canGoBack && (
          <DesignButton
            variant="ghost"
            size="sm"
            className="w-fit -ml-2 h-8 gap-1.5 rounded-lg px-2 text-muted-foreground hover:text-foreground"
            onClick={() => router.back()}
          >
            <ArrowLeftIcon className="h-4 w-4" />
            Back
          </DesignButton>
        )}
        <ProductHeader productId={productId} product={product} productLineName={productLineName} />
        <Separator />
        <ProductDetailsSection productId={productId} product={product} config={config} />
        <Separator />
        <Suspense fallback={<CustomersSkeleton />}>
          <ProductCustomersSection productId={productId} product={product} />
        </Suspense>
      </div>
    </PageLayout>
  );
}

type ProductHeaderProps = {
  productId: string,
  product: Product,
  productLineName: string | null,
};

function ProductTitleEditor({
  productId,
  displayName,
  storedDisplayName,
}: {
  productId: string,
  displayName: string,
  storedDisplayName: string,
}) {
  const adminApp = useAdminApp();
  const updateConfig = useUpdateConfig();
  const [editing, setEditing] = useState(false);
  const [draftValue, setDraftValue] = useState(storedDisplayName);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const beginEditing = () => {
    setDraftValue(storedDisplayName);
    setEditing(true);
  };

  const cancelEditing = () => {
    setDraftValue(storedDisplayName);
    setEditing(false);
  };

  const save = async () => {
    setIsSaving(true);
    try {
      const success = await updateConfig({
        adminApp,
        configUpdate: {
          [`payments.products.${productId}.displayName`]: draftValue || null,
        },
        pushable: true,
      });
      if (success) {
        toast({ title: "Product name updated" });
        setEditing(false);
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      role={editing ? undefined : "button"}
      tabIndex={editing ? undefined : 0}
      aria-label={editing ? undefined : "Edit display name"}
      className={cn(
        "group flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-lg border px-2.5",
        "border-black/[0.1] bg-white cursor-text",
        "hover:border-black/[0.16] hover:bg-zinc-50",
        "dark:border-white/[0.1] dark:bg-zinc-950 dark:hover:border-white/[0.18] dark:hover:bg-zinc-900",
        "transition-colors duration-150 hover:transition-none",
        editing && "border-black/[0.28] dark:border-white/[0.32]",
      )}
      onClick={() => {
        if (!editing) {
          beginEditing();
        } else {
          inputRef.current?.focus();
        }
      }}
      onKeyDown={(event) => {
        if (editing) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          beginEditing();
        }
      }}
    >
      {editing ? (
        <input
          ref={inputRef}
          autoFocus
          aria-label="Display name"
          autoComplete="off"
          disabled={isSaving}
          value={draftValue}
          placeholder={productId}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setDraftValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (draftValue !== storedDisplayName && !isSaving) {
                runAsynchronouslyWithAlert(save());
              }
            }
            if (event.key === "Escape") {
              cancelEditing();
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-lg font-semibold leading-none tracking-tight text-foreground outline-none placeholder:text-muted-foreground/60 disabled:opacity-50"
        />
      ) : (
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold leading-none tracking-tight text-foreground">
          {displayName}
        </h1>
      )}
      {editing ? (
        <div className="flex shrink-0 items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
          <DesignButton
            aria-label="Save display name"
            className="h-6 w-6 rounded-md p-0 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700 dark:text-emerald-400"
            disabled={draftValue === storedDisplayName || isSaving}
            loading={isSaving}
            onClick={save}
            size="icon"
            variant="ghost"
          >
            <Check aria-hidden className="h-3.5 w-3.5" weight="bold" />
          </DesignButton>
          <DesignButton
            aria-label="Cancel editing display name"
            className="h-6 w-6 rounded-md p-0 text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400"
            disabled={isSaving}
            onClick={cancelEditing}
            size="icon"
            variant="ghost"
          >
            <X aria-hidden className="h-3.5 w-3.5" weight="bold" />
          </DesignButton>
        </div>
      ) : (
        <PencilSimpleIcon
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors duration-150 group-hover:text-foreground group-hover:transition-none"
        />
      )}
    </div>
  );
}

function ProductHeader({ productId, product, productLineName }: ProductHeaderProps) {
  const projectId = useProjectId();
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const config = project.useConfig();
  const router = useRouter();
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const displayName = product.displayName || productId;
  const isAddOn = product.isAddOnTo !== false && typeof product.isAddOnTo === "object";

  const addOnParents = useMemo(() => {
    if (product.isAddOnTo === false || typeof product.isAddOnTo !== "object") {
      return [];
    }
    return Object.keys(product.isAddOnTo).map((parentId) => ({
      id: parentId,
      displayName: config.payments.products[parentId].displayName || parentId,
    }));
  }, [product.isAddOnTo, config.payments.products]);

  return (
    <div className="flex items-start gap-4">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-black/[0.1] bg-white text-muted-foreground dark:border-white/[0.1] dark:bg-zinc-950">
        {isAddOn ? (
          <PuzzlePieceIcon className="h-7 w-7" />
        ) : (
          <PackageIcon className="h-7 w-7" />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <ProductTitleEditor
            productId={productId}
            displayName={displayName}
            storedDisplayName={product.displayName || ""}
          />
          <div className="flex shrink-0 items-center">
            <CreateCheckoutDialog
              open={isCheckoutOpen}
              onOpenChange={setIsCheckoutOpen}
              customerType={product.customerType as CustomerType}
              productId={productId}
              lockProduct
            />
            <DesignMenu
              variant="actions"
              trigger="icon"
              triggerLabel="Product actions"
              align="end"
              withIcons
              items={[
                {
                  id: "checkout",
                  label: "Create checkout",
                  icon: <ShoppingCartIcon className="h-4 w-4" />,
                  onClick: () => setIsCheckoutOpen(true),
                },
                {
                  id: "product-lines",
                  label: "View in Product Lines",
                  icon: <FolderOpenIcon className="h-4 w-4" />,
                  onClick: () => router.push(`/projects/${projectId}/payments/product-lines#product-${productId}`),
                },
                {
                  id: "edit",
                  label: "Edit full details",
                  icon: <PencilSimpleIcon className="h-4 w-4" />,
                  onClick: () => router.push(`/projects/${projectId}/payments/products/${productId}/edit`),
                },
              ]}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <DesignBadge
            label={product.customerType.toUpperCase()}
            color={getCustomerTypeBadgeColor(product.customerType)}
            size="sm"
            contentMode="text"
          />
          <span className="inline-flex items-center rounded-md border border-black/[0.08] bg-white px-2 py-0.5 font-mono text-[11px] text-muted-foreground dark:border-white/[0.1] dark:bg-zinc-950">
            ID: {productId}
          </span>
          {productLineName != null && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="text-muted-foreground/40">·</span>
              Product Line: <span className="font-medium text-foreground">{productLineName}</span>
            </span>
          )}
          {addOnParents.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              <span className="text-muted-foreground/40">·</span>
              Add-on to{" "}
              {addOnParents.map((parent, index) => (
                <span key={parent.id} className="inline-flex items-center">
                  {index > 0 && <span className="mr-1 text-muted-foreground/50">,</span>}
                  <StyledLink href={`/projects/${adminApp.projectId}/payments/products/${parent.id}`}>
                    {parent.displayName}
                  </StyledLink>
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

type ProductDetailsSectionProps = {
  productId: string,
  product: Product,
  config: CompleteConfig,
};

// Type for pending changes to be applied on save
type PendingProductChanges = {
  displayName?: string | null,
  catalogId?: string | null,
  stackable?: boolean | null,
  serverOnly?: boolean | null,
  freeTrial?: DayInterval | null,
  isAddOnTo?: Record<string, true> | null,
  prices?: Product['prices'],
  includedItems?: Product['includedItems'],
  // For creating new catalogs
  newCatalogs?: Record<string, { displayName: string | undefined }>,
};

function ProductDetailsSection({ productId, product, config }: ProductDetailsSectionProps) {
  const adminApp = useAdminApp();
  const updateConfig = useUpdateConfig();

  // Dialog states
  const [addOnDialogOpen, setAddOnDialogOpen] = useState(false);
  const [freeTrialPopoverOpen, setFreeTrialPopoverOpen] = useState(false);
  const [createProductLineDialogOpen, setCreateProductLineDialogOpen] = useState(false);

  // ===== LOCAL STATE FOR DEFERRED SAVE =====
  // Track all pending changes. undefined means "use original value"
  const [pendingChanges, setPendingChanges] = useState<PendingProductChanges>({});
  // Inline validation error shown above the editable grid. We avoid `window.alert()`
  // (jarring/blocking) and `toast()` (per AGENTS.md, blocking errors are easily
  // missed as toasts) in favor of a destructive Alert in the design system.
  const [saveValidationError, setSaveValidationError] = useState<string | null>(null);

  // Computed local values (pending change or original)
  const localDisplayName = pendingChanges.displayName !== undefined ? pendingChanges.displayName : (product.displayName || '');
  const localStackable = pendingChanges.stackable !== undefined ? !!pendingChanges.stackable : !!product.stackable;
  const localServerOnly = pendingChanges.serverOnly !== undefined ? !!pendingChanges.serverOnly : !!product.serverOnly;
  const localFreeTrial = pendingChanges.freeTrial !== undefined ? pendingChanges.freeTrial : (product.freeTrial || null);
  const localIsAddOnTo = pendingChanges.isAddOnTo !== undefined
    ? pendingChanges.isAddOnTo
    : (product.isAddOnTo !== false && typeof product.isAddOnTo === 'object' ? product.isAddOnTo : null);
  const localPrices = pendingChanges.prices !== undefined ? pendingChanges.prices : product.prices;
  const localIncludedItems = pendingChanges.includedItems !== undefined ? pendingChanges.includedItems : product.includedItems;

  // Check if there are any pending changes
  const hasChanges = Object.keys(pendingChanges).length > 0;

  // Compute which item keys are modified (for visual indicator)
  const externalModifiedKeys = useMemo(() => {
    const keys = new Set<string>();
    if (pendingChanges.displayName !== undefined) keys.add('displayName');
    if (pendingChanges.stackable !== undefined) keys.add('stackable');
    if (pendingChanges.serverOnly !== undefined) keys.add('serverOnly');
    if (pendingChanges.freeTrial !== undefined) keys.add('freeTrial');
    if (pendingChanges.isAddOnTo !== undefined) keys.add('isAddOnTo');
    if (pendingChanges.prices !== undefined) keys.add('prices');
    if (pendingChanges.includedItems !== undefined) keys.add('includedItems');
    return keys;
  }, [pendingChanges]);

  // Discard all pending changes
  const handleDiscard = () => {
    setPendingChanges({});
    setSaveValidationError(null);
    // Reset add-on dialog state
    setIsAddOn(product.isAddOnTo !== false && typeof product.isAddOnTo === 'object');
    setSelectedAddOnProducts(
      product.isAddOnTo !== false && typeof product.isAddOnTo === 'object'
        ? new Set(Object.keys(product.isAddOnTo))
        : new Set()
    );
  };

  // Save all pending changes
  const handleSave = async () => {
    const effectivePrices = pendingChanges.prices ?? product.prices;
    if (Object.keys(effectivePrices).length === 0) {
      setSaveValidationError("A product must have at least one price. Add a price option or make the product free before saving.");
      return;
    }
    setSaveValidationError(null);

    const configUpdate: Record<string, any> = {};

    // Apply product changes
    if (pendingChanges.displayName !== undefined) {
      configUpdate[`payments.products.${productId}.displayName`] = pendingChanges.displayName || null;
    }
    if (pendingChanges.stackable !== undefined) {
      configUpdate[`payments.products.${productId}.stackable`] = pendingChanges.stackable;
    }
    if (pendingChanges.serverOnly !== undefined) {
      configUpdate[`payments.products.${productId}.serverOnly`] = pendingChanges.serverOnly;
    }
    if (pendingChanges.freeTrial !== undefined) {
      configUpdate[`payments.products.${productId}.freeTrial`] = pendingChanges.freeTrial;
    }
    if (pendingChanges.isAddOnTo !== undefined) {
      configUpdate[`payments.products.${productId}.isAddOnTo`] = pendingChanges.isAddOnTo;
    }
    if (pendingChanges.prices !== undefined) {
      configUpdate[`payments.products.${productId}.prices`] = pendingChanges.prices;
    }
    if (pendingChanges.includedItems !== undefined) {
      configUpdate[`payments.products.${productId}.includedItems`] = Object.keys(pendingChanges.includedItems).length > 0 ? pendingChanges.includedItems : null;
    }

    const success = await updateConfig({ adminApp, configUpdate, pushable: true });
    if (success) {
      setPendingChanges({});
      toast({ title: "Changes saved" });
    }
    // If cancelled (success === false), keep pending changes as-is
  };

  // Get all productLines with their customer types (only show matching customer type)
  const productLineOptions = useMemo(() => {
    const productLines = Object.entries(config.payments.productLines)
      .filter(([, productLine]) => productLine.customerType === product.customerType)
      .map(([id, productLine]) => ({
        value: id,
        label: productLine.displayName || id,
        customerType: productLine.customerType,
        disabled: false,
        disabledReason: undefined,
      }));

    // Also add "No product line" option (using __none__ since Select.Item can't have empty string value)
    return [
      { value: '__none__', label: 'No product line', disabled: false, disabledReason: undefined, customerType: undefined },
      ...productLines,
    ];
  }, [config.payments.productLines, product.customerType]);

  // Add-on dialog state (temporary state for the dialog, applied on dialog save)
  const [isAddOn, setIsAddOn] = useState(() => product.isAddOnTo !== false && typeof product.isAddOnTo === 'object');
  const [selectedAddOnProducts, setSelectedAddOnProducts] = useState<Set<string>>(() => {
    if (product.isAddOnTo === false || typeof product.isAddOnTo !== 'object') return new Set();
    return new Set(Object.keys(product.isAddOnTo));
  });

  // Free trial popover state
  const [freeTrialCount, setFreeTrialCount] = useState(() => product.freeTrial ? product.freeTrial[0] : 7);
  const [freeTrialUnit, setFreeTrialUnit] = useState<DayInterval[1]>(() => product.freeTrial ? product.freeTrial[1] : 'day');

  // Computed: add-on parent products from local state
  const localAddOnParents = useMemo(() => {
    if (!localIsAddOnTo) return [];
    return Object.keys(localIsAddOnTo).map((parentId: string) => ({
      id: parentId,
      displayName: config.payments.products[parentId].displayName || parentId,
    }));
  }, [localIsAddOnTo, config.payments.products]);

  // Get all available products for add-on selection (same customer type and productLine, excluding this product)
  const availableProducts = useMemo(() => {
    return Object.entries(config.payments.products)
      .filter(([id, p]) =>
        id !== productId &&
        p.customerType === product.customerType &&
        p.productLineId === product.productLineId
      )
      .map(([id, p]) => ({
        id,
        displayName: p.displayName || id,
      }));
  }, [config.payments.products, productId, product.customerType, product.productLineId]);

  const localFreeTrialDisplayText = useMemo(() => {
    if (!localFreeTrial) return 'None';
    const [count, unit] = localFreeTrial;
    return `${count} ${count === 1 ? unit : unit + 's'}`;
  }, [localFreeTrial]);

  // ===== CHANGE HANDLERS (update local state) =====
  const handleDisplayNameChange = (value: string) => {
    const originalValue = product.displayName || '';
    if (value === originalValue) {
      // Remove from pending if back to original
      const { displayName: _, ...rest } = pendingChanges;
      setPendingChanges(rest);
    } else {
      setPendingChanges({ ...pendingChanges, displayName: value || null });
    }
    return Promise.resolve();
  };

  const handleProductLineUpdate = async (productLineId: string) => {
    const actualProductLineId = productLineId === '__none__' ? null : productLineId;
    const success = await updateConfig({
      adminApp,
      configUpdate: {
        [`payments.products.${productId}.productLineId`]: actualProductLineId,
      },
      pushable: true,
    });
    if (success) {
      toast({ title: actualProductLineId ? "Product moved to product line" : "Product removed from product line" });
    }
  };

  const handleCreateProductLine = async (productLine: { id: string, displayName: string }) => {
    // Create the productLine first with the current product's customerType
    const success = await updateConfig({
      adminApp,
      configUpdate: {
        [`payments.productLines.${productLine.id}`]: {
          displayName: productLine.displayName || null,
          customerType: product.customerType,
        },
        [`payments.products.${productId}.productLineId`]: productLine.id,
      },
      pushable: true,
    });
    if (success) {
      setCreateProductLineDialogOpen(false);
      toast({ title: "Product line created and product moved" });
    }
  };

  const handleStackableChange = (value: boolean) => {
    const originalValue = !!product.stackable;
    if (value === originalValue) {
      const { stackable: _, ...rest } = pendingChanges;
      setPendingChanges(rest);
    } else {
      setPendingChanges({ ...pendingChanges, stackable: value });
    }
    return Promise.resolve();
  };

  const handleServerOnlyChange = (value: boolean) => {
    const originalValue = !!product.serverOnly;
    if (value === originalValue) {
      const { serverOnly: _, ...rest } = pendingChanges;
      setPendingChanges(rest);
    } else {
      setPendingChanges({ ...pendingChanges, serverOnly: value });
    }
    return Promise.resolve();
  };

  const handleAddOnDialogSave = () => {
    if (isAddOn && selectedAddOnProducts.size === 0) {
      toast({ title: "Please select at least one product", variant: "destructive" });
      return;
    }

    const addOnValue = isAddOn
      ? Object.fromEntries([...selectedAddOnProducts].map(id => [id, true])) as Record<string, true>
      : null;

    // Check if this matches original
    const originalValue = product.isAddOnTo !== false && typeof product.isAddOnTo === 'object'
      ? product.isAddOnTo
      : null;
    const originalKeys = originalValue ? Object.keys(originalValue).sort().join(',') : '';
    const newKeys = addOnValue ? Object.keys(addOnValue).sort().join(',') : '';

    if (originalKeys === newKeys) {
      const { isAddOnTo: _, ...rest } = pendingChanges;
      setPendingChanges(rest);
    } else {
      setPendingChanges({ ...pendingChanges, isAddOnTo: addOnValue });
    }

    setAddOnDialogOpen(false);
  };

  const handleFreeTrialSave = (count: number, unit: DayInterval[1]) => {
    const newValue: DayInterval = [count, unit];
    const originalValue = product.freeTrial || null;

    if (originalValue && originalValue[0] === count && originalValue[1] === unit) {
      const { freeTrial: _, ...rest } = pendingChanges;
      setPendingChanges(rest);
    } else {
      setPendingChanges({ ...pendingChanges, freeTrial: newValue });
    }
    setFreeTrialPopoverOpen(false);
  };

  const handleRemoveFreeTrial = () => {
    const originalValue = product.freeTrial || null;
    if (originalValue === null) {
      const { freeTrial: _, ...rest } = pendingChanges;
      setPendingChanges(rest);
    } else {
      setPendingChanges({ ...pendingChanges, freeTrial: null });
    }
    setFreeTrialPopoverOpen(false);
  };

  const handleFreeTrialPopoverOpenChange = (open: boolean) => {
    setFreeTrialPopoverOpen(open);
    if (open) {
      setFreeTrialCount(localFreeTrial ? localFreeTrial[0] : 7);
      setFreeTrialUnit(localFreeTrial ? localFreeTrial[1] : 'day');
    }
  };

  // ===== PRICES HANDLERS (for deferred save) =====
  const handlePricesChange = (newPrices: Product['prices']) => {
    // Clear the "needs at least one price" error as soon as the user adds one back.
    if (Object.keys(newPrices).length > 0) {
      setSaveValidationError(null);
    }
    // Deep compare to see if we're back to original
    const originalPrices = product.prices;
    if (JSON.stringify(newPrices) === JSON.stringify(originalPrices)) {
      const { prices: _, ...rest } = pendingChanges;
      setPendingChanges(rest);
    } else {
      setPendingChanges({ ...pendingChanges, prices: newPrices });
    }
  };

  // ===== INCLUDED ITEMS HANDLERS (for deferred save) =====
  const handleIncludedItemsChange = (newItems: Product['includedItems']) => {
    const originalItems = product.includedItems;
    if (JSON.stringify(newItems) === JSON.stringify(originalItems)) {
      const { includedItems: _, ...rest } = pendingChanges;
      setPendingChanges(rest);
    } else {
      setPendingChanges({ ...pendingChanges, includedItems: newItems });
    }
  };

  // Build grid items for EditableGrid
  const gridItems: DesignEditableGridItem[] = [
    {
      type: 'text',
      itemKey: 'displayName',
      icon: <TagIcon size={16} />,
      name: "Display Name",
      tooltip: "The name shown to customers. Leave empty to use the product ID.",
      value: localDisplayName || '',
      placeholder: productId,
      onUpdate: handleDisplayNameChange,
    },
    {
      type: 'dropdown',
      itemKey: 'productLineId',
      icon: <FolderOpenIcon size={16} />,
      name: "Product Line",
      tooltip: "Product lines group products together. Customers can only have one active product per product line.",
      value: product.productLineId || '__none__',
      options: productLineOptions,
      onUpdate: handleProductLineUpdate,
      extraAction: {
        label: "+ Create new product line",
        onClick: () => setCreateProductLineDialogOpen(true),
      },
    },
    {
      type: 'boolean',
      itemKey: 'stackable',
      icon: <StackIcon size={16} />,
      name: "Stackable",
      tooltip: "Stackable products can be purchased multiple times by the same customer.",
      value: localStackable,
      onUpdate: handleStackableChange,
    },
    {
      type: 'custom-button',
      itemKey: 'isAddOnTo',
      icon: <PuzzlePieceIcon size={16} />,
      name: "Add-on",
      tooltip: "Add-ons are optional extras that can only be purchased alongside a parent product.",
      onClick: () => {
        // Initialize dialog state from local state
        setIsAddOn(localIsAddOnTo !== null);
        setSelectedAddOnProducts(
          localIsAddOnTo ? new Set(Object.keys(localIsAddOnTo)) : new Set()
        );
        setAddOnDialogOpen(true);
      },
      children: localAddOnParents.length > 0 ? (
        <span>
          To{' '}
          {localAddOnParents.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ', '}
              {p.displayName}
            </span>
          ))}
        </span>
      ) : 'No',
    },
    {
      type: 'custom-dropdown',
      itemKey: 'freeTrial',
      icon: <ClockIcon size={16} />,
      name: "Free Trial",
      tooltip: "Free trial period before billing starts. Customers won't be charged during this period.",
      open: freeTrialPopoverOpen,
      onOpenChange: handleFreeTrialPopoverOpenChange,
      triggerContent: localFreeTrialDisplayText,
      popoverContent: (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <DesignInput
              className="w-20 bg-white dark:bg-zinc-950"
              type="number"
              min={1}
              value={freeTrialCount}
              onChange={(e) => setFreeTrialCount(Math.max(1, parseInt(e.target.value) || 1))}
            />
            <DesignSelectorDropdown
              className="w-28"
              triggerClassName="bg-white dark:bg-zinc-950 border-black/[0.1] dark:border-white/[0.1]"
              value={freeTrialUnit}
              onValueChange={(v) => setFreeTrialUnit(v as DayInterval[1])}
              options={DEFAULT_INTERVAL_UNITS.map((unit) => ({
                value: unit,
                label: `${unit}${freeTrialCount !== 1 ? 's' : ''}`,
              }))}
            />
          </div>
          <div className="flex gap-2">
            <DesignButton
              size="sm"
              className="flex-1"
              onClick={() => handleFreeTrialSave(freeTrialCount, freeTrialUnit)}
            >
              Apply
            </DesignButton>
            {localFreeTrial && (
              <DesignButton
                size="sm"
                variant="outline"
                onClick={handleRemoveFreeTrial}
              >
                Remove
              </DesignButton>
            )}
          </div>
        </div>
      ),
    },
    {
      type: 'boolean',
      itemKey: 'serverOnly',
      icon: <HardDriveIcon size={16} />,
      name: "Server Only",
      tooltip: "Server-only products are only available through checkout sessions created by server-side APIs.",
      value: localServerOnly,
      onUpdate: handleServerOnlyChange,
    },
    {
      type: 'custom',
      itemKey: 'prices',
      icon: <CurrencyDollarIcon size={16} />,
      name: "Prices",
      tooltip: "Pricing options for this product. Multiple prices allow different billing intervals or pricing tiers.",
      children: (
        <ProductPricesSection
          productId={productId}
          prices={localPrices}
          onPricesChange={handlePricesChange}
          inline
        />
      ),
    },
    {
      type: 'custom',
      itemKey: 'includedItems',
      icon: <PackageIcon size={16} />,
      name: "Included Items",
      tooltip: "Items that customers receive when they purchase this product.",
      children: (
        <ProductItemsSection
          productId={productId}
          product={product}
          items={localIncludedItems}
          onItemsChange={handleIncludedItemsChange}
          config={config}
          inline
        />
      ),
    },
  ];

  return (
    <>
      {saveValidationError && (
        <Alert variant="destructive" className="mb-4">
          {saveValidationError}
        </Alert>
      )}
      <DesignEditableGrid
        items={gridItems}
        columns={2}
        deferredSave
        hasChanges={hasChanges}
        onSave={handleSave}
        onDiscard={handleDiscard}
        externalModifiedKeys={externalModifiedKeys}
      />

      {/* Add-on Configuration Dialog */}
      <Dialog open={addOnDialogOpen} onOpenChange={setAddOnDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add-on Configuration</DialogTitle>
            <DialogDescription>
              Add-ons are optional products that can only be purchased when a customer already owns one of the parent products. They&apos;re great for extras like additional seats, premium features, or one-time upgrades. A product can only be an add-on to products with the same customer type and in the same product line.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="flex items-center gap-2">
              <Checkbox
                id="is-addon"
                checked={isAddOn}
                onCheckedChange={(checked) => {
                  setIsAddOn(!!checked);
                  if (!checked) setSelectedAddOnProducts(new Set());
                }}
              />
              <Label htmlFor="is-addon" className="cursor-pointer">
                This product is an add-on
              </Label>
            </div>

            {isAddOn && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  Select parent products (at least one required):
                </Label>
                <div className="max-h-48 overflow-y-auto space-y-2 rounded-md border p-3">
                  {availableProducts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No other products with the same customer type and productLine</p>
                  ) : (
                    availableProducts.map((p) => (
                      <div key={p.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`addon-${p.id}`}
                          checked={selectedAddOnProducts.has(p.id)}
                          onCheckedChange={(checked) => {
                            const newSet = new Set(selectedAddOnProducts);
                            if (checked) {
                              newSet.add(p.id);
                            } else {
                              newSet.delete(p.id);
                            }
                            setSelectedAddOnProducts(newSet);
                          }}
                        />
                        <Label htmlFor={`addon-${p.id}`} className="cursor-pointer text-sm">
                          {p.displayName}
                        </Label>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOnDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddOnDialogSave}>
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Product Line Dialog */}
      <CreateProductLineDialog
        open={createProductLineDialogOpen}
        onOpenChange={setCreateProductLineDialogOpen}
        onCreate={handleCreateProductLine}
      />
    </>
  );
}

type ProductPricesSectionProps = {
  productId: string,
  prices: Product['prices'],
  onPricesChange: (newPrices: Product['prices']) => void,
  inline?: boolean,
};

function ProductPricesSection({ productId, prices, onPricesChange, inline = false }: ProductPricesSectionProps) {
  const [editingPrice, setEditingPrice] = useState<EditingPrice | null>(null);
  const [isAddingPrice, setIsAddingPrice] = useState(false);
  const [replacePricesOnSave, setReplacePricesOnSave] = useState(false);

  const handleSavePrice = (editing: EditingPrice) => {
    const newPrice = editingPriceToPrice(editing);

    const updatedPrices = replacePricesOnSave
      ? { [editing.priceId]: newPrice }
      : { ...prices, [editing.priceId]: newPrice };

    onPricesChange(updatedPrices);
    setEditingPrice(null);
    setIsAddingPrice(false);
    setReplacePricesOnSave(false);
  };

  const handleDeletePrice = (priceId: string) => {
    const { [priceId]: _, ...remainingPrices } = prices;
    onPricesChange(remainingPrices);
  };


  const openEditDialog = (priceId: string, price: Price) => {
    setEditingPrice(priceToEditingPrice(priceId, price));
  };

  const openAddDialog = () => {
    const newId = generateUniqueId('price');
    setEditingPrice(createNewEditingPrice(newId));
    setIsAddingPrice(true);
  };

  const priceEntries = typedEntries(prices);
  const isFree = isFreePrices(prices);
  const hasNoPrices = priceEntries.length === 0;

  const handleMakePaid = () => {
    setReplacePricesOnSave(true);
    openAddDialog();
  };

  const handleMakeFree = () => {
    onPricesChange(createFreePrice());
  };

  const listContent = (
    <div className="pl-1">
      {isFree ? (
        <div className="flex flex-col">
          <div className="flex items-center text-sm leading-6">
            <span className="font-semibold text-foreground">Free</span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-fit h-6 px-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={handleMakePaid}
            >
              <CurrencyDollarIcon className="h-3 w-3 mr-1" />
              Make paid
            </Button>
          </div>
        </div>
      ) : hasNoPrices ? (
        // No prices configured - show error state
        <div className="flex flex-col">
          <p className="text-sm text-destructive leading-6">No prices configured</p>
          <div className="flex items-center gap-2 mt-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-fit h-6 px-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={openAddDialog}
            >
              <PlusIcon className="h-3 w-3 mr-1" />
              Add price option
            </Button>
            <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">or</span>
            <Button
              variant="ghost"
              size="sm"
              className="w-fit h-6 px-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={handleMakeFree}
            >
              <GiftIcon className="h-3 w-3 mr-1" />
              Make free
            </Button>
          </div>
        </div>
      ) : (
        // Has prices - show them with both options
        <div className="flex flex-col">
          {priceEntries.map(([priceId, price]) => {
            const intervalText = price.interval ? intervalLabel(price.interval) : 'One-time';
            return (
              <div key={priceId} className="group flex items-center text-sm leading-6">
                <span className="font-semibold text-foreground">${price.USD}</span>
                <span className="text-muted-foreground ml-1.5">{intervalText}</span>
                {price.freeTrial && (
                  <Badge variant="outline" className="text-[10px] ml-1.5 h-4 py-0 leading-none">
                    {price.freeTrial[0]} {price.freeTrial[1]} trial
                  </Badge>
                )}
                {price.serverOnly && (
                  <Badge variant="outline" className="text-[10px] ml-1.5 h-4 py-0 leading-none">Server only</Badge>
                )}
                <div className="flex items-center ml-1 opacity-0 group-hover:opacity-100">
                  <SimpleTooltip tooltip="Edit">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0"
                      onClick={() => openEditDialog(priceId, price)}
                    >
                      <PencilSimpleIcon className="h-3 w-3" />
                    </Button>
                  </SimpleTooltip>
                  <SimpleTooltip tooltip="Delete">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0 text-destructive hover:text-destructive"
                      onClick={() => handleDeletePrice(priceId)}
                    >
                      <TrashIcon className="h-3 w-3" />
                    </Button>
                  </SimpleTooltip>
                </div>
              </div>
            );
          })}
          <div className="flex items-center gap-2 mt-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-fit h-6 px-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={openAddDialog}
            >
              <PlusIcon className="h-3 w-3 mr-1" />
              Add price option
            </Button>
            <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">or</span>
            <Button
              variant="ghost"
              size="sm"
              className="w-fit h-6 px-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={handleMakeFree}
            >
              <GiftIcon className="h-3 w-3 mr-1" />
              Make free
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  const priceDialog = (
    <PriceEditDialog
      open={!!editingPrice}
      onOpenChange={(open) => {
        if (!open) {
          setEditingPrice(null);
          setIsAddingPrice(false);
          setReplacePricesOnSave(false);
        }
      }}
      editingPrice={editingPrice}
      onEditingPriceChange={setEditingPrice}
      isAdding={isAddingPrice}
      onSave={handleSavePrice}
    />
  );

  if (inline) {
    return (
      <>
        {listContent}
        {priceDialog}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Prices</h3>
      {listContent}
      {priceDialog}
    </div>
  );
}

type ProductItemsSectionProps = {
  productId: string,
  product: Product,
  items: Product['includedItems'],
  onItemsChange: (newItems: Product['includedItems']) => void,
  config: CompleteConfig,
  inline?: boolean,
};

type EditingItem = {
  itemId: string,
  quantity: number,
  repeatSelection: 'once' | 'custom' | DayInterval[1],
  repeatCount: number,
  repeatUnit: DayInterval[1] | undefined,
};

function ProductItemsSection({ productId, product, items, onItemsChange, config, inline = false }: ProductItemsSectionProps) {
  const adminApp = useAdminApp();
  const updateConfig = useUpdateConfig();
  const [editingItem, setEditingItem] = useState<EditingItem | null>(null);
  const [isAddingItem, setIsAddingItem] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string>('');
  const [showCreateItemDialog, setShowCreateItemDialog] = useState(false);

  // Get all available items for this customer type
  const availableItems = useMemo(() => {
    return typedEntries(config.payments.items)
      .filter(([_, item]) => item.customerType === product.customerType)
      .map(([id, item]) => ({ id, displayName: item.displayName || id }));
  }, [config.payments.items, product.customerType]);

  const handleSaveItem = (editing: EditingItem) => {
    const repeat: DayInterval | 'never' = editing.repeatSelection === 'once'
      ? 'never'
      : [editing.repeatCount, editing.repeatUnit || 'month'];

    const newItem = {
      quantity: editing.quantity,
      repeat,
      expires: 'never' as const,
    };

    const updatedItems = {
      ...items,
      [editing.itemId]: newItem,
    };

    onItemsChange(updatedItems);
    setEditingItem(null);
    setIsAddingItem(false);
    setSelectedItemId('');
  };

  const openCreateItemDialog = () => {
    setEditingItem(null);
    setIsAddingItem(false);
    setSelectedItemId('');
    setShowCreateItemDialog(true);
  };

  const handleCreateAndAddItem = async (item: { id: string, displayName: string, customerType: 'user' | 'team' | 'custom' }) => {
    const success = await updateConfig({
      adminApp,
      configUpdate: { [`payments.items.${item.id}`]: { displayName: item.displayName, customerType: item.customerType } },
      pushable: true,
    });
    if (!success) {
      return;
    }

    onItemsChange({
      ...items,
      [item.id]: {
        quantity: 1,
        repeat: 'never',
        expires: 'never',
      },
    });
    toast({ title: "Item created", description: "Save product changes to keep it included." });
  };

  const handleDeleteItem = (itemId: string) => {
    const { [itemId]: _, ...remainingItems } = items;
    onItemsChange(remainingItems);
  };

  const openEditDialog = (itemId: string, item: { quantity: number, repeat: DayInterval | 'once' | 'never' }) => {
    const isOnce = item.repeat === 'once' || item.repeat === 'never';
    const repeatInterval: DayInterval | undefined = isOnce ? undefined : (item.repeat as DayInterval);
    setEditingItem({
      itemId,
      quantity: item.quantity,
      repeatSelection: isOnce ? 'once' : (repeatInterval?.[0] === 1 ? repeatInterval[1] : 'custom') as EditingItem['repeatSelection'],
      repeatCount: repeatInterval?.[0] || 1,
      repeatUnit: repeatInterval?.[1] as DayInterval[1] | undefined,
    });
    setSelectedItemId(itemId);
  };

  const openAddDialog = () => {
    // Find first available item not already included
    const includedIds = new Set(Object.keys(items));
    const firstAvailable = availableItems.find(i => !includedIds.has(i.id));
    if (firstAvailable) {
      setEditingItem({
        itemId: firstAvailable.id,
        quantity: 1,
        repeatSelection: 'once',
        repeatCount: 1,
        repeatUnit: 'month',
      });
      setSelectedItemId(firstAvailable.id);
    } else if (availableItems.length > 0) {
      // All items are already included, use the first one (will update existing)
      setEditingItem({
        itemId: availableItems[0].id,
        quantity: 1,
        repeatSelection: 'once',
        repeatCount: 1,
        repeatUnit: 'month',
      });
      setSelectedItemId(availableItems[0].id);
    } else {
      // No items available - still open the dialog to show empty state
      setEditingItem({
        itemId: '',
        quantity: 1,
        repeatSelection: 'once',
        repeatCount: 1,
        repeatUnit: 'month',
      });
      setSelectedItemId('');
    }
    setIsAddingItem(true);
  };

  const handleCopyPrompt = async (itemId: string, displayName: string) => {
    const prompt = `Check if the current user has the "${displayName}" (${itemId}) item.`;
    await navigator.clipboard.writeText(prompt);
    toast({ title: "Prompt copied to clipboard" });
  };

  const itemEntries = typedEntries(items) as [string, typeof items[keyof typeof items]][];

  const listContent = (
    <div className="pl-1">
      {itemEntries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No items included</p>
      ) : (
        <div className="flex flex-col">
          {itemEntries.map(([itemId, item]) => {
            const itemConfig = Object.prototype.hasOwnProperty.call(config.payments.items, itemId)
              ? config.payments.items[itemId]
              : undefined;
            const displayName = itemConfig?.displayName || itemId;
            return (
              <div key={itemId} className="group flex items-center text-sm leading-6">
                <span className="font-semibold tabular-nums text-foreground">{prettyPrintWithMagnitudes(item.quantity)}×</span>
                <SimpleTooltip tooltip={`ID: ${itemId}`}>
                  <span className="ml-1.5 text-foreground cursor-help">{displayName}</span>
                </SimpleTooltip>
                <span className="text-muted-foreground ml-1.5">{shortIntervalLabel(item.repeat)}</span>
                <div className="flex items-center ml-1 opacity-0 group-hover:opacity-100">
                  <SimpleTooltip tooltip="Copy prompt">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0"
                      onClick={() => runAsynchronouslyWithAlert(() => handleCopyPrompt(itemId, displayName))}
                    >
                      <CopyIcon className="h-3 w-3" />
                    </Button>
                  </SimpleTooltip>
                  <SimpleTooltip tooltip="Edit">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0"
                      onClick={() => openEditDialog(itemId, item)}
                    >
                      <PencilSimpleIcon className="h-3 w-3" />
                    </Button>
                  </SimpleTooltip>
                  <SimpleTooltip tooltip="Delete">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0 text-destructive hover:text-destructive"
                      onClick={() => handleDeleteItem(itemId)}
                    >
                      <TrashIcon className="h-3 w-3" />
                    </Button>
                  </SimpleTooltip>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-1">
        <Button
          variant="ghost"
          size="sm"
          className="w-fit h-6 px-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={openAddDialog}
        >
          <PlusIcon className="h-3 w-3 mr-1" />
          Add included item
        </Button>
      </div>
    </div>
  );

  const itemDialog = (
    /* Item Edit Dialog */
    <Dialog open={!!editingItem} onOpenChange={(open) => {
      if (!open) {
        setEditingItem(null);
        setIsAddingItem(false);
        setSelectedItemId('');
      }
    }}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{isAddingItem ? "Add Included Item" : "Edit Included Item"}</DialogTitle>
          <DialogDescription>
            Configure how much of this item customers receive.
          </DialogDescription>
        </DialogHeader>
        {editingItem && availableItems.length === 0 && isAddingItem ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <PackageIcon className="h-10 w-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground text-center">
              No items available for this customer type.
            </p>
            <p className="text-xs text-muted-foreground/70 text-center">
              Create an item now and it will be added to this product automatically.
            </p>
          </div>
        ) : editingItem && (
          <div className="grid gap-4 py-4">
            {/* Item Selection (only for adding) */}
            {isAddingItem && (
              <div className="grid gap-2">
                <Label>Item</Label>
                <Select
                  value={selectedItemId}
                  onValueChange={(v) => {
                    setSelectedItemId(v);
                    setEditingItem({ ...editingItem, itemId: v });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select an item" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableItems.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Quantity */}
            <div className="grid gap-2">
              <Label>Quantity</Label>
              <Input
                type="number"
                min={1}
                value={editingItem.quantity}
                onChange={(e) => setEditingItem({ ...editingItem, quantity: parseInt(e.target.value) || 1 })}
              />
            </div>

            {/* Repeat */}
            <div className="grid gap-2">
              <Label>Repeat</Label>
              <Select
                value={editingItem.repeatSelection}
                onValueChange={(v) => {
                  const selection = v as 'once' | 'custom' | DayInterval[1];
                  if (selection === 'once') {
                    setEditingItem({ ...editingItem, repeatSelection: 'once', repeatUnit: undefined });
                  } else if (selection === 'custom') {
                    setEditingItem({ ...editingItem, repeatSelection: 'custom', repeatUnit: 'month' });
                  } else {
                    setEditingItem({ ...editingItem, repeatSelection: selection, repeatCount: 1, repeatUnit: selection });
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="once">Once (on purchase)</SelectItem>
                  <SelectItem value="day">Daily</SelectItem>
                  <SelectItem value="week">Weekly</SelectItem>
                  <SelectItem value="month">Monthly</SelectItem>
                  <SelectItem value="year">Yearly</SelectItem>
                  <SelectItem value="custom">Custom interval</SelectItem>
                </SelectContent>
              </Select>
              {editingItem.repeatSelection === 'custom' && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Every</span>
                  <Input
                    className="w-20"
                    type="number"
                    min={1}
                    value={editingItem.repeatCount}
                    onChange={(e) => setEditingItem({ ...editingItem, repeatCount: parseInt(e.target.value) || 1 })}
                  />
                  <Select
                    value={editingItem.repeatUnit || 'month'}
                    onValueChange={(v) => setEditingItem({ ...editingItem, repeatUnit: v as DayInterval[1] })}
                  >
                    <SelectTrigger className="w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DEFAULT_INTERVAL_UNITS.map((unit) => (
                        <SelectItem key={unit} value={unit}>
                          {unit}{editingItem.repeatCount !== 1 ? 's' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => {
            setEditingItem(null);
            setIsAddingItem(false);
            setSelectedItemId('');
          }}>
            Cancel
          </Button>
          <Button
            onClick={isAddingItem && availableItems.length === 0
              ? openCreateItemDialog
              : editingItem ? () => handleSaveItem(editingItem) : undefined}
          >
            {isAddingItem && availableItems.length === 0 ? "Create Item" : isAddingItem ? "Add Item" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const createItemDialog = (
    <ItemDialog
      open={showCreateItemDialog}
      onOpenChange={setShowCreateItemDialog}
      onSave={handleCreateAndAddItem}
      existingItemIds={Object.keys(config.payments.items)}
      forceCustomerType={product.customerType}
    />
  );

  if (inline) {
    return (
      <>
        {listContent}
        {itemDialog}
        {createItemDialog}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Included Items</h3>
      {listContent}
      {itemDialog}
      {createItemDialog}
    </div>
  );
}

function CustomersSkeleton() {
  const skeletonColumns = useMemo<DataGridColumnDef<{ id: number }>[]>(() => [
    { id: "customer", header: "Customer", width: 200, renderCell: () => <Skeleton className="h-8 w-32" /> },
    { id: "type", header: "Type", width: 100, renderCell: () => <Skeleton className="h-4 w-16" /> },
    { id: "purchased", header: "Purchased", width: 150, renderCell: () => <Skeleton className="h-4 w-24" /> },
    { id: "actions", header: "", width: 80, renderCell: () => <Skeleton className="h-8 w-8" /> },
  ], []);
  const skeletonData = useMemo(() => [{ id: 0 }, { id: 1 }, { id: 2 }], []);
  const [gridState, setGridState] = useState(() => createDefaultDataGridState(skeletonColumns));
  const gridData = useDataSource({
    data: skeletonData,
    columns: skeletonColumns,
    getRowId: (row) => String(row.id),
    sorting: gridState.sorting,
    quickSearch: gridState.quickSearch,
    pagination: gridState.pagination,
    paginationMode: "client",
  });

  return (
    <div className="relative rounded-2xl bg-foreground/[0.04] ring-1 ring-foreground/[0.06]">
      <div className="px-5 pt-4 pb-3">
        <h3 className="text-base font-semibold">Customers</h3>
        <p className="text-sm text-muted-foreground">
          Customers who have purchased this product
        </p>
      </div>
      <div className="px-5 pb-5">
        <DataGrid
          columns={skeletonColumns}
          rows={gridData.rows}
          getRowId={(row) => String(row.id)}
          totalRowCount={gridData.totalRowCount}
          state={gridState}
          onChange={setGridState}
          toolbar={false}
          footer={false}
          fillHeight={false}
        />
      </div>
    </div>
  );
}

type ProductCustomersSectionProps = {
  productId: string,
  product: Product,
};

function isProductGrantEntry(entry: TransactionEntry): entry is Extract<TransactionEntry, { type: 'product_grant' }> {
  return entry.type === 'product_grant';
}

type CustomerGridRow = {
  key: string,
  customerType: string,
  customerId: string,
  purchasedAt: Date,
};

function ProductCustomersSection({ productId, product }: ProductCustomersSectionProps) {
  const adminApp = useAdminApp();
  const { transactions } = adminApp.useTransactions({ limit: 100 });

  const customersWithTransactions = useMemo(() => {
    const customerMap = new Map<string, {
      customerType: string,
      customerId: string,
      latestTransaction: Transaction,
    }>();

    for (const transaction of transactions) {
      if (transaction.type !== 'purchase') continue;

      const productGrant = transaction.entries.find(isProductGrantEntry);
      if (!productGrant || productGrant.product_id !== productId) continue;

      const customerEntry = transaction.entries.find(e => 'customer_type' in e && 'customer_id' in e) as { customer_type: string, customer_id: string } | undefined;
      if (!customerEntry) continue;

      const key = `${customerEntry.customer_type}:${customerEntry.customer_id}`;
      const existing = customerMap.get(key);

      if (!existing || transaction.created_at_millis > existing.latestTransaction.created_at_millis) {
        customerMap.set(key, {
          customerType: customerEntry.customer_type,
          customerId: customerEntry.customer_id,
          latestTransaction: transaction,
        });
      }
    }

    return Array.from(customerMap.values()).sort(
      (a, b) => b.latestTransaction.created_at_millis - a.latestTransaction.created_at_millis
    );
  }, [transactions, productId]);

  const gridRows = useMemo<CustomerGridRow[]>(
    () => customersWithTransactions.map(({ customerType, customerId, latestTransaction }) => ({
      key: `${customerType}:${customerId}`,
      customerType,
      customerId,
      purchasedAt: new Date(latestTransaction.created_at_millis),
    })),
    [customersWithTransactions],
  );

  const columns = useMemo<DataGridColumnDef<CustomerGridRow>[]>(() => [
    {
      id: "customer",
      header: "Customer",
      width: 200,
      renderCell: ({ row }) => (
        row.customerType === 'user' ? (
          <Suspense fallback={<AvatarCellSkeleton />}>
            <UserCell userId={row.customerId} />
          </Suspense>
        ) : row.customerType === 'team' ? (
          <Suspense fallback={<AvatarCellSkeleton />}>
            <TeamCell teamId={row.customerId} />
          </Suspense>
        ) : (
          <div className="flex items-center gap-2">
            <AvatarCell fallback="?" />
            <span className="font-mono text-xs">{row.customerId}</span>
          </div>
        )
      ),
    },
    {
      id: "type",
      header: "Type",
      width: 100,
      accessor: "customerType",
      renderCell: ({ row }) => (
        <span className={cn(
          "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ring-1",
          CUSTOMER_TYPE_COLORS[row.customerType as keyof typeof CUSTOMER_TYPE_COLORS]
        )}>
          {row.customerType}
        </span>
      ),
    },
    {
      id: "purchased",
      header: "Purchased",
      width: 150,
      type: "dateTime",
      accessor: "purchasedAt",
    },
    {
      id: "actions",
      header: "",
      width: 80,
      sortable: false,
      renderCell: ({ row }) => (
        <CustomerRowActions customerType={row.customerType} customerId={row.customerId} />
      ),
    },
  ], []);

  const [gridState, setGridState] = useDataGridUrlState(columns, { paramPrefix: "productcustomers" });
  const gridData = useDataSource({
    data: gridRows,
    columns,
    getRowId: (row) => row.key,
    sorting: gridState.sorting,
    quickSearch: gridState.quickSearch,
    pagination: gridState.pagination,
    paginationMode: "client",
  });

  return (
    <div className="relative rounded-2xl bg-foreground/[0.04] ring-1 ring-foreground/[0.06]">
      <div className="px-5 pt-4 pb-3">
        <h3 className="text-base font-semibold">Customers</h3>
        <p className="text-sm text-muted-foreground">
          Customers who have purchased this product ({customersWithTransactions.length} found)
        </p>
      </div>
      <div className="px-5 pb-5">
        {customersWithTransactions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-8 rounded-xl bg-foreground/[0.02]">
            <UsersIcon className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground text-center">
              No customers have purchased this product yet
            </p>
          </div>
        ) : (
          <DataGrid
            columns={columns}
            rows={gridData.rows}
            getRowId={(row) => row.key}
            totalRowCount={gridData.totalRowCount}
            state={gridState}
            onChange={setGridState}
            toolbar={false}
            fillHeight={false}
          />
        )}
      </div>
    </div>
  );
}

function CustomerRowActions({ customerType, customerId }: { customerType: string, customerId: string }) {
  const adminApp = useAdminApp();
  return (
    <ActionCell
      items={[
        ...(customerType === 'user' ? [{
          item: "View User",
          onClick: () => {
            window.open(`/projects/${adminApp.projectId}/users/${customerId}`, '_blank', 'noopener');
          },
        }] : []),
        ...(customerType === 'team' ? [{
          item: "View Team",
          onClick: () => {
            window.open(`/projects/${adminApp.projectId}/teams/${customerId}`, '_blank', 'noopener');
          },
        }] : []),
      ]}
    />
  );
}

// TODO(ui-fixes-minor): This component calls `adminApp.useUser(userId)` once
// per row. With the customer grid capped at 100 rows via `useTransactions`,
// that's 100 individual user fetches on the product detail page. Consider
// hoisting to a parent-level `adminApp.useUsers({ ids: [...] })` (when the
// SDK grows that capability) and passing a `Map<userId, user>` down so the
// cell is a pure lookup. Same applies to `TeamCell` below.
function UserCell({ userId }: { userId: string }) {
  const adminApp = useAdminApp();
  const user = adminApp.useUser(userId);

  if (!user) {
    return (
      <div className="flex items-center gap-2">
        <AvatarCell fallback="?" />
        <span className="font-mono text-xs text-muted-foreground">{userId}</span>
      </div>
    );
  }

  return (
    <Link href={`/projects/${adminApp.projectId}/users/${userId}`}>
      <div className="flex items-center gap-2 hover:text-primary transition-colors">
        <AvatarCell
          src={user.profileImageUrl ?? undefined}
          fallback={user.displayName?.charAt(0) ?? user.primaryEmail?.charAt(0) ?? '?'}
        />
        <span className="truncate max-w-[150px]">
          {user.displayName ?? user.primaryEmail ?? userId}
        </span>
      </div>
    </Link>
  );
}

function TeamCell({ teamId }: { teamId: string }) {
  const adminApp = useAdminApp();
  const team = adminApp.useTeam(teamId);

  if (!team) {
    return (
      <div className="flex items-center gap-2">
        <AvatarCell fallback="?" />
        <span className="font-mono text-xs text-muted-foreground">{teamId}</span>
      </div>
    );
  }

  return (
    <Link href={`/projects/${adminApp.projectId}/teams/${teamId}`}>
      <div className="flex items-center gap-2 hover:text-primary transition-colors">
        <AvatarCell
          src={team.profileImageUrl ?? undefined}
          fallback={team.displayName.charAt(0)}
        />
        <span className="truncate max-w-[150px]">
          {team.displayName}
        </span>
      </div>
    </Link>
  );
}
