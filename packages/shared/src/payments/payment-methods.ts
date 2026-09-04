/**
 * Payment Methods Configuration
 *
 * Single source of truth for payment method metadata used by both
 * backend (route validation) and frontend (UI rendering).
 */

export type PaymentMethodCategory =
  | 'cards'
  | 'wallets'
  | 'bnpl'
  | 'realtime'
  | 'bank_debits'
  | 'bank_transfers'
  | 'vouchers';

export type PaymentMethodConfig = {
  name: string,
  category: PaymentMethodCategory,
  dependencies?: string[],
};

type PaymentMethodsByCategory = Record<PaymentMethodCategory, string[]>;

/**
 * All supported payment methods with their display names, categories, and dependencies.
 * This is the single source of truth - both backend and frontend should import from here.
 */
export const PAYMENT_METHODS: Record<string, PaymentMethodConfig> = {
  // Cards
  card: { name: 'Credit/Debit Card', category: 'cards' },
  cartes_bancaires: { name: 'Cartes Bancaires', category: 'cards' },

  // Wallets
  apple_pay: { name: 'Apple Pay', category: 'wallets', dependencies: ['card'] },
  google_pay: { name: 'Google Pay', category: 'wallets', dependencies: ['card'] },
  link: { name: 'Link', category: 'wallets' },
  amazon_pay: { name: 'Amazon Pay', category: 'wallets' },
  cashapp: { name: 'Cash App', category: 'wallets' },

  // Buy Now, Pay Later
  klarna: { name: 'Klarna', category: 'bnpl' },
  affirm: { name: 'Affirm', category: 'bnpl' },
  afterpay_clearpay: { name: 'Afterpay / Clearpay', category: 'bnpl' },
  zip: { name: 'Zip', category: 'bnpl' },

  // Real-Time Payments
  ideal: { name: 'iDEAL', category: 'realtime' },
  bancontact: { name: 'Bancontact', category: 'realtime' },
  eps: { name: 'EPS', category: 'realtime' },
  p24: { name: 'Przelewy24', category: 'realtime' },
  blik: { name: 'BLIK', category: 'realtime' },
  alipay: { name: 'Alipay', category: 'realtime' },
  wechat_pay: { name: 'WeChat Pay', category: 'realtime' },

  // Bank Debits
  sepa_debit: { name: 'SEPA Direct Debit', category: 'bank_debits' },
  bacs_debit: { name: 'Bacs Direct Debit', category: 'bank_debits' },
  acss_debit: { name: 'ACSS Debit', category: 'bank_debits' },

  // Bank Transfers
  us_bank_account: { name: 'US Bank Account', category: 'bank_transfers' },

  // Vouchers
  multibanco: { name: 'Multibanco', category: 'vouchers' },
  customer_balance: { name: 'Customer Balance', category: 'vouchers' },
};

/**
 * Category definitions with display names, ordered by commonality.
 */
export const PAYMENT_CATEGORIES: { id: PaymentMethodCategory, name: string }[] = [
  { id: 'cards', name: 'Cards' },
  { id: 'wallets', name: 'Wallets' },
  { id: 'bnpl', name: 'Buy Now, Pay Later' },
  { id: 'realtime', name: 'Real-Time Payments' },
  { id: 'bank_debits', name: 'Bank Debits' },
  { id: 'bank_transfers', name: 'Bank Transfers' },
  { id: 'vouchers', name: 'Vouchers' },
];

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Get display name for a payment method ID.
 * Returns the ID itself if not found (fallback for unknown methods).
 */
export function getPaymentMethodName(methodId: string): string {
  if (!isKnownPaymentMethod(methodId)) {
    return methodId;
  }
  return PAYMENT_METHODS[methodId].name;
}

/**
 * Get category for a payment method ID.
 * Returns undefined if method is not known.
 */
export function getPaymentMethodCategory(methodId: string): PaymentMethodCategory | undefined {
  if (!isKnownPaymentMethod(methodId)) {
    return undefined;
  }
  return PAYMENT_METHODS[methodId].category;
}

/**
 * Get dependencies for a payment method ID.
 * Returns empty array if method is not known or has no dependencies.
 */
export function getPaymentMethodDependencies(methodId: string): string[] {
  if (!isKnownPaymentMethod(methodId)) {
    return [];
  }
  return PAYMENT_METHODS[methodId].dependencies ?? [];
}

/**
 * Check if a payment method ID is known/supported.
 */
export function isKnownPaymentMethod(methodId: string): boolean {
  return methodId in PAYMENT_METHODS;
}

/**
 * Get all payment method IDs.
 */
export function getAllPaymentMethodIds(): string[] {
  return Object.keys(PAYMENT_METHODS);
}

/**
 * Get all display names (useful for schema validation).
 */
export function getAllPaymentMethodNames(): string[] {
  return Object.values(PAYMENT_METHODS).map(m => m.name);
}

/**
 * Build dependencies map: { methodId: [requiredMethodIds] }
 * Only includes methods that have dependencies.
 */
export const PAYMENT_METHOD_DEPENDENCIES: Record<string, string[]> = Object.fromEntries(
  Object.entries(PAYMENT_METHODS)
    .filter(([, config]) => config.dependencies && config.dependencies.length > 0)
    .map(([id, config]) => [id, config.dependencies!])
);

/**
 * Group payment method IDs by category.
 */
export function getPaymentMethodsByCategory(): PaymentMethodsByCategory {
  const result: PaymentMethodsByCategory = {
    cards: [],
    wallets: [],
    bnpl: [],
    realtime: [],
    bank_debits: [],
    bank_transfers: [],
    vouchers: [],
  };

  for (const [id, config] of Object.entries(PAYMENT_METHODS)) {
    result[config.category].push(id);
  }

  return result;
}
