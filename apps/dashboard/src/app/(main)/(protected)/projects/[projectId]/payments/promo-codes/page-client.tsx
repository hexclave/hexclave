"use client";

import {
  DesignBadge,
  DesignButton,
  DesignDialog,
  DesignDialogClose,
  DesignInput,
  DesignPillToggle,
  DesignSelectorDropdown,
} from "@/components/design-components";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { MagnifyingGlassIcon, PlusIcon, TicketIcon } from "@phosphor-icons/react";
import { CheckIcon } from "@radix-ui/react-icons";
import { useId, useState, type ReactNode } from "react";
import { PageLayout } from "../../page-layout";

type DiscountKind = "percent" | "fixed";
type ProductScope = "all" | "specific";
type RedemptionLimitMode = "total" | "per_period";
type SubscriptionApplicability = "first_payment" | "between_dates" | "every_renewal";
type ValidDatesMode = "always" | "between_dates" | "recurring";

const REDEMPTION_LIMIT_OPTIONS = [
  { id: "total", label: "Total" },
  { id: "per_period", label: "Per period" },
] as const;

const SUBSCRIPTION_APPLICABILITY_OPTIONS = [
  { id: "first_payment", label: "First payment only" },
  { id: "between_dates", label: "Between these dates" },
  { id: "every_renewal", label: "On every renewal" },
] as const;

const VALID_DATES_OPTIONS = [
  { id: "always", label: "Always" },
  { id: "between_dates", label: "Between these dates" },
  { id: "recurring", label: "Recurring schedule" },
] as const;

const DISCOUNT_KIND_OPTIONS = [
  { id: "percent", label: "% off" },
  { id: "fixed", label: "$ off" },
] as const;

const PRODUCT_SCOPE_OPTIONS = [
  { id: "all", label: "All products" },
  { id: "specific", label: "Specific products" },
] as const;

const PRODUCT_OPTIONS = [
  { value: "pro-plan", label: "Pro Plan" },
  { value: "seats", label: "Seats" },
  { value: "team", label: "Team" },
  { value: "credits", label: "Credits" },
  { value: "starter", label: "Starter" },
  { value: "enterprise", label: "Enterprise" },
];

const PERIOD_OPTIONS = [
  { value: "month", label: "Per month" },
  { value: "year", label: "Per year" },
];

const RECURRING_OPTIONS = [
  { value: "yearly", label: "Yearly" },
  { value: "monthly", label: "Monthly" },
];

function parseDiscountKind(id: string): DiscountKind {
  if (id === "percent" || id === "fixed") return id;
  throwErr(`Unknown discount kind: ${id}`);
}

function parseProductScope(id: string): ProductScope {
  if (id === "all" || id === "specific") return id;
  throwErr(`Unknown product scope: ${id}`);
}

function parseRedemptionLimitMode(id: string): RedemptionLimitMode {
  if (id === "total" || id === "per_period") return id;
  throwErr(`Unknown redemption limit mode: ${id}`);
}

function parseSubscriptionApplicability(id: string): SubscriptionApplicability {
  if (id === "first_payment" || id === "between_dates" || id === "every_renewal") return id;
  throwErr(`Unknown subscription applicability: ${id}`);
}

function parseValidDatesMode(id: string): ValidDatesMode {
  if (id === "always" || id === "between_dates" || id === "recurring") return id;
  throwErr(`Unknown valid dates mode: ${id}`);
}

export default function PageClient() {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <PageLayout containedHeight>
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center">
        <div className="relative w-full h-64 md:h-80 lg:h-96">
          <PromoCodesIllustration />
        </div>

        <div className="w-full flex flex-col items-center px-4 pt-4 md:pt-6">
          <p className="text-center max-w-xl text-muted-foreground text-sm md:text-base">
            Promo codes are codes your users can apply at checkout to discount their purchases. Make them seasonal or valid only for a short period.
          </p>
          <DesignButton
            className="mt-5 mb-4 md:mb-6 gap-1.5"
            onClick={() => setCreateOpen(true)}
          >
            <PlusIcon className="h-4 w-4" weight="bold" />
            Create a Promo Code
          </DesignButton>
        </div>
      </div>

      <CreatePromoCodeDialog open={createOpen} onOpenChange={setCreateOpen} />
    </PageLayout>
  );
}

