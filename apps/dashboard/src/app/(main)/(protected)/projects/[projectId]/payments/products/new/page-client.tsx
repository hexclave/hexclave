"use client";

import { Link } from "@/components/link";
import { ItemDialog } from "@/components/payments/item-dialog";
import { useRouter } from "@/components/router";
import {
  DesignButton,
  DesignInput,
  DesignSelectorDropdown,
} from "@/components/design-components";
import { SubpageHeader } from "@/components/design-components/subpage-header";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Label,
  SimpleTooltip,
  toast,
  Typography,
} from "@/components/ui";
import { useUpdateConfig } from "@/components/config-update";
import { cn } from "@/lib/utils";
import { ArrowSquareOutIcon, BuildingOfficeIcon, CaretDownIcon, ChatIcon, ClockIcon, CodeIcon, CopyIcon, GearIcon, HardDriveIcon, LightningIcon, PlusIcon, PuzzlePieceIcon, StackIcon, TrashIcon, UserIcon } from "@phosphor-icons/react";
import { CompleteConfig } from "@hexclave/shared/dist/config/schema";
import { getUserSpecifiedIdErrorMessage, isValidUserSpecifiedId, sanitizeUserSpecifiedId } from "@hexclave/shared/dist/schema-fields";
import { typedEntries } from "@hexclave/shared/dist/utils/objects";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useSearchParams } from "next/navigation";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAdminApp, useProjectId } from "../../../use-admin-app";
import { CreateProductLineDialog } from "../create-product-line-dialog";
import { IncludedItemDialog } from "../included-item-dialog";
import { PricingSection } from "../pricing-section";
import { ProductCardPreview } from "../product-card-preview";
import {
  createFreePrice,
  isFreePrices,
  type Price,
  type Product,
} from "../utils";

type IncludedItem = Product['includedItems'][string];

const CUSTOMER_TYPE_OPTIONS = [
  {
    value: 'user' as const,
    label: 'User',
    description: 'The customer of this product is an individual user',
    icon: UserIcon,
    color: 'blue',
  },
  {
    value: 'team' as const,
    label: 'Team',
    description: 'The customer of this product is an entire team',
    icon: BuildingOfficeIcon,
    color: 'emerald',
  },
  {
    value: 'custom' as const,
    label: 'Custom',
    description: 'Products for entities you define. You can specify a custom ID to identify the customer.',
    icon: GearIcon,
    color: 'amber',
  },
] as const;

const FREE_TRIAL_UNIT_OPTIONS = [
  { value: 'day', label: 'days' },
  { value: 'week', label: 'weeks' },
  { value: 'month', label: 'months' },
  { value: 'year', label: 'years' },
];

const COLOR_CLASSES = {
  blue: {
    hover: 'hover:border-blue-500/40 hover:shadow-[0_0_12px_rgba(59,130,246,0.1)]',
    bg: 'bg-blue-500/10 dark:bg-blue-500/[0.15] group-hover:bg-blue-500/20',
    icon: 'text-blue-600 dark:text-blue-400',
  },
  emerald: {
    hover: 'hover:border-emerald-500/40 hover:shadow-[0_0_12px_rgba(16,185,129,0.1)]',
    bg: 'bg-emerald-500/10 dark:bg-emerald-500/[0.15] group-hover:bg-emerald-500/20',
    icon: 'text-emerald-600 dark:text-emerald-400',
  },
  amber: {
    hover: 'hover:border-amber-500/40 hover:shadow-[0_0_12px_rgba(245,158,11,0.1)]',
    bg: 'bg-amber-500/10 dark:bg-amber-500/[0.15] group-hover:bg-amber-500/20',
    icon: 'text-amber-600 dark:text-amber-400',
  },
  gray: {
    hover: '',
    bg: 'bg-foreground/[0.05]',
    icon: 'text-foreground/40',
  },
} as const;

