"use client";

import { Link } from "@/components/link";
import { ItemDialog } from "@/components/payments/item-dialog";
import { useRouter } from "@/components/router";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SimpleTooltip,
  toast,
  Typography,
} from "@/components/ui";
import { SubpageHeader } from "@/components/design-components/subpage-header";
import { useUpdateConfig } from "@/components/config-update";
import { cn } from "@/lib/utils";
import { ClockIcon, HardDriveIcon, PackageIcon, PlusIcon, PuzzlePieceIcon, StackIcon, TrashIcon } from "@phosphor-icons/react";
import { CompleteConfig } from "@hexclave/shared/dist/config/schema";
import { typedEntries } from "@hexclave/shared/dist/utils/objects";
import { useState } from "react";
import { useAdminApp, useProjectId } from "../../../../use-admin-app";
import { CreateProductLineDialog } from "../../create-product-line-dialog";
import { IncludedItemDialog } from "../../included-item-dialog";
import { PricingSection } from "../../pricing-section";
import { ProductCardPreview } from "../../product-card-preview";
import {
  createFreePrice,
  isFreePrices,
  type Price,
  type Product,
} from "../../utils";

type IncludedItem = Product['includedItems'][string];

const CUSTOMER_TYPE_COLORS = {
  user: 'bg-blue-500/15 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400 ring-blue-500/30',
  team: 'bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400 ring-emerald-500/30',
  custom: 'bg-amber-500/15 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400 ring-amber-500/30',
} as const;

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

export default function PageClient({ productId }: { productId: string }) {
  const projectId = useProjectId();
  const router = useRouter();
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const paymentsConfig: CompleteConfig['payments'] = config.payments;

  const existingProduct = paymentsConfig.products[productId] as Product | undefined;

  // If product not found, show error
  if (!existingProduct) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-4">
        <PackageIcon className="h-12 w-12 text-muted-foreground/50" />
        <Typography className="text-muted-foreground">Product not found</Typography>
        <Button variant="outline" asChild>
          <Link href={`/projects/${projectId}/app-configuration/payments/products`}>
            Back to Products
          </Link>
        </Button>
      </div>
    );
  }

  return <EditProductForm productId={productId} existingProduct={existingProduct} />;
}

