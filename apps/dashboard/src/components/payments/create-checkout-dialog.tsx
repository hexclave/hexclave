"use client";

import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import { StyledLink } from "@/components/link";
import {
  DesignAlert,
  DesignButton,
  DesignDialog,
  DesignDialogClose,
  DesignSelectorDropdown,
} from "@/components/design-components";
import {
  CustomerSelector,
  CustomerTypeSelect,
  customerToMutationOptions,
  type CustomerType,
  type SelectedCustomer,
} from "@/components/payments/customer-selector";
import { InlineCode, Label, toast } from "@/components/ui";
import { LinkIcon, ShoppingCartIcon } from "@phosphor-icons/react";
import { KnownErrors } from "@hexclave/shared";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { Result } from "@hexclave/shared/dist/utils/results";
import { useEffect, useMemo, useState } from "react";

type Props = {
  open: boolean,
  onOpenChange: (open: boolean) => void,
  /**
   * Pre-selected customer. When provided, the dialog skips the customer
   * selector and creates a checkout for this exact customer (used from the
   * user/team tables, detail pages, and the customers table rows).
   */
  customer?: SelectedCustomer,
  /**
   * Restricts the dialog to a single customer type (e.g. opened from a
   * product page where the product already has a fixed customer type). Hides
   * the type switcher.
   */
  customerType?: CustomerType,
  /** Pre-selects a product in the product dropdown. */
  productId?: string,
  /**
   * When true the product is fixed and the dropdown is hidden (used from the
   * product page / product-lines card where the product is the entry point).
   */
  lockProduct?: boolean,
};

