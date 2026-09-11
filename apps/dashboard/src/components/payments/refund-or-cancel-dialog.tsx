"use client";

import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import {
  DesignAlert,
  DesignButton,
  DesignDialog,
  DesignDialogClose,
  DesignInput,
  DesignPillToggle,
} from "@/components/design-components";
import { cn } from "@/lib/utils";
import { ArrowCounterClockwiseIcon, CheckIcon, ProhibitIcon, ReceiptXIcon } from "@phosphor-icons/react";
import { moneyAmountSchema } from "@hexclave/shared/dist/schema-fields";
import { moneyAmountToStripeUnits } from "@hexclave/shared/dist/utils/currencies";
import type { MoneyAmount } from "@hexclave/shared/dist/utils/currency-constants";
import { SUPPORTED_CURRENCIES } from "@hexclave/shared/dist/utils/currency-constants";
import { KnownError } from "@hexclave/shared/dist/known-errors";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { useMemo, useState } from "react";
import type { RefundTarget, TransactionRowActionKind } from "./transaction-actions";

const USD_CURRENCY = SUPPORTED_CURRENCIES.find((currency) => currency.code === "USD")
  ?? throwErr("USD currency configuration missing in SUPPORTED_CURRENCIES");

export type EndActionChoice = "now" | "at-period-end" | "none";

/**
 * The dialog is always rendered open; parents mount it only while an action
 * is in flight and unmount it to close. This keeps all form state local
 * (initialized once from props) instead of resetting it via effects on an
 * `open` flag, which was the source of the seed-from-props bugs in the old
 * ActionDialog-based implementation.
 */
export type RefundOrCancelDialogProps = {
  onClose: () => void,
  /**
   * When set, the secondary footer button reads "Back" and returns to the
   * previous view (the transaction details) instead of closing the dialog.
   */
  onBack?: () => void,
  intent: TransactionRowActionKind,
  target: RefundTarget,
  productDisplayName: string | null,
  chargedAmountUsd: string | null,
  moneyAlreadyReturned: boolean,
  accessAlreadyEnded: boolean,
  onCompleted?: () => void,
};

type AccessChoice = {
  value: Exclude<EndActionChoice, "none">,
  title: string,
  description: string,
};

function ChoiceCard(props: {
  selected: boolean,
  title: string,
  description: string,
  onSelect: () => void,
  disabled?: boolean,
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      disabled={props.disabled}
      onClick={props.onSelect}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ring-1 transition-colors duration-150 hover:transition-none disabled:cursor-not-allowed disabled:opacity-50",
        props.selected
          ? "bg-foreground/[0.06] ring-2 ring-foreground/40"
          : "bg-transparent ring-foreground/[0.08] hover:bg-foreground/[0.03]",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{props.title}</div>
        <div className="text-xs text-muted-foreground">{props.description}</div>
      </div>
      <span
        aria-hidden
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1",
          props.selected ? "bg-foreground text-background ring-foreground" : "ring-foreground/20",
        )}
      >
        {props.selected ? <CheckIcon className="h-3 w-3" weight="bold" /> : null}
      </span>
    </button>
  );
}

function isUsdMoneyAmount(value: string): value is MoneyAmount {
  return moneyAmountSchema(USD_CURRENCY).defined().isValidSync(value);
}

