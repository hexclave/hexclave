"use client";

import { Link } from "@/components/link";
import { ItemDialog } from "@/components/payments/item-dialog";
import { useRouter } from "@/components/router";
import { ActionDialog, Alert, AlertDescription, AlertTitle, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, toast } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useUpdateConfig } from "@/components/config-update";
import { DotsThreeVerticalIcon } from "@phosphor-icons/react";
import { CompleteConfig } from "@hexclave/shared/dist/config/schema";
import { useHover } from "@hexclave/shared/dist/hooks/use-hover";
import { DayInterval } from "@hexclave/shared/dist/utils/dates";
import { prettyPrintWithMagnitudes } from "@hexclave/shared/dist/utils/numbers";
import { typedEntries, typedFromEntries } from "@hexclave/shared/dist/utils/objects";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import React, { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useAdminApp, useProjectId } from "../../use-admin-app";
import { ListSection } from "./list-section";
import { ProductDialog } from "./product-dialog";
import { getPriceCheckoutError } from "./utils";

type Product = CompleteConfig['payments']['products'][keyof CompleteConfig['payments']['products']];
type Item = CompleteConfig['payments']['items'][keyof CompleteConfig['payments']['items']];

// Custom action menu component
type ActionMenuItem = '-' | { item: React.ReactNode, onClick: () => void | Promise<void>, danger?: boolean };