export function CreateCheckoutDialog(props: Props) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const products = config.payments.products;

  const hasFixedCustomer = props.customer != null;

  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Selector-mode state (only relevant when no fixed customer is supplied).
  const [typeState, setTypeState] = useState<CustomerType>(props.customer?.type ?? props.customerType ?? "user");
  const [selectedCustomer, setSelectedCustomer] = useState<SelectedCustomer | null>(props.customer ?? null);
  const [productId, setProductId] = useState(props.productId ?? "");

  const activeCustomer = props.customer ?? selectedCustomer;
  const activeType: CustomerType = props.customer?.type ?? props.customerType ?? typeState;
  const lockType = props.customerType != null || hasFixedCustomer;

  // Reset the dialog whenever it's (re)opened so stale selections don't leak
  // across invocations.
  useEffect(() => {
    if (props.open) {
      setTypeState(props.customer?.type ?? props.customerType ?? "user");
      setSelectedCustomer(props.customer ?? null);
      setProductId(props.productId ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const productOptions = useMemo(() => {
    return Object.entries(products)
      .filter(([, product]) => product.customerType === activeType)
      .map(([id, product]) => ({
        value: id,
        label: product.displayName ? `${product.displayName} (${id})` : id,
      }));
  }, [products, activeType]);

  const fixedProduct = props.lockProduct && props.productId ? products[props.productId] : undefined;
  const fixedProductLabel = props.productId
    ? (fixedProduct?.displayName ? `${fixedProduct.displayName} (${props.productId})` : props.productId)
    : null;

  const createProductHref = urlString`/projects/${hexclaveAdminApp.projectId}/app-configuration/payments/products/new?customerType=${activeType}`;

  const createCheckoutUrl = async () => {
    if (!activeCustomer) {
      toast({ title: "Please select a customer", variant: "destructive" });
      return;
    }
    const effectiveProductId = props.lockProduct && props.productId ? props.productId : productId;
    if (!effectiveProductId) {
      toast({ title: "Please select a product", variant: "destructive" });
      return;
    }

    setIsCreating(true);
    try {
      const result = await Result.fromPromise(hexclaveAdminApp.createCheckoutUrl({
        ...customerToMutationOptions(activeCustomer),
        productId: effectiveProductId,
      }));
      if (result.status === "ok") {
        setCheckoutUrl(result.data);
        props.onOpenChange(false);
        return;
      }
      if (result.error instanceof KnownErrors.ProductDoesNotExist) {
        toast({ title: "Product with given productId does not exist", variant: "destructive" });
      } else if (result.error instanceof KnownErrors.ProductCustomerTypeDoesNotMatch) {
        toast({ title: "Customer type does not match expected type for this product", variant: "destructive" });
      } else if (result.error instanceof KnownErrors.CustomerDoesNotExist) {
        toast({ title: "Customer with given customerId does not exist", variant: "destructive" });
      } else if (result.error instanceof KnownErrors.ProductAlreadyGranted) {
        toast({ title: "This customer already owns the selected product", variant: "destructive" });
      } else {
        toast({ title: "An unknown error occurred", variant: "destructive" });
      }
    } finally {
      setIsCreating(false);
    }
  };

  const noProducts = !fixedProduct && productOptions.length === 0;
  const createDisabled = isCreating || !activeCustomer || (props.lockProduct ? !props.productId : noProducts);

  return (
    <>
      <DesignDialog
        open={props.open}
        onOpenChange={props.onOpenChange}
        size="md"
        icon={ShoppingCartIcon}
        title="Create Checkout URL"
        footer={(
          <>
            <DesignDialogClose asChild>
              <DesignButton variant="secondary" size="sm" type="button" disabled={isCreating}>
                Cancel
              </DesignButton>
            </DesignDialogClose>
            <DesignButton
              size="sm"
              type="button"
              disabled={createDisabled}
              loading={isCreating}
              onClick={() => runAsynchronouslyWithAlert(createCheckoutUrl())}
            >
              Create
            </DesignButton>
          </>
        )}
      >
        <div className="grid gap-4">
          {/* Customer selector (only when no fixed customer was supplied). */}
          {!hasFixedCustomer && (
            <div className="grid gap-2">
              <Label className="text-sm font-medium">Customer</Label>
              <div className="flex flex-col sm:flex-row gap-2">
                {!lockType && (
                  <CustomerTypeSelect
                    value={typeState}
                    onValueChange={(value) => {
                      setTypeState(value);
                      setSelectedCustomer(null);
                      setProductId("");
                    }}
                    className="w-full sm:w-40"
                  />
                )}
                <CustomerSelector
                  customerType={activeType}
                  selectedCustomer={selectedCustomer}
                  onSelect={setSelectedCustomer}
                />
              </div>
            </div>
          )}

          {/* Product picker / fixed product. */}
          {props.lockProduct && fixedProductLabel ? (
            <div className="grid gap-2">
              <Label className="text-sm font-medium">Product</Label>
              <InlineCode className="block overflow-x-auto whitespace-nowrap">{fixedProductLabel}</InlineCode>
            </div>
          ) : noProducts ? (
            <DesignAlert
              variant="warning"
              title="No products available"
              description={(
                <>
                  No {activeType} products are configured for this project.{" "}
                  <StyledLink href={createProductHref}>Create one here</StyledLink>.
                </>
              )}
            />
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="checkout-product" className="text-sm font-medium">
                Product
              </Label>
              <DesignSelectorDropdown
                value={productId}
                onValueChange={setProductId}
                options={productOptions}
                placeholder="Select a product"
                size="md"
                triggerId="checkout-product"
              />
            </div>
          )}
        </div>
      </DesignDialog>

      <DesignDialog
        open={checkoutUrl !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCheckoutUrl(null);
          }
        }}
        size="md"
        icon={LinkIcon}
        title="Checkout URL"
        description="This is a temporary URL. It will expire in 24 hours."
        footer={(
          <DesignDialogClose asChild>
            <DesignButton variant="secondary" size="sm" type="button">
              Close
            </DesignButton>
          </DesignDialogClose>
        )}
      >
        <InlineCode className="block overflow-x-auto whitespace-nowrap">{checkoutUrl}</InlineCode>
      </DesignDialog>
    </>
  );
}
