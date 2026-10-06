// Note: UI components (AppIcon, etc.) are exported via ./dist/apps/apps-ui
// They are not re-exported here to avoid requiring React for non-UI consumers

export {
  HexclaveAdminInterface
} from "./interface/admin-interface";
export {
  HexclaveClientInterface
} from "./interface/client-interface";
export {
  HexclaveServerInterface
} from "./interface/server-interface";
export {
  KnownError,
  KnownErrors
} from "./known-errors";
export {
  ERROR_ENVELOPE_LIMITS,
  ERROR_ENVELOPE_SCHEMA,
  ERROR_ENVELOPE_VERSION,
  deriveErrorEnvelopeEventId,
  normalizeErrorEnvelope,
} from "./utils/error-envelope";
export type {
  ErrorEnvelopeAttachment,
  ErrorEnvelopeBreadcrumb,
  ErrorEnvelopeCorrelation,
  ErrorEnvelopeDebugImage,
  ErrorEnvelopeDebugMeta,
  ErrorEnvelopeExceptionValue,
  ErrorEnvelopeInput,
  ErrorEnvelopeItemMetadata,
  ErrorEnvelopeKind,
  ErrorEnvelopeLevel,
  ErrorEnvelopeLimits,
  ErrorEnvelopeMechanism,
  ErrorEnvelopeNormalization,
  ErrorEnvelopeNormalizationOptions,
  ErrorEnvelopeRequest,
  ErrorEnvelopeRuntime,
  ErrorEnvelopeSdk,
  ErrorEnvelopeStackFrame,
  ErrorEnvelopeStacktrace,
  ErrorEnvelopeUser,
  ErrorEnvelopeV1,
  FlatErrorEventInput,
} from "./utils/error-envelope";
