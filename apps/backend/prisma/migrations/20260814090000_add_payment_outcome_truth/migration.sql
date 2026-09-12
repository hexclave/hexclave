ALTER TABLE "SubscriptionInvoice"
  ADD COLUMN "paidAt" TIMESTAMP(3),
  ADD COLUMN "markedUncollectibleAt" TIMESTAMP(3),
  ADD COLUMN "voidedAt" TIMESTAMP(3),
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "amountPaid" INTEGER;

ALTER TABLE "OneTimePurchase"
  ADD COLUMN "amountReceived" INTEGER,
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "paidAt" TIMESTAMP(3);
