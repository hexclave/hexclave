-- Promo codes are a Hexclave abstraction. Status is derived from these columns
-- (endedAt / pausedAt / availability window / redemptions), never stored.
-- A Stripe Coupon is created per PromoCode so subscription discounts can persist
-- via Coupon duration (once / repeating / forever). New empty tables, so CHECKs
-- are inline — later constraints on populated tables must still split NOT VALID
-- / VALIDATE.

-- CreateEnum
CREATE TYPE "PromoCodeDiscountType" AS ENUM ('percent', 'amount');

-- CreateEnum
CREATE TYPE "PromoCodeSubscriptionBehavior" AS ENUM ('first_payment', 'fixed_duration', 'forever');

-- CreateEnum
CREATE TYPE "PromoCodeAvailabilityType" AS ENUM ('always', 'between_dates');

-- CreateEnum
CREATE TYPE "PromoCodeRedemptionStatus" AS ENUM ('pending', 'succeeded', 'released');

-- CreateEnum
CREATE TYPE "PromoCodeRedemptionPurchaseKind" AS ENUM ('one_time', 'subscription');

-- CreateTable
CREATE TABLE "PromoCode" (
    "id" UUID NOT NULL,
    "tenancyId" UUID NOT NULL,
    "codeName" TEXT NOT NULL,
    "discountType" "PromoCodeDiscountType" NOT NULL,
    "discountAmount" DECIMAL(10,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "applicableProductIds" JSONB,
    "maxRedemptions" INTEGER,
    "numRedemptions" INTEGER NOT NULL DEFAULT 0,
    "pendingRedemptions" INTEGER NOT NULL DEFAULT 0,
    "subscriptionBehavior" "PromoCodeSubscriptionBehavior" NOT NULL,
    "subscriptionDiscountDurationMonths" INTEGER,
    "availabilityType" "PromoCodeAvailabilityType" NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "stripeCouponId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("tenancyId","id"),
    CONSTRAINT "PromoCode_codeName_check" CHECK ("codeName" = upper(btrim("codeName")) AND length(btrim("codeName")) > 0),
    CONSTRAINT "PromoCode_discountAmount_check" CHECK ("discountAmount" > 0),
    CONSTRAINT "PromoCode_percent_max_check" CHECK ("discountType" <> 'percent' OR "discountAmount" <= 100),
    CONSTRAINT "PromoCode_amount_decimals_check" CHECK ("discountType" <> 'amount' OR "discountAmount" = trunc("discountAmount", 2)),
    CONSTRAINT "PromoCode_currency_check" CHECK ("currency" = 'USD'),
    CONSTRAINT "PromoCode_maxRedemptions_check" CHECK ("maxRedemptions" IS NULL OR "maxRedemptions" >= 1),
    CONSTRAINT "PromoCode_numRedemptions_check" CHECK ("numRedemptions" >= 0),
    CONSTRAINT "PromoCode_pendingRedemptions_check" CHECK ("pendingRedemptions" >= 0),
    CONSTRAINT "PromoCode_fixed_duration_months_check" CHECK (
        ("subscriptionBehavior" = 'fixed_duration' AND "subscriptionDiscountDurationMonths" IS NOT NULL AND "subscriptionDiscountDurationMonths" >= 1)
        OR ("subscriptionBehavior" <> 'fixed_duration' AND "subscriptionDiscountDurationMonths" IS NULL)
    ),
    CONSTRAINT "PromoCode_availability_window_check" CHECK (
        ("availabilityType" = 'always' AND "startsAt" IS NULL AND "endsAt" IS NULL)
        OR ("availabilityType" = 'between_dates' AND "startsAt" IS NOT NULL AND "endsAt" IS NOT NULL AND "startsAt" < "endsAt")
    )
);

-- CreateTable
CREATE TABLE "PromoCodeRedemption" (
    "id" UUID NOT NULL,
    "tenancyId" UUID NOT NULL,
    "promoCodeId" UUID NOT NULL,
    "customerId" TEXT NOT NULL,
    "customerType" "CustomerType" NOT NULL,
    "status" "PromoCodeRedemptionStatus" NOT NULL,
    "purchaseKind" "PromoCodeRedemptionPurchaseKind" NOT NULL,
    "stripePaymentIntentId" TEXT,
    "stripeSubscriptionId" TEXT,
    "oneTimePurchaseId" UUID,
    "subscriptionId" UUID,
    "stripeDiscountId" TEXT,
    "subscriptionDiscountRemovedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoCodeRedemption_pkey" PRIMARY KEY ("tenancyId","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromoCode_tenancyId_codeName_key" ON "PromoCode"("tenancyId", "codeName");

-- CreateIndex
CREATE INDEX "PromoCode_tenancyId_createdAt_idx" ON "PromoCode"("tenancyId", "createdAt");

-- CreateIndex
CREATE INDEX "PromoCodeRedemption_tenancyId_promoCodeId_status_idx" ON "PromoCodeRedemption"("tenancyId", "promoCodeId", "status");

-- CreateIndex
CREATE INDEX "PromoCodeRedemption_tenancyId_stripePaymentIntentId_idx" ON "PromoCodeRedemption"("tenancyId", "stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "PromoCodeRedemption_tenancyId_stripeSubscriptionId_idx" ON "PromoCodeRedemption"("tenancyId", "stripeSubscriptionId");

-- AddForeignKey
ALTER TABLE "PromoCodeRedemption" ADD CONSTRAINT "PromoCodeRedemption_tenancyId_promoCodeId_fkey" FOREIGN KEY ("tenancyId", "promoCodeId") REFERENCES "PromoCode"("tenancyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
