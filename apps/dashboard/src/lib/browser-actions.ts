import { sendInternalAdminRequest } from "@/lib/hexclave-app-internals";
import { yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import type { InferType } from "yup";

const browserActionResponseSchema = yupObject({
  id: yupString().defined(),
  url: yupString().defined(),
  expires_at_millis: yupNumber().defined(),
}).defined();

export type BrowserActionResponse = InferType<typeof browserActionResponseSchema>;

export async function openBrowserActionInNewTab(
  adminApp: object,
  options: Parameters<typeof createBrowserAction>[1],
): Promise<boolean> {
  const popup = window.open("about:blank", "_blank");
  if (popup == null) {
    window.alert("Allow pop-ups for this dashboard to open the browser action.");
    return false;
  }
  // Open without noopener so we retain the handle, then sever opener access before navigation.
  popup.opener = null;
  try {
    const action = await createBrowserAction(adminApp, options);
    popup.location.href = action.url;
    return true;
  } catch (error) {
    popup.close();
    throw error;
  }
}

export async function createBrowserAction(
  adminApp: object,
  options: {
    type: "impersonation" | "clickmap-overlay",
    origin: string,
    userId?: string,
    expiresInMillis?: number,
    sessionExpiresInMillis?: number,
    reason?: string,
  },
): Promise<BrowserActionResponse> {
  const response = await sendInternalAdminRequest(adminApp, "/browser-actions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: options.type,
      origin: options.origin,
      expires_in_millis: options.expiresInMillis,
      session_expires_in_millis: options.sessionExpiresInMillis,
      user_id: options.userId,
      reason: options.reason,
    }),
  });
  if (!response.ok) {
    throw new HexclaveAssertionError(
      `Browser action creation failed (${response.status}): ${await response.text()}`,
    );
  }
  return await browserActionResponseSchema.validate(await response.json(), { strict: true });
}
