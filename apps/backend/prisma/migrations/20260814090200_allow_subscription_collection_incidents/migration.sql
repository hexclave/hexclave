ALTER TABLE "TvEventOccurrence"
  DROP CONSTRAINT "TvEventOccurrence_event_type_class_check",
  ADD CONSTRAINT "TvEventOccurrence_event_type_class_check"
  CHECK (
    (
      "eventType" = 'USER_MILESTONE'
      AND "presentationClass" = 'CELEBRATION'
    )
    OR
    (
      "eventType" IN ('EMAIL_DELIVERY_DEGRADATION', 'SUBSCRIPTION_COLLECTION_DEGRADATION')
      AND "presentationClass" IN ('INCIDENT', 'CRITICAL_INCIDENT')
    )
  ) NOT VALID;
