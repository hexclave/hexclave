import { describe, expect, it } from "vitest";
import { compileAndExtractWorkflowManifest, validateWorkflowManifest, validateWorkflowSource } from "../compile";
import type { WorkflowSandboxManifest } from "../protocol";
import { ISSUE_ALERT_WORKFLOW_EVENT_TYPE } from "./contract";
import {
  ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE,
  ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE_CONTRACT,
  validateIssueAlertWorkflowSource,
} from "./source";

describe("issue alert workflow source", () => {
  it("declares the custom trigger and sends through ServerApp inside a durable step", () => {
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE_CONTRACT.triggerEventType).toBe("custom.hexclave.issue-alert");
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE_CONTRACT.deliveryBoundary).toBe("ServerApp.sendEmail");
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE_CONTRACT.durableEmailStore).toBe("EmailOutbox");
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE_CONTRACT.terminalFailureState).toBe("dropped");
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).toContain('customEvent("hexclave.issue-alert")');
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).toContain('step.run("send-email"');
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).toContain("hexclaveApp.sendEmail({");
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).toContain('idempotencyKey: event.id + ":send-email"');
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).toContain("emails: event.data.action.emails");
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).toContain("userIds: event.data.action.user_ids");
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).toContain("routing_resolution");
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).toContain("html: event.data.action.html");
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).toContain("subject: event.data.action.subject");
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).toContain("notificationCategoryName: event.data.action.notification_category_name");
    expect(validateIssueAlertWorkflowSource(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE)).toEqual({ status: "ok" });
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).not.toContain("sendEmailToMany");
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).not.toContain("nodemailer");
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).not.toContain("Resend");
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).toContain('throw new NonRetriableError("Issue alert webhook destination is not configured")');
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).toContain('event.data.action.type !== "email"');
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).toContain('throw new NonRetriableError("Issue alert email recipient routing is not configured")');
    expect(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE).toContain('throw new NonRetriableError("Issue alert email recipient routing resolved to no deliverable recipients")');
  });

  it("rejects direct provider or direct outbox source", () => {
    expect(validateIssueAlertWorkflowSource('customEvent("hexclave.issue-alert"); sendEmailToMany();')).toEqual({
      status: "error",
      reason: "direct_email_provider_call",
    });
    expect(validateIssueAlertWorkflowSource('customEvent("hexclave.issue-alert"); new Resend("secret");')).toEqual({
      status: "error",
      reason: "direct_email_provider_call",
    });
  });

  it("is accepted by the existing Workflows source and manifest validators", () => {
    expect(validateWorkflowSource(ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE)).toEqual({ status: "ok", data: null });
    const manifest: WorkflowSandboxManifest = {
      workflowId: ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE_CONTRACT.workflowId,
      triggers: [{ type: "event", eventType: ISSUE_ALERT_WORKFLOW_EVENT_TYPE }],
      hasRunKey: true,
      onConflict: "skip",
    };
    expect(validateWorkflowManifest(manifest, ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE_CONTRACT.workflowId)).toEqual({ status: "ok", data: null });
  });

  it("compiles as an executable Workflows source with the durable custom trigger", async () => {
    const result = await compileAndExtractWorkflowManifest(
      ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE,
      ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE_CONTRACT.workflowId,
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.manifest).toEqual({
        workflow_id: ISSUE_ALERT_EMAIL_WORKFLOW_SOURCE_CONTRACT.workflowId,
        triggers: [{ type: "event", event_type: ISSUE_ALERT_WORKFLOW_EVENT_TYPE }],
        has_run_key: true,
        on_conflict: "skip",
        uses_stdlib: [],
      });
    }
  });
});