function ActionMenu({ items }: { items: ActionMenuItem[] }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            "h-7 w-7 p-0 rounded-lg",
            "text-muted-foreground hover:text-foreground",
            "hover:bg-foreground/[0.05]",
            "transition-all duration-150 hover:transition-none",
            "opacity-0 group-hover:opacity-100",
            isOpen && "opacity-100 bg-foreground/[0.05]"
          )}
        >
          <DotsThreeVerticalIcon className="h-4 w-4" />
          <span className="sr-only">Open menu</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[150px]">
        {items.map((item, index) => {
          if (item === '-') {
            return <DropdownMenuSeparator key={index} />;
          }

          return (
            <DropdownMenuItem
              key={index}
              onClick={item.onClick}
              className={cn(item.danger && "text-destructive focus:text-destructive")}
            >
              {item.item}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}


type ListItemProps = {
  id: string,
  displayName?: string,
  customerType: string,
  subtitle?: ReactNode,
  onClick?: () => void,
  onMouseEnter?: () => void,
  onMouseLeave?: () => void,
  isEven?: boolean,
  isHighlighted?: boolean,
  itemRef?: React.RefObject<HTMLDivElement | null>,
  actionItems?: ActionMenuItem[],
};

function ListItem({
  id,
  displayName,
  customerType,
  subtitle,
  onClick,
  onMouseEnter,
  onMouseLeave,
  isEven,
  isHighlighted,
  itemRef,
  actionItems
}: ListItemProps) {
  const itemRefBackup = useRef<HTMLDivElement>(null);
  itemRef ??= itemRefBackup;
  const [isMenuHovered, setIsMenuHovered] = useState(false);
  const isHovered = useHover(itemRef);

  return (
    <div
      ref={itemRef}
      className={cn(
        "px-4 py-3.5 cursor-pointer relative rounded-xl mx-3 my-1",
        "flex items-center justify-between gap-3 group",
        "transition-all duration-150 hover:transition-none",
        "bg-background/50 dark:bg-foreground/[0.02]",
        "border border-transparent",
        isHighlighted
          ? "bg-cyan-500/[0.1] dark:bg-cyan-500/[0.08] border-cyan-500/30 shadow-sm"
          : "hover:bg-background dark:hover:bg-foreground/[0.04] hover:border-border/40 dark:hover:border-foreground/[0.08] hover:shadow-sm",
        isHighlighted && isHovered && "bg-cyan-500/[0.15] dark:bg-cyan-500/[0.12]"
      )}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="uppercase font-semibold tracking-wide">{customerType}</span>
          <span className="text-muted-foreground/50">—</span>
          <span className="font-mono truncate">{id}</span>
        </div>
        <div className="font-semibold text-sm mt-1 text-foreground truncate">
          {displayName || id}
        </div>
        {subtitle && (
          <div className="text-xs text-muted-foreground mt-0.5 tabular-nums">
            {subtitle}
          </div>
        )}
      </div>
      {actionItems && (
        <div
          className="shrink-0"
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={() => setIsMenuHovered(true)}
          onMouseLeave={() => setIsMenuHovered(false)}
        >
          <ActionMenu items={actionItems} />
        </div>
      )}
    </div>
  );
}

type GroupedListProps = {
  children: ReactNode,
};

function GroupedList({ children }: GroupedListProps) {
  return <div>{children}</div>;
}

type ListGroupProps = {
  title?: string,
  children: ReactNode,
};

function ListGroup({ title, children }: ListGroupProps) {
  return (
    <div className="mb-2">
      {title && (
        <div className="sticky top-0 z-[1] px-4 py-2.5 bg-gray-100/90 dark:bg-foreground/[0.04] backdrop-blur-sm border-b border-border/30 dark:border-foreground/[0.06]">
          <h3 className="text-xs font-bold uppercase tracking-wider text-foreground/70">
            {title}
          </h3>
        </div>
      )}
      <div className="py-2">
        {children}
      </div>
    </div>
  );
}

// Connection line component
type ConnectionLineProps = {
  fromRef: React.RefObject<HTMLDivElement | null>,
  toRef: React.RefObject<HTMLDivElement | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  quantity?: number,
};

function ConnectionLine({ fromRef, toRef, containerRef, quantity }: ConnectionLineProps) {
  const [path, setPath] = useState<string>("");
  const [midpoint, setMidpoint] = useState<{ x: number, y: number } | null>(null);

  useEffect(() => {
    if (!fromRef.current || !toRef.current || !containerRef.current) return;

    const updatePath = () => {
      const container = containerRef.current;
      const from = fromRef.current;
      const to = toRef.current;

      if (!container || !from || !to) return;

      const containerRect = container.getBoundingClientRect();
      const fromRect = from.getBoundingClientRect();
      const toRect = to.getBoundingClientRect();

      // Calculate positions relative to container
      const fromY = fromRect.top - containerRect.top + fromRect.height / 2;
      const fromX = fromRect.right - containerRect.left - 6;
      const toY = toRect.top - containerRect.top + toRect.height / 2;
      const toX = toRect.left - containerRect.left + 6;

      // Create a curved path
      const midX = (fromX + toX) / 2;
      const midY = (fromY + toY) / 2;
      const pathStr = `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`;

      setPath(pathStr);
      setMidpoint({ x: midX, y: midY });
    };

    updatePath();
    window.addEventListener('resize', updatePath);
    window.addEventListener('scroll', updatePath, true);

    return () => {
      window.removeEventListener('resize', updatePath);
      window.removeEventListener('scroll', updatePath, true);
    };
  }, [fromRef, toRef, containerRef]);

  if (!path) return null;

  return (
    <svg
      className="absolute inset-0 pointer-events-none z-20"
      style={{ width: '100%', height: '100%' }}
    >
      <defs>
        <linearGradient id="lineGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="hsl(200, 91%, 70%)" stopOpacity="0.4" />
          <stop offset="100%" stopColor="hsl(200, 91%, 70%)" stopOpacity="0.4" />
        </linearGradient>
      </defs>
      <g>
        <path
          d={path}
          fill="none"
          stroke="url(#lineGradient)"
          strokeWidth="2"
          strokeDasharray="6 4"
          strokeLinecap="round"
        />
        {quantity && quantity > 0 && midpoint && (
          <>
            <circle
              cx={midpoint.x}
              cy={midpoint.y}
              r="14"
              className="fill-white dark:fill-background"
              stroke="hsl(200, 91%, 70%)"
              strokeWidth="1"
              strokeOpacity="0.3"
            />
            <text
              x={midpoint.x}
              y={midpoint.y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="text-[11px] font-semibold"
              fill="hsl(200, 91%, 70%)"
            >
              ×{prettyPrintWithMagnitudes(quantity)}
            </text>
          </>
        )}
      </g>
    </svg>
  );
}

// Price formatting utilities
function formatInterval(interval: DayInterval): string {
  const [count, unit] = interval;
  const unitShort = unit === 'month' ? 'mo' : unit === 'year' ? 'yr' : unit === 'week' ? 'wk' : unit;
  return count > 1 ? `${count}${unitShort}` : unitShort;
}

function formatPrice(price: (Product['prices'] & object)[string]): string | null {
  if (typeof price === 'string') return null;

  const amounts = [];
  const interval = price.interval;

  // Check for USD amounts
  if (price.USD) {
    const amount = `$${(+price.USD).toFixed(2).replace(/\.00$/, '')}`;
    if (interval) {
      amounts.push(`${amount}/${formatInterval(interval)}`);
    } else {
      amounts.push(amount);
    }
  }

  return amounts.join(', ') || null;
}

function formatProductPrices(prices: Product['prices']): string {
  const formattedPrices = Object.values(prices)
    .map(formatPrice)
    .filter(Boolean)
    .slice(0, 4); // Show max 4 prices

  return formattedPrices.join(', ');
}

// ProductsList component with props
type ProductsListProps = {
  groupedProducts: Map<string | undefined, Array<{ id: string, product: any }>>,
  paymentsGroups: any,
  hoveredItemId: string | null,
  getConnectedProducts: (itemId: string) => string[],
  productRefs?: Record<string, React.RefObject<HTMLDivElement | null>>,
  onProductMouseEnter: (productId: string) => void,
  onProductMouseLeave: () => void,
  onProductAdd?: () => void,
  setEditingProduct: (product: any) => void,
  setShowProductDialog: (show: boolean) => void,
};

function ProductsList({
  groupedProducts,
  paymentsGroups,
  hoveredItemId,
  getConnectedProducts,
  productRefs,
  onProductMouseEnter,
  onProductMouseLeave,
  onProductAdd,
  setEditingProduct,
  setShowProductDialog,
}: ProductsListProps) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const updateConfig = useUpdateConfig();
  const projectId = useProjectId();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [productToDelete, setProductToDelete] = useState<{ id: string, displayName: string } | null>(null);
  let globalIndex = 0;

  // Filter products based on search query
  const filteredGroupedProducts = useMemo(() => {
    if (!searchQuery) return groupedProducts;

    const filtered = new Map<string | undefined, Array<{ id: string, product: any }>>();

    groupedProducts.forEach((products, productLineId) => {
      const filteredProducts = products.filter(({ id, product }) => {
        const query = searchQuery.toLowerCase();
        return (
          id.toLowerCase().includes(query) ||
          product.displayName?.toLowerCase().includes(query) ||
          product.customerType?.toLowerCase().includes(query)
        );
      });

      if (filteredProducts.length > 0) {
        filtered.set(productLineId, filteredProducts);
      }
    });

    return filtered;
  }, [groupedProducts, searchQuery]);

  return (
    <ListSection
      title={<>
        Products
      </>}
      titleTooltip="Products are the products, plans, or pricing tiers you sell to your customers. They are the columns in a pricing table."
      onAddClick={() => onProductAdd?.()}
      hasTitleBorder={false}
      searchValue={searchQuery}
      onSearchChange={setSearchQuery}
      searchPlaceholder="Search products..."
    >
      <GroupedList>
        {[...filteredGroupedProducts.entries()].map(([productLineId, products]) => {
          const group = productLineId ? paymentsGroups[productLineId] : undefined;
          const groupName = group?.displayName;

          return (
            <ListGroup key={productLineId || 'ungrouped'} title={productLineId ? (groupName || productLineId) : "Other"}>
              {products.map(({ id, product }) => {
                const isEven = globalIndex % 2 === 0;
                globalIndex++;
                const connectedItems = hoveredItemId ? getConnectedProducts(hoveredItemId) : [];
                const isHighlighted = hoveredItemId ? connectedItems.includes(id) : false;

                return (
                  <ListItem
                    key={id}
                    id={id}
                    displayName={product.displayName}
                    customerType={product.customerType}
                    subtitle={formatProductPrices(product.prices)}
                    isEven={isEven}
                    isHighlighted={isHighlighted}
                    itemRef={productRefs?.[id]}
                    onClick={() => router.push(`/projects/${projectId}/app-configuration/payments/products/${id}`)}
                    onMouseEnter={() => onProductMouseEnter(id)}
                    onMouseLeave={onProductMouseLeave}
                    actionItems={[
                      {
                        item: "Edit",
                        onClick: () => {
                          setEditingProduct(product);
                          setShowProductDialog(true);
                        },
                      },
                      '-',
                      {
                        item: "Delete",
                        onClick: () => {
                          setProductToDelete({ id, displayName: product.displayName });
                          setDeleteDialogOpen(true);
                        },
                        danger: true,
                      },
                    ]}
                  />
                );
              })}
            </ListGroup>
          );
        })}
      </GroupedList>

      <ActionDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete Product"
        danger
        cancelButton
        okButton={{
          label: "Delete",
          onClick: async () => {
            if (!productToDelete) return;
            const config = project.useConfig();
            const updatedProducts = typedFromEntries(
              typedEntries(config.payments.products)
                .filter(([productId]) => productId !== productToDelete.id)
            );
            await updateConfig({ adminApp: hexclaveAdminApp, configUpdate: { "payments.products": updatedProducts }, pushable: true });
            toast({ title: "Product deleted" });
            setProductToDelete(null);
          }
        }}
      >
        Are you sure you want to delete the product &quot;{productToDelete?.displayName}&quot;?
      </ActionDialog>
    </ListSection>
  );
}

// ItemsList component with props
type ItemsListProps = {
  items: CompleteConfig['payments']['items'],
  hoveredProductId: string | null,
  getConnectedItems: (productId: string) => string[],
  itemRefs?: Record<string, React.RefObject<HTMLDivElement | null>>,
  onItemMouseEnter: (itemId: string) => void,
  onItemMouseLeave: () => void,
  onItemAdd?: () => void,
  setEditingItem: (item: any) => void,
  setShowItemDialog: (show: boolean) => void,
};

function ItemsList({
  items,
  hoveredProductId,
  getConnectedItems,
  itemRefs,
  onItemMouseEnter,
  onItemMouseLeave,
  onItemAdd,
  setEditingItem,
  setShowItemDialog,
}: ItemsListProps) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const updateConfig = useUpdateConfig();
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<{ id: string, displayName: string } | null>(null);

  // Sort items by customer type, then by ID
  const sortedItems = useMemo(() => {
    const customerTypePriority = { user: 1, team: 2, custom: 3 };
    return Object.entries(items).sort(([aId, aItem]: [string, any], [bId, bItem]: [string, any]) => {
      const priorityA = customerTypePriority[aItem.customerType as keyof typeof customerTypePriority] || 4;
      const priorityB = customerTypePriority[bItem.customerType as keyof typeof customerTypePriority] || 4;
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }
      // If same customer type, sort by ID
      return stringCompare(aId, bId);
    });
  }, [items]);

  // Filter items based on search query
  const filteredItems = useMemo(() => {
    if (!searchQuery) return sortedItems;

    const query = searchQuery.toLowerCase();
    return sortedItems.filter(([id, item]) => {
      return (
        id.toLowerCase().includes(query) ||
        (item.displayName && item.displayName.toLowerCase().includes(query)) ||
        item.customerType.toLowerCase().includes(query)
      );
    });
  }, [sortedItems, searchQuery]);

  return (
    <ListSection
      title="Items"
      titleTooltip="Items are the features or services that your customers will receive from you. They are the rows in a pricing table."
      onAddClick={() => onItemAdd?.()}
      searchValue={searchQuery}
      onSearchChange={setSearchQuery}
      searchPlaceholder="Search items..."
    >
      <GroupedList>
        {filteredItems.map(([id, item]: [string, any], index) => {
          const connectedProducts = hoveredProductId ? getConnectedItems(hoveredProductId) : [];
          const isHighlighted = hoveredProductId ? connectedProducts.includes(id) : false;

          return (
            <ListItem
              key={id}
              id={id}
              displayName={item.displayName}
              customerType={item.customerType}
              isEven={index % 2 === 0}
              isHighlighted={isHighlighted}
              itemRef={itemRefs?.[id]}
              onMouseEnter={() => onItemMouseEnter(id)}
              onMouseLeave={onItemMouseLeave}
              actionItems={[
                {
                  item: "Edit",
                  onClick: () => {
                    setEditingItem({
                      id,
                      displayName: item.displayName,
                      customerType: item.customerType
                    });
                    setShowItemDialog(true);
                  },
                },
                '-',
                {
                  item: "Delete",
                  onClick: () => {
                    setItemToDelete({ id, displayName: item.displayName });
                    setDeleteDialogOpen(true);
                  },
                  danger: true,
                },
              ]}
            />
          );
        })}
      </GroupedList>

      <ActionDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete Item"
        danger
        cancelButton
        okButton={{
          label: "Delete",
          onClick: async () => {
            if (!itemToDelete) return;
            await updateConfig({ adminApp: hexclaveAdminApp, configUpdate: { [`payments.items.${itemToDelete.id}`]: null }, pushable: true });
            toast({ title: "Item deleted" });
            setItemToDelete(null);
          }
        }}
      >
        Are you sure you want to delete the item &quot;{itemToDelete?.displayName}&quot;?
      </ActionDialog>
    </ListSection>
  );
}

// Surfaces products with empty `prices` (legacy `include-by-default` rewritten by `migrateConfigOverride`).
function ProductsWithoutPricesAlert({
  products,
  projectId,
}: {
  products: CompleteConfig['payments']['products'],
  projectId: string,
}) {
  const productsWithoutPrices = useMemo(() => {
    return typedEntries(products)
      .filter(([, product]) => Object.keys(product.prices).length === 0)
      .map(([id, product]) => ({ id, displayName: product.displayName || id }))
      .sort((a, b) => stringCompare(a.id, b.id));
  }, [products]);

  if (productsWithoutPrices.length === 0) return null;

  const previewLimit = 5;
  const preview = productsWithoutPrices.slice(0, previewLimit);
  const overflow = productsWithoutPrices.length - preview.length;

  return (
    <Alert variant="destructive" className="mb-4">
      <AlertTitle>
        {productsWithoutPrices.length === 1
          ? "1 product has no prices configured"
          : `${productsWithoutPrices.length} products have no prices configured`}
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <div>
          These products were previously set to &quot;include by default&quot;, which is no longer supported.
          They are no longer purchasable and won&apos;t appear in upgrade flows. Existing owners keep their
          included items, but no new owners will be granted them. Open each one and either set a price or
          click &quot;Make free&quot; to restore customer access.
        </div>
        <ul className="list-disc pl-5 space-y-0.5">
          {preview.map(({ id, displayName }) => (
            <li key={id}>
              <Link
                href={urlString`/projects/${projectId}/app-configuration/payments/products/${id}/edit`}
                className="underline hover:no-underline"
              >
                {displayName}
              </Link>
              {displayName !== id && <span className="ml-1 font-mono text-xs opacity-70">({id})</span>}
            </li>
          ))}
          {overflow > 0 && (
            <li className="opacity-80">
              …and {overflow} more
            </li>
          )}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

// Surfaces products with prices that Stripe will reject at checkout time
// (e.g. $0 one-time, sub-$0.50 one-time). These typically slipped past pre-
// validation history and only fail when a customer actually tries to buy.
function ProductsWithInvalidPricesAlert({
  products,
  projectId,
}: {
  products: CompleteConfig['payments']['products'],
  projectId: string,
}) {
  const productsWithInvalidPrices = useMemo(() => {
    return typedEntries(products)
      .flatMap(([id, product]) => {
        const issues = typedEntries(product.prices)
          .map(([priceId, price]) => ({ priceId, error: getPriceCheckoutError(price) }))
          .filter((x): x is { priceId: string, error: string } => x.error !== null);
        if (issues.length === 0) return [];
        return [{ id, displayName: product.displayName || id, issues }];
      })
      .sort((a, b) => stringCompare(a.id, b.id));
  }, [products]);

  if (productsWithInvalidPrices.length === 0) return null;

  const previewLimit = 5;
  const preview = productsWithInvalidPrices.slice(0, previewLimit);
  const overflow = productsWithInvalidPrices.length - preview.length;

  return (
    <Alert variant="destructive" className="mb-4">
      <AlertTitle>
        {productsWithInvalidPrices.length === 1
          ? "1 product has a price customers can't check out"
          : `${productsWithInvalidPrices.length} products have prices customers can't check out`}
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <div>
          Stripe rejects these prices at checkout (e.g. $0 one-time, or one-time
          charges below $0.50). Open each product and either change the amount
          or switch to a recurring interval.
        </div>
        <ul className="list-disc pl-5 space-y-0.5">
          {preview.map(({ id, displayName, issues }) => (
            <li key={id}>
              <Link
                href={`/projects/${projectId}/app-configuration/payments/products/${id}/edit`}
                className="underline hover:no-underline"
              >
                {displayName}
              </Link>
              {displayName !== id && <span className="ml-1 font-mono text-xs opacity-70">({id})</span>}
              <span className="ml-1 opacity-80">
                — {issues.length === 1 ? `price “${issues[0].priceId}”` : `${issues.length} prices`}
              </span>
            </li>
          ))}
          {overflow > 0 && (
            <li className="opacity-80">
              …and {overflow} more
            </li>
          )}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

export default function PageClient() {
  const projectId = useProjectId();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"products" | "items">("products");
  const [hoveredProductId, setHoveredProductId] = useState<string | null>(null);
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);
  const [showProductDialog, setShowProductDialog] = useState(false);
  const [editingProduct, setEditingProduct] = useState<any>(null);
  const [showItemDialog, setShowItemDialog] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const updateConfig = useUpdateConfig();
  const paymentsConfig = config.payments;

  // Refs for products and items
  const containerRef = useRef<HTMLDivElement>(null);

  // Create refs for all products and items
  const productRefs = useMemo(() => {
    const refs = Object.fromEntries(
      Object.entries(paymentsConfig.products)
        .map(([id]) => [id, React.createRef<HTMLDivElement>()])
    );
    return refs;
  }, [paymentsConfig.products]);

  const itemRefs = useMemo(() => {
    const refs = Object.fromEntries(
      Object.keys(paymentsConfig.items)
        .map(id => [id, React.createRef<HTMLDivElement>()])
    );
    return refs;
  }, [paymentsConfig.items]);

  // Group products by productLineId and sort by customer type priority
  const groupedProducts = useMemo(() => {
    const groups = new Map<string | undefined, Array<{ id: string, product: typeof paymentsConfig.products[keyof typeof paymentsConfig.products] }>>();

    // Group products (filter out null/undefined products that may occur during deletion)
    Object.entries(paymentsConfig.products).forEach(([id, product]: [string, any]) => {
      if (!product) return; // Skip deleted/null products
      const productLineId = product.productLineId;
      if (!groups.has(productLineId)) {
        groups.set(productLineId, []);
      }
      groups.get(productLineId)!.push({ id, product });
    });

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
  }, [paymentsConfig]);

  // Get connected items for an product
  const getConnectedItems = (productId: string) => {
    const product = paymentsConfig.products[productId];
    return Object.keys(product.includedItems);
  };

  // Get item quantity for an product
  const getItemQuantity = (productId: string, itemId: string) => {
    const product = paymentsConfig.products[productId];
    if (!(itemId in product.includedItems)) return 0;
    return product.includedItems[itemId].quantity;
  };

  // Get connected products for an item
  const getConnectedProducts = (itemId: string) => {
    return Object.entries(paymentsConfig.products)
      .filter(([_, product]: [string, any]) => itemId in product.includedItems)
      .map(([id]) => id);
  };

  // Check if there are no products and no items
  // Handler for create product button
  const handleCreateProduct = () => {
    router.push(`/projects/${projectId}/app-configuration/payments/products/new`);
  };

  // Handler for create item button
  const handleCreateItem = () => {
    setShowItemDialog(true);
  };

  // Handler for saving product
  const handleSaveProduct = async (productId: string, product: Product) => {
    await updateConfig({ adminApp: hexclaveAdminApp, configUpdate: { [`payments.products.${productId}`]: product }, pushable: true });
    setShowProductDialog(false);
    toast({ title: editingProduct ? "Product updated" : "Product created" });
  };

  // Handler for saving item
  const handleSaveItem = async (item: { id: string, displayName: string, customerType: 'user' | 'team' | 'custom' }) => {
    await updateConfig({ adminApp: hexclaveAdminApp, configUpdate: { [`payments.items.${item.id}`]: { displayName: item.displayName, customerType: item.customerType } }, pushable: true });
    setShowItemDialog(false);
    setEditingItem(null);
    toast({ title: editingItem ? "Item updated" : "Item created" });
  };

  // Prepare data for product dialog - update when items change
  const existingProductsList = Object.entries(paymentsConfig.products).map(([id, product]: [string, any]) => ({
    id,
    displayName: product.displayName,
    productLineId: product.productLineId,
    customerType: product.customerType
  }));

  const existingItemsList = Object.entries(paymentsConfig.items).map(([id, item]: [string, any]) => ({
    id,
    displayName: item.displayName,
    customerType: item.customerType
  }));

  const innerContent = (
    <>
      {/* Mobile tabs */}
      <div className="lg:hidden mb-4">
        <div className="inline-flex items-center gap-1 rounded-xl bg-foreground/[0.04] p-1 backdrop-blur-sm">
          <button
            onClick={() => setActiveTab("products")}
            className={cn(
              "px-4 py-2 text-sm font-medium rounded-lg transition-all duration-150 hover:transition-none",
              activeTab === "products"
                ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/[0.06]"
                : "text-muted-foreground hover:text-foreground hover:bg-background/50"
            )}
          >
            Products
          </button>
          <button
            onClick={() => setActiveTab("items")}
            className={cn(
              "px-4 py-2 text-sm font-medium rounded-lg transition-all duration-150 hover:transition-none",
              activeTab === "items"
                ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/[0.06]"
                : "text-muted-foreground hover:text-foreground hover:bg-background/50"
            )}
          >
            Items
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex gap-6 flex-1 min-h-0 overflow-auto">
        {/* Desktop two-column layout */}
        <div
          ref={containerRef}
          className={cn(
            "hidden lg:flex w-full relative rounded-2xl overflow-hidden",
            "bg-gray-100/80 dark:bg-foreground/[0.03]",
            "border border-border/40 dark:border-foreground/[0.08]",
            "shadow-sm backdrop-blur-xl"
          )}
        >
          <div className="flex-1 min-w-0">
            <ProductsList
              groupedProducts={groupedProducts}
              paymentsGroups={paymentsConfig.productLines}
              hoveredItemId={hoveredItemId}
              getConnectedProducts={getConnectedProducts}
              productRefs={productRefs}
              onProductMouseEnter={setHoveredProductId}
              onProductMouseLeave={() => setHoveredProductId(null)}
              onProductAdd={handleCreateProduct}
              setEditingProduct={setEditingProduct}
              setShowProductDialog={setShowProductDialog}
            />
          </div>
          <div className="w-px bg-border/60 dark:bg-foreground/[0.1]" />
          <div className="flex-1 min-w-0">
            <ItemsList
              items={paymentsConfig.items}
              hoveredProductId={hoveredProductId}
              getConnectedItems={getConnectedItems}
              itemRefs={itemRefs}
              onItemMouseEnter={setHoveredItemId}
              onItemMouseLeave={() => setHoveredItemId(null)}
              onItemAdd={handleCreateItem}
              setEditingItem={setEditingItem}
              setShowItemDialog={setShowItemDialog}
            />
          </div>

          {/* Connection lines */}
          {
            hoveredProductId && getConnectedItems(hoveredProductId).map(itemId => (
              <ConnectionLine
                key={`${hoveredProductId}-${itemId}`}
                fromRef={productRefs[hoveredProductId]}
                toRef={itemRefs[itemId]}
                containerRef={containerRef}
                quantity={getItemQuantity(hoveredProductId, itemId)}
              />
            ))
          }

          {
            hoveredItemId && getConnectedProducts(hoveredItemId).map(productId => (
              <ConnectionLine
                key={`${productId}-${hoveredItemId}`}
                fromRef={productRefs[productId]}
                toRef={itemRefs[hoveredItemId]}
                containerRef={containerRef}
                quantity={getItemQuantity(productId, hoveredItemId)}
              />
            ))
          }
        </div>

        {/* Mobile single column with tabs */}
        <div className={cn(
          "lg:hidden w-full rounded-2xl overflow-hidden",
          "bg-gray-100/80 dark:bg-foreground/[0.03]",
          "border border-border/40 dark:border-foreground/[0.08]",
          "shadow-sm backdrop-blur-xl"
        )}>
          {activeTab === "products" ? (
            <ProductsList
              groupedProducts={groupedProducts}
              paymentsGroups={paymentsConfig.productLines}
              hoveredItemId={hoveredItemId}
              getConnectedProducts={getConnectedProducts}
              onProductMouseEnter={setHoveredProductId}
              onProductMouseLeave={() => setHoveredProductId(null)}
              onProductAdd={handleCreateProduct}
              setEditingProduct={setEditingProduct}
              setShowProductDialog={setShowProductDialog}
            />
          ) : (
            <ItemsList
              items={paymentsConfig.items}
              hoveredProductId={hoveredProductId}
              getConnectedItems={getConnectedItems}
              onItemMouseEnter={setHoveredItemId}
              onItemMouseLeave={() => setHoveredItemId(null)}
              onItemAdd={handleCreateItem}
              setEditingItem={setEditingItem}
              setShowItemDialog={setShowItemDialog}
            />
          )}
        </div>
      </div>
    </>
  );

  return (
    <>
      <ProductsWithoutPricesAlert products={paymentsConfig.products} projectId={projectId} />
      <ProductsWithInvalidPricesAlert products={paymentsConfig.products} projectId={projectId} />
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
        editingProduct={editingProduct}
        existingProducts={existingProductsList}
        existingProductLines={paymentsConfig.productLines}
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
          }
        }}
        onSave={async (item) => await handleSaveItem(item)}
        editingItem={editingItem}
        existingItemIds={Object.keys(paymentsConfig.items)}
      />
    </>
  );
}
