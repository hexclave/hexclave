import { completeGrowthOnboardingAndStartRun, requireGrowthAppEnabled } from "@/lib/growth/dashboard";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { adaptSchema, adminAuthTypeSchema, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

function parseWebsiteUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new StatusError(400, "website_url must be a valid absolute URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new StatusError(400, "website_url must use http or https.");
  }
  return parsed.toString();
}

export const POST = createSmartRouteHandler({
  metadata: { hidden: true },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      tenancy: adaptSchema.defined(),
    }),
    method: yupString().oneOf(["POST"]).defined(),
    body: yupObject({
      website_url: yupString().max(2048).defined(),
      company_summary: yupString().max(10_000).nullable().optional(),
      additional_notes: yupString().max(10_000).nullable().optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupMixed().defined(),
  }),
  handler: async ({ auth, body }) => {
    requireGrowthAppEnabled(auth.tenancy);
    // No engine kick anymore: run creation enqueues the workflow boundary
    // event transactionally, and the workflow engine picks it up on its own.
    const result = await completeGrowthOnboardingAndStartRun({
      tenancy: auth.tenancy,
      websiteUrl: parseWebsiteUrl(body.website_url),
      companySummary: body.company_summary ?? null,
      additionalNotes: body.additional_notes ?? null,
    });
    return { statusCode: 200, bodyType: "json", body: { run_id: result.runId } };
  },
});
