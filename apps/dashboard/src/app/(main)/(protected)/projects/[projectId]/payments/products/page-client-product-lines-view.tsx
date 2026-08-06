"use client";

import { Link } from '@/components/link';
import { ItemDialog } from "@/components/payments/item-dialog";
import { useRouter } from "@/components/router";
import {
  ActionDialog,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SimpleTooltip,
  toast
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { useUpdateConfig } from "@/components/config-update";
import { DndContext, DragOverlay, useDraggable, useDroppable, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { CaretUpDownIcon, CircleNotchIcon, CodeIcon, CopyIcon, DotsSixVerticalIcon, DotsThreeVerticalIcon, EyeIcon, FileTextIcon, HardDriveIcon, InfoIcon, PencilSimpleIcon, PlusIcon, PuzzlePieceIcon, ShoppingCartIcon, StackIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { CreateCheckoutDialog } from "@/components/payments/create-checkout-dialog";
import type { CustomerType } from "@/components/payments/customer-selector";
import { CompleteConfig } from "@hexclave/shared/dist/config/schema";
import { getUserSpecifiedIdErrorMessage, isValidUserSpecifiedId } from "@hexclave/shared/dist/schema-fields";
import type { DayInterval } from "@hexclave/shared/dist/utils/dates";
import { prettyPrintWithMagnitudes } from "@hexclave/shared/dist/utils/numbers";
import { typedEntries, typedFromEntries } from "@hexclave/shared/dist/utils/objects";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { urlString } from '@hexclave/shared/dist/utils/urls';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAdminApp, useProjectId } from "../../use-admin-app";
import { IntervalPopover, OrSeparator } from "./components";
import { ProductDialog } from "./product-dialog";
import { ProductPriceRow } from "./product-price-row";
import {
  generateUniqueId,
  intervalLabel,
  shortIntervalLabel,
  type PricesObject,
  type Product
} from "./utils";

// Custom error class to signal validation failures without closing edit mode
class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// Helper to convert display name to ID format
function toIdFormat(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generates a unique product/item ID
 */
function generateProductId(prefix: string): string {
  return generateUniqueId(prefix);
}

// ============================================================================
// Product Editable Input Component
// ============================================================================

type ProductEditableInputProps = {
  value: string,
  onUpdate?: (value: string) => void,
  readOnly?: boolean,
  placeholder?: string,
  inputClassName?: string,
  transform?: (value: string) => string,
};

function ProductEditableInput({
  value,
  onUpdate,
  readOnly,
  placeholder,
  inputClassName,
  transform,
}: ProductEditableInputProps) {
  const [isActive, setIsActive] = useState(false);

  if (readOnly) {
    return (
      <div
        className={cn(
          "w-full px-1 py-0 h-[unset] border-transparent bg-transparent cursor-default truncate",
          inputClassName,
          !value && "text-muted-foreground"
        )}
        aria-label={placeholder}
      >
        {value || placeholder}
      </div>
    );
  }

  return (
    <Input
      value={value}
      onChange={(event) => {
        const rawValue = event.target.value;
        const nextValue = transform ? transform(rawValue) : rawValue;
        onUpdate?.(nextValue);
      }}
      placeholder={placeholder}
      autoComplete="off"
      className={cn(
        "w-full px-1 py-0 h-[unset] border-transparent transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-transparent",
        isActive ? "bg-muted/60 dark:bg-muted/30 z-20" : "bg-transparent hover:bg-muted/40 dark:hover:bg-muted/20",
        inputClassName,
      )}
      onFocus={() => setIsActive(true)}
      onBlur={() => setIsActive(false)}
    />
  );
}

// ============================================================================
// Helper Components
// ============================================================================

/**
 * Label with optional info tooltip for technical terms
 */
function LabelWithInfo({ children, tooltip }: { children: React.ReactNode, tooltip?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <Label className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
        {children}
      </Label>
      {tooltip && (
        <SimpleTooltip tooltip={tooltip}>
          <InfoIcon className="h-3 w-3 text-muted-foreground/60 cursor-help" />
        </SimpleTooltip>
      )}
    </div>
  );
}

// ============================================================================
// Product Item Row Component
// ============================================================================

const EXPIRES_OPTIONS: Array<{ value: Product["includedItems"][string]["expires"], label: string, description: string }> = [
  {
    value: 'never' as const,
    label: 'Never',
    description: 'Customer keeps these items forever, even after subscription ends'
  },
  {
    value: 'when-purchase-expires' as const,
    label: 'With subscription',
    description: 'Items are removed when the subscription ends or is cancelled'
  },
  {
    value: 'when-repeated' as const,
    label: 'Until next renewal',
    description: 'Items reset each billing cycle (e.g., monthly credits that refresh)'
  }
];

function ProductItemRow({
  activeType,
  itemId,
  item,
  itemDisplayName,
  readOnly,
  startEditing,
  onSave,
  onRemove,
  allItems,
  existingIncludedItemIds,
  onChangeItemId,
  onCreateNewItem,
}: {
  activeType: 'user' | 'team' | 'custom',
  itemId: string,
  item: Product['includedItems'][string],
  itemDisplayName: string,
  readOnly?: boolean,
  startEditing?: boolean,
  onSave: (itemId: string, item: Product['includedItems'][string]) => void,
  onRemove?: () => void,
  allItems: Array<{ id: string, displayName: string, customerType: string }>,
  existingIncludedItemIds: string[],
  onChangeItemId: (newItemId: string) => void,
  onCreateNewItem: (customerType?: 'user' | 'team' | 'custom', onCreated?: (itemId: string) => void) => void,
}) {
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [quantity, setQuantity] = useState<string>(String(item.quantity));
  const [repeatUnit, setRepeatUnit] = useState<DayInterval[1] | undefined>(item.repeat !== 'never' ? item.repeat[1] : undefined);
  const [repeatCount, setRepeatCount] = useState<number>(item.repeat !== 'never' ? item.repeat[0] : 1);
  const [repeatSelection, setRepeatSelection] = useState<'one-time' | 'custom' | DayInterval[1]>(
    item.repeat !== 'never' ? (item.repeat[0] === 1 ? item.repeat[1] : 'custom') : 'one-time'
  );
  const [itemSelectOpen, setItemSelectOpen] = useState(false);

  useEffect(() => {
    setQuantity(String(item.quantity));
    setRepeatUnit(item.repeat !== 'never' ? item.repeat[1] : undefined);
    setRepeatCount(item.repeat !== 'never' ? item.repeat[0] : 1);
    setRepeatSelection(item.repeat !== 'never' ? (item.repeat[0] === 1 ? item.repeat[1] : 'custom') : 'one-time');
  }, [item]);

  useEffect(() => {
    if (!readOnly && startEditing) setIsEditing(true);
    if (readOnly) setIsEditing(false);
  }, [startEditing, readOnly]);


  const updateParent = (raw: string) => {
    const normalized = raw === '' ? 0 : parseInt(raw, 10);
    const updated: Product['includedItems'][string] = { ...item, quantity: Number.isNaN(normalized) ? 0 : normalized };
    onSave(itemId, updated);
  };

  const repeatText = item.repeat === 'never' ? null : intervalLabel(item.repeat);
  const shortRepeatText = shortIntervalLabel(item.repeat);

  // Consistent dropdown button styling
  const dropdownButtonClass = cn(
    "flex h-10 w-full items-center justify-between px-3 text-sm font-medium",
    "rounded-xl border border-border/60 dark:border-foreground/[0.1]",
    "bg-background dark:bg-[hsl(240,10%,10%)]",
    "transition-colors duration-150 hover:transition-none hover:bg-foreground/[0.03]"
  );

  if (isEditing) {
    return (
      <div className={cn(
        "relative rounded-2xl p-4",
        "border border-border/60 dark:border-foreground/[0.12]",
        "bg-background/60 dark:bg-[hsl(240,10%,7%)]"
      )}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <LabelWithInfo tooltip="Select the type of resource or credit to grant when this product is purchased">
              Item Name
            </LabelWithInfo>
            <Popover open={itemSelectOpen} onOpenChange={setItemSelectOpen}>
              <PopoverTrigger asChild>
                <button className={dropdownButtonClass}>
                  <span className="truncate">{itemDisplayName}</span>
                  <CaretUpDownIcon className="h-4 w-4 text-muted-foreground" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 p-0 overflow-hidden">
                <div className="flex max-h-64 flex-col overflow-auto p-1">
                  {allItems.filter(opt => opt.customerType === activeType).map((opt) => {
                    const isSelected = opt.id === itemId;
                    const isUsed = existingIncludedItemIds.includes(opt.id) && !isSelected;
                    return (
                      <button
                        key={opt.id}
                        disabled={isUsed}
                        className={cn(
                          "flex flex-col items-start w-full px-3 py-2 rounded-lg text-left",
                          "transition-colors duration-150 hover:transition-none",
                          isSelected
                            ? "bg-foreground/[0.08] text-foreground"
                            : "hover:bg-foreground/[0.04] text-foreground",
                          isUsed && "opacity-40 cursor-not-allowed"
                        )}
                        onClick={() => {
                          if (isSelected || isUsed) {
                            setItemSelectOpen(false);
                            return;
                          }
                          onChangeItemId(opt.id);
                          setItemSelectOpen(false);
                        }}
                      >
                        <span className="font-medium">{opt.displayName || opt.id}</span>
                        <span className="text-xs text-muted-foreground">{opt.customerType.toUpperCase()} • {opt.id}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="border-t border-border/30 p-1">
                  <button
                    className={cn(
                      "flex items-center w-full px-3 py-2 rounded-lg text-left text-sm font-medium",
                      "text-primary hover:bg-primary/[0.08]",
                      "transition-colors duration-150 hover:transition-none"
                    )}
                    onClick={() => {
                        setItemSelectOpen(false);
                      onCreateNewItem(activeType, (newItemId) => {
                        // Auto-select the newly created item
                        onChangeItemId(newItemId);
                      });
                    }}
                  >
                    <PlusIcon className="mr-2 h-4 w-4" /> New Item
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <div className="flex flex-col gap-1.5">
            <LabelWithInfo tooltip="Number of units to grant each time (e.g., 100 credits, 5 seats)">
              Quantity
            </LabelWithInfo>
            <Input
              className={cn(
                "h-10 w-full px-3 text-right tabular-nums",
                "rounded-xl border border-border/60 dark:border-foreground/[0.1]",
                "bg-background dark:bg-[hsl(240,10%,10%)]"
              )}
              inputMode="numeric"
              value={quantity}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '' || /^\d*$/.test(v)) setQuantity(v);
                if (!readOnly && (v === '' || /^\d*$/.test(v))) updateParent(v);
              }}
            />
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <LabelWithInfo tooltip="When should these items be removed from the customer?">
              Expires
            </LabelWithInfo>
            <Popover>
              <PopoverTrigger asChild>
                <button className={dropdownButtonClass}>
                  <span className="truncate">
                    {EXPIRES_OPTIONS.find(o => o.value === item.expires)?.label ?? 'Never'}
                  </span>
                  <CaretUpDownIcon className="h-4 w-4 text-muted-foreground" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 p-0 overflow-hidden">
                <div className="flex flex-col p-1">
                  {EXPIRES_OPTIONS.map((option) => {
                    const isSelected = item.expires === option.value;
                    return (
                      <button
                        key={option.value}
                        className={cn(
                          "flex flex-col items-start w-full px-3 py-2.5 rounded-lg text-left",
                          "transition-colors duration-150 hover:transition-none",
                          isSelected
                            ? "bg-foreground/[0.08] text-foreground"
                            : "hover:bg-foreground/[0.04] text-foreground"
                        )}
                        onClick={() => {
                          onSave(itemId, { ...item, expires: option.value });
                        }}
                      >
                        <span className="font-medium">{option.label}</span>
                        <span className="text-xs text-muted-foreground">{option.description}</span>
                      </button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <div className="flex flex-col gap-1.5">
            <LabelWithInfo tooltip="How often should these items be granted? (e.g., monthly credits)">
              Repeat
            </LabelWithInfo>
            <IntervalPopover
              readOnly={readOnly}
              intervalText={repeatText}
              intervalSelection={repeatSelection}
              unit={repeatUnit}
              count={repeatCount}
              setIntervalSelection={setRepeatSelection}
              setUnit={setRepeatUnit}
              setCount={setRepeatCount}
              noneLabel="One-time only"
              triggerClassName={dropdownButtonClass + " capitalize"}
              onChange={(interval) => {
                if (readOnly) return;
                const updated: Product['includedItems'][string] = {
                  ...item,
                  repeat: interval ? interval : 'never',
                };
                onSave(itemId, updated);
              }}
            />
          </div>
        </div>

        {onRemove && (
          <button
            className="absolute right-3 top-3 p-1 rounded-md text-muted-foreground transition-colors duration-150 hover:transition-none hover:text-foreground hover:bg-foreground/[0.05]"
            onClick={onRemove}
            aria-label="Remove item"
          >
            <XIcon className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  } else {
    // Simplified view mode - just show the essential info
    return (
      <div className="flex items-center gap-3 py-1">
        <span className="text-sm text-foreground truncate">{itemDisplayName}</span>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <span className="text-sm text-muted-foreground tabular-nums">{prettyPrintWithMagnitudes(item.quantity)}</span>
          <span className="text-xs text-muted-foreground">{shortRepeatText}</span>
        </div>
      </div>
    );
  }
}


type ProductCardProps = {
  id: string,
  product: Product,
  allProducts: Array<{ id: string, product: Product }>,
  existingItems: Array<{ id: string, displayName: string, customerType: string }>,
  onSave: (id: string, product: Product) => Promise<void>,
  onDelete: (id: string) => Promise<void>,
  onCreateNewItem: (customerType?: 'user' | 'team' | 'custom') => void,
  onOpenDetails: (product: Product) => void,
  // Table mode props - when part of a pricing table
  isColumnInTable?: boolean,
  isFirstColumn?: boolean,
  isLastColumn?: boolean,
  // Drag handle props
  isDragging?: boolean,
  dragHandleProps?: {
    attributes: ReturnType<typeof useDraggable>['attributes'],
    listeners: ReturnType<typeof useDraggable>['listeners'],
  },
};

// Wrapper component that makes ProductCard draggable
function DraggableProductCard(props: Omit<ProductCardProps, 'isDragging' | 'dragHandleProps'>) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: props.id,
    data: {
      productId: props.id,
      customerType: props.product.customerType,
      productLineId: props.product.productLineId,
    },
  });

  // When using DragOverlay, the original element stays in place but becomes semi-transparent
  // The DragOverlay component renders the visual preview that follows the cursor
  return (
    <div ref={setNodeRef} style={{ opacity: isDragging ? 0.4 : undefined }}>
      <ProductCard
        {...props}
        isDragging={isDragging}
        dragHandleProps={{ attributes, listeners }}
      />
    </div>
  );
}

// Droppable zone for product lines
type DroppableProductLineZoneProps = {
  productLineId: string | undefined, // undefined means "No product line"
  customerType: 'user' | 'team' | 'custom' | undefined,
  children: ReactNode,
  activeDragCustomerType: 'user' | 'team' | 'custom' | null,
};

function DroppableProductLineZone({ productLineId, customerType, children, activeDragCustomerType }: DroppableProductLineZoneProps) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: productLineId ?? "no-product-line",
    data: {
      productLineId,
      customerType,
    },
  });

  // Check if this drop zone is valid for the currently dragged product
  const isDraggedProductCompatible = activeDragCustomerType
    ? (productLineId === undefined || customerType === activeDragCustomerType)
    : false;

  const isActiveDrag = !!active;
  const showCompatibleIndicator = isActiveDrag && isDraggedProductCompatible;
  const showIncompatibleIndicator = isActiveDrag && !isDraggedProductCompatible && activeDragCustomerType;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "relative rounded-2xl transition-all duration-150",
        showCompatibleIndicator && "ring-2 ring-primary/50 ring-offset-2 ring-offset-background",
        isOver && isDraggedProductCompatible && "ring-primary bg-primary/5",
        isOver && showIncompatibleIndicator && "ring-destructive/50 bg-destructive/5"
      )}
    >
      {children}
      {isOver && showIncompatibleIndicator && (
        <div className="absolute inset-0 rounded-2xl bg-destructive/10 flex items-center justify-center pointer-events-none">
          <span className="text-xs text-destructive font-medium px-2 py-1 bg-background/90 rounded">
            Incompatible customer type
          </span>
        </div>
      )}
    </div>
  );
}

// Customer type badge colors
const CUSTOMER_TYPE_COLORS = {
  user: 'bg-blue-500/15 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400 ring-blue-500/30',
  team: 'bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400 ring-emerald-500/30',
  custom: 'bg-amber-500/15 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400 ring-amber-500/30',
} as const;

function ProductCard({ id, product, allProducts, existingItems, onSave, onDelete, onCreateNewItem, onOpenDetails, isColumnInTable, isFirstColumn, isLastColumn, isDragging, dragHandleProps }: ProductCardProps) {
  const projectId = useProjectId();
  const router = useRouter();
  const customerType = product.customerType;
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showCheckoutDialog, setShowCheckoutDialog] = useState(false);
  const [currentHash, setCurrentHash] = useState<string | null>(null);
  const hashAnchor = `#product-${id}`;
  const isHashTarget = currentHash === hashAnchor;

  useEffect(() => {
    const updateFromHash = () => {
      const h = window.location.hash;
      if (h !== currentHash) setCurrentHash(h);
    };
    updateFromHash();
    window.addEventListener('hashchange', updateFromHash);

    const removeHashTarget = () => {
      if (isHashTarget && window.location.hash === hashAnchor) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    };
    window.addEventListener("click", removeHashTarget, { capture: true });

    return () => {
      window.removeEventListener('hashchange', updateFromHash);
      window.removeEventListener("click", removeHashTarget, { capture: true });
    };
  }, [hashAnchor, isHashTarget, currentHash]);

  const pricesObject: PricesObject = product.prices;
  const priceCount = Object.keys(pricesObject).length;

  const generateComprehensivePrompt = (): string => {
    const priceEntries = typedEntries(pricesObject);

    let prompt = `# Product Implementation Guide: ${product.displayName || id}\n\n`;

    prompt += `## Product Overview\n`;
    prompt += `- **Product ID**: \`${id}\`\n`;
    prompt += `- **Display Name**: ${product.displayName || 'Untitled Product'}\n`;
    prompt += `- **Customer Type**: ${product.customerType}\n`;
    if (product.freeTrial) {
      const [count, unit] = product.freeTrial;
      prompt += `- **Free Trial**: ${count} ${count === 1 ? unit : unit + 's'}\n`;
    }
    prompt += `- **Server Only**: ${product.serverOnly ? 'Yes' : 'No'}\n`;
    prompt += `- **Stackable**: ${product.stackable ? 'Yes' : 'No'}\n`;
    if (product.isAddOnTo && typeof product.isAddOnTo === 'object') {
      const addOnProductIds = Object.keys(product.isAddOnTo);
      prompt += `- **Add-on To**: ${addOnProductIds.join(', ')}\n`;
    }
    if (product.productLineId) {
      prompt += `- **Product Line ID**: ${product.productLineId}\n`;
    }
    prompt += `\n`;

    prompt += `## Pricing Structure\n`;
    if (priceEntries.length === 0) {
      prompt += `No prices configured.\n\n`;
    } else {
      priceEntries.forEach(([priceId, price], index) => {
        prompt += `### Price Tier ${index + 1}${priceId !== 'free' ? ` (ID: \`${priceId}\`)` : ''}\n`;

        const currencyCodes = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'BRL', 'MXN', 'INR', 'SGD', 'HKD', 'NZD', 'ZAR', 'KRW'] as const;
        const currencies = currencyCodes
          .map(code => ({ code, amount: (price as any)[code] }))
          .filter(({ amount }) => amount !== undefined && amount !== null);

        if (currencies.length > 0) {
          prompt += `**Pricing**:\n`;
          currencies.forEach(({ code, amount }) => {
            prompt += `- ${code}: $${amount}\n`;
          });
        }

        if (price.interval) {
          const [count, unit] = price.interval;
          prompt += `**Billing Interval**: ${intervalLabel(price.interval) || `${count} ${unit}${count !== 1 ? 's' : ''}`}\n`;
        } else {
          prompt += `**Billing**: One-time payment\n`;
        }

        if (price.freeTrial) {
          const [count, unit] = price.freeTrial;
          prompt += `**Free Trial**: ${count} ${count === 1 ? unit : unit + 's'}\n`;
        }

        if (price.serverOnly) {
          prompt += `**Note**: Server-side purchase only\n`;
        }

        prompt += `\n`;
      });
    }

    const itemsList = Object.entries(product.includedItems);
    if (itemsList.length > 0) {
      prompt += `## Included Items\n`;
      itemsList.forEach(([itemId, item]) => {
        const itemMeta = existingItems.find(i => i.id === itemId);
        const itemLabel = itemMeta ? itemMeta.displayName : itemId;
        prompt += `### ${itemLabel} (\`${itemId}\`)\n`;
        prompt += `- **Quantity**: ${prettyPrintWithMagnitudes(item.quantity)}\n`;
        if (item.repeat === 'never') {
          prompt += `- **Repeat**: Never (one-time grant)\n`;
        } else {
          const [count, unit] = item.repeat;
          prompt += `- **Repeat**: Every ${count} ${count === 1 ? unit : unit + 's'}\n`;
        }
        prompt += `- **Expires**: ${item.expires === 'never' ? 'Never' : item.expires === 'when-purchase-expires' ? 'When purchase expires' : 'When repeated'}\n`;
        prompt += `\n`;
      });
    } else {
      prompt += `## Included Items\n`;
      prompt += `No items included.\n\n`;
    }

    prompt += `## Implementation Code\n\n`;
    prompt += `To create a checkout URL for this product:\n\n`;
    prompt += `\`\`\`typescript\n`;
    prompt += `const url = await ${product.customerType}.createCheckoutUrl({ productId: "${id}" });\n`;
    prompt += `window.open(url, "_blank");\n`;
    prompt += `\`\`\`\n\n`;

    prompt += `## Implementation Notes\n\n`;
    if (product.serverOnly) {
      prompt += `- This product can only be purchased from server-side code. Use \`hexclaveServerApp\` instead of \`hexclaveClientApp\`.\n`;
    }
    if (product.stackable) {
      prompt += `- This product is stackable, meaning customers can purchase it multiple times and quantities will accumulate.\n`;
    }
    if (product.isAddOnTo && typeof product.isAddOnTo === 'object') {
      prompt += `- This is an add-on product. Customers must already have one of the base products to purchase this.\n`;
    }
    if (product.freeTrial) {
      prompt += `- This product includes a free trial period. Customers will not be charged until the trial ends.\n`;
    }
    if (itemsList.length > 0) {
      prompt += `- When a customer purchases this product, they will automatically receive the included items listed above.\n`;
    }

    if (itemsList.length > 0) {
      prompt += `\n## Item Implementation Guide\n\n`;
      prompt += `Items are automatically granted to customers when they purchase this product. Here's how to work with items in your code:\n\n`;

      prompt += `### Getting Item Quantities\n\n`;
      prompt += `**Server-side (recommended)**:\n\n`;
      prompt += `\`\`\`typescript\n`;
      if (product.customerType === 'user') {
        prompt += `// Get a user and their item\n`;
        prompt += `const user = await hexclaveServerApp.getUser({ userId: "user_123" });\n`;
        prompt += `const item = await user.getItem("${itemsList[0][0]}");\n`;
        prompt += `console.log(\`Current quantity: \${item.quantity}\`);\n`;
        prompt += `console.log(\`Display name: \${item.displayName}\`);\n`;
      } else if (product.customerType === 'team') {
        prompt += `// Get a team and their item\n`;
        prompt += `const team = await hexclaveServerApp.getTeam({ teamId: "team_123" });\n`;
        prompt += `const item = await team.getItem("${itemsList[0][0]}");\n`;
        prompt += `console.log(\`Current quantity: \${item.quantity}\`);\n`;
        prompt += `console.log(\`Display name: \${item.displayName}\`);\n`;
      } else {
        prompt += `// Get a custom customer and their item\n`;
        prompt += `const customer = await hexclaveServerApp.getCustomCustomer({ customCustomerId: "customer_123" });\n`;
        prompt += `const item = await customer.getItem("${itemsList[0][0]}");\n`;
        prompt += `console.log(\`Current quantity: \${item.quantity}\`);\n`;
        prompt += `console.log(\`Display name: \${item.displayName}\`);\n`;
      }
      prompt += `\`\`\`\n\n`;

      prompt += `**Client-side (React)**:\n\n`;
      prompt += `\`\`\`typescript\n`;
      if (product.customerType === 'user') {
        prompt += `// In a React component\n`;
        prompt += `const user = useUser();\n`;
        prompt += `const item = user?.useItem("${itemsList[0][0]}");\n`;
        prompt += `if (item) {\n`;
        prompt += `  console.log(\`Current quantity: \${item.quantity}\`);\n`;
        prompt += `  // Use item.nonNegativeQuantity for display (clamps to 0)\n`;
        prompt += `  console.log(\`Available: \${item.nonNegativeQuantity}\`);\n`;
        prompt += `}\n`;
      } else if (product.customerType === 'team') {
        prompt += `// In a React component with team context\n`;
        prompt += `const team = useTeam();\n`;
        prompt += `const item = team?.useItem("${itemsList[0][0]}");\n`;
        prompt += `if (item) {\n`;
        prompt += `  console.log(\`Current quantity: \${item.quantity}\`);\n`;
        prompt += `  console.log(\`Available: \${item.nonNegativeQuantity}\`);\n`;
        prompt += `}\n`;
      }
      prompt += `\`\`\`\n\n`;

      prompt += `### Modifying Item Quantities (Server-side only)\n\n`;
      prompt += `**Increase quantity** (add credits/resources):\n\n`;
      prompt += `\`\`\`typescript\n`;
      if (product.customerType === 'user') {
        prompt += `const user = await hexclaveServerApp.getUser({ userId: "user_123" });\n`;
        prompt += `const item = await user.getItem("${itemsList[0][0]}");\n`;
        prompt += `// Add 100 units\n`;
        prompt += `await item.increaseQuantity(100);\n`;
      } else if (product.customerType === 'team') {
        prompt += `const team = await hexclaveServerApp.getTeam({ teamId: "team_123" });\n`;
        prompt += `const item = await team.getItem("${itemsList[0][0]}");\n`;
        prompt += `// Add 100 units\n`;
        prompt += `await item.increaseQuantity(100);\n`;
      } else {
        prompt += `const customer = await hexclaveServerApp.getCustomCustomer({ customCustomerId: "customer_123" });\n`;
        prompt += `const item = await customer.getItem("${itemsList[0][0]}");\n`;
        prompt += `// Add 100 units\n`;
        prompt += `await item.increaseQuantity(100);\n`;
      }
      prompt += `\`\`\`\n\n`;

      prompt += `**Decrease quantity** (consume credits/resources):\n\n`;
      prompt += `\`\`\`typescript\n`;
      if (product.customerType === 'user') {
        prompt += `const user = await hexclaveServerApp.getUser({ userId: "user_123" });\n`;
        prompt += `const item = await user.getItem("${itemsList[0][0]}");\n`;
        prompt += `// Consume 50 units (allows negative balance)\n`;
        prompt += `await item.decreaseQuantity(50);\n`;
        prompt += `\n`;
        prompt += `// Or use tryDecreaseQuantity to prevent going below 0\n`;
        prompt += `const success = await item.tryDecreaseQuantity(50);\n`;
        prompt += `if (!success) {\n`;
        prompt += `  // Insufficient quantity - handle accordingly\n`;
        prompt += `  throw new Error("Insufficient credits");\n`;
        prompt += `}\n`;
      } else if (product.customerType === 'team') {
        prompt += `const team = await hexclaveServerApp.getTeam({ teamId: "team_123" });\n`;
        prompt += `const item = await team.getItem("${itemsList[0][0]}");\n`;
        prompt += `// Consume 50 units\n`;
        prompt += `await item.decreaseQuantity(50);\n`;
        prompt += `\n`;
        prompt += `// Or use tryDecreaseQuantity to prevent going below 0\n`;
        prompt += `const success = await item.tryDecreaseQuantity(50);\n`;
        prompt += `if (!success) {\n`;
        prompt += `  throw new Error("Insufficient quantity");\n`;
        prompt += `}\n`;
      } else {
        prompt += `const customer = await hexclaveServerApp.getCustomCustomer({ customCustomerId: "customer_123" });\n`;
        prompt += `const item = await customer.getItem("${itemsList[0][0]}");\n`;
        prompt += `// Consume 50 units\n`;
        prompt += `await item.decreaseQuantity(50);\n`;
        prompt += `\n`;
        prompt += `// Or use tryDecreaseQuantity to prevent going below 0\n`;
        prompt += `const success = await item.tryDecreaseQuantity(50);\n`;
        prompt += `if (!success) {\n`;
        prompt += `  throw new Error("Insufficient quantity");\n`;
        prompt += `}\n`;
      }
      prompt += `\`\`\`\n\n`;

      prompt += `### Item Properties\n\n`;
      prompt += `- \`quantity\`: The current quantity (can be negative)\n`;
      prompt += `- \`nonNegativeQuantity\`: Quantity clamped to minimum 0 (use for display)\n`;
      prompt += `- \`displayName\`: Human-readable name of the item\n`;
      prompt += `- \`increaseQuantity(amount)\`: Add to the quantity (server-side only)\n`;
      prompt += `- \`decreaseQuantity(amount)\`: Subtract from quantity, allows negative (server-side only)\n`;
      prompt += `- \`tryDecreaseQuantity(amount)\`: Subtract if sufficient, returns false if would go negative (server-side only)\n\n`;

      prompt += `### Important Notes\n\n`;
      prompt += `- Items are automatically granted when customers purchase this product based on the included items configuration.\n`;
      if (itemsList.some(([, item]) => item.repeat !== 'never')) {
        prompt += `- Some items repeat automatically based on their repeat interval configuration.\n`;
      }
      if (itemsList.some(([, item]) => item.expires !== 'never')) {
        prompt += `- Some items expire based on their expiration rules (when purchase expires, when repeated, etc.).\n`;
      }
      prompt += `- Item quantity modifications are atomic and safe for concurrent use.\n`;
      prompt += `- Use \`tryDecreaseQuantity()\` for pre-paid credits to prevent overdrafts.\n`;
      prompt += `- Use \`nonNegativeQuantity\` when displaying quantities to users to avoid showing negative numbers.\n`;
    }

    return prompt;
  };

  const renderPrimaryPrices = () => {
    const entries = Object.entries(pricesObject);
    if (entries.length === 0) {
      return null;
    }
    return (
      <div className="shrink-0 space-y-3 text-center">
        {entries.map(([pid, price], index) => (
          <Fragment key={pid}>
            <ProductPriceRow
              priceId={pid}
              price={price}
              isFree={false}
              readOnly={true}
              startEditing={false}
              existingPriceIds={entries.map(([k]) => k).filter(k => k !== pid)}
              onSave={() => { /* no-op in view mode */ }}
              onRemove={() => { /* no-op in view mode */ }}
            />
            {index < entries.length - 1 && <OrSeparator />}
          </Fragment>
        ))}
      </div>
    );
  };

  const itemsList = Object.entries(product.includedItems);

  const isAddOnTo = allProducts.filter(o => product.isAddOnTo && o.id in product.isAddOnTo);

  const PRODUCT_TOGGLE_OPTIONS = [{
    key: 'serverOnly' as const,
    label: 'Server only',
    shortLabel: 'Server only',
    description: "Restricts this product to only be purchased from server-side calls. Use this for backend-initiated purchases.",
    active: !!product.serverOnly,
    visible: true,
    icon: <HardDriveIcon size={14} />,
  }, {
    key: 'stackable' as const,
    label: 'Stackable',
    shortLabel: 'Stackable',
    description: "Allows customers to purchase this product multiple times. Each purchase adds to their existing quantity.",
    active: !!product.stackable,
    visible: true,
    icon: <StackIcon size={14} />,
  }, {
    key: 'addon' as const,
    label: 'Add-on',
    shortLabel: 'Add-on',
    description: "Makes this an optional extra that customers can purchase alongside a main product.",
    visible: product.isAddOnTo !== false,
    active: product.isAddOnTo !== false,
    icon: <PuzzlePieceIcon size={14} />,
  }] as const;

  const renderToggleButtons = () => {
    const getLabel = (b: typeof PRODUCT_TOGGLE_OPTIONS[number]) => {
      if (b.key === "addon" && isAddOnTo.length > 0) {
        return <span key={b.key}>
          Add-on to {isAddOnTo.map((o, i) => (
            <Fragment key={o.id}>
              {i > 0 && ", "}
              <Link className="underline hover:text-foreground transition-colors" href={`#product-${o.id}`}>
                {o.product.displayName}
              </Link>
            </Fragment>
          ))}
        </span>;
      }
      return b.shortLabel;
    };
    return PRODUCT_TOGGLE_OPTIONS
      .filter(b => b.visible !== false)
      .filter(b => b.active)
      .map((b) => (
        <SimpleTooltip tooltip={b.description} key={b.key}>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-help">
            {b.icon}
            {getLabel(b)}
          </span>
        </SimpleTooltip>
      ));
  };

  const handleCardClick = (e: React.MouseEvent) => {
    // Don't navigate if clicking on interactive elements
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('a') || target.closest('[role="menuitem"]') || target.closest('[data-radix-collection-item]')) {
      return;
    }
    router.push(`/projects/${projectId}/app-configuration/payments/products/${id}`);
  };

  const viewingContent = (
    <div
      className={cn(
        "group relative flex flex-col h-full cursor-pointer",
        // Card mode (standalone)
        !isColumnInTable && [
          "rounded-2xl overflow-hidden",
          "bg-gray-200/80 dark:bg-[hsl(240,10%,5.5%)]",
          "border border-border/50 dark:border-foreground/[0.12]",
          "shadow-sm hover:shadow-md hover:bg-gray-300/80 dark:hover:bg-[hsl(240,10%,7%)] transition-all duration-150 hover:transition-none",
        ],
        // Table column mode
        isColumnInTable && [
          !isFirstColumn && "border-l border-border/30 dark:border-foreground/[0.08]",
          "hover:bg-foreground/[0.02] transition-colors duration-150 hover:transition-none",
        ],
        isHashTarget && "border-primary shadow-[0_0_0_1px_rgba(59,130,246,0.35)]"
      )}
      onClick={handleCardClick}
    >
      {/* Main content wrapper */}
      <div className="flex-1 flex flex-col">
        {/* Header section */}
        <div className="relative px-5 pt-5 pb-3">
          {/* Customer type badge and Product ID */}
          <div className="flex items-center justify-center gap-2 mb-2">
            <span className={cn(
              "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ring-1",
              CUSTOMER_TYPE_COLORS[customerType]
            )}>
              {customerType}
            </span>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-mono text-muted-foreground bg-foreground/[0.04] ring-1 ring-foreground/[0.06]">
              ID: {id}
            </span>
          </div>
          {/* Product name */}
          <h3 className="text-lg font-semibold text-center tracking-tight flex items-center justify-center gap-1.5">
            {product.isAddOnTo !== false && <PuzzlePieceIcon className="h-4 w-4 text-muted-foreground shrink-0" />}
            {product.displayName || "Untitled Product"}
          </h3>

          {/* Drag handle - appears on hover */}
          {dragHandleProps && (
            <div
              className="absolute left-3 top-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-hover:transition-none"
              {...dragHandleProps.attributes}
              {...dragHandleProps.listeners}
            >
              <button
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-colors duration-150 hover:transition-none cursor-grab active:cursor-grabbing"
                aria-label="Drag to move"
              >
                <DotsSixVerticalIcon className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Action menu - appears on hover */}
          <div className="absolute right-3 top-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-hover:transition-none">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-colors duration-150 hover:transition-none" aria-label="Options">
                  <DotsThreeVerticalIcon className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  icon={<EyeIcon className="h-4 w-4" />}
                  onClick={() => router.push(`/projects/${projectId}/app-configuration/payments/products/${id}`)}
                >
                  View Details
                </DropdownMenuItem>
                <DropdownMenuItem
                  icon={<ShoppingCartIcon className="h-4 w-4" />}
                  onClick={() => setShowCheckoutDialog(true)}
                >
                  Create checkout
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  icon={<PencilSimpleIcon className="h-4 w-4" />}
                  onClick={() => router.push(`/projects/${projectId}/app-configuration/payments/products/${id}/edit`)}
                >
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  icon={<CopyIcon className="h-4 w-4" />}
                  onClick={() => {
                    // Store product data for duplication and navigate to create page
                    const duplicateKey = `duplicate-${Date.now()}`;
                    const duplicateData = {
                      ...product,
                      displayName: `${product.displayName || id} Copy`,
                    };
                    sessionStorage.setItem(duplicateKey, JSON.stringify(duplicateData));
                    router.push(`/projects/${projectId}/app-configuration/payments/products/new?duplicate=${duplicateKey}`);
                  }}
                >
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  icon={<TrashIcon className="h-4 w-4" />}
                  className="text-destructive focus:text-destructive"
                  onClick={() => { setShowDeleteDialog(true); }}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Toggle badges */}
        {PRODUCT_TOGGLE_OPTIONS.some(b => b.visible !== false && b.active) && (
          <div className="flex flex-col items-center gap-1.5 px-4 pb-3">
            {renderToggleButtons()}
          </div>
        )}

        {/* Pricing section - grows if no items */}
        <div className={cn(
          "border-t border-border/20 dark:border-foreground/[0.06] px-5 py-4",
          itemsList.length === 0 && "flex-1"
        )}>
          {renderPrimaryPrices()}
        </div>

        {/* Items section - grows to fill available space */}
        {itemsList.length > 0 && (
          <div className="flex-1 border-t border-border/20 dark:border-foreground/[0.06] px-5 py-3">
            <div className="space-y-1">
              {itemsList.map(([itemId, item]) => {
                const itemMeta = existingItems.find(i => i.id === itemId);
                const itemLabel = itemMeta ? itemMeta.displayName : itemId;
                return (
                  <div key={itemId} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{itemLabel}</span>
                    <span className="text-foreground tabular-nums">
                      {prettyPrintWithMagnitudes(item.quantity)}
                      <span className="text-muted-foreground text-xs ml-1">{shortIntervalLabel(item.repeat)}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Quick actions footer - stays at bottom */}
      {customerType !== "custom" && (
        <div className="border-t border-border/20 dark:border-foreground/[0.06] px-4 py-3 flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "h-8 px-3 text-xs gap-1.5 rounded-lg",
              "bg-background/60 dark:bg-foreground/[0.03]",
              "border-border/60 dark:border-foreground/[0.1]",
              "text-muted-foreground hover:text-foreground",
              "hover:bg-background dark:hover:bg-foreground/[0.06]",
              "transition-colors duration-150 hover:transition-none"
            )}
            onClick={async () => {
              await navigator.clipboard.writeText(`const url = await ${customerType}.createCheckoutUrl({ productId: "${id}" });\nwindow.open(url, "_blank");`);
              toast({ title: "Copied to clipboard" });
            }}
          >
            <CodeIcon className="h-3.5 w-3.5" />
            Copy code
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "h-8 px-3 text-xs gap-1.5 rounded-lg",
              "bg-background/60 dark:bg-foreground/[0.03]",
              "border-border/60 dark:border-foreground/[0.1]",
              "text-muted-foreground hover:text-foreground",
              "hover:bg-background dark:hover:bg-foreground/[0.06]",
              "transition-colors duration-150 hover:transition-none"
            )}
            onClick={async () => {
              const prompt = generateComprehensivePrompt();
              await navigator.clipboard.writeText(prompt);
              toast({ title: "Prompt copied to clipboard" });
            }}
          >
            <FileTextIcon className="h-3.5 w-3.5" />
            Copy prompt
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <div
      id={`product-${id}`}
      className={cn(
        "shrink-0 transition-all h-full",
        isColumnInTable ? "w-[260px]" : "w-[320px]"
      )}
    >
      {viewingContent}

      <ActionDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title="Delete product"
        danger
        okButton={{
          label: "Delete",
          onClick: async () => {
            await onDelete(id);
          }
        }}
        cancelButton
      >
        Are you sure you want to delete this product?
      </ActionDialog>
      <CreateCheckoutDialog
        open={showCheckoutDialog}
        onOpenChange={setShowCheckoutDialog}
        customerType={customerType as CustomerType}
        productId={id}
        lockProduct
      />
    </div >
  );
}

type ProductLineViewProps = {
  groupedProducts: Map<string | undefined, Array<{ id: string, product: Product }>>,
  groups: Record<string, { displayName?: string, customerType?: 'user' | 'team' | 'custom' }>,
  existingItems: Array<{ id: string, displayName: string, customerType: string }>,
  onSaveProduct: (id: string, product: Product) => Promise<void>,
  onDeleteProduct: (id: string) => Promise<void>,
  onCreateNewItem: (customerType?: 'user' | 'team' | 'custom', onCreated?: (itemId: string) => void) => void,
  onOpenProductDetails: (product: Product) => void,
  onSaveProductWithGroup: (productLineId: string, productId: string, product: Product) => Promise<void>,
  onCreateProductLine: (productLineId: string, displayName: string, customerType: 'user' | 'team' | 'custom') => Promise<void>,
  onUpdateProductLine: (productLineId: string, displayName: string) => Promise<void>,
  onDeleteProductLine: (productLineId: string) => Promise<void>,
  createDraftRequestId?: string,
  draftCustomerType: 'user' | 'team' | 'custom',
  onDraftHandled?: () => void,
  // Drag and drop support
  paymentsConfig: CompleteConfig['payments'],
  onMoveProduct: (productId: string, targetProductLineId: string | undefined) => Promise<void>,
};

// Combined key for productLine + customer type grouping
type ProductLineTypeKey = {
  productLineId: string | undefined,
  customerType: 'user' | 'team' | 'custom',
};

function productLineTypeKeyToString(key: ProductLineTypeKey): string {
  return `${key.productLineId ?? '__none__'}::${key.customerType}`;
}

function ProductLineView({ groupedProducts, groups, existingItems, onSaveProduct, onDeleteProduct, onCreateNewItem, onOpenProductDetails, onSaveProductWithGroup, onCreateProductLine, onUpdateProductLine, onDeleteProductLine, createDraftRequestId, draftCustomerType, onDraftHandled, paymentsConfig, onMoveProduct }: ProductLineViewProps) {
  const hexclaveAdminApp = useAdminApp();
  const projectId = hexclaveAdminApp.projectId;
  const [drafts, setDrafts] = useState<Array<{ key: string, productLineId: string | undefined, product: Product }>>([]);
  const [creatingGroupKey, setCreatingGroupKey] = useState<string | undefined>(undefined);
  const [newProductLineDisplayName, setNewProductLineDisplayName] = useState("");
  const [newProductLineId, setNewProductLineId] = useState("");
  const [hasManuallyEditedProductLineId, setHasManuallyEditedProductLineId] = useState(false);
  const [newProductLineCustomerType, setNewProductLineCustomerType] = useState<'user' | 'team' | 'custom'>('user');
  const newGroupInputRef = useRef<HTMLInputElement | null>(null);

  // Product line edit/delete state
  const [editingProductLineId, setEditingProductLineId] = useState<string | null>(null);
  const [editingProductLineDisplayName, setEditingProductLineDisplayName] = useState("");
  const [deletingProductLineId, setDeletingProductLineId] = useState<string | null>(null);

  // Regroup products by both productLineId AND customerType
  const groupedByProductLineAndType = useMemo(() => {
    const result = new Map<string, { key: ProductLineTypeKey, products: Array<{ id: string, product: Product }> }>();

    groupedProducts.forEach((products, _productLineId) => {
      products.forEach(({ id, product }) => {
        const key: ProductLineTypeKey = { productLineId: product.productLineId, customerType: product.customerType };
        const keyStr = productLineTypeKeyToString(key);

        if (!result.has(keyStr)) {
          result.set(keyStr, { key, products: [] });
        }
        result.get(keyStr)!.products.push({ id, product });
      });
    });

    return result;
  }, [groupedProducts]);

  useEffect(() => {
    if (creatingGroupKey && newGroupInputRef.current) {
      newGroupInputRef.current.focus();
      newGroupInputRef.current.select();
    }
  }, [creatingGroupKey]);


  const usedIds = useMemo(() => {
    const all: string[] = [];
    groupedProducts.forEach(arr => arr.forEach(({ id }) => all.push(id)));
    drafts.forEach(d => all.push(d.key));
    return new Set(all);
  }, [groupedProducts, drafts]);
  const lastHandledDraftRequestRef = useRef<string | undefined>(undefined);
  const getCreateProductHref = (productLineId: string | undefined, customerType: 'user' | 'team' | 'custom' | undefined) => {
    if (productLineId == null || customerType == null) {
      return urlString`/projects/${projectId}/app-configuration/payments/products/new`;
    }
    return urlString`/projects/${projectId}/app-configuration/payments/products/new?productLineId=${productLineId}&customerType=${customerType}`;
  };

  useEffect(() => {
    if (!createDraftRequestId) return;
    if (lastHandledDraftRequestRef.current === createDraftRequestId) return;

    lastHandledDraftRequestRef.current = createDraftRequestId;

    let candidate = "product";
    let counter = 2;
    while (usedIds.has(candidate)) {
      candidate = `product-${counter++}`;
    }

    const newProduct: Product = {
      displayName: 'New Product',
      customerType: draftCustomerType,
      productLineId: undefined,
      isAddOnTo: false,
      stackable: false,
      prices: {},
      includedItems: {},
      serverOnly: false,
      freeTrial: undefined,
    };

    setDrafts((prev) => [...prev, { key: candidate, productLineId: undefined, product: newProduct }]);
    onDraftHandled?.();
  }, [createDraftRequestId, draftCustomerType, onDraftHandled, usedIds]);

  const generateProductId = (base: string) => {
    let id = base;
    let i = 2;
    while (usedIds.has(id)) id = `${base}-${i++}`;
    return id;
  };

  // Build list of product lines to render directly from config
  // Now that product lines have their own customerType, we simply iterate over them
  const productLinesToRender = useMemo(() => {
    const productLines = Object.entries(groups).map(([id, productLine]) => {
      let customerType = productLine.customerType;
      return {
        id,
        displayName: productLine.displayName || id,
        customerType,
      };
    });

    // Sort: by customer type priority, then by productLine name
    // Unknown customer types (undefined) go last
    const customerTypePriority: Record<string, number> = { user: 1, team: 2, custom: 3 };
    productLines.sort((a, b) => {
      const priorityA = a.customerType ? (customerTypePriority[a.customerType] ?? 99) : 99;
      const priorityB = b.customerType ? (customerTypePriority[b.customerType] ?? 99) : 99;
      if (priorityA !== priorityB) return priorityA - priorityB;
      return stringCompare(a.displayName, b.displayName);
    });

    return productLines;
  }, [groups]);

  // Get products for a specific product line
  const getProductsForProductLine = (productLineId: string) => {
    const products: Array<{ id: string, product: Product }> = [];
    groupedByProductLineAndType.forEach(({ key, products: prods }) => {
      if (key.productLineId === productLineId) {
        products.push(...prods);
      }
    });
    return products;
  };

  // Get drafts for a specific product line
  const getDraftsForProductLine = (productLineId: string) => {
    return drafts.filter(d => d.productLineId === productLineId);
  };

  // Get all "No product line" products (all customer types combined)
  const noProductLineProducts = useMemo(() => {
    const products: Array<{ id: string, product: Product }> = [];
    groupedByProductLineAndType.forEach(({ key, products: prods }) => {
      if (key.productLineId === undefined) {
        products.push(...prods);
      }
    });
    // Sort by customer type, then by ID
    const customerTypePriority = { user: 1, team: 2, custom: 3 };
    products.sort((a, b) => {
      const priorityA = customerTypePriority[a.product.customerType];
      const priorityB = customerTypePriority[b.product.customerType];
      if (priorityA !== priorityB) return priorityA - priorityB;
      return stringCompare(a.id, b.id);
    });
    return products;
  }, [groupedByProductLineAndType]);

  // Get drafts for "No product line"
  const noProductLineDrafts = useMemo(() => {
    return drafts.filter(d => d.productLineId === undefined);
  }, [drafts]);

  // Drag and drop state
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [isMovingProduct, setIsMovingProduct] = useState(false);
  const activeDragProduct = activeDragId ? paymentsConfig.products[activeDragId] : null;

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null);

    const { active, over } = event;
    if (!over) return;

    const draggedProductId = active.id as string;
    const draggedProduct = paymentsConfig.products[draggedProductId] as Product | undefined;
    if (!draggedProduct) return;

    // Parse the drop target - it's either a productLineId or "no-product-line"
    const targetProductLineId = over.id === "no-product-line" ? undefined : (over.id as string);

    // Normalize productLineId values for comparison (treat null, undefined, and empty string as "no product line")
    const currentProductLineId = draggedProduct.productLineId || undefined;
    const normalizedTargetProductLineId = targetProductLineId || undefined;

    // Don't do anything if dropped on the same product line
    if (normalizedTargetProductLineId === currentProductLineId) return;

    // Get the target product line's customer type
    const targetCustomerType = targetProductLineId
      ? paymentsConfig.productLines[targetProductLineId].customerType
      : undefined;

    // Validate customer type compatibility:
    // - Can always drop to "No product line"
    // - Can drop to a product line if it has the same customer type as the product
    if (targetProductLineId && targetCustomerType !== draggedProduct.customerType) {
      toast({
        title: "Cannot move product",
        description: `This product has customer type "${draggedProduct.customerType}" but the target product line is for "${targetCustomerType}" customers.`,
      });
      return;
    }

    // Show loading state and update the product's productLineId
    setIsMovingProduct(true);
    try {
      await onMoveProduct(draggedProductId, targetProductLineId);

      toast({
        title: "Product moved",
        description: targetProductLineId
          ? `Moved to "${paymentsConfig.productLines[targetProductLineId].displayName || targetProductLineId}"`
          : "Removed from product line",
      });
    } finally {
      setIsMovingProduct(false);
    }
  };

  return (
    <DndContext onDragStart={handleDragStart} onDragEnd={(event) => runAsynchronously(handleDragEnd(event))}>
      <div className="space-y-8">
        {productLinesToRender.map((productLine) => {
          const productLineId = productLine.id;
          const customerType = productLine.customerType;
          const groupName = productLine.displayName;

          // Get products for this product line
          const products = getProductsForProductLine(productLineId);

          // Filter drafts for this product line
          const matchingDrafts = getDraftsForProductLine(productLineId);

          // Separate non-add-on and add-on products for pricing table layout
          const nonAddOnProducts = products.filter(({ product }) => product.isAddOnTo === false);
          const addOnProducts = products.filter(({ product }) => product.isAddOnTo !== false);
          const nonAddOnDrafts = matchingDrafts.filter(d => d.product.isAddOnTo === false);
          const addOnDrafts = matchingDrafts.filter(d => d.product.isAddOnTo !== false);

          const hasNonAddOns = nonAddOnProducts.length > 0 || nonAddOnDrafts.length > 0;

          return (
            <div key={productLineId}>
              <div className="mb-3 group/productLine-header">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-foreground">{groupName}</h3>
                  <div className="opacity-0 group-hover/productLine-header:opacity-100 transition-opacity flex items-center gap-1">
                    <button
                      onClick={() => {
                      setEditingProductLineId(productLineId);
                      setEditingProductLineDisplayName(groups[productLineId].displayName || '');
                      }}
                      className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-colors duration-150 hover:transition-none"
                      aria-label="Edit product line"
                    >
                      <PencilSimpleIcon className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setDeletingProductLineId(productLineId)}
                      className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors duration-150 hover:transition-none"
                      aria-label="Delete product line"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className={cn(
                  "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ring-1",
                  customerType && customerType in CUSTOMER_TYPE_COLORS
                    ? CUSTOMER_TYPE_COLORS[customerType as keyof typeof CUSTOMER_TYPE_COLORS]
                    : "bg-gray-500/10 text-gray-500 ring-gray-500/30"
                )}>
                    {customerType ?? "unknown customer type"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Products in this product line are mutually exclusive (except add-ons)
                  </span>
                </div>
              </div>
              <DroppableProductLineZone
                productLineId={productLineId}
                customerType={customerType}
                activeDragCustomerType={activeDragProduct?.customerType ?? null}
              >
                <div className="relative rounded-2xl bg-foreground/[0.04] ring-1 ring-foreground/[0.06]">
                  <div className="flex gap-4 justify-start overflow-x-auto p-5 min-h-20 pr-16">
                    <div className="flex max-w-max gap-4 items-stretch">
                      {/* Non-add-on products as a pricing table */}
                      {nonAddOnProducts.length > 0 && (
                        <div className={cn(
                        "flex rounded-2xl overflow-hidden",
                        "bg-gray-200/80 dark:bg-[hsl(240,10%,5.5%)]",
                        "border border-border/50 dark:border-foreground/[0.12]",
                        "shadow-sm"
                      )}>
                          {nonAddOnProducts.map(({ id, product }, index) => (
                            <DraggableProductCard
                              key={id}
                              id={id}
                              product={product}
                              allProducts={products}
                              existingItems={existingItems}
                              onSave={onSaveProduct}
                              onDelete={onDeleteProduct}
                              onCreateNewItem={onCreateNewItem}
                              onOpenDetails={(o) => onOpenProductDetails(o)}
                              isColumnInTable
                              isFirstColumn={index === 0}
                              isLastColumn={index === nonAddOnProducts.length - 1}
                            />
                          ))}
                        </div>
                      )}


                      {/* Add-on products as separate cards */}
                      {addOnProducts.map(({ id, product }) => (
                        <DraggableProductCard
                          key={id}
                          id={id}
                          product={product}
                          allProducts={products}
                          existingItems={existingItems}
                          onSave={onSaveProduct}
                          onDelete={onDeleteProduct}
                          onCreateNewItem={onCreateNewItem}
                          onOpenDetails={(o) => onOpenProductDetails(o)}
                        />
                      ))}

                      {/* Add product button */}
                      <Link href={getCreateProductHref(productLineId, customerType)}>
                        <Button
                          variant="outline"
                          size="plain"
                          className={cn(
                          "h-full min-h-[200px] w-[320px] flex flex-col items-center justify-center",
                          "rounded-2xl border border-dashed border-foreground/[0.1]",
                          "bg-background/40 hover:bg-foreground/[0.03]",
                          "text-muted-foreground hover:text-foreground",
                          "transition-all duration-150 hover:transition-none"
                        )}
                        >
                          <div className="flex flex-col items-center gap-2">
                            <PlusIcon className="h-6 w-6" />
                            <span className="text-sm font-medium">Add product</span>
                          </div>
                        </Button>
                      </Link>
                    </div>
                  </div>
                </div>
              </DroppableProductLineZone>
            </div>
          );
        })}

        {/* No product line section - shows all products without a productLine, regardless of customer type */}
        <div>
          <div className="mb-3">
            <h3 className="text-base font-semibold text-foreground">No product line</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Products that are not in a product line are not mutually exclusive
            </p>
          </div>
          <DroppableProductLineZone
            productLineId={undefined}
            customerType={undefined}
            activeDragCustomerType={activeDragProduct?.customerType ?? null}
          >
            <div className="relative rounded-2xl bg-foreground/[0.04] ring-1 ring-foreground/[0.06]">
              <div className="flex gap-4 justify-start overflow-x-auto p-5 min-h-20 pr-16">
                <div className="flex max-w-max gap-4 items-stretch">
                  {noProductLineProducts.map(({ id, product }) => (
                    <DraggableProductCard
                      key={id}
                      id={id}
                      product={product}
                      allProducts={noProductLineProducts}
                      existingItems={existingItems}
                      onSave={onSaveProduct}
                      onDelete={onDeleteProduct}
                      onCreateNewItem={onCreateNewItem}
                      onOpenDetails={(o) => onOpenProductDetails(o)}
                    />
                  ))}
                  <Link href={getCreateProductHref(undefined, undefined)}>
                    <Button
                      variant="outline"
                      size="plain"
                      className={cn(
                      "h-full min-h-[200px] w-[320px] flex flex-col items-center justify-center",
                      "rounded-2xl border border-dashed border-foreground/[0.1]",
                      "bg-background/40 hover:bg-foreground/[0.03]",
                      "text-muted-foreground hover:text-foreground",
                      "transition-all duration-150 hover:transition-none"
                    )}
                    >
                      <div className="flex flex-col items-center gap-2">
                        <PlusIcon className="h-6 w-6" />
                        <span className="text-sm font-medium">Add product</span>
                      </div>
                    </Button>
                  </Link>
                </div>
              </div>
            </div>
          </DroppableProductLineZone>
        </div>

        {/* New product line button with customer type selector */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="plain"
              className={cn(
              "w-full h-32 flex items-center justify-center",
              "rounded-2xl border border-dashed border-foreground/[0.1]",
              "bg-background/40 hover:bg-foreground/[0.03]",
              "text-muted-foreground hover:text-foreground",
              "transition-all duration-150 hover:transition-none"
            )}
            >
              <div className="flex flex-col items-center gap-2">
                <PlusIcon className="h-6 w-6" />
                <span className="text-sm font-medium">New product line</span>
              </div>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-4">
            <div className="space-y-4">
              <div>
                <p className="text-xs text-muted-foreground mb-3">
                  A product line groups products that are mutually exclusive — besides add-ons, customers can only have one active product from each product line at a time.
                </p>
              </div>
              <div>
                <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">Display Name</Label>
                <Input
                  ref={newGroupInputRef}
                  value={newProductLineDisplayName}
                  onChange={(e) => {
                    const value = e.target.value;
                  setNewProductLineDisplayName(value);
                  // Auto-generate ID from display name if not manually edited
                  if (!hasManuallyEditedProductLineId) {
                    setNewProductLineId(toIdFormat(value));
                  }
                  }}
                  placeholder="e.g., Pricing Plans"
                  className="h-9"
                />
              </div>
              <div>
                <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">Product Line ID</Label>
                <Input
                  value={newProductLineId}
                  onChange={(e) => {
                    const value = e.target.value.toLowerCase().replace(/[^a-z0-9_\-]/g, '-');
                  setNewProductLineId(value);
                  setHasManuallyEditedProductLineId(true);
                  }}
                  placeholder="e.g., pricing-plans"
                  className="h-9 font-mono text-sm"
                />
              </div>
              <div>
                <Label className="text-xs font-medium text-muted-foreground mb-1.5 block">Customer Type</Label>
                <div className="flex gap-1.5">
                  {(['user', 'team', 'custom'] as const).map((type) => (
                    <button
                      key={type}
                      onClick={() => setNewProductLineCustomerType(type)}
                      className={cn(
                      "flex-1 px-2 py-1.5 rounded-lg text-xs font-medium capitalize",
                      "transition-colors duration-150 hover:transition-none",
                      newProductLineCustomerType === type
                        ? cn("ring-1", CUSTOMER_TYPE_COLORS[type])
                        : "bg-foreground/[0.04] text-muted-foreground hover:bg-foreground/[0.08]"
                    )}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </div>
              <Button
                size="sm"
                className="w-full"
                disabled={!newProductLineId.trim() || !newProductLineDisplayName.trim()}
                onClick={async () => {
                  const id = newProductLineId.trim();
                  const displayName = newProductLineDisplayName.trim();
                  if (!id || !displayName) return;
                  if (!isValidUserSpecifiedId(id)) {
                  alert(getUserSpecifiedIdErrorMessage("productLineId"));
                  return;
                  }
                  if (Object.prototype.hasOwnProperty.call(groups, id)) {
                  alert("Product line ID already exists");
                  return;
                  }

                  // Create the productLine with display name and customer type
                  await onCreateProductLine(id, displayName, newProductLineCustomerType);

                setNewProductLineDisplayName("");
                setNewProductLineId("");
                setHasManuallyEditedProductLineId(false);
                toast({ title: "Product line created" });
                }}
              >
                Create Product Line
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        {/* Edit productLine dialog */}
        <Dialog open={editingProductLineId !== null} onOpenChange={(open) => !open && setEditingProductLineId(null)}>
          <DialogContent className="sm:max-w-[400px]">
            <DialogHeader>
              <DialogTitle>Edit Product Line</DialogTitle>
              <DialogDescription>
                Update the display name for this product line.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label>Display Name</Label>
                <Input
                  value={editingProductLineDisplayName}
                  onChange={(e) => setEditingProductLineDisplayName(e.target.value)}
                  placeholder="e.g., Pricing Plans"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingProductLineId(null)}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  if (editingProductLineId && editingProductLineDisplayName.trim()) {
                    await onUpdateProductLine(editingProductLineId, editingProductLineDisplayName.trim());
                  toast({ title: "Product line updated" });
                  setEditingProductLineId(null);
                  }
                }}
                disabled={!editingProductLineDisplayName.trim()}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete productLine confirmation dialog */}
        <ActionDialog
          open={deletingProductLineId !== null}
          onOpenChange={(open) => !open && setDeletingProductLineId(null)}
          title="Delete Product Line"
          danger
          okButton={{
            label: "Delete",
            onClick: async () => {
              if (deletingProductLineId) {
                await onDeleteProductLine(deletingProductLineId);
              toast({ title: "Product line deleted" });
              setDeletingProductLineId(null);
              }
            }
          }}
          cancelButton
        >
          Are you sure you want to delete this product line? All products in this product line will be moved to &quot;No product line&quot;.
        </ActionDialog>

        {/* Drag overlay for visual feedback */}
        <DragOverlay>
          {activeDragId && activeDragProduct ? (
            <div className="opacity-90 rotate-3 scale-105">
              <div className={cn(
              "w-[260px] p-4 rounded-2xl",
              "bg-gray-200/95 dark:bg-[hsl(240,10%,8%)]",
              "border-2 border-primary",
              "shadow-2xl"
            )}>
                <div className="text-center">
                  <span className={cn(
                  "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ring-1 mb-2",
                  CUSTOMER_TYPE_COLORS[activeDragProduct.customerType]
                )}>
                    {activeDragProduct.customerType}
                  </span>
                  <h3 className="text-lg font-semibold">
                    {activeDragProduct.displayName || activeDragId}
                  </h3>
                </div>
              </div>
            </div>
          ) : null}
        </DragOverlay>

        {/* Loading overlay when moving product */}
        {isMovingProduct && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/50 backdrop-blur-sm">
            <div className="flex items-center gap-3 px-4 py-3 bg-background border rounded-lg shadow-lg">
              <CircleNotchIcon className="h-5 w-5 animate-spin text-primary" />
              <span className="text-sm font-medium">Moving product...</span>
            </div>
          </div>
        )}
      </div>
    </DndContext>
  );
}

type ProductLineViewPageProps = {
  createDraftRequestId?: string,
  draftCustomerType?: 'user' | 'team' | 'custom',
  onDraftHandled?: () => void,
};

export default function PageClient({ createDraftRequestId, draftCustomerType = 'user', onDraftHandled }: ProductLineViewPageProps) {
  const [showProductDialog, setShowProductDialog] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [showItemDialog, setShowItemDialog] = useState(false);
  const [editingItem, setEditingItem] = useState<{ id: string, displayName: string, customerType: 'user' | 'team' | 'custom' } | null>(null);
  const [newItemCustomerType, setNewItemCustomerType] = useState<'user' | 'team' | 'custom' | undefined>(undefined);
  const [refreshKey, setRefreshKey] = useState(0);
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const updateConfig = useUpdateConfig();
  const paymentsConfig: CompleteConfig['payments'] = config.payments;

  // Use product IDs as a key to ensure re-render when products change
  const productIds = Object.entries(paymentsConfig.products)
    .map(([id]) => id)
    .sort()
    .join(',');

  // Group products by productLineId and sort by customer type priority
  const groupedProducts = useMemo(() => {
    const groups = new Map<string | undefined, Array<{ id: string, product: Product }>>();

    // Group products
    for (const [id, product] of typedEntries(paymentsConfig.products)) {
      const productLineId = product.productLineId;
      if (!groups.has(productLineId)) {
        groups.set(productLineId, []);
      }
      groups.get(productLineId)!.push({ id, product });
    }

    // Sort products within each group by customer type, then by ID
    const customerTypePriority = { user: 1, team: 2, custom: 3 };
    groups.forEach((products) => {
      products.sort((a, b) => {
        const priorityA = customerTypePriority[a.product.customerType as keyof typeof customerTypePriority] || 4;
        const priorityB = customerTypePriority[b.product.customerType as keyof typeof customerTypePriority] || 4;
        if (priorityA !== priorityB) {
          return priorityA - priorityB;
        }
        // If same customer type, sort addons last
        if (a.product.isAddOnTo !== b.product.isAddOnTo) {
          return a.product.isAddOnTo ? 1 : -1;
        }
        // If same customer type and addons, sort by lowest price
        const getPricePriority = (product: Product) => {
          return Math.min(...Object.values(product.prices).map(price => +(price.USD ?? Infinity)));
        };
        const priceA = getPricePriority(a.product);
        const priceB = getPricePriority(b.product);
        if (priceA !== priceB) {
          return priceA - priceB;
        }
        // Otherwise, sort by ID
        return stringCompare(a.id, b.id);
      });
    });

    // Sort groups by their predominant customer type
    const sortedGroups = new Map<string | undefined, Array<{ id: string, product: Product }>>();

    // Helper to get group priority
    const getGroupPriority = (productLineId: string | undefined) => {
      if (!productLineId) return 999; // Ungrouped always last

      const products = groups.get(productLineId) || [];
      if (products.length === 0) return 999;

      // Get the most common customer type in the group
      const typeCounts = products.reduce((acc, { product }) => {
        const type = product.customerType;
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      // Find predominant type
      const predominantType = Object.entries(typeCounts)
        .sort(([, a], [, b]) => b - a)[0]?.[0];

      return customerTypePriority[predominantType as keyof typeof customerTypePriority] || 4;
    };

    // Sort group entries
    const sortedEntries = Array.from(groups.entries()).sort(([aId], [bId]) => {
      const priorityA = getGroupPriority(aId);
      const priorityB = getGroupPriority(bId);
      return priorityA - priorityB;
    });

    // Rebuild map in sorted order
    sortedEntries.forEach(([productLineId, products]) => {
      sortedGroups.set(productLineId, products);
    });

    return sortedGroups;
  }, [paymentsConfig.products]);

  // Callback to be called when a new item is created (for auto-selection)
  const [onItemCreatedCallback, setOnItemCreatedCallback] = useState<((itemId: string) => void) | undefined>(undefined);

  // Handler for create item button
  const handleCreateItem = (customerType?: 'user' | 'team' | 'custom', onCreated?: (itemId: string) => void) => {
    setNewItemCustomerType(customerType);
    setOnItemCreatedCallback(() => onCreated);
    setShowItemDialog(true);
  };

  // Handler for saving product
  const handleSaveProduct = async (productId: string, product: Product) => {
    const success = await updateConfig({ adminApp: hexclaveAdminApp, configUpdate: { [`payments.products.${productId}`]: product }, pushable: true });
    if (success) {
      setShowProductDialog(false);
      toast({ title: editingProduct ? "Product updated" : "Product created" });
    }
  };

  // Handler for saving item
  const handleSaveItem = async (item: { id: string, displayName: string, customerType: 'user' | 'team' | 'custom' }) => {
    const success = await updateConfig({ adminApp: hexclaveAdminApp, configUpdate: { [`payments.items.${item.id}`]: { displayName: item.displayName, customerType: item.customerType } }, pushable: true });
    if (success) {
      setShowItemDialog(false);
      setEditingItem(null);
      toast({ title: editingItem ? "Item updated" : "Item created" });
      // Call the callback to auto-select the newly created item
      if (onItemCreatedCallback && !editingItem) {
        onItemCreatedCallback(item.id);
        setOnItemCreatedCallback(undefined);
      }
    }
  };

  // Prepare data for product dialog - update when items change
  const existingProductsList = typedEntries(paymentsConfig.products)
    .map(([id, product]) => ({
      id,
      displayName: product.displayName,
      productLineId: product.productLineId,
      customerType: product.customerType
    }));

  const existingItemsList = typedEntries(paymentsConfig.items).map(([id, item]) => ({
    id,
    displayName: item.displayName,
    customerType: item.customerType
  }));

  const handleInlineSaveProduct = async (productId: string, product: Product) => {
    const success = await updateConfig({ adminApp: hexclaveAdminApp, configUpdate: { [`payments.products.${productId}`]: product }, pushable: true });
    if (success) {
      toast({ title: "Product updated" });
    }
  };

  const handleDeleteProduct = async (productId: string) => {
    // Get the product's productLine before deleting
    const product = paymentsConfig.products[productId];
    const productLineId = product.productLineId;

    // Count products in the same productLine (before deletion)
    const productsInProductLine = productLineId
      ? Object.entries(paymentsConfig.products).filter(([, p]) => p.productLineId === productLineId)
      : [];
    const isLastProductInProductLine = productLineId && productsInProductLine.length === 1;

    // Rebuild the products object without the deleted product
    // This is the correct way to delete - rebuild the object instead of setting to null
    const updatedProducts = typedFromEntries(
      typedEntries(paymentsConfig.products)
        .filter(([id]) => id !== productId)
    );

    // Delete the product (and productLine if it will be empty)
    let success: boolean;
    if (isLastProductInProductLine) {
      // Also rebuild productLines without the empty productLine
      const updatedProductLines = typedFromEntries(
        typedEntries(paymentsConfig.productLines)
          .filter(([id]) => id !== productLineId)
      );
      success = await updateConfig({ adminApp: hexclaveAdminApp, configUpdate: {
        "payments.products": updatedProducts,
        "payments.productLines": updatedProductLines,
      }, pushable: true });
      if (success) {
        toast({ title: "Product and empty product line deleted" });
      }
    } else {
      success = await updateConfig({ adminApp: hexclaveAdminApp, configUpdate: { "payments.products": updatedProducts }, pushable: true });
      if (success) {
        toast({ title: "Product deleted" });
      }
    }

    if (success) {
      // Force a re-render by updating the refresh key
      setRefreshKey(prev => prev + 1);
    }
  };

  const innerContent = (
    <div className="flex-1" key={`${productIds}-${refreshKey}`}>
      <ProductLineView
        groupedProducts={groupedProducts}
        groups={paymentsConfig.productLines}
        existingItems={existingItemsList}
        onSaveProduct={handleInlineSaveProduct}
        onDeleteProduct={handleDeleteProduct}
        onCreateNewItem={handleCreateItem}
        onOpenProductDetails={(product) => {
          setEditingProduct(product);
          setShowProductDialog(true);
        }}
        onSaveProductWithGroup={async (productLineId, productId, product) => {
          const success = await updateConfig({ adminApp: hexclaveAdminApp, configUpdate: {
            [`payments.products.${productId}`]: product,
          }, pushable: true });
          if (success) {
            toast({ title: "Product created" });
          }
        }}
        onCreateProductLine={async (productLineId, displayName, customerType) => {
          await updateConfig({ adminApp: hexclaveAdminApp, configUpdate: {
            [`payments.productLines.${productLineId}`]: { displayName, customerType },
          }, pushable: true });
        }}
        onUpdateProductLine={async (productLineId, displayName) => {
          await updateConfig({
            adminApp: hexclaveAdminApp,
            configUpdate: { [`payments.productLines.${productLineId}.displayName`]: displayName },
            pushable: true,
          });
        }}
        onDeleteProductLine={async (productLineId) => {
          // Move all products from this productLine to "No product line"
          const productsToUpdate = typedEntries(paymentsConfig.products)
            .filter(([, product]) => product.productLineId === productLineId)
            .map(([id, product]) => [id, { ...product, productLineId: undefined }] as const);

          // Rebuild productLines without the deleted productLine
          const updatedProductLines = typedFromEntries(
            typedEntries(paymentsConfig.productLines)
              .filter(([id]) => id !== productLineId)
          );

          // Build the update object
          // Using `as any` because we're building a dynamic config update that TypeScript can't statically verify
          const configUpdateObj: Record<string, unknown> = {
            "payments.productLines": updatedProductLines,
          };

          // Update each product to remove productLineId
          for (const [productId, product] of productsToUpdate) {
            configUpdateObj[`payments.products.${productId}`] = product;
          }

          await updateConfig({
            adminApp: hexclaveAdminApp,
            configUpdate: configUpdateObj as any,
            pushable: true,
          });
        }}
        createDraftRequestId={createDraftRequestId}
        draftCustomerType={draftCustomerType}
        onDraftHandled={onDraftHandled}
        paymentsConfig={paymentsConfig}
        onMoveProduct={async (productId, targetProductLineId) => {
          const currentProduct = paymentsConfig.products[productId];

          // Update the entire product object with the new productLineId
          // Using undefined instead of null to properly clear the value
          await updateConfig({
            adminApp: hexclaveAdminApp,
            configUpdate: {
              [`payments.products.${productId}`]: {
                ...currentProduct,
                productLineId: targetProductLineId ?? undefined,
              },
            },
            pushable: true,
          });
        }}
      />
    </div>
  );

  return (
    <>
      {innerContent}

      {/* Product Dialog */}
      <ProductDialog
        open={showProductDialog}
        onOpenChange={(open) => {
          setShowProductDialog(open);
          if (!open) {
            setEditingProduct(null);
          }
        }}
        onSave={async (productId, product) => await handleSaveProduct(productId, product)}
        editingProduct={editingProduct ?? undefined}
        existingProducts={existingProductsList}
        existingProductLines={Object.fromEntries(Object.entries(paymentsConfig.productLines).map(([id, g]) => [id, { displayName: g.displayName || id, customerType: g.customerType }]))}
        existingItems={existingItemsList}
        onCreateNewItem={handleCreateItem}
      />

      {/* Item Dialog */}
      <ItemDialog
        open={showItemDialog}
        onOpenChange={(open) => {
          setShowItemDialog(open);
          if (!open) {
            setEditingItem(null);
            setNewItemCustomerType(undefined);
            setOnItemCreatedCallback(undefined);
          }
        }}
        onSave={async (item) => await handleSaveItem(item)}
        editingItem={editingItem ?? undefined}
        existingItemIds={Object.keys(paymentsConfig.items)}
        forceCustomerType={newItemCustomerType}
      />
    </>
  );
}