function CreatePromoCodeDialog(props: {
  open: boolean,
  onOpenChange: (open: boolean) => void,
}) {
  const ids = {
    codename: useId(),
    discount: useId(),
    redemptions: useId(),
    validFrom: useId(),
    validUntil: useId(),
    subFrom: useId(),
    subUntil: useId(),
  };

  const [codename, setCodename] = useState("");
  const [discount, setDiscount] = useState("");
  const [discountKind, setDiscountKind] = useState<DiscountKind>("percent");
  const [productScope, setProductScope] = useState<ProductScope>("all");
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(() => new Set());
  const [maxRedemptions, setMaxRedemptions] = useState("");
  const [isUnlimited, setIsUnlimited] = useState(false);
  const [redemptionLimitMode, setRedemptionLimitMode] = useState<RedemptionLimitMode>("total");
  const [period, setPeriod] = useState("month");
  const [subscriptionApplicability, setSubscriptionApplicability] = useState<SubscriptionApplicability>("first_payment");
  const [validDatesMode, setValidDatesMode] = useState<ValidDatesMode>("always");
  const [recurringSchedule, setRecurringSchedule] = useState("yearly");
  const [validFrom, setValidFrom] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [subscriptionFrom, setSubscriptionFrom] = useState("");
  const [subscriptionUntil, setSubscriptionUntil] = useState("");

  return (
    <DesignDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      size="xl"
      icon={TicketIcon}
      title="Create a Promo Code"
      hideTopCloseButton
      className="max-h-[min(100dvh-2rem,44rem)]"
      footer={(
        <>
          <DesignDialogClose asChild>
            <DesignButton variant="outline" size="sm">
              Back
            </DesignButton>
          </DesignDialogClose>
          <DesignButton
            size="sm"
            onClick={() => props.onOpenChange(false)}
          >
            Confirm
          </DesignButton>
        </>
      )}
    >
      <div className="flex flex-col gap-5">
        <FormField label="Codename" htmlFor={ids.codename}>
          <DesignInput
            id={ids.codename}
            value={codename}
            onChange={(event) => setCodename(event.target.value)}
            placeholder="SUMMER25"
          />
        </FormField>

        <FormField label="Discount" htmlFor={ids.discount}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="sm:w-40">
              <DesignInput
                id={ids.discount}
                type="number"
                min={0}
                max={discountKind === "percent" ? 100 : undefined}
                inputMode="decimal"
                value={discount}
                onChange={(event) => setDiscount(event.target.value)}
                placeholder={discountKind === "percent" ? "25" : "10"}
                prefixItem={discountKind === "fixed" ? "$" : undefined}
              />
            </div>
            <DesignPillToggle
              size="sm"
              options={[...DISCOUNT_KIND_OPTIONS]}
              selected={discountKind}
              onSelect={(id) => setDiscountKind(parseDiscountKind(id))}
            />
          </div>
        </FormField>

        <FormField label="Applicable Products">
          <div className="flex flex-col gap-3">
            <DesignPillToggle
              size="sm"
              options={[...PRODUCT_SCOPE_OPTIONS]}
              selected={productScope}
              onSelect={(id) => setProductScope(parseProductScope(id))}
            />
            {productScope === "specific" && (
              <ProductSearchMultiSelect
                options={PRODUCT_OPTIONS}
                selectedIds={selectedProductIds}
                onSelectedIdsChange={setSelectedProductIds}
              />
            )}
          </div>
        </FormField>

        <FormField label="Maximum Redemptions" htmlFor={isUnlimited ? undefined : ids.redemptions}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              {isUnlimited ? (
                <DesignBadge label="Unlimited" color="blue" size="md" />
              ) : (
                <>
                  <div className="sm:w-40">
                    <DesignInput
                      id={ids.redemptions}
                      type="number"
                      min={1}
                      inputMode="numeric"
                      value={maxRedemptions}
                      onChange={(event) => setMaxRedemptions(event.target.value)}
                      placeholder="400"
                    />
                  </div>
                  <DesignPillToggle
                    size="sm"
                    options={[...REDEMPTION_LIMIT_OPTIONS]}
                    selected={redemptionLimitMode}
                    onSelect={(id) => setRedemptionLimitMode(parseRedemptionLimitMode(id))}
                  />
                </>
              )}
              <DesignButton
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setIsUnlimited((current) => !current)}
              >
                {isUnlimited ? "Set a limit" : "Make Unlimited"}
              </DesignButton>
            </div>
            {redemptionLimitMode === "per_period" && !isUnlimited && (
              <DesignSelectorDropdown
                value={period}
                onValueChange={setPeriod}
                options={PERIOD_OPTIONS}
                size="md"
                className="sm:max-w-[12rem]"
              />
            )}
          </div>
        </FormField>

        <FormField label="Subscription Discount Applicability">
          <DesignPillToggle
            size="sm"
            options={[...SUBSCRIPTION_APPLICABILITY_OPTIONS]}
            selected={subscriptionApplicability}
            onSelect={(id) => setSubscriptionApplicability(parseSubscriptionApplicability(id))}
            className="flex-wrap"
          />
          {subscriptionApplicability === "between_dates" && (
            <DateRangeFields
              fromId={ids.subFrom}
              untilId={ids.subUntil}
              from={subscriptionFrom}
              until={subscriptionUntil}
              onFromChange={setSubscriptionFrom}
              onUntilChange={setSubscriptionUntil}
            />
          )}
        </FormField>

        <FormField label="Valid Dates">
          <DesignPillToggle
            size="sm"
            options={[...VALID_DATES_OPTIONS]}
            selected={validDatesMode}
            onSelect={(id) => setValidDatesMode(parseValidDatesMode(id))}
            className="flex-wrap"
          />
          {validDatesMode === "between_dates" && (
            <DateRangeFields
              fromId={ids.validFrom}
              untilId={ids.validUntil}
              from={validFrom}
              until={validUntil}
              onFromChange={setValidFrom}
              onUntilChange={setValidUntil}
            />
          )}
          {validDatesMode === "recurring" && (
            <DesignSelectorDropdown
              value={recurringSchedule}
              onValueChange={setRecurringSchedule}
              options={RECURRING_OPTIONS}
              size="md"
              className="sm:max-w-[12rem]"
            />
          )}
        </FormField>
      </div>
    </DesignDialog>
  );
}

