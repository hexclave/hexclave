import { adaptSchema, serverOrHigherAuthTypeSchema, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

export const issueAlertAuthSchema = yupObject({
  type: serverOrHigherAuthTypeSchema.defined(),
  tenancy: adaptSchema.defined(),
}).defined();

export const issueAlertRuleParamsSchema = yupObject({
  rule_id: yupString().uuid().defined(),
}).defined();

export const issueAlertDeliveryParamsSchema = yupObject({
  delivery_id: yupString().uuid().defined(),
}).defined();