function getSubmitErrorMessage(error: unknown): string {
  if (KnownError.isKnownError(error)) {
    return error.humanReadableMessage;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

type AmountMode = "none" | "full" | "partial";

function isZeroAmount(amountUsd: string): boolean {
  return isUsdMoneyAmount(amountUsd) && moneyAmountToStripeUnits(amountUsd, USD_CURRENCY) === 0;
}

/**
 * Intent-first form over the refund API (`amount` + optional `end_action`).
 *
 * Refund is a payment action: it asks for money, and the related
 * subscription/grant is an opt-in. Cancel/revoke are lifecycle actions: they
 * ask when to end access, and refunding this charge is an opt-in. The other
 * half is omitted when it's no longer possible (already canceled, or no money
 * on this charge). That is what makes "cancel, then refund later" a money-only
 * dialog instead of a trapped lifecycle picker.
 */
export function RefundOrCancelDialog(props: RefundOrCancelDialogProps) {
  const app = useAdminApp();
  const isSubscription = props.target.type === "subscription";
  const targetsRenewalInvoice = props.target.invoiceId != null;
  const canRefundMoney = props.chargedAmountUsd != null;
  const canEndAccess = !props.accessAlreadyEnded;
  const isRefundIntent = props.intent === "refund";
  const isLifecycleIntent = props.intent === "cancel" || props.intent === "revoke";

  const defaultsToFullRefund = isRefundIntent && canRefundMoney && !props.moneyAlreadyReturned;
  const [amountUsd, setAmountUsd] = useState(() => (defaultsToFullRefund ? (props.chargedAmountUsd ?? "0") : "0"));
  const [amountMode, setAmountMode] = useState<AmountMode>(() => {
    if (defaultsToFullRefund) {
      return "full";
    }
    if (isRefundIntent) {
      return "partial";
    }
    return "none";
  });
  const [alsoEndAccess, setAlsoEndAccess] = useState(false);
  const [endAction, setEndAction] = useState<Exclude<EndActionChoice, "none">>(() => (
    isSubscription && targetsRenewalInvoice ? "at-period-end" : "now"
  ));
  const [submitError, setSubmitError] = useState<string | null>(null);

  const refunding = isUsdMoneyAmount(amountUsd) && !isZeroAmount(amountUsd);
  const endingAccess = isLifecycleIntent || (isRefundIntent && alsoEndAccess && canEndAccess);
  const resolvedEndAction: EndActionChoice = endingAccess ? endAction : "none";

  const timingChoices = useMemo((): AccessChoice[] => {
    if (!isSubscription) {
      return [{ value: "now", title: "Revoke access now", description: "Remove the product immediately." }];
    }
    // A renewal invoice can stop future renewals (period end) but cannot
    // revoke access immediately — that has to go through the original purchase.
    if (targetsRenewalInvoice) {
      return [{
        value: "at-period-end",
        title: "Cancel at period end",
        description: "Access continues until the current period expires. No further renewals.",
      }];
    }
    return [
      { value: "at-period-end", title: "Cancel at period end", description: "Access continues until the current period expires. No further renewals." },
      { value: "now", title: "Cancel now", description: "Revoke access immediately and stop the subscription." },
    ];
  }, [isSubscription, targetsRenewalInvoice]);

  const validation = useMemo(() => {
    if (!isUsdMoneyAmount(amountUsd)) {
      return { canSubmit: false, error: "Enter a valid USD amount." };
    }
    const refundUnits = moneyAmountToStripeUnits(amountUsd, USD_CURRENCY);
    if (refundUnits < 0) {
      return { canSubmit: false, error: "Amount can’t be negative." };
    }
    if (refundUnits > 0 && !canRefundMoney) {
      return { canSubmit: false, error: "There’s no money to refund (test mode or non-USD)." };
    }
    if (props.chargedAmountUsd != null) {
      if (!isUsdMoneyAmount(props.chargedAmountUsd)) {
        return { canSubmit: false, error: "This transaction’s charged amount isn’t a valid USD amount." };
      }
      const maxUnits = moneyAmountToStripeUnits(props.chargedAmountUsd, USD_CURRENCY);
      if (refundUnits > maxUnits) {
        return { canSubmit: false, error: `Amount can’t exceed $${props.chargedAmountUsd}.` };
      }
    }
    if (refundUnits > 0 && resolvedEndAction === "now" && targetsRenewalInvoice) {
      return { canSubmit: false, error: "Refunding a renewal charge can’t cancel the subscription immediately. Cancel at period end, or cancel now from the original purchase without refunding this renewal." };
    }
    if (refundUnits === 0 && resolvedEndAction === "none") {
      return { canSubmit: false, error: isRefundIntent ? "Enter an amount to refund." : "Pick when to cancel." };
    }
    return { canSubmit: true, error: null as string | null };
  }, [amountUsd, canRefundMoney, props.chargedAmountUsd, resolvedEndAction, targetsRenewalInvoice, isRefundIntent]);

  const accessLabel = resolvedEndAction === "none"
    ? null
    : resolvedEndAction === "at-period-end"
      ? "cancel the subscription at period end"
      : (isSubscription ? "cancel the subscription now" : "revoke product access now");
  const preview = refunding && accessLabel != null
    ? `This will refund $${amountUsd} and ${accessLabel}.`
    : refunding
      ? `This will refund $${amountUsd}. The subscription is unchanged.`
      : accessLabel != null
        ? `This will ${accessLabel}. No money will be returned.`
        : "Nothing will change.";

  const title = props.intent === "cancel"
    ? "Cancel subscription"
    : props.intent === "revoke"
      ? "Revoke access"
      : "Refund payment";
  const TitleIcon = props.intent === "cancel"
    ? ProhibitIcon
    : props.intent === "revoke"
      ? ArrowCounterClockwiseIcon
      : ReceiptXIcon;
  const subject = props.productDisplayName ?? (isSubscription ? "this subscription" : "this product");
  const description = isRefundIntent
    ? (props.accessAlreadyEnded
      ? `Return money for this payment. The related subscription is already canceled.`
      : `Return money for this payment.`)
    : props.intent === "revoke"
      ? `Remove access to ${subject}.`
      : (canRefundMoney
        ? `Stop ${subject}. This payment is unchanged unless you also refund it.`
        : `Stop ${subject}.`);

  const endLabel = resolvedEndAction === "now"
    ? (isSubscription ? "cancel now" : "revoke access")
    : "cancel at period end";
  const submitLabel = (() => {
    if (refunding && resolvedEndAction === "none") {
      return `Refund $${amountUsd}`;
    }
    if (refunding) {
      return `Refund $${amountUsd} and ${endLabel}`;
    }
    return endLabel.charAt(0).toUpperCase() + endLabel.slice(1);
  })();

  const submit = async () => {
    if (!validation.canSubmit || !isUsdMoneyAmount(amountUsd)) {
      return;
    }
    setSubmitError(null);
    const apiEndAction = resolvedEndAction === "none" ? undefined : resolvedEndAction;
    const invoiceId = refunding ? props.target.invoiceId : undefined;
    try {
      await app.refundTransaction({
        type: props.target.type,
        id: props.target.id,
        ...(invoiceId !== undefined ? { invoiceId } : {}),
        amountUsd,
        ...(apiEndAction !== undefined ? { endAction: apiEndAction } : {}),
      });
    } catch (error: unknown) {
      setSubmitError(getSubmitErrorMessage(error));
      return;
    }
    props.onClose();
    props.onCompleted?.();
  };

  const refundAmountOptions = [
    ...(!props.moneyAlreadyReturned && props.chargedAmountUsd != null ? [{ id: "full", label: `Full · $${props.chargedAmountUsd}` }] : []),
    { id: "partial", label: "Partial" },
  ];
  const optionalRefundOptions = [
    { id: "none", label: "Don’t refund" },
    ...refundAmountOptions,
  ];

  const showRefundAmount = isRefundIntent ? canRefundMoney : (canRefundMoney && isLifecycleIntent);
  const showLifecycle = isLifecycleIntent || (isRefundIntent && canEndAccess && alsoEndAccess);
  const showAlsoCancel = isRefundIntent && canEndAccess && isSubscription;
  const showAlsoRevoke = isRefundIntent && canEndAccess && !isSubscription;
  const showAlreadyEndedNote = isRefundIntent && props.accessAlreadyEnded;

  return (
    <DesignDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
      size="md"
      icon={TitleIcon}
      title={title}
      description={description}
      footer={(
        <>
          {props.onBack != null ? (
            <DesignButton variant="secondary" size="sm" type="button" onClick={props.onBack}>
              Back
            </DesignButton>
          ) : (
            <DesignDialogClose asChild>
              <DesignButton variant="secondary" size="sm" type="button">
                Close
              </DesignButton>
            </DesignDialogClose>
          )}
          <DesignButton
            size="sm"
            type="button"
            variant={resolvedEndAction === "now" ? "destructive" : "default"}
            disabled={!validation.canSubmit}
            onClick={submit}
          >
            {submitLabel}
          </DesignButton>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        {showRefundAmount ? (
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium text-foreground">
              {isRefundIntent ? "Amount" : "This payment"}
            </div>
            <DesignPillToggle
              size="sm"
              options={isRefundIntent ? refundAmountOptions : optionalRefundOptions}
              selected={amountMode}
              onSelect={(id) => {
                if (id === "none") {
                  setAmountMode("none");
                  setAmountUsd("0");
                  return;
                }
                if (id === "full") {
                  setAmountMode("full");
                  setAmountUsd(props.chargedAmountUsd ?? throwErr("Full refund option is only offered when chargedAmountUsd is known"));
                  return;
                }
                if (id === "partial") {
                  setAmountMode("partial");
                  return;
                }
                throwErr(`Unexpected refund amount mode ${id}`);
              }}
            />
            {props.moneyAlreadyReturned ? (
              <p className="text-xs text-muted-foreground">
                A refund was already issued for this charge. Enter only the remaining amount to return.
              </p>
            ) : null}
            {amountMode === "partial" ? (
              <DesignInput
                id="refund-amount"
                inputMode="decimal"
                prefixItem="$"
                placeholder={props.chargedAmountUsd ?? "0"}
                value={amountUsd}
                onChange={(event) => setAmountUsd(event.target.value)}
                size="md"
              />
            ) : null}
          </div>
        ) : null}

        {showAlsoCancel ? (
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium text-foreground">Related subscription</div>
            <DesignPillToggle
              size="sm"
              options={[
                { id: "refund-only", label: "This payment only" },
                { id: "also-cancel", label: "Cancel subscription too" },
              ]}
              selected={alsoEndAccess ? "also-cancel" : "refund-only"}
              onSelect={(id) => setAlsoEndAccess(id === "also-cancel")}
            />
          </div>
        ) : null}

        {showAlsoRevoke ? (
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium text-foreground">Related product</div>
            <DesignPillToggle
              size="sm"
              options={[
                { id: "refund-only", label: "This payment only" },
                { id: "also-revoke", label: "Revoke access too" },
              ]}
              selected={alsoEndAccess ? "also-revoke" : "refund-only"}
              onSelect={(id) => setAlsoEndAccess(id === "also-revoke")}
            />
          </div>
        ) : null}

        {showAlreadyEndedNote ? (
          <p className="text-xs text-muted-foreground">
            The related subscription is already canceled. Submitting returns money only.
          </p>
        ) : null}

        {showLifecycle ? (
          <div className="flex flex-col gap-2">
            <div id="refund-access-label" className="text-sm font-medium text-foreground">
              {isSubscription ? "When" : "Access"}
            </div>
            <div className="flex flex-col gap-2" role="radiogroup" aria-labelledby="refund-access-label">
              {timingChoices.map((choice) => (
                <ChoiceCard
                  key={choice.value}
                  selected={endAction === choice.value}
                  title={choice.title}
                  description={choice.description}
                  onSelect={() => setEndAction(choice.value)}
                />
              ))}
            </div>
          </div>
        ) : null}

        <DesignAlert variant="info" description={preview} />

        {validation.error || submitError ? (
          <DesignAlert variant="error" description={validation.error ?? submitError} />
        ) : null}
      </div>
    </DesignDialog>
  );
}