function ProductSearchMultiSelect(props: {
  options: { value: string, label: string }[],
  selectedIds: Set<string>,
  onSelectedIdsChange: (next: Set<string>) => void,
}) {
  const [open, setOpen] = useState(false);
  const selectedOptions = props.options.filter((option) => props.selectedIds.has(option.value));

  const toggleValue = (value: string) => {
    const next = new Set(props.selectedIds);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    props.onSelectedIdsChange(next);
  };

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex min-h-9 w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left text-sm",
            "border border-black/[0.08] bg-white/80 shadow-sm ring-1 ring-black/[0.08]",
            "transition-all duration-150 hover:bg-white hover:transition-none",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/[0.1]",
            "dark:border-white/[0.06] dark:bg-foreground/[0.03] dark:ring-white/[0.06] dark:hover:bg-foreground/[0.06]",
          )}
        >
          {selectedOptions.length === 0 ? (
            <span className="flex-1 truncate text-muted-foreground/50">Search products...</span>
          ) : selectedOptions.length > 2 ? (
            <span className="flex-1 truncate">
              {selectedOptions.length} products selected
            </span>
          ) : (
            <span className="flex min-w-0 flex-1 flex-wrap gap-1">
              {selectedOptions.map((option) => (
                <DesignBadge key={option.value} label={option.label} color="blue" size="sm" />
              ))}
            </span>
          )}
          <MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] rounded-xl border-black/[0.08] bg-white/95 p-0 shadow-md ring-1 ring-black/[0.08] backdrop-blur-xl dark:border-white/[0.06] dark:bg-background/95 dark:ring-white/[0.06]"
      >
        <Command className="rounded-xl bg-transparent">
          <CommandInput placeholder="Search products..." />
          <CommandList>
            <CommandEmpty>No products found.</CommandEmpty>
            <CommandGroup>
              {props.options.map((option) => {
                const isSelected = props.selectedIds.has(option.value);
                return (
                  <CommandItem
                    key={option.value}
                    value={option.label}
                    onSelect={() => toggleValue(option.value)}
                  >
                    <div
                      className={cn(
                        "mr-2 flex h-4 w-4 items-center justify-center rounded-sm border border-foreground/30",
                        isSelected
                          ? "bg-foreground text-background"
                          : "opacity-50 [&_svg]:invisible"
                      )}
                    >
                      <CheckIcon className="h-4 w-4" />
                    </div>
                    <span>{option.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {props.selectedIds.size > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => props.onSelectedIdsChange(new Set())}
                    className="justify-center text-center text-muted-foreground"
                  >
                    Clear selection
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function FormField(props: {
  label: string,
  htmlFor?: string,
  children: ReactNode,
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label
        htmlFor={props.htmlFor}
        className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
      >
        {props.label}
      </Label>
      {props.children}
    </div>
  );
}

function DateRangeFields(props: {
  fromId: string,
  untilId: string,
  from: string,
  until: string,
  onFromChange: (value: string) => void,
  onUntilChange: (value: string) => void,
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <DesignInput
        id={props.fromId}
        type="date"
        value={props.from}
        onChange={(event) => props.onFromChange(event.target.value)}
      />
      <DesignInput
        id={props.untilId}
        type="date"
        value={props.until}
        onChange={(event) => props.onUntilChange(event.target.value)}
      />
    </div>
  );
}

// Same visual language as the Payments onboarding welcome graphic: glass tiles,
// soft rings, and scattered price/percent chips. Centerpiece is a coupon instead
// of a card so the empty state still reads as "promo codes" at a glance.
function PromoCodesIllustration() {
  return (
    <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
      <div className={cn(
        "relative z-10",
        "w-52 h-28 md:w-72 md:h-40 lg:w-80 lg:h-48",
        "rounded-2xl",
        "bg-gradient-to-br from-violet-500/20 via-fuchsia-500/12 to-amber-500/20",
        "backdrop-blur-xl",
        "ring-1 ring-white/20",
        "shadow-[0_0_40px_rgba(168,85,247,0.15)]",
        "flex items-center",
      )}>
        <div className="absolute -left-3.5 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full bg-background ring-1 ring-foreground/[0.06]" />
        <div className="absolute -right-3.5 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full bg-background ring-1 ring-foreground/[0.06]" />
        <div className="flex w-full items-center justify-between px-7 md:px-10">
          <div className="space-y-2 md:space-y-2.5">
            <div className="h-2 md:h-2.5 bg-white/25 rounded-full w-28 md:w-36" />
            <div className="h-1.5 md:h-2 bg-white/12 rounded-full w-16 md:w-24" />
            <div className="h-1.5 md:h-2 bg-white/10 rounded-full w-24 md:w-32" />
          </div>
          <div className={cn(
            "flex h-14 w-14 md:h-20 md:w-20 items-center justify-center rounded-2xl",
            "bg-gradient-to-br from-amber-400/35 to-fuchsia-500/25",
            "ring-1 ring-white/25",
          )}>
            <span className="text-xl md:text-3xl font-semibold text-amber-500/80">%</span>
          </div>
        </div>
      </div>

      <div className={cn(
        "absolute z-20",
        "top-[16%] left-[16%] md:left-[18%] lg:left-[20%]",
        "px-3 py-1.5 md:px-4 md:py-2",
        "rounded-xl",
        "bg-gradient-to-r from-violet-500/20 to-fuchsia-500/15",
        "ring-1 ring-violet-500/25",
        "shadow-[0_0_15px_rgba(139,92,246,0.15)]",
        "rotate-[-10deg]"
      )}>
        <span className="text-violet-500/80 font-semibold text-xs md:text-sm">SUMMER25</span>
      </div>

      <div className={cn(
        "absolute z-20",
        "bottom-[12%] left-[5%] md:left-[7%] lg:left-[8%]",
        "px-3 py-1.5 md:px-4 md:py-2",
        "rounded-xl",
        "bg-gradient-to-r from-green-500/20 to-emerald-500/15",
        "ring-1 ring-green-500/25",
        "shadow-[0_0_15px_rgba(34,197,94,0.15)]",
        "rotate-[-8deg]"
      )}>
        <span className="text-green-500/70 font-semibold text-xs md:text-sm">25% off</span>
      </div>

      <div className={cn(
        "absolute z-0 hidden md:block",
        "top-[38%] left-[2%] lg:left-[3%]",
        "w-20 h-12 lg:w-24 lg:h-14",
        "rounded-xl",
        "bg-gradient-to-br from-purple-500/12 to-blue-500/8",
        "ring-1 ring-purple-500/15",
        "rotate-[-12deg]",
        "opacity-40"
      )} />

      <div className={cn(
        "absolute hidden lg:block",
        "top-[14%] left-[4%]",
        "w-3 h-3 rounded-full",
        "bg-cyan-500/20",
        "ring-1 ring-cyan-500/10"
      )} />

      <div className={cn(
        "absolute z-0 hidden lg:block",
        "top-[6%] left-[20%]",
        "w-10 h-14 rounded-lg",
        "bg-foreground/[0.03]",
        "ring-1 ring-foreground/[0.05]",
        "rotate-[-18deg]",
        "p-1.5",
        "opacity-35"
      )}>
        <div className="space-y-0.5">
          <div className="h-0.5 bg-foreground/[0.06] rounded-full w-full" />
          <div className="h-0.5 bg-foreground/[0.04] rounded-full w-2/3" />
          <div className="h-0.5 bg-foreground/[0.04] rounded-full w-full" />
        </div>
      </div>

      <div className={cn(
        "absolute z-10 hidden lg:flex",
        "bottom-[10%] left-[3%]",
        "w-6 h-6 rounded-full",
        "bg-gradient-to-br from-amber-400/15 to-amber-600/8",
        "ring-1 ring-amber-500/15",
        "items-center justify-center",
        "rotate-[25deg]",
        "opacity-35"
      )}>
        <span className="text-amber-500/30 font-bold text-[8px]">$</span>
      </div>

      <div className={cn(
        "absolute z-10 hidden md:block",
        "top-[58%] left-[5%] lg:left-[6%]",
        "px-1.5 py-0.5",
        "rounded-md",
        "bg-gradient-to-r from-cyan-500/12 to-blue-500/8",
        "ring-1 ring-cyan-500/15",
        "rotate-[-5deg]",
        "opacity-35"
      )}>
        <span className="text-cyan-500/40 font-semibold text-[8px]">$10 off</span>
      </div>

      <div className={cn(
        "absolute hidden md:block",
        "bottom-[42%] left-[24%]",
        "w-2 h-2 rounded-full",
        "bg-purple-500/15",
        "ring-1 ring-purple-500/10"
      )} />

      <div className={cn(
        "absolute z-20 hidden md:flex",
        "top-[14%] right-[8%] lg:right-[6%]",
        "w-12 h-12 md:w-16 md:h-16 lg:w-[4.5rem] lg:h-[4.5rem]",
        "rounded-full",
        "bg-gradient-to-br from-amber-400/30 to-amber-600/20",
        "ring-1 ring-amber-500/30",
        "shadow-[0_0_20px_rgba(245,158,11,0.2)]",
        "items-center justify-center",
        "rotate-[12deg]"
      )}>
        <span className="text-amber-500/60 font-bold text-sm md:text-lg lg:text-xl">$</span>
      </div>

      <div className={cn(
        "absolute z-0",
        "top-[18%] right-[16%] md:right-[14%] lg:right-[12%]",
        "w-16 h-10 md:w-24 md:h-14 lg:w-28 lg:h-16",
        "rounded-xl",
        "bg-gradient-to-br from-cyan-500/15 to-blue-500/10",
        "ring-1 ring-cyan-500/20",
        "rotate-[20deg]",
        "opacity-60"
      )} />

      <div className={cn(
        "absolute z-0",
        "bottom-[10%] right-[6%] md:right-[8%] lg:right-[6%]",
        "w-12 h-16 md:w-16 md:h-20 lg:w-20 lg:h-24",
        "rounded-lg",
        "bg-foreground/[0.04]",
        "ring-1 ring-foreground/[0.06]",
        "rotate-[12deg]",
        "p-2",
        "opacity-50"
      )}>
        <div className="space-y-1">
          <div className="h-1 bg-foreground/[0.08] rounded-full w-full" />
          <div className="h-1 bg-foreground/[0.06] rounded-full w-3/4" />
          <div className="h-1 bg-foreground/[0.06] rounded-full w-full" />
          <div className="h-1 bg-foreground/[0.04] rounded-full w-1/2" />
        </div>
      </div>

      <div className={cn(
        "absolute z-10 hidden md:flex",
        "top-[48%] right-[2%] lg:right-[3%]",
        "w-8 h-8 md:w-10 md:h-10 lg:w-12 lg:h-12",
        "rounded-full",
        "bg-gradient-to-br from-amber-400/20 to-amber-600/10",
        "ring-1 ring-amber-500/20",
        "items-center justify-center",
        "rotate-[10deg]",
        "opacity-50"
      )}>
        <span className="text-amber-500/40 font-bold text-xs md:text-sm">$</span>
      </div>

      <div className={cn(
        "absolute hidden lg:block",
        "top-[8%] right-[5%]",
        "px-2 py-1",
        "rounded-lg",
        "bg-gradient-to-r from-fuchsia-500/12 to-violet-500/8",
        "ring-1 ring-fuchsia-500/15",
        "rotate-[8deg]",
        "opacity-50"
      )}>
        <span className="text-fuchsia-500/50 font-semibold text-[10px]">BOGO</span>
      </div>

      <div className={cn(
        "absolute hidden lg:block",
        "bottom-[40%] right-[4%]",
        "w-2 h-2 rounded-full",
        "bg-purple-500/25",
        "ring-1 ring-purple-500/15"
      )} />

      <div className={cn(
        "absolute z-0 hidden lg:block",
        "top-[62%] right-[16%]",
        "w-14 h-9 rounded-lg",
        "bg-gradient-to-br from-green-500/10 to-emerald-500/6",
        "ring-1 ring-green-500/12",
        "rotate-[-8deg]",
        "opacity-40"
      )} />

      <div className={cn(
        "absolute z-0 hidden lg:block",
        "top-[4%] right-[24%]",
        "w-8 h-11 rounded-md",
        "bg-foreground/[0.025]",
        "ring-1 ring-foreground/[0.04]",
        "rotate-[8deg]",
        "p-1",
        "opacity-30"
      )}>
        <div className="space-y-0.5">
          <div className="h-0.5 bg-foreground/[0.05] rounded-full w-full" />
          <div className="h-0.5 bg-foreground/[0.03] rounded-full w-3/4" />
        </div>
      </div>

      <div className={cn(
        "absolute z-10 hidden lg:flex",
        "bottom-[8%] right-[20%]",
        "w-7 h-7 rounded-full",
        "bg-gradient-to-br from-amber-400/18 to-amber-600/10",
        "ring-1 ring-amber-500/18",
        "items-center justify-center",
        "rotate-[-18deg]",
        "opacity-40"
      )}>
        <span className="text-amber-500/35 font-bold text-[10px]">$</span>
      </div>
    </div>
  );
}
