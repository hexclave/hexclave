export type ApiKeyType = "user" | "team";

export type ApiKey<Type extends ApiKeyType = ApiKeyType, IsFirstView extends boolean = false> = {
  id: string;
  description: string;
  createdAt: Date;
  expiresAt?: Date | null;
  manuallyRevokedAt?: Date | null;
  value: {
    lastFour: string;
    secret?: string;
  };
  type: Type;
  userId: string;
  update: (options: { description?: string }) => Promise<void>;
  revoke: () => Promise<void>;
  isValid: () => boolean;
  whyInvalid: () => 'manually-revoked' | 'expired' | null;
}

export type ApiKeyCreationOptions<Type extends ApiKeyType = ApiKeyType> = {
  description: string;
  expiresAt?: Date | null;
}

export type ActiveSession = {
  id: string;
  isCurrentSession: boolean;
  isImpersonation?: boolean;
  agentName?: string | null;
  createdAt: string;
  lastUsedAt?: string;
  geoInfo?: {
    ip?: string;
    cityName?: string;
  };
}
