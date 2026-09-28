-- CreateTable
CREATE TABLE "ManualTransaction" (
    "tenancyId" UUID NOT NULL,
    "txnId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "customerType" "CustomerType" NOT NULL,
    "paymentProvider" TEXT,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "entries" JSONB NOT NULL,

    CONSTRAINT "ManualTransaction_pkey" PRIMARY KEY ("tenancyId","txnId")
);

-- CreateIndex
CREATE INDEX "ManualTransaction_tenancyId_createdAt_idx" ON "ManualTransaction"("tenancyId", "createdAt");