function CustomerTypeSelection({
  onSelectCustomerType,
  onCancel,
  isTeamsEnabled,
  projectId,
}: {
  onSelectCustomerType: (type: 'user' | 'team' | 'custom') => void,
  onCancel: () => void,
  isTeamsEnabled: boolean,
  projectId: string,
}) {
  // Split options into available and unavailable
  const availableOptions = CUSTOMER_TYPE_OPTIONS.filter(
    (option) => option.value !== 'team' || isTeamsEnabled
  );
  const unavailableOptions = CUSTOMER_TYPE_OPTIONS.filter(
    (option) => option.value === 'team' && !isTeamsEnabled
  );

  return (
    <div className="flex flex-col h-full">
      <SubpageHeader title="Create Product" onBack={onCancel} />
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="space-y-4 max-w-md mx-auto">
          <div className="text-center mb-8">
            <Typography type="h2" className="text-2xl font-semibold">Who will this product be for?</Typography>
          </div>

          {/* Available options */}
          <div className="grid gap-3">
            {availableOptions.map((option) => {
              const Icon = option.icon;
              const colorClasses = COLOR_CLASSES[option.color];

              return (
                <Card
                  key={option.value}
                  className={cn(
                    "cursor-pointer group",
                    "rounded-xl border border-border/50 dark:border-foreground/[0.1]",
                    "bg-foreground/[0.02] hover:bg-foreground/[0.04]",
                    colorClasses.hover,
                    "transition-all duration-150 hover:transition-none"
                  )}
                  onClick={() => onSelectCustomerType(option.value)}
                >
                  <CardHeader className="p-4">
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        "p-2.5 rounded-xl transition-colors duration-150 group-hover:transition-none",
                        colorClasses.bg
                      )}>
                        <Icon className={cn("h-5 w-5", colorClasses.icon)} />
                      </div>
                      <div>
                        <CardTitle className="text-base font-semibold">{option.label}</CardTitle>
                        <CardDescription className="text-sm mt-1 text-muted-foreground">
                          {option.description}
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                </Card>
              );
            })}
          </div>

          {/* Unavailable options section */}
          {unavailableOptions.length > 0 && (
            <div className="space-y-2 pt-8">
              <Typography type="label" className="text-xs text-foreground/40 uppercase tracking-wider">
                Unavailable options
              </Typography>
              <p className="text-xs text-muted-foreground mb-3">
                These options require additional apps or configuration.
              </p>
              <div className="grid gap-3">
                {unavailableOptions.map((option) => {
                  const Icon = option.icon;
                  const colorClasses = COLOR_CLASSES.gray;

                  return (
                    <Link
                      key={option.value}
                      href={`/projects/${projectId}/apps/teams`}
                    >
                      <Card
                        className={cn(
                          "cursor-pointer group",
                          "rounded-xl border border-border/30 dark:border-foreground/[0.05]",
                          "bg-foreground/[0.01] hover:bg-foreground/[0.03]",
                          "opacity-60 hover:opacity-80",
                          "transition-all duration-150 hover:transition-none"
                        )}
                      >
                        <CardHeader className="p-4">
                          <div className="flex items-center gap-3">
                            <div className={cn(
                              "p-2.5 rounded-xl",
                              colorClasses.bg
                            )}>
                              <Icon className={cn("h-5 w-5", colorClasses.icon)} />
                            </div>
                            <div className="flex-1">
                              <CardTitle className="text-base font-semibold text-foreground/50">{option.label}</CardTitle>
                              <CardDescription className="text-sm mt-1 text-muted-foreground/70">
                                Enable the Teams app to choose this customer type
                              </CardDescription>
                            </div>
                            <ArrowSquareOutIcon className="h-4 w-4 text-foreground/30" />
                          </div>
                        </CardHeader>
                      </Card>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


function getItemDisplay(itemId: string, item: IncludedItem, existingItems: Array<{ id: string, displayName: string, customerType: string }>) {
  const itemData = existingItems.find(i => i.id === itemId);
  if (!itemData) return itemId;

  let display = `${item.quantity}× ${itemData.displayName || itemData.id}`;
  if (item.repeat !== 'never') {
    const [count, unit] = item.repeat;
    display += ` every ${count} ${unit}${count > 1 ? 's' : ''}`;
  }
  return display;
}

function toIdFormat(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric sequences with hyphens
    .replace(/^-+|-+$/g, ''); // Trim leading/trailing hyphens
}

// Helper to get duplicate data from sessionStorage
function getDuplicateData(key: string | null): Product | null {
  if (!key) return null;
  try {
    const data = sessionStorage.getItem(key);
    if (data) {
      sessionStorage.removeItem(key); // Clean up after reading
      return JSON.parse(data) as Product;
    }
  } catch {
    // Ignore parsing errors
  }
  return null;
}

export default function PageClient() {
  const projectId = useProjectId();
  const router = useRouter();
  const searchParams = useSearchParams();
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const updateConfig = useUpdateConfig();
  const paymentsConfig: CompleteConfig['payments'] = config.payments;

  // Check for duplicate data from sessionStorage
  const duplicateKey = searchParams.get("duplicate");
  const [duplicateData] = useState(() => getDuplicateData(duplicateKey));

  // Get URL parameters for pre-filling the form
  const urlProductLineId = duplicateData?.productLineId ?? searchParams.get("productLineId");
  const urlCustomerType = duplicateData?.customerType ?? searchParams.get("customerType") as 'user' | 'team' | 'custom' | null;

  // Validate productLineId exists and get its customerType
  const validProductLineId = urlProductLineId && urlProductLineId in paymentsConfig.productLines ? urlProductLineId : null;
  const productLineCustomerType = validProductLineId ? paymentsConfig.productLines[validProductLineId].customerType : null;

  // Determine initial customer type: from product line > from URL/duplicate > default 'user'
  const validUrlCustomerType = urlCustomerType && ['user', 'team', 'custom'].includes(urlCustomerType) ? urlCustomerType : null;
  const initialCustomerType = productLineCustomerType ?? validUrlCustomerType ?? 'user';

  // Skip customer type selection if we have duplicate data, valid productLineId, or valid customerType in URL
  const skippedCustomerTypeSelection = !!duplicateData || !!validProductLineId || !!validUrlCustomerType;
  const [hasSelectedCustomerType, setHasSelectedCustomerType] = useState(skippedCustomerTypeSelection);

  // Parse duplicate data for form initialization
  const duplicateIsAddOn = duplicateData?.isAddOnTo !== false && duplicateData?.isAddOnTo !== undefined;
  const duplicateIsAddOnTo = duplicateIsAddOn && duplicateData.isAddOnTo
    ? Object.keys(duplicateData.isAddOnTo as Record<string, boolean>)
    : [];
  const duplicatePrices = duplicateData?.prices ?? {};

  // Form state - initialized from duplicate data if available
  const [productId, setProductId] = useState("");
  const [displayName, setDisplayName] = useState(duplicateData?.displayName ?? "");
  const [hasManuallyEditedId, setHasManuallyEditedId] = useState(false);
  const [customerType, setCustomerType] = useState<'user' | 'team' | 'custom'>(initialCustomerType);
  const [productLineId, setProductLineId] = useState(validProductLineId ?? "");
  const [isAddOn, setIsAddOn] = useState(duplicateIsAddOn);
  const [isAddOnTo, setIsAddOnTo] = useState<string[]>(duplicateIsAddOnTo);
  const [stackable, setStackable] = useState(duplicateData?.stackable ?? false);
  const [serverOnly, setServerOnly] = useState(duplicateData?.serverOnly ?? false);
  const [isInlineProduct, setIsInlineProduct] = useState(false);
  const [prices, setPrices] = useState<Record<string, Price>>(duplicatePrices);
  const [includedItems, setIncludedItems] = useState<Product['includedItems']>(duplicateData?.includedItems ?? {});
  const [freeTrial, setFreeTrial] = useState<Product['freeTrial']>(duplicateData?.freeTrial);

  // Dialog states
  const [showProductLineDialog, setShowProductLineDialog] = useState(false);
  const [showItemDialog, setShowItemDialog] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | undefined>();
  const [showNewItemDialog, setShowNewItemDialog] = useState(false);

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);

  // Container width measurement for responsive preview
  const mainContentRef = useRef<HTMLDivElement>(null);
  const [showPreview, setShowPreview] = useState(true);

  useLayoutEffect(() => {
    const container = mainContentRef.current;
    if (!container) return;

    const updateShowPreview = () => {
      setShowPreview(container.offsetWidth > 900);
    };

    const observer = new ResizeObserver(() => {
      updateShowPreview();
    });

    observer.observe(container);
    // Initial check
    updateShowPreview();

    return () => observer.disconnect();
  }, [hasSelectedCustomerType]);

  const productLineDropdownOptions = useMemo(() => [
    { value: 'no-product-line', label: 'No product line' },
    ...typedEntries(paymentsConfig.productLines)
      .filter(([, productLine]) => productLine.customerType === customerType)
      .map(([id, productLine]) => ({
        value: id,
        label: productLine.displayName || id,
      })),
    { value: 'create-new', label: '+ Create new' },
  ], [paymentsConfig.productLines, customerType]);

  // Computed values
  const existingProducts = typedEntries(paymentsConfig.products)
    .map(([id, product]) => ({
      id,
      displayName: product.displayName,
      productLineId: product.productLineId,
      customerType: product.customerType
    }));

  const existingItems = typedEntries(paymentsConfig.items).map(([id, item]) => ({
    id,
    displayName: item.displayName,
    customerType: item.customerType
  }));

  const isFirstProduct = existingProducts.length === 0;

  // Validate that the selected productLineId matches the current customerType
  // If not, treat it as "no product line" - this handles cases where URL params have mismatched types
  const effectiveProductLineId = productLineId && paymentsConfig.productLines[productLineId].customerType === customerType
    ? productLineId
    : "";

  // Build product object for preview
  const previewProduct: Product = {
    displayName: displayName || 'New Product',
    customerType,
    productLineId: effectiveProductLineId || undefined,
    isAddOnTo: isAddOn ? Object.fromEntries(isAddOnTo.map(id => [id, true])) : false,
    stackable,
    prices,
    includedItems,
    serverOnly,
    freeTrial,
  };

  const handleSelectCustomerType = (type: 'user' | 'team' | 'custom') => {
    setCustomerType(type);
    setHasSelectedCustomerType(true);
  };

  const handleBack = () => {
    // If we skipped customer type selection (came from URL with customerType or productLineId),
    // go back to the previous page instead of showing the selection screen
    if (skippedCustomerTypeSelection) {
      if (window.history.length > 1) {
        window.history.back();
      } else {
        router.push(`/projects/${projectId}/app-configuration/payments/products`);
      }
    } else {
      setHasSelectedCustomerType(false);
    }
  };

  // When customer type changes via the dropdown, reset product-line-related state
  const handleCustomerTypeChange = (newType: 'user' | 'team' | 'custom') => {
    if (newType !== customerType) {
      setCustomerType(newType);
      // Reset product line since product lines are customer-type-specific
      setProductLineId("");
      // Reset add-on selections since they may not be valid for the new type
      setIsAddOnTo([]);
    }
  };

  const handleCreateProductLine = (productLine: { id: string, displayName: string }) => {
    runAsynchronouslyWithAlert(async () => {
      await updateConfig({
        adminApp: hexclaveAdminApp,
        configUpdate: {
          [`payments.productLines.${productLine.id}`]: {
            displayName: productLine.displayName || null,
            customerType,
          },
        },
        pushable: true,
      });
      setProductLineId(productLine.id);
    });
  };

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    if (!productId.trim()) {
      newErrors.productId = "Product ID is required";
    } else if (!isValidUserSpecifiedId(productId)) {
      newErrors.productId = getUserSpecifiedIdErrorMessage("productId");
    } else if (existingProducts.some(o => o.id === productId)) {
      newErrors.productId = "This product ID already exists";
    }

    if (!displayName.trim()) {
      newErrors.displayName = "Display name is required";
    }

    if (isAddOn && isAddOnTo.length === 0) {
      newErrors.isAddOnTo = "Please select at least one product this is an add-on to";
    }

    if (isAddOn && isAddOnTo.length > 0) {
      const addOnProductLines = new Set(
        isAddOnTo.map(pid => existingProducts.find(o => o.id === pid)?.productLineId)
      );
      if (addOnProductLines.size > 1) {
        newErrors.isAddOnTo = "All selected products must be in the same product line";
      }
    }

    if (Object.keys(prices).length === 0) {
      newErrors.prices = "Add at least one price";
    }

    return newErrors;
  };

  const handleSave = async () => {
    const validationErrors = validateForm();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setIsSaving(true);
    try {
      const product: Product = {
        displayName,
        customerType,
        productLineId: effectiveProductLineId || undefined,
        isAddOnTo: isAddOn ? Object.fromEntries(isAddOnTo.map(id => [id, true])) : false,
        stackable,
        prices,
        includedItems,
        serverOnly,
        freeTrial,
      };

      const success = await updateConfig({
        adminApp: hexclaveAdminApp,
        configUpdate: { [`payments.products.${productId}`]: product },
        pushable: true,
      });
      if (success) {
        toast({ title: "Product created" });
        router.push(`/projects/${projectId}/app-configuration/payments/products`);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const addIncludedItem = (itemId: string, item: IncludedItem) => {
    setIncludedItems(prev => ({ ...prev, [itemId]: item }));
  };

  const editIncludedItem = (itemId: string, item: IncludedItem) => {
    setIncludedItems(prev => {
      const newItems = { ...prev };
      newItems[itemId] = item;
      return newItems;
    });
  };

  const removeIncludedItem = (itemId: string) => {
    setIncludedItems(prev => {
      const newItems = { ...prev };
      delete newItems[itemId];
      return newItems;
    });
  };

  const handleCancel = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      router.push(`/projects/${projectId}/app-configuration/payments/products`);
    }
  };

  // Check if Teams app is enabled
  const isTeamsEnabled = config.apps.installed.teams?.enabled ?? false;

  // Show customer type selection if not selected yet
  if (!hasSelectedCustomerType) {
    return (
      <CustomerTypeSelection
        onSelectCustomerType={handleSelectCustomerType}
        onCancel={handleCancel}
        isTeamsEnabled={isTeamsEnabled}
        projectId={projectId}
      />
    );
  }

  const canSave = !!(productId.trim() && displayName.trim() && Object.keys(prices).length > 0);

  // Generate inline product code for copying
  const generateInlineProductCode = () => {
    const pricesCode = `{
${Object.entries(prices).map(([id, price]) => {
  const parts = [`    '${id}': { USD: '${price.USD}'`];
  if (price.interval) {
    parts.push(`, interval: [${price.interval[0]}, '${price.interval[1]}']`);
  }
  if (price.freeTrial) {
    parts.push(`, freeTrial: [${price.freeTrial[0]}, '${price.freeTrial[1]}']`);
  }
  if (price.serverOnly) {
    parts.push(`, serverOnly: true`);
  }
  parts.push(` }`);
  return parts.join('');
}).join(',\n')}
  }`;

    const isAddOnToCode = isAddOn && isAddOnTo.length > 0
      ? `{ ${isAddOnTo.map(id => `'${id}': true`).join(', ')} }`
      : 'false';

    return `const product = {
  id: '${productId || 'product-id'}',
  displayName: '${displayName || 'New Product'}',
  customerType: '${customerType}',
  prices: ${pricesCode},${effectiveProductLineId ? `\n  productLineId: '${effectiveProductLineId}',` : ''}${stackable ? '\n  stackable: true,' : ''}${serverOnly ? '\n  serverOnly: true,' : ''}
  isAddOnTo: ${isAddOnToCode},
  includedItems: {${Object.entries(includedItems).map(([id, item]) => {
    const repeatPart = item.repeat === 'never' ? `'never'` : `[${item.repeat[0]}, '${item.repeat[1]}']`;
    return `\n    '${id}': { quantity: ${item.quantity}, repeat: ${repeatPart} }`;
  }).join(',')}${Object.keys(includedItems).length > 0 ? '\n  ' : ''}}
};`;
  };

  // Generate prompt for creating inline product
  const generateInlineProductPrompt = () => {
    const priceDescriptions = Object.entries(prices).map(([id, price]) => {
      let desc = `$${price.USD}`;
      if (price.interval) {
        const [count, unit] = price.interval;
        desc += count === 1 ? ` per ${unit}` : ` every ${count} ${unit}s`;
      } else {
        desc += ' one-time';
      }
      if (price.freeTrial) {
        const [count, unit] = price.freeTrial;
        desc += ` with ${count} ${unit}${count > 1 ? 's' : ''} free trial`;
      }
      return desc;
    }).join(', ');

    const itemDescriptions = Object.entries(includedItems).map(([itemId, item]) => {
      const itemInfo = existingItems.find(i => i.id === itemId);
      return `${item.quantity}x ${itemInfo?.displayName || itemId}`;
    }).join(', ');

    return `Create an inline product with the following configuration:
- Product ID: ${productId || 'product-id'}
- Display Name: ${displayName || 'New Product'}
- Customer Type: ${customerType}
- Pricing: ${priceDescriptions}${effectiveProductLineId ? `\n- Product Line: ${effectiveProductLineId}` : ''}${stackable ? '\n- Stackable: yes' : ''}${serverOnly ? '\n- Server only: yes' : ''}${isAddOn && isAddOnTo.length > 0 ? `\n- Add-on to: ${isAddOnTo.join(', ')}` : ''}${itemDescriptions ? `\n- Included items: ${itemDescriptions}` : ''}`;
  };

  return (
    <div className="flex flex-col h-full">
      <SubpageHeader
        title="Create Product"
        onBack={handleBack}
        actions={
          <>
            <DesignButton
              variant="secondary"
              size="sm"
              type="button"
              onClick={handleCancel}
              className="h-9 rounded-xl px-4 text-sm"
            >
              Cancel
            </DesignButton>
            {isInlineProduct ? (
              <DesignButton
                size="sm"
                type="button"
                onClick={() => {
                  const prompt = generateInlineProductPrompt();
                  runAsynchronouslyWithAlert(async () => {
                    await navigator.clipboard.writeText(prompt);
                    toast({ title: "Prompt copied to clipboard" });
                  });
                }}
                className="h-9 rounded-xl px-4 text-sm"
              >
                <CopyIcon className="h-4 w-4 mr-2" />
                Copy Checkout Prompt
              </DesignButton>
            ) : (
              <DropdownMenu>
                <div className="inline-flex items-stretch overflow-hidden rounded-xl">
                  <SimpleTooltip
                    tooltip={!canSave ? "Fill in required fields and add at least one price" : undefined}
                    disabled={canSave}
                  >
                    <DesignButton
                      size="sm"
                      type="button"
                      onClick={handleSave}
                      disabled={!canSave || isSaving}
                      loading={isSaving}
                      className="h-9 rounded-none px-4 text-sm"
                    >
                      Create Product
                    </DesignButton>
                  </SimpleTooltip>
                  <DropdownMenuTrigger asChild>
                    <DesignButton
                      variant="default"
                      size="sm"
                      type="button"
                      disabled={!canSave || isSaving}
                      className="h-9 rounded-none px-2.5 border-l border-primary-foreground/20"
                    >
                      <CaretDownIcon className="h-4 w-4" />
                    </DesignButton>
                  </DropdownMenuTrigger>
                </div>
                <DropdownMenuContent align="end" className="min-w-[180px]">
                  <DropdownMenuItem
                    icon={<CodeIcon className="h-4 w-4" />}
                    onClick={() => {
                      const code = generateInlineProductCode();
                      runAsynchronouslyWithAlert(async () => {
                        await navigator.clipboard.writeText(code);
                        toast({ title: "Code copied to clipboard" });
                      });
                    }}
                  >
                    Copy code
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={<ChatIcon className="h-4 w-4" />}
                    onClick={() => {
                      const prompt = generateInlineProductPrompt();
                      runAsynchronouslyWithAlert(async () => {
                        await navigator.clipboard.writeText(prompt);
                        toast({ title: "Prompt copied to clipboard" });
                      });
                    }}
                  >
                    Copy prompt
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />

      {/* Main content - form on left, preview on right */}
      <div ref={mainContentRef} className="flex-1 flex overflow-hidden">
        {/* Left side - Configuration form */}
        <div className="flex-1 overflow-y-auto p-6 flex justify-center">
          <div className="w-full max-w-2xl space-y-5">
            {/* Display Name and Product ID - same row */}
            <div className="grid grid-cols-2 gap-4 items-start">
              {/* Display Name */}
              <div className="grid gap-2">
                <Label htmlFor="display-name" className="text-sm font-medium">Display Name</Label>
                <DesignInput
                  id="display-name"
                  value={displayName}
                  onChange={(e) => {
                    const newDisplayName = e.target.value;
                    setDisplayName(newDisplayName);
                    if (!hasManuallyEditedId) {
                      setProductId(toIdFormat(newDisplayName));
                    }
                    if (errors.displayName || (!hasManuallyEditedId && errors.productId)) {
                      setErrors(prev => {
                        const newErrors = { ...prev };
                        delete newErrors.displayName;
                        if (!hasManuallyEditedId) {
                          delete newErrors.productId;
                        }
                        return newErrors;
                      });
                    }
                  }}
                  placeholder="e.g., Pro Plan"
                  size="md"
                  className={cn(errors.displayName && "border-destructive focus-visible:ring-destructive/30")}
                />
                <span className="text-xs text-muted-foreground">Visible to customers during checkout</span>
                {errors.displayName && (
                  <Typography type="label" className="text-destructive text-xs">
                    {errors.displayName}
                  </Typography>
                )}
              </div>

              {/* Product ID */}
              <div className="grid gap-2">
                <Label htmlFor="product-id" className="text-sm font-medium">Product ID</Label>
                <DesignInput
                  id="product-id"
                  value={productId}
                  onChange={(e) => {
                    const nextValue = sanitizeUserSpecifiedId(e.target.value);
                    setProductId(nextValue);
                    setHasManuallyEditedId(true);
                    if (errors.productId) {
                      setErrors(prev => {
                        const newErrors = { ...prev };
                        delete newErrors.productId;
                        return newErrors;
                      });
                    }
                  }}
                  placeholder="e.g., pro-plan"
                  size="md"
                  className={cn(
                    "font-mono text-sm",
                    errors.productId && "border-destructive focus-visible:ring-destructive/30"
                  )}
                />
                <span className="text-xs text-muted-foreground">Used to reference this product in code</span>
                {errors.productId && (
                  <Typography type="label" className="text-destructive text-xs">
                    {errors.productId}
                  </Typography>
                )}
              </div>
            </div>

            {/* Pricing Section */}
            <section className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pricing</h2>
              <PricingSection
                prices={prices}
                onPricesChange={(newPrices) => {
                  setPrices(newPrices);
                  if (errors.prices && Object.keys(newPrices).length > 0) {
                    setErrors(prev => {
                      const newErrors = { ...prev };
                      delete newErrors.prices;
                      return newErrors;
                    });
                  }
                }}
                hasError={!!errors.prices}
                errorMessage={errors.prices}
                variant="form"
                onMakeFree={() => {
                  setPrices(createFreePrice());
                }}
              />
            </section>

            {/* Included Items Section */}
            <section className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Included Items</h2>

              {Object.entries(includedItems).length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/50 p-4 text-center">
                  <p className="text-sm text-muted-foreground mb-3">
                    No items included yet
                  </p>
                  <DesignButton
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={() => {
                      setEditingItemId(undefined);
                      setShowItemDialog(true);
                    }}
                  >
                    <PlusIcon className="h-4 w-4 mr-2" />
                    Add Item
                  </DesignButton>
                </div>
              ) : (
                <div className="space-y-2">
                  {Object.entries(includedItems).map(([itemId, item]) => (
                    <div
                      key={itemId}
                      className={cn(
                        "flex items-center justify-between p-3 rounded-xl",
                        "bg-foreground/[0.02] border border-border/50 ring-1 ring-foreground/[0.04]",
                        "hover:bg-foreground/[0.04] transition-colors duration-150 hover:transition-none"
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm">{getItemDisplay(itemId, item, existingItems)}</div>
                        <div className="text-xs text-muted-foreground font-mono truncate">{itemId}</div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <DesignButton
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={() => {
                            setEditingItemId(itemId);
                            setShowItemDialog(true);
                          }}
                        >
                          Edit
                        </DesignButton>
                        <DesignButton
                          variant="ghost"
                          size="sm"
                          type="button"
                          className="text-destructive hover:text-destructive"
                          onClick={() => removeIncludedItem(itemId)}
                        >
                          <TrashIcon className="h-4 w-4" />
                        </DesignButton>
                      </div>
                    </div>
                  ))}
                  <DesignButton
                    variant="outline"
                    size="sm"
                    className="w-full"
                    type="button"
                    onClick={() => {
                      setEditingItemId(undefined);
                      setShowItemDialog(true);
                    }}
                  >
                    <PlusIcon className="h-4 w-4 mr-2" />
                    Add Another Item
                  </DesignButton>
                </div>
              )}
            </section>

            {/* Options Section - Two column grid */}
            <section className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Options</h2>

              <div className="grid grid-cols-[auto,1fr] gap-x-6">
                {/* Stackable */}
                <span className="text-sm text-foreground/70 py-2 border-b border-border/20">Can this be purchased multiple times?</span>
                <label className="flex items-center gap-2 cursor-pointer py-2 border-b border-border/20">
                  <Checkbox
                    id="stackable"
                    checked={stackable}
                    onCheckedChange={(checked) => setStackable(checked as boolean)}
                  />
                  <StackIcon className="h-4 w-4 text-foreground/50" />
                  <span className="text-sm font-medium">Stackable</span>
                </label>

                {/* Server Only */}
                <span className="text-sm text-foreground/70 py-2 border-b border-border/20">Restrict to server-side purchases only?</span>
                <label className="flex items-center gap-2 cursor-pointer py-2 border-b border-border/20">
                  <Checkbox
                    id="server-only"
                    checked={serverOnly}
                    onCheckedChange={(checked) => setServerOnly(checked as boolean)}
                  />
                  <HardDriveIcon className="h-4 w-4 text-foreground/50" />
                  <span className="text-sm font-medium">Server only</span>
                </label>

                {/* Add-on */}
                {!isFirstProduct && (
                  <>
                    <span className="text-sm text-foreground/70 py-2 border-b border-border/20">Require another product to be purchased first?</span>
                    <div className="py-2 border-b border-border/20">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox
                          id="addon"
                          checked={isAddOn}
                          onCheckedChange={(checked) => {
                            setIsAddOn(checked as boolean);
                            if (!checked) {
                              setIsAddOnTo([]);
                              if (errors.isAddOnTo) {
                                setErrors(prev => {
                                  const newErrors = { ...prev };
                                  delete newErrors.isAddOnTo;
                                  return newErrors;
                                });
                              }
                            }
                          }}
                        />
                        <PuzzlePieceIcon className="h-4 w-4 text-foreground/50" />
                        <span className="text-sm font-medium">Add-on</span>
                      </label>

                      {isAddOn && (
                        <div className="mt-1.5 mb-0.5 space-y-1 p-2 rounded-lg bg-foreground/[0.02] border border-border/30">
                          <span className="text-xs text-foreground/50">Add-on to:</span>
                          <div className="space-y-1 max-h-24 overflow-y-auto">
                            {existingProducts.map(product => (
                              <label key={product.id} className="flex items-center gap-2 cursor-pointer">
                                <Checkbox
                                  id={`addon-to-${product.id}`}
                                  checked={isAddOnTo.includes(product.id)}
                                  onCheckedChange={(checked) => {
                                    if (checked) {
                                      setIsAddOnTo(prev => [...prev, product.id]);
                                    } else {
                                      setIsAddOnTo(prev => prev.filter(id => id !== product.id));
                                    }
                                    if (errors.isAddOnTo) {
                                      setErrors(prev => {
                                        const newErrors = { ...prev };
                                        delete newErrors.isAddOnTo;
                                        return newErrors;
                                      });
                                    }
                                  }}
                                />
                                <span className="text-sm">{product.displayName}</span>
                              </label>
                            ))}
                          </div>
                          {errors.isAddOnTo && (
                            <Typography type="label" className="text-destructive text-xs">
                              {errors.isAddOnTo}
                            </Typography>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* Free Trial */}
                <span className="text-sm text-foreground/70 py-2 flex items-center border-b border-border/20">Offer a free trial period?</span>
                <div className="py-2 flex items-center border-b border-border/20">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      id="free-trial"
                      checked={!!freeTrial}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setFreeTrial([7, 'day']);
                        } else {
                          setFreeTrial(undefined);
                        }
                      }}
                    />
                    <ClockIcon className="h-4 w-4 text-foreground/50" />
                    <span className="text-sm font-medium">Free trial</span>
                  </label>
                  {freeTrial && (
                    <div className="flex items-center gap-2 ml-4">
                      <DesignInput
                        type="number"
                        min={1}
                        value={freeTrial[0]}
                        onChange={(e) => {
                          const val = parseInt(e.target.value) || 1;
                          setFreeTrial([val, freeTrial[1]]);
                        }}
                        size="sm"
                        className="w-16"
                      />
                      <DesignSelectorDropdown
                        value={freeTrial[1]}
                        onValueChange={(value) => setFreeTrial([freeTrial[0], value as 'day' | 'week' | 'month' | 'year'])}
                        options={FREE_TRIAL_UNIT_OPTIONS}
                        size="sm"
                        className="w-28 shrink-0"
                      />
                    </div>
                  )}
                </div>

                {/* Product Line */}
                <span className="text-sm text-foreground/70 py-2 flex items-center border-b border-border/20">Part of a mutually exclusive group?</span>
                <div className="py-2 flex items-center border-b border-border/20">
                  <DesignSelectorDropdown
                    value={effectiveProductLineId || 'no-product-line'}
                    onValueChange={(value) => {
                      if (value === 'create-new') {
                        setShowProductLineDialog(true);
                      } else if (value === 'no-product-line') {
                        setProductLineId('');
                      } else {
                        setProductLineId(value);
                      }
                    }}
                    options={productLineDropdownOptions}
                    placeholder="No product line"
                    size="sm"
                    className="w-full max-w-[200px]"
                    triggerClassName="w-full max-w-[200px]"
                  />
                </div>

                {/* Inline Product */}
                <span className="text-sm text-foreground/70 py-2">Create on-the-fly for each checkout?</span>
                <label className="flex items-center gap-2 cursor-pointer py-2">
                  <Checkbox
                    id="inline"
                    checked={isInlineProduct}
                    onCheckedChange={(checked) => setIsInlineProduct(checked as boolean)}
                  />
                  <LightningIcon className="h-4 w-4 text-foreground/50" />
                  <span className="text-sm font-medium">Inline</span>
                </label>
              </div>
            </section>
          </div>
        </div>

        {/* Right side - Preview or Code Snippet (shown when container too small) */}
        {showPreview && (
          <div className="flex w-[400px] shrink-0 flex-col items-center p-8 mr-12 lg:mr-16 border-l border-border/40 bg-foreground/[0.01]">
            <div className="text-center mb-6">
              <span className="text-xs font-medium text-foreground/40 uppercase tracking-wider">
                {isInlineProduct ? 'Checkout Code Snippet' : 'Preview'}
              </span>
            </div>
            {isInlineProduct ? (
              <div className="w-full flex-1 flex flex-col">
                <pre className={cn(
                "flex-1 overflow-auto p-4 rounded-lg text-xs font-mono",
                "bg-foreground/[0.03] border border-border/30",
                "text-foreground/80 whitespace-pre-wrap"
              )}>
                  {generateInlineProductCode()}
                </pre>
                <DesignButton
                  variant="outline"
                  size="sm"
                  type="button"
                  className="mt-4"
                  onClick={() => {
                  runAsynchronouslyWithAlert(async () => {
                    await navigator.clipboard.writeText(generateInlineProductCode());
                    toast({ title: "Code copied to clipboard" });
                  });
                  }}
                >
                  <CopyIcon className="h-4 w-4 mr-2" />
                  Copy Code
                </DesignButton>
              </div>
            ) : (
              <div className="w-[320px]">
                <ProductCardPreview
                  productId={productId || 'product-id'}
                  product={previewProduct}
                  existingItems={existingItems}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Dialogs */}
      <CreateProductLineDialog
        open={showProductLineDialog}
        onOpenChange={setShowProductLineDialog}
        onCreate={handleCreateProductLine}
      />

      <IncludedItemDialog
        open={showItemDialog}
        onOpenChange={setShowItemDialog}
        existingItems={existingItems}
        existingIncludedItemIds={Object.keys(includedItems)}
        editingItemId={editingItemId}
        editingItem={editingItemId ? includedItems[editingItemId] : undefined}
        onSave={(itemId, item) => {
          if (editingItemId) {
            editIncludedItem(itemId, item);
          } else {
            addIncludedItem(itemId, item);
          }
        }}
        onCreateNewItem={() => setShowNewItemDialog(true)}
      />

      <ItemDialog
        open={showNewItemDialog}
        onOpenChange={setShowNewItemDialog}
        onSave={async (item) => {
          try {
            const success = await updateConfig({
              adminApp: hexclaveAdminApp,
              configUpdate: { [`payments.items.${item.id}`]: { displayName: item.displayName, customerType: item.customerType } },
              pushable: true,
            });
            if (success) {
              toast({ title: "Item created" });
            } else {
              // User cancelled the confirmation dialog - throw to keep dialog open
              throw new Error("Operation cancelled");
            }
          } catch (error) {
            // Show error toast for actual failures (not cancellations)
            if (error instanceof Error && error.message !== "Operation cancelled") {
              alert("Failed to create item: " + error.message);
            }
            throw error;
          }
        }}
        existingItemIds={Object.keys(paymentsConfig.items)}
        forceCustomerType={customerType}
      />
    </div>
  );
}