function EditProductForm({ productId, existingProduct }: { productId: string, existingProduct: Product }) {
  const projectId = useProjectId();
  const router = useRouter();
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const paymentsConfig: CompleteConfig['payments'] = config.payments;
  const updateConfig = useUpdateConfig();

  // Customer type is fixed from the existing product (cannot be changed)
  const customerType = existingProduct.customerType;

  // Parse existing product data
  const existingIsAddOn = existingProduct.isAddOnTo !== false;
  const existingIsAddOnTo = existingIsAddOn
    ? Object.keys(existingProduct.isAddOnTo as Record<string, boolean>)
    : [];
  const existingPrices = existingProduct.prices;

  // Form state - initialized from existing product
  const [displayName, setDisplayName] = useState(existingProduct.displayName || '');
  const [productLineId, setProductLineId] = useState(existingProduct.productLineId || '');
  const [isAddOn, setIsAddOn] = useState(existingIsAddOn);
  const [isAddOnTo, setIsAddOnTo] = useState<string[]>(existingIsAddOnTo);
  const [stackable, setStackable] = useState(existingProduct.stackable);
  const [serverOnly, setServerOnly] = useState(existingProduct.serverOnly);
  const [prices, setPrices] = useState<Record<string, Price>>(existingPrices);
  const [includedItems, setIncludedItems] = useState<Product['includedItems']>(existingProduct.includedItems);
  const [freeTrial, setFreeTrial] = useState<Product['freeTrial']>(existingProduct.freeTrial);

  // Dialog states
  const [showProductLineDialog, setShowProductLineDialog] = useState(false);
  const [showItemDialog, setShowItemDialog] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | undefined>();
  const [showNewItemDialog, setShowNewItemDialog] = useState(false);

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);

  // Computed values
  const existingProducts = typedEntries(paymentsConfig.products)
    .filter(([id]) => id !== productId) // Exclude self
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

  // Validate that the selected productLineId matches the current customerType
  const effectiveProductLineId = productLineId && paymentsConfig.productLines[productLineId].customerType === customerType
    ? productLineId
    : "";

  // Build product object for preview
  const previewProduct: Product = {
    displayName: displayName || 'Product',
    customerType,
    productLineId: effectiveProductLineId || undefined,
    isAddOnTo: isAddOn ? Object.fromEntries(isAddOnTo.map(id => [id, true])) : false,
    stackable,
    prices,
    includedItems,
    serverOnly,
    freeTrial,
  };

  const handleCreateProductLine = async (productLine: { id: string, displayName: string }) => {
    const success = await updateConfig({
      adminApp: hexclaveAdminApp,
      configUpdate: {
        [`payments.productLines.${productLine.id}`]: {
          displayName: productLine.displayName || null,
          customerType,
        },
      },
      pushable: true,
    });
    if (success) {
      setProductLineId(productLine.id);
    }
  };

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

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
        toast({ title: "Product updated" });
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

  const canSave = !!(displayName.trim() && Object.keys(prices).length > 0);

  return (
    <div className="flex flex-col h-full">
      <SubpageHeader
        title="Edit Product"
        onBack={handleCancel}
        actions={
          <>
            <Button variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
            <SimpleTooltip
              tooltip={!canSave ? "Fill in required fields and add at least one price" : undefined}
              disabled={canSave}
            >
              <Button
                onClick={handleSave}
                disabled={!canSave || isSaving}
              >
                {isSaving ? "Saving..." : "Save Changes"}
              </Button>
            </SimpleTooltip>
          </>
        }
      />

      {/* Main content - form on left, preview on right */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left side - Configuration form */}
        <div className="flex-1 overflow-y-auto p-6 flex justify-center">
          <div className="w-full max-w-2xl space-y-6">
            {/* Display Name and Product ID - same row */}
            <div className="grid grid-cols-2 gap-4 items-start">
              {/* Display Name */}
              <div className="grid gap-1.5">
                <Label htmlFor="display-name" className="text-sm font-medium">Display Name</Label>
                <Input
                  id="display-name"
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                    if (errors.displayName) {
                      setErrors(prev => {
                        const newErrors = { ...prev };
                        delete newErrors.displayName;
                        return newErrors;
                      });
                    }
                  }}
                  placeholder="e.g., Pro Plan"
                  className={cn(
                    "h-8 rounded-lg text-sm",
                    "bg-foreground/[0.03] border-border/50 dark:border-foreground/[0.1]",
                    "focus:ring-1 focus:ring-cyan-500/30 focus:border-cyan-500/50",
                    "transition-all duration-150 hover:transition-none",
                    errors.displayName && "border-destructive focus:ring-destructive/30"
                  )}
                />
                <span className="text-xs text-foreground/40">Visible to customers during checkout</span>
                {errors.displayName && (
                  <Typography type="label" className="text-destructive text-xs">
                    {errors.displayName}
                  </Typography>
                )}
              </div>

              {/* Product ID - Read Only */}
              <div className="grid gap-1.5">
                <Label htmlFor="product-id" className="text-sm font-medium">Product ID</Label>
                <Input
                  id="product-id"
                  value={productId}
                  disabled
                  className={cn(
                    "h-8 rounded-lg font-mono text-sm",
                    "bg-foreground/[0.06] border-border/50 dark:border-foreground/[0.1]",
                    "text-foreground/60 cursor-not-allowed"
                  )}
                />
                <span className="text-xs text-foreground/40">Product ID cannot be changed</span>
              </div>
            </div>

            {/* Pricing Section */}
            <section className="space-y-3">
              <Typography type="h4" className="font-semibold">Pricing</Typography>
              {Object.keys(existingPrices).length === 0 && Object.keys(prices).length === 0 && (
                <Alert variant="destructive">
                  <AlertTitle>This product has no prices</AlertTitle>
                  <AlertDescription>
                    This product was previously set to &quot;include by default&quot;, which is no longer supported.
                    Add an explicit $0 price below (click &quot;Make free&quot;) to restore customer access, or
                    set a paid price.
                  </AlertDescription>
                </Alert>
              )}
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
                  if (errors.prices) {
                    setErrors(prev => {
                      const newErrors = { ...prev };
                      delete newErrors.prices;
                      return newErrors;
                    });
                  }
                }}
              />
            </section>

            {/* Included Items Section */}
            <section className="space-y-3">
              <Typography type="h4" className="font-semibold">Included Items</Typography>

              {Object.entries(includedItems).length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/50 p-4 text-center">
                  <p className="text-sm text-foreground/50 mb-3">
                    No items included yet
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setEditingItemId(undefined);
                      setShowItemDialog(true);
                    }}
                  >
                    <PlusIcon className="h-4 w-4 mr-2" />
                    Add Item
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {Object.entries(includedItems).map(([itemId, item]) => (
                    <div
                      key={itemId}
                      className={cn(
                        "flex items-center justify-between p-2.5 rounded-lg",
                        "bg-foreground/[0.02] border border-border/30",
                        "hover:bg-foreground/[0.04] transition-colors duration-150 hover:transition-none"
                      )}
                    >
                      <div className="flex-1">
                        <div className="font-medium text-sm">{getItemDisplay(itemId, item, existingItems)}</div>
                        <div className="text-xs text-foreground/30 font-mono">{itemId}</div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingItemId(itemId);
                            setShowItemDialog(true);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeIncludedItem(itemId)}
                        >
                          <TrashIcon className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      setEditingItemId(undefined);
                      setShowItemDialog(true);
                    }}
                  >
                    <PlusIcon className="h-4 w-4 mr-2" />
                    Add Another Item
                  </Button>
                </div>
              )}
            </section>

            {/* Options Section - Two column grid */}
            <section className="space-y-3">
              <Typography type="h4" className="font-semibold">Options</Typography>

              <div className="grid grid-cols-[auto,1fr] gap-x-6">
                {/* Customer Type - Read Only */}
                <span className="text-sm text-foreground/70 py-2 border-b border-border/20">Customer type</span>
                <div className="py-2 flex items-center border-b border-border/20">
                  <span className={cn(
                    "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ring-1",
                    CUSTOMER_TYPE_COLORS[customerType]
                  )}>
                    {customerType}
                  </span>
                  <span className="text-xs text-foreground/40 ml-2">(cannot be changed)</span>
                </div>

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
                {existingProducts.length > 0 && (
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
                      <Input
                        type="number"
                        min={1}
                        value={freeTrial[0]}
                        onChange={(e) => {
                          const val = parseInt(e.target.value) || 1;
                          setFreeTrial([val, freeTrial[1]]);
                        }}
                        className="h-7 w-16 text-sm rounded-md"
                      />
                      <Select
                        value={freeTrial[1]}
                        onValueChange={(value) => setFreeTrial([freeTrial[0], value as 'day' | 'week' | 'month' | 'year'])}
                      >
                        <SelectTrigger className="h-7 w-24 rounded-md text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="day">days</SelectItem>
                          <SelectItem value="week">weeks</SelectItem>
                          <SelectItem value="month">months</SelectItem>
                          <SelectItem value="year">years</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>

                {/* Product Line */}
                <span className="text-sm text-foreground/70 py-2 flex items-center border-b border-border/20">Part of a mutually exclusive group?</span>
                <div className="py-2 flex items-center border-b border-border/20">
                  <Select
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
                  >
                    <SelectTrigger className="h-8 w-full max-w-[200px] rounded-lg">
                      <SelectValue placeholder="No product line" />
                    </SelectTrigger>
                    <SelectContent className="rounded-lg">
                      <SelectItem value="no-product-line" className="rounded-lg">No product line</SelectItem>
                      {Object.entries(paymentsConfig.productLines)
                        .filter(([, productLine]) => productLine.customerType === customerType)
                        .map(([id, productLine]) => (
                          <SelectItem key={id} value={id} className="rounded-lg">
                            {productLine.displayName || id}
                          </SelectItem>
                        ))}
                      <SelectItem value="create-new" className="rounded-lg">
                        <span className="text-primary">+ Create new</span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </section>
          </div>
        </div>

        {/* Right side - Preview */}
        <div className="hidden lg:flex w-[400px] shrink-0 flex-col items-center p-8 border-l border-border/40 bg-foreground/[0.01]">
          <div className="text-center mb-6">
            <span className="text-xs font-medium text-foreground/40 uppercase tracking-wider">
              Preview
            </span>
          </div>
          <div className="w-[320px]">
            <ProductCardPreview
              productId={productId}
              product={previewProduct}
              existingItems={existingItems}
            />
          </div>
        </div>
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
          const success = await updateConfig({
            adminApp: hexclaveAdminApp,
            configUpdate: { [`payments.items.${item.id}`]: { displayName: item.displayName, customerType: item.customerType } },
            pushable: true,
          });
          if (success) {
            toast({ title: "Item created" });
          } else {
            // User cancelled - throw to keep dialog open
            throw new Error("Operation cancelled");
          }
        }}
        existingItemIds={Object.keys(paymentsConfig.items)}
        forceCustomerType={customerType}
      />
    </div>
  );
}
