"use client";

import { DesignAlert, DesignButton, DesignInput } from "@/components/design-components";
import { Label } from "@/components/ui/label";
import { KnownErrors } from "@hexclave/shared";
import { XIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";

const PROMO_CODE_APPLY_ERROR_CODES = new Set([
  "PROMO_CODES_DISABLED",
  "PROMO_CODE_STACKING_DISABLED",
  "PROMO_CODE_INVALID",
  "PROMO_CODE_NOT_FOUND",
  "PROMO_CODE_PAUSED",
  "PROMO_CODE_ENDED",
  "PROMO_CODE_EXPIRED",
  "PROMO_CODE_NOT_YET_AVAILABLE",
  "PROMO_CODE_NOT_APPLICABLE_TO_PRODUCT",
  "PROMO_CODE_REDEMPTION_LIMIT_REACHED",
  "PROMO_CODE_STACKING_NOT_ALLOWED",
  "PROMO_CODE_NOTHING_TO_DISCOUNT",
  "PROMO_CODE_DISCOUNT_BELOW_MINIMUM",
]);

function isPromoCodeApplyKnownError(error: unknown): error is Error {
  return error instanceof KnownErrors.PromoCodesDisabled
    || error instanceof KnownErrors.PromoCodeStackingDisabled
    || error instanceof KnownErrors.PromoCodeInvalid
    || error instanceof KnownErrors.PromoCodeNotFound
    || error instanceof KnownErrors.PromoCodePaused
    || error instanceof KnownErrors.PromoCodeEnded
    || error instanceof KnownErrors.PromoCodeExpired
    || error instanceof KnownErrors.PromoCodeNotYetAvailable
    || error instanceof KnownErrors.PromoCodeNotApplicableToProduct
    || error instanceof KnownErrors.PromoCodeRedemptionLimitReached
    || error instanceof KnownErrors.PromoCodeStackingNotAllowed
    || error instanceof KnownErrors.PromoCodeNothingToDiscount
    || error instanceof KnownErrors.PromoCodeDiscountBelowMinimum;
}

export function promoCodeErrorMessage(error: unknown): string {
  if (isPromoCodeApplyKnownError(error)) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && PROMO_CODE_APPLY_ERROR_CODES.has(error.code)) {
    if ("error" in error && typeof error.error === "string") {
      return error.error;
    }
  }
  return "This promo code could not be applied.";
}

export function PromoCodeApplyField(props: {
  appliedCodeNames: string[],
  allowStacking: boolean,
  disabled?: boolean,
  onApply: (codeName: string) => Promise<void>,
  onRemove: (codeName: string) => Promise<void>,
}) {
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [removingCodeName, setRemovingCodeName] = useState<string | null>(null);
  const showInput = props.appliedCodeNames.length === 0 || props.allowStacking;
  const removeDisabled = props.disabled === true || removingCodeName != null;

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={inputId} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Promo code
      </Label>
      {props.appliedCodeNames.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {props.appliedCodeNames.map((codeName) => (
            <div
              key={codeName}
              className="flex items-center justify-between rounded-xl border border-border/40 bg-foreground/[0.02] px-3 py-2"
            >
              <span className="text-sm font-medium">With Code {codeName}</span>
              <DesignButton
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                disabled={removeDisabled}
                aria-label={`Remove ${codeName}`}
                onClick={async () => {
                  setErrorMessage(null);
                  setRemovingCodeName(codeName);
                  try {
                    await props.onRemove(codeName);
                  } catch (error) {
                    setErrorMessage(promoCodeErrorMessage(error));
                  } finally {
                    setRemovingCodeName(null);
                  }
                }}
              >
                <XIcon className="h-4 w-4" />
              </DesignButton>
            </div>
          ))}
        </div>
      )}
      {showInput && (
        <div className="flex gap-2">
          <DesignInput
            id={inputId}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="SUMMER25"
            disabled={props.disabled}
          />
          <DesignButton
            variant="outline"
            size="sm"
            disabled={props.disabled === true || removeDisabled || draft.trim().length === 0}
            onClick={async () => {
              setErrorMessage(null);
              try {
                await props.onApply(draft.trim());
                setDraft("");
              } catch (error) {
                setErrorMessage(promoCodeErrorMessage(error));
              }
            }}
          >
            Apply
          </DesignButton>
        </div>
      )}
      {errorMessage != null && (
        <DesignAlert variant="error" description={errorMessage} />
      )}
    </div>
  );
}
