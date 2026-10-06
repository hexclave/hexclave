import { createProductionErrorAttachmentService, ErrorAttachmentConflictError, type ErrorAttachmentMetadata } from "@/lib/attachments";
import { validateErrorAttachmentScope, validateErrorAttachmentUpload, validateErrorEventId, ErrorAttachmentValidationError, type ValidatedErrorAttachmentUpload } from "@/lib/attachments/attachment-contract";
import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupArray, yupBoolean, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

const attachmentResponseSchema = yupObject({
  id: yupString().uuid().defined(),
  event_id: yupString().defined(),
  occurrence_id: yupString().nullable().defined(),
  filename: yupString().defined(),
  content_type: yupString().defined(),
  attachment_type: yupString().defined(),
  byte_length: yupNumber().defined(),
  sha256: yupString().defined(),
  created_at: yupString().defined(),
}).defined();

const authSchema = yupObject({
  type: clientOrHigherAuthTypeSchema,
  tenancy: adaptSchema.defined(),
}).defined();

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Upload an error attachment",
    description: "Stores one bounded private error attachment and returns immutable metadata. Attachment bytes never enter ClickHouse or the error event envelope.",
    tags: ["Analytics Events"],
    hidden: true,
  },
  request: yupObject({
    auth: authSchema,
    body: yupMixed().defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }).defined(),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      status: yupString().oneOf(["uploaded", "already_uploaded"]).defined(),
      attachment: attachmentResponseSchema,
    }).defined(),
  }).defined(),
  async handler({ auth, body }) {
    assertObservabilityEnabled(auth.tenancy);
    let upload: ValidatedErrorAttachmentUpload;
    try {
      upload = validateErrorAttachmentUpload(body);
    } catch (error) {
      // Only validation failures become BadRequest; anything else must not
      // leak its internal message to the client.
      if (!(error instanceof ErrorAttachmentValidationError)) throw error;
      throw new StatusError(StatusError.BadRequest, error.message);
    }
    const service = await createProductionErrorAttachmentService(auth.tenancy);
    let result;
    try {
      result = await service.uploadBytes(attachmentScope(auth.tenancy), upload);
    } catch (error) {
      if (error instanceof ErrorAttachmentConflictError) throw new StatusError(StatusError.Conflict, error.message);
      throw error;
    }
    return { statusCode: 200, bodyType: "json", body: { status: result.status, attachment: serializeAttachment(result.attachment) } } as const;
  },
});

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "List error attachments for an event",
    description: "Lists private attachment metadata for one authenticated error event. Bytes are delivered through the attachment detail endpoint.",
    tags: ["Analytics Events"],
    hidden: true,
  },
  request: yupObject({
    auth: authSchema,
    query: yupObject({ event_id: yupString().defined() }).defined(),
    method: yupString().oneOf(["GET"]).defined(),
  }).defined(),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({ attachments: yupArray(attachmentResponseSchema).defined() }).defined(),
  }).defined(),
  async handler({ auth, query }) {
    assertObservabilityEnabled(auth.tenancy);
    const eventId = validateEventIdForRoute(query.event_id);
    const service = await createProductionErrorAttachmentService(auth.tenancy);
    const attachments = await service.list(attachmentScope(auth.tenancy), eventId);
    return { statusCode: 200, bodyType: "json", body: { attachments: attachments.map(serializeAttachment) } } as const;
  },
});

function attachmentScope(tenancy: { id: string, branchId: string, project: { id: string } }) {
  return validateErrorAttachmentScope({ tenantId: tenancy.id, projectId: tenancy.project.id, branchId: tenancy.branchId });
}

function validateEventIdForRoute(value: unknown): string {
  try {
    return validateErrorEventId(value);
  } catch {
    throw new StatusError(StatusError.BadRequest, "event_id must be 32 hexadecimal characters");
  }
}

function serializeAttachment(attachment: ErrorAttachmentMetadata) {
  return {
    id: attachment.id,
    event_id: attachment.eventId,
    occurrence_id: attachment.occurrenceId,
    filename: attachment.filename,
    content_type: attachment.contentType,
    attachment_type: attachment.attachmentType,
    byte_length: attachment.byteLength,
    sha256: attachment.sha256,
    created_at: attachment.createdAt.toISOString(),
  };
}
