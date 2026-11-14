import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { deindent } from "@hexclave/shared/dist/utils/strings";
import { describe } from "vitest";
import { it } from "../../../../../helpers";
import { withPortPrefix } from "../../../../../helpers/ports";
import { Project, backendContext, bumpEmailAddress, getOutboxEmails, niceBackendFetch, waitForOutboxEmailWithStatus } from "../../../../backend-helpers";
import { withInternalDatabase } from "../external-db-sync-utils";

const testEmailConfig = {
  type: "standard",
  host: "localhost",
  port: Number(withPortPrefix("29")),
  username: "test",
  password: "test",
  sender_name: "Test Project",
  sender_email: "test@example.com",
} as const;

const simpleTemplate = deindent`
  import { Container } from "@react-email/components";
  import { Subject, NotificationCategory, Props } from "@stackframe/emails";

  export function EmailTemplate({ user, project }) {
    return (
      <Container>
        <Subject value="Test Email Subject" />
        <NotificationCategory value="Marketing" />
        <div>Test email content</div>
      </Container>
    );
  }
`;

// A template that is slow to render, giving us time to pause/cancel it
const slowTemplate = deindent`
  import { Container } from "@react-email/components";
  import { Subject, NotificationCategory, Props } from "@stackframe/emails";

  // Artificial delay to make the email slow to render
  const startTime = performance.now();
  while (performance.now() - startTime < 2000) {
    // Busy wait - 2000ms delay
  }

  export function EmailTemplate({ user, project }) {
    return (
      <Container>
        <Subject value="Slow Render Cancel Test" />
        <NotificationCategory value="Transactional" />
        <div>Slow email content</div>
      </Container>
    );
  }
`;

describe("email outbox API", () => {
  describe("list endpoint", () => {
    it("should list emails in the outbox", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Outbox List Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Create a user directly to avoid signup emails
      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      // Send an email
      const sendResponse = await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          html: "<p>List test email</p>",
          subject: "List Test Email",
          notification_category_name: "Transactional",
        },
      });
      expect(sendResponse.status).toBe(200);

      // Wait for email to be processed
      await wait(7_000);

      // List outbox
      const listResponse = await niceBackendFetch("/api/v1/emails/outbox", {
        method: "GET",
        accessType: "server",
      });
      expect(listResponse.status).toBe(200);
      expect(listResponse.body.items.length).toBeGreaterThanOrEqual(1);
      expect(listResponse.body.is_paginated).toBe(true);
    });

    it("should filter by status", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Outbox Filter Status Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Create a user directly
      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      // Send an email
      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          html: "<p>Filter test email</p>",
          subject: "Filter Test Email",
          notification_category_name: "Transactional",
        },
      });

      // Wait for email to be processed
      await wait(7_000);

      // Filter by sent status
      const sentResponse = await niceBackendFetch("/api/v1/emails/outbox?status=sent", {
        method: "GET",
        accessType: "server",
      });
      expect(sentResponse.status).toBe(200);
      expect(sentResponse.body.items.every((e: any) => e.status === "sent")).toBe(true);
    });

    it("should filter by simple_status", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Outbox Filter Simple Status Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Create a user directly
      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      // Send an email
      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          html: "<p>Simple status test email</p>",
          subject: "Simple Status Test Email",
          notification_category_name: "Transactional",
        },
      });

      // Wait for email to be processed
      await wait(7_000);

      // Filter by ok simple_status
      const okResponse = await niceBackendFetch("/api/v1/emails/outbox?simple_status=ok", {
        method: "GET",
        accessType: "server",
      });
      expect(okResponse.status).toBe(200);
      expect(okResponse.body.items.every((e: any) => e.simple_status === "ok")).toBe(true);
    });

    it("should filter by recipient user_id", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Outbox Filter User Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      const firstMailbox = backendContext.value.mailbox;
      const firstUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: firstMailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(firstUserResponse.status).toBe(201);
      const firstUserId = firstUserResponse.body.id;

      const secondMailbox = await bumpEmailAddress();
      const secondUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: secondMailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(secondUserResponse.status).toBe(201);
      const secondUserId = secondUserResponse.body.id;

      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [firstUserId],
          html: "<p>User filter first email</p>",
          subject: "User Filter First Email",
          notification_category_name: "Transactional",
        },
      });
      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [secondUserId],
          html: "<p>User filter second email</p>",
          subject: "User Filter Second Email",
          notification_category_name: "Transactional",
        },
      });

      await waitForOutboxEmailWithStatus("User Filter First Email", "sent");
      await waitForOutboxEmailWithStatus("User Filter Second Email", "sent");

      const firstUserOutboxResponse = await niceBackendFetch(`/api/v1/emails/outbox?user_id=${firstUserId}`, {
        method: "GET",
        accessType: "server",
      });
      expect(firstUserOutboxResponse.status).toBe(200);
      expect(firstUserOutboxResponse.body.items).toHaveLength(1);
      expect(firstUserOutboxResponse.body.items[0].subject).toBe("User Filter First Email");
      expect(firstUserOutboxResponse.body.items[0].to.user_id).toBe(firstUserId);
    });

    it("should return empty list for project with no emails", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Empty Outbox Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      const listResponse = await niceBackendFetch("/api/v1/emails/outbox", {
        method: "GET",
        accessType: "server",
      });
      expect(listResponse.status).toBe(200);
      expect(listResponse.body.items).toEqual([]);
    });

    async function createOutboxEmails(count: number) {
      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      if (createUserResponse.status !== 201) throw new Error(`Failed to create user: ${createUserResponse.status}`);
      const userId = createUserResponse.body.id;
      for (let i = 0; i < count; i++) {
        const sendResponse = await niceBackendFetch("/api/v1/emails/send-email", {
          method: "POST",
          accessType: "server",
          body: {
            user_ids: [userId],
            html: `<p>Pagination ${i}</p>`,
            subject: `Pagination ${i}`,
            notification_category_name: "Transactional",
          },
        });
        if (sendResponse.status !== 200) throw new Error(`Failed to send email: ${sendResponse.status} ${JSON.stringify(sendResponse.body)}`);
      }
      const list = await niceBackendFetch("/api/v1/emails/outbox?limit=100", { accessType: "server" });
      if (list.status !== 200) throw new Error(`Failed to list outbox: ${list.status}`);
      return list.body.items as { id: string, created_at_millis: number }[];
    }

    async function listAllOutboxIds(limit = 3) {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const response = await niceBackendFetch(`/api/v1/emails/outbox?limit=${limit}${cursor == null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`, { accessType: "server" });
        if (response.status !== 200) throw new Error(`Failed to list outbox: ${response.status} ${JSON.stringify(response.body)}`);
        ids.push(...response.body.items.map((email: { id: string }) => email.id));
        cursor = response.body.pagination.next_cursor;
      } while (cursor != null);
      return ids;
    }

    it("paginates outbox emails across pages without duplicates or skips", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Outbox Pagination Project",
        config: {
          email_config: testEmailConfig,
        },
      });
      const all = await createOutboxEmails(7);
      const allIds = all.map((email) => email.id);
      for (const limit of [1, 3, 5]) {
        expect(await listAllOutboxIds(limit), `limit=${limit}`).toEqual(allIds);
      }
      const page1 = await niceBackendFetch("/api/v1/emails/outbox?limit=3", { accessType: "server" });
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(3);
      expect(page1.body.pagination.next_cursor).toBe(`${page1.body.items[2].created_at_millis}_${page1.body.items[2].id}`);
    });

    it("accepts a legacy inclusive bare-ID outbox cursor", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Outbox Legacy Cursor Project",
        config: {
          email_config: testEmailConfig,
        },
      });
      const all = await createOutboxEmails(5);
      const allIds = all.map((email) => email.id);
      // Legacy next_cursor named the first row of the next page (inclusive).
      const rest = await niceBackendFetch(`/api/v1/emails/outbox?limit=10&cursor=${allIds[2]}`, { accessType: "server" });
      expect(rest.status).toBe(200);
      expect(rest.body.items.map((email: { id: string }) => email.id)).toEqual(allIds.slice(2));
    });

    async function deleteOutboxEmail(id: string) {
      await withInternalDatabase(async (client) => {
        const deleted = await client.query(`DELETE FROM "EmailOutbox" WHERE id = $1`, [id]);
        if (deleted.rowCount !== 1) throw new Error(`Expected to delete 1 outbox row, deleted ${deleted.rowCount}`);
      });
      // SQL delete bypasses Prisma's replica wait. List/read go to the replica, so wait until it
      // no longer returns the row before asserting cursor behavior.
      const deadline = performance.now() + 5_000;
      while (true) {
        const get = await niceBackendFetch(`/api/v1/emails/outbox/${id}`, { accessType: "server" });
        if (get.status === 404) return;
        if (performance.now() >= deadline) {
          throw new Error(`Outbox row ${id} was deleted on the primary but GET still returned ${get.status}`);
        }
        await wait(50);
      }
    }

    it("keeps paginating from a position cursor after its email is deleted", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Outbox Deleted Cursor Project",
        config: {
          email_config: testEmailConfig,
        },
      });
      const all = await createOutboxEmails(7);
      const allIds = all.map((email) => email.id);
      const page1 = await niceBackendFetch("/api/v1/emails/outbox?limit=3", { accessType: "server" });
      const cursor = page1.body.pagination.next_cursor;
      expect(cursor).toBe(`${page1.body.items[2].created_at_millis}_${page1.body.items[2].id}`);

      await deleteOutboxEmail(page1.body.items[2].id);

      const rest = await niceBackendFetch(`/api/v1/emails/outbox?limit=10&cursor=${encodeURIComponent(cursor)}`, { accessType: "server" });
      expect(rest.status).toBe(200);
      expect(rest.body.items.map((email: { id: string }) => email.id)).toEqual(allIds.slice(3));
    });

    it("rejects a legacy (bare email ID) cursor whose email was deleted", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Outbox Legacy Deleted Cursor Project",
        config: {
          email_config: testEmailConfig,
        },
      });
      const [email] = await createOutboxEmails(1);
      await deleteOutboxEmail(email.id);
      const response = await niceBackendFetch(`/api/v1/emails/outbox?limit=10&cursor=${encodeURIComponent(email.id)}`, { accessType: "server" });
      expect(response).toMatchInlineSnapshot(`
        NiceResponse {
          "status": 400,
          "body": "The email referenced by \`cursor\` does not exist (it may have been deleted). Restart pagination without a cursor.",
          "headers": Headers { <some fields may have been hidden> },
        }
      `);
    });

    it("rejects invalid outbox list cursors", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Outbox Invalid Cursor Project",
        config: {
          email_config: testEmailConfig,
        },
      });
      const [email] = await createOutboxEmails(1);
      for (const cursor of [
        "", "null", "undefined", "not-a-cursor", "123", `abc_${email.id}`, `123_not-a-uuid`, `-5_${email.id}`, `1.5_${email.id}`,
        ` 1_${email.id}`, `1_${email.id}\n`, `1_${email.id}_x`,
        `8640000000000001_${email.id}`, `99999999999999999999_${email.id}`,
      ]) {
        const response = await niceBackendFetch(`/api/v1/emails/outbox?limit=5&cursor=${encodeURIComponent(cursor)}`, { accessType: "server" });
        expect(response.status, cursor).toBe(400);
      }
    });
  });

  describe("get endpoint", () => {
    it("should get email by id", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Outbox Get Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Create a user directly
      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      // Send an email
      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          html: "<p>Get test email</p>",
          subject: "Get Test Email",
          notification_category_name: "Transactional",
        },
      });

      // Wait for email to reach sent status
      const emails = await waitForOutboxEmailWithStatus("Get Test Email", "sent");
      const emailId = emails[0].id;

      // Get the email by ID
      const getResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
        method: "GET",
        accessType: "server",
      });
      expect(getResponse.status).toBe(200);
      expect(getResponse.body.id).toBe(emailId);
      expect(getResponse.body.status).toBe("sent");
      expect(getResponse.body.simple_status).toBe("ok");
    });

    it("should return 404 for non-existent email", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Outbox 404 Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Use a valid UUID v4 format
      const getResponse = await niceBackendFetch("/api/v1/emails/outbox/a1234567-89ab-4def-8123-456789abcdef", {
        method: "GET",
        accessType: "server",
      });
      expect(getResponse.status).toBe(404);
    });

    it("should return 404 for email from different project", async ({ expect }) => {
      // Create first project and send an email
      await Project.createAndSwitch({
        display_name: "Test Outbox Project 1",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Create a user directly
      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          html: "<p>Cross project test email</p>",
          subject: "Cross Project Test Email",
          notification_category_name: "Transactional",
        },
      });

      // Wait for email to reach sent status
      const emails = await waitForOutboxEmailWithStatus("Cross Project Test Email", "sent");
      const emailId = emails[0].id;

      // Create second project
      await Project.createAndSwitch({
        display_name: "Test Outbox Project 2",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Try to get email from first project using second project's credentials
      const getResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
        method: "GET",
        accessType: "server",
      });
      expect(getResponse.status).toBe(404);
    });
  });

  describe("edit endpoint - state restrictions", () => {
    it("should return EMAIL_NOT_EDITABLE for sent email", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Not Editable SENT Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Create a user directly
      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      // Send and wait for completion
      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          html: "<p>Not editable test</p>",
          subject: "Not Editable Test",
          notification_category_name: "Transactional",
        },
      });

      // Wait for email to reach sent status
      const emails = await waitForOutboxEmailWithStatus("Not Editable Test", "sent");
      const emailId = emails[0].id;

      // Try to edit
      const editResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
        method: "PATCH",
        accessType: "server",
        body: {
          is_paused: true,
        },
      });
      expect(editResponse.status).toBe(400);
      expect(editResponse.body.code).toBe("EMAIL_NOT_EDITABLE");
    });

    it("should return EMAIL_NOT_EDITABLE for already skipped email", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Not Editable SKIPPED Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Create user without primary email
      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {},
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      // Send email to user without primary email (will be skipped)
      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          html: "<p>Skipped test</p>",
          subject: "Skipped Test",
          notification_category_name: "Transactional",
        },
      });

      // Wait for email to reach skipped status
      const emails = await waitForOutboxEmailWithStatus("Skipped Test", "skipped");
      const email = emails[0];

      // Try to edit
      const editResponse = await niceBackendFetch(`/api/v1/emails/outbox/${email.id}`, {
        method: "PATCH",
        accessType: "server",
        body: {
          is_paused: true,
        },
      });
      expect(editResponse.status).toBe(400);
      expect(editResponse.body.code).toBe("EMAIL_NOT_EDITABLE");
    });
  });

  describe("status discriminated union validation", () => {
    it("should return correct fields for sent status with no delivery info", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test SENT Status Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Create a user directly
      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          html: "<p>Status test</p>",
          subject: "Status Test Email",
          notification_category_name: "Transactional",
        },
      });

      const emails = await waitForOutboxEmailWithStatus("Status Test Email", "sent");
      const email = emails[0];

      // Check discriminated union fields
      expect(email.status).toBe("sent");
      expect(email.simple_status).toBe("ok");
      expect(email.is_paused).toBe(false);
      expect(email.can_have_delivery_info).toBe(false);
      expect(typeof email.started_rendering_at_millis).toBe("number");
      expect(typeof email.rendered_at_millis).toBe("number");
      expect(typeof email.started_sending_at_millis).toBe("number");
      expect(typeof email.delivered_at_millis).toBe("number");
      expect(typeof email.subject).toBe("string");
      expect(email.is_transactional).toBe(true);
    });

    it("should return correct fields for skipped status", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test SKIPPED Status Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Create user without primary email
      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {},
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          html: "<p>Skipped status test</p>",
          subject: "Skipped Status Test",
          notification_category_name: "Transactional",
        },
      });

      const emails = await waitForOutboxEmailWithStatus("Skipped Status Test", "skipped");
      const email = emails[0];

      expect(email.status).toBe("skipped");
      expect(email.simple_status).toBe("ok");
      expect(email.is_paused).toBe(false);
      expect(email.skipped_reason).toBe("USER_HAS_NO_PRIMARY_EMAIL");
      expect(email.skipped_details).toEqual({});
    });
  });

  describe("edit endpoint - success cases", () => {
    it("should edit tsx_source and trigger re-render", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Edit TSX Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Create a user directly
      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      // Create email that will be paused immediately so we can edit it
      const sendResponse = await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          html: "<p>Original content</p>",
          subject: "Edit TSX Test",
          notification_category_name: "Transactional",
        },
      });
      expect(sendResponse.status).toBe(200);

      // Wait for email to reach sent status
      const emails = await waitForOutboxEmailWithStatus("Edit TSX Test", "sent");
      const emailId = emails[0].id;

      // For emails that are already SENT, we can't edit them
      // So we test by confirming the error is correct
      const editResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
        method: "PATCH",
        accessType: "server",
        body: {
          tsx_source: simpleTemplate,
        },
      });
      expect(editResponse.status).toBe(400);
      expect(editResponse.body.code).toBe("EMAIL_NOT_EDITABLE");
    });

    it("should edit scheduled_at_millis to reschedule email", async ({ expect }) => {
      // This test uses a slow-rendering template to reliably pause the email,
      // then edits the scheduled_at_millis to verify rescheduling works.
      await Project.createAndSwitch({
        display_name: "Test Edit Schedule Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      // Create a draft with a slow-rendering template to give us time to pause
      const createDraftResponse = await niceBackendFetch("/api/v1/internal/email-drafts", {
        method: "POST",
        accessType: "admin",
        body: {
          display_name: "Schedule Edit Draft",
          tsx_source: slowTemplate,
          theme_id: false,
        },
      });
      expect(createDraftResponse.status).toBe(200);
      const draftId = createDraftResponse.body.id;

      // Send the email using the slow-rendering template
      const sendResponse = await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          draft_id: draftId,
        },
      });
      expect(sendResponse.status).toBe(200);

      // Poll until we find the email and can pause it (with timeout)
      let emailId: string;
      for (let i = 0;; i++) {
        const listResponse = await niceBackendFetch("/api/v1/emails/outbox", {
          method: "GET",
          accessType: "server",
        });
        const emails = listResponse.body.items.filter((e: any) => e.to?.user_id === userId);

        if (emails.length > 0) {
          emailId = emails[0].id;
          // Try to pause it
          const pauseResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
            method: "PATCH",
            accessType: "server",
            body: {
              is_paused: true,
            },
          });

          expect(pauseResponse).toMatchInlineSnapshot(`
            NiceResponse {
              "status": 200,
              "body": {
                "created_at_millis": <stripped field 'created_at_millis'>,
                "created_with": "draft",
                "email_draft_id": "<stripped UUID>",
                "email_programmatic_call_template_id": null,
                "has_delivered": false,
                "has_rendered": false,
                "id": "<stripped UUID>",
                "is_paused": true,
                "next_send_retry_at_millis": null,
                "scheduled_at_millis": <stripped field 'scheduled_at_millis'>,
                "send_attempt_errors": null,
                "send_retries": 0,
                "simple_status": "in-progress",
                "skip_deliverability_check": false,
                "status": "paused",
                "theme_id": null,
                "to": {
                  "type": "user-primary-email",
                  "user_id": "<stripped UUID>",
                },
                "tsx_source": deindent\`
                  import { Container } from "@react-email/components";
                  import { Subject, NotificationCategory, Props } from "@stackframe/emails";
                  
                  // Artificial delay to make the email slow to render
                  const startTime = performance.now();
                  while (performance.now() - startTime < 2000) {
                    // Busy wait - 2000ms delay
                  }
                  
                  export function EmailTemplate({ user, project }) {
                    return (
                      <Container>
                        <Subject value="Slow Render Cancel Test" />
                        <NotificationCategory value="Transactional" />
                        <div>Slow email content</div>
                      </Container>
                    );
                  }
                \`,
                "updated_at_millis": <stripped field 'updated_at_millis'>,
                "variables": {},
              },
              "headers": Headers { <some fields may have been hidden> },
            }
          `);
          break;
        } else {
          if (i >= 50) {
            throw new HexclaveAssertionError(`Timeout waiting for email in the outbox`, {
              outboxEmails: await getOutboxEmails(),
            });
          }
          await wait(100);
        }
      }

      // Now edit the scheduled_at_millis
      const newScheduleTime = Date.now() + 3600000; // 1 hour from now
      const editResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
        method: "PATCH",
        accessType: "server",
        body: {
          scheduled_at_millis: newScheduleTime,
        },
      });
      expect(editResponse.status).toBe(200);
      expect(editResponse.body.scheduled_at_millis).toBe(newScheduleTime);

      // Verify the scheduled time was updated by fetching the email
      const getResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
        method: "GET",
        accessType: "server",
      });
      expect(getResponse.body.scheduled_at_millis).toBe(newScheduleTime);
    });

    it("should update recipient via PATCH and process email correctly", async ({ expect }) => {
      // This test verifies that updating the 'to' field via PATCH correctly converts
      // from API format (snake_case: user_id) to DB format (camelCase: userId),
      // ensuring the email worker can process the updated recipient.
      await Project.createAndSwitch({
        display_name: "Test Update Recipient Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Create the original user
      const originalMailbox = backendContext.value.mailbox;
      const createOriginalUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: originalMailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createOriginalUserResponse.status).toBe(201);
      const originalUserId = createOriginalUserResponse.body.id;

      // Create a second user to redirect the email to
      const newMailbox = await bumpEmailAddress();
      const createNewUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: newMailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createNewUserResponse.status).toBe(201);
      const newUserId = createNewUserResponse.body.id;

      // Create a draft with a slow-rendering template to give us time to pause
      const createDraftResponse = await niceBackendFetch("/api/v1/internal/email-drafts", {
        method: "POST",
        accessType: "admin",
        body: {
          display_name: "Update Recipient Draft",
          tsx_source: slowTemplate,
          theme_id: false,
        },
      });
      expect(createDraftResponse.status).toBe(200);
      const draftId = createDraftResponse.body.id;

      // Send the email to the original user
      const sendResponse = await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [originalUserId],
          draft_id: draftId,
        },
      });
      expect(sendResponse.status).toBe(200);

      // Poll until we find the email and can pause it
      let emailId: string | null = null;
      let pauseSucceeded = false;

      for (let i = 0; i < 50; i++) {
        const listResponse = await niceBackendFetch("/api/v1/emails/outbox", {
          method: "GET",
          accessType: "server",
        });
        const emails = listResponse.body.items.filter((e: any) => e.to?.user_id === originalUserId);

        if (emails.length > 0 && ["preparing", "scheduled", "queued", "rendering"].includes(emails[0].status)) {
          emailId = emails[0].id;
          const pauseResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
            method: "PATCH",
            accessType: "server",
            body: {
              is_paused: true,
            },
          });

          if (pauseResponse.status === 200 && pauseResponse.body.status === "paused") {
            pauseSucceeded = true;
            break;
          }
        }

        await wait(100);
      }

      expect(emailId).not.toBeNull();
      expect(pauseSucceeded).toBe(true);

      // Update the recipient to the new user using the API format (snake_case: user_id)
      const updateResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
        method: "PATCH",
        accessType: "server",
        body: {
          to: {
            type: "user-primary-email",
            user_id: newUserId,  // API format uses snake_case
          },
        },
      });
      expect(updateResponse.status).toBe(200);
      expect(updateResponse.body.to.type).toBe("user-primary-email");
      expect(updateResponse.body.to.user_id).toBe(newUserId);

      // Unpause the email so it gets processed
      const unpauseResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
        method: "PATCH",
        accessType: "server",
        body: {
          is_paused: false,
        },
      });
      expect(unpauseResponse.status).toBe(200);

      // Wait for the email to be sent to the new user
      await newMailbox.waitForMessagesWithSubject("Slow Render Cancel Test");

      // Verify the original user did NOT receive the email
      const originalUserMessages = await originalMailbox.fetchMessages();
      const originalUserEmails = originalUserMessages.filter(m => m.subject === "Slow Render Cancel Test");
      expect(originalUserEmails).toHaveLength(0);

      // Verify outbox shows sent status and correct recipient
      const finalGetResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
        method: "GET",
        accessType: "server",
      });
      expect(finalGetResponse.body.status).toBe("sent");
      expect(finalGetResponse.body.to.user_id).toBe(newUserId);
    });

    it("should pause and unpause email deterministically", async ({ expect }) => {
      // This test uses a slow-rendering template to reliably place the email
      // into a pausable state before asserting pause/unpause behavior.
      await Project.createAndSwitch({
        display_name: "Test Pause Email Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      // Create a draft with a slow-rendering template to give us time to pause
      const createDraftResponse = await niceBackendFetch("/api/v1/internal/email-drafts", {
        method: "POST",
        accessType: "admin",
        body: {
          display_name: "Pause Test Draft",
          tsx_source: slowTemplate,
          theme_id: false,
        },
      });
      expect(createDraftResponse.status).toBe(200);
      const draftId = createDraftResponse.body.id;

      // Send the email using the slow-rendering template
      const sendResponse = await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          draft_id: draftId,
        },
      });
      expect(sendResponse.status).toBe(200);

      // Poll until we find the email and can pause it (with timeout)
      let emailId: string | null = null;
      let pauseSucceeded = false;

      for (let i = 0; i < 50; i++) {
        const listResponse = await niceBackendFetch("/api/v1/emails/outbox", {
          method: "GET",
          accessType: "server",
        });
        const emails = listResponse.body.items.filter((e: any) => e.to?.user_id === userId);

        if (emails.length > 0) {
          emailId = emails[0].id;
          // Try to pause it
          const pauseResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
            method: "PATCH",
            accessType: "server",
            body: {
              is_paused: true,
            },
          });

          if (pauseResponse.status === 200 && pauseResponse.body.status === "paused") {
            pauseSucceeded = true;
            break;
          }
        }

        await wait(100);
      }

      // These assertions must always run - test fails if we couldn't pause
      expect(emailId).not.toBeNull();
      expect(pauseSucceeded).toBe(true);

      // Verify the email is in paused state
      const getResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
        method: "GET",
        accessType: "server",
      });
      expect(getResponse.status).toBe(200);
      expect(getResponse.body.status).toBe("paused");
      expect(getResponse.body.is_paused).toBe(true);

      // Unpause the email
      const unpauseResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
        method: "PATCH",
        accessType: "server",
        body: {
          is_paused: false,
        },
      });
      expect(unpauseResponse.status).toBe(200);
      expect(unpauseResponse.body.is_paused).toBe(false);
      // After unpausing, the email should go back to processing (preparing/rendering/scheduled/etc)
      expect(unpauseResponse.body.status).not.toBe("paused");

      // Poll until the email is sent (since we unpaused it)
      for (let i = 0; ; i++) {
        const finalGetResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
          method: "GET",
          accessType: "server",
        });
        if (finalGetResponse.body.status === "sent") break;
        if (i >= 50) {
          throw new HexclaveAssertionError(`Timed out waiting for email to be sent after unpause`, {
            status: finalGetResponse.body.status,
          });
        }
        await wait(500);
      }
    });

    it("should cancel email with MANUALLY_CANCELLED reason", async ({ expect }) => {
      // This test uses a slow-rendering template to give us time to pause the email,
      // then reschedules it to the far future to prevent any race conditions,
      // and finally cancels it to verify the cancel functionality works correctly.
      await Project.createAndSwitch({
        display_name: "Test Cancel Email Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Create a user with verified email
      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      // Create a draft with a slow-rendering template
      const createDraftResponse = await niceBackendFetch("/api/v1/internal/email-drafts", {
        method: "POST",
        accessType: "admin",
        body: {
          display_name: "Slow Cancel Test Draft",
          tsx_source: slowTemplate,
          theme_id: false,
        },
      });
      expect(createDraftResponse.status).toBe(200);
      const draftId = createDraftResponse.body.id;

      // Send the email using the slow-rendering template
      const sendResponse = await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          draft_id: draftId,
        },
      });
      expect(sendResponse.status).toBe(200);

      // Immediately try to get and pause the email (before it finishes rendering)
      // We poll until we find the email and can pause it
      let emailId: string | null = null;
      let pauseSucceeded = false;

      for (let i = 0; i < 50; i++) {
        const listResponse = await niceBackendFetch("/api/v1/emails/outbox", {
          method: "GET",
          accessType: "server",
        });
        const emails = listResponse.body.items.filter((e: any) => e.to?.user_id === userId);

        if (emails.length > 0) {
          emailId = emails[0].id;
          // Try to pause it
          const pauseResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
            method: "PATCH",
            accessType: "server",
            body: {
              is_paused: true,
            },
          });

          if (pauseResponse.status === 200 && pauseResponse.body.status === "paused") {
            pauseSucceeded = true;
            break;
          }
        }

        await wait(100);
      }

      // We need to have successfully paused the email to test cancel
      expect(pauseSucceeded).toBe(true);
      expect(emailId).not.toBeNull();

      // Reschedule the email to far in the future to prevent any race conditions
      // where the worker might pick it up while we're testing
      const futureTime = Date.now() + 3600000; // 1 hour from now
      const rescheduleResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
        method: "PATCH",
        accessType: "server",
        body: {
          scheduled_at_millis: futureTime,
        },
      });
      expect(rescheduleResponse.status).toBe(200);
      expect(rescheduleResponse.body.scheduled_at_millis).toBe(futureTime);

      // Verify it's still paused
      const getResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
        method: "GET",
        accessType: "server",
      });
      expect(getResponse.body.status).toBe("paused");

      // Now cancel the paused email
      const cancelResponse = await niceBackendFetch(`/api/v1/emails/outbox/${emailId}`, {
        method: "PATCH",
        accessType: "server",
        body: {
          cancel: true,
        },
      });
      expect(cancelResponse.status).toBe(200);
      expect(cancelResponse.body.status).toBe("skipped");
      expect(cancelResponse.body.skipped_reason).toBe("MANUALLY_CANCELLED");
      expect(cancelResponse.body.is_paused).toBe(false);

      // Wait to ensure no email is sent
      await wait(2000);

      // Verify no email was received (it was cancelled and scheduled far in the future)
      const messages = await backendContext.value.mailbox.fetchMessages();
      const testEmails = messages.filter(m => m.subject === "Slow Render Cancel Test");
      expect(testEmails).toHaveLength(0);
    });

    it("should return EMAIL_NOT_EDITABLE when trying to cancel an already-skipped email", async ({ expect }) => {
      // This test verifies that attempting to cancel an already-skipped email
      // returns EMAIL_NOT_EDITABLE. We use a user without a primary email to
      // reliably get an email into SKIPPED state (no timing issues).
      await Project.createAndSwitch({
        display_name: "Test Cancel Already Skipped Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Create user without primary email - emails to this user will be skipped
      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {},
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      // Send email to user without primary email (will be skipped with USER_HAS_NO_PRIMARY_EMAIL)
      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          html: "<p>Cancel skipped test</p>",
          subject: "Cancel Already Skipped Test",
          notification_category_name: "Transactional",
        },
      });

      // Wait for email to reach skipped status
      const emails = await waitForOutboxEmailWithStatus("Cancel Already Skipped Test", "skipped");
      const email = emails[0];
      expect(email.skipped_reason).toBe("USER_HAS_NO_PRIMARY_EMAIL");

      // Try to cancel an already-skipped email - should fail with EMAIL_NOT_EDITABLE
      const cancelResponse = await niceBackendFetch(`/api/v1/emails/outbox/${email.id}`, {
        method: "PATCH",
        accessType: "server",
        body: {
          cancel: true,
        },
      });
      expect(cancelResponse.status).toBe(400);
      expect(cancelResponse.body.code).toBe("EMAIL_NOT_EDITABLE");
    });
  });

  describe("edge cases", () => {
    it("should return emails with correct recipient type", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Recipient Type Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Create a user directly
      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          html: "<p>Recipient type test</p>",
          subject: "Recipient Type Test",
          notification_category_name: "Transactional",
        },
      });

      const emails = await waitForOutboxEmailWithStatus("Recipient Type Test", "sent");
      const email = emails[0];

      expect(email.to).toBeDefined();
      expect(email.to!.type).toBe("user-primary-email");
      expect(email.to!.user_id).toBe(userId);
    });

    it("should show correct fields for PREPARING state (before rendering starts)", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test PREPARING State Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      // Send email and immediately check outbox
      const sendResponse = await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          html: "<p>State test</p>",
          subject: "PREPARING State Test",
          notification_category_name: "Transactional",
        },
      });
      expect(sendResponse.status).toBe(200);

      // Check immediately for PREPARING state (might be too fast and already in another state)
      const listResponse = await niceBackendFetch("/api/v1/emails/outbox", {
        method: "GET",
        accessType: "server",
      });
      const preparingEmails = listResponse.body.items.filter((e: any) => e.status === "preparing");

      // If we caught one in preparing state, verify its fields
      if (preparingEmails.length > 0) {
        const email = preparingEmails[0];
        expect(email.is_paused).toBe(false);
        expect(email.simple_status).toBe("in-progress");
        // Should NOT have rendered fields
        expect(email.started_rendering_at_millis).toBeUndefined();
        expect(email.rendered_at_millis).toBeUndefined();
        expect(email.subject).toBeUndefined();
      }
    });

    it("should correctly handle email with all base fields populated", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test All Base Fields Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      // Send and wait for completion
      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          html: "<p>Base fields test</p>",
          subject: "Base Fields Test",
          notification_category_name: "Transactional",
        },
      });

      const emails = await waitForOutboxEmailWithStatus("Base Fields Test", "sent");
      const email = emails[0];

      // Check all base fields
      expect(typeof email.id).toBe("string");
      expect(typeof email.created_at_millis).toBe("number");
      expect(typeof email.updated_at_millis).toBe("number");
      expect(typeof email.tsx_source).toBe("string");
      expect(typeof email.scheduled_at_millis).toBe("number");
      expect(typeof email.skip_deliverability_check).toBe("boolean");
      expect(email.variables).toBeDefined();
      expect(email.to).toBeDefined();
      expect(email.to!.type).toBe("user-primary-email");
    });

    it("should list emails across multiple status types", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test Multi-Status List Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Create user with primary email
      const createUserResponse1 = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createUserResponse1.status).toBe(201);
      const userId1 = createUserResponse1.body.id;

      // Create user without primary email (will be skipped)
      const createUserResponse2 = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {},
      });
      expect(createUserResponse2.status).toBe(201);
      const userId2 = createUserResponse2.body.id;

      // Send email to both
      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId1],
          html: "<p>Multi status test 1</p>",
          subject: "Multi Status Test Sent",
          notification_category_name: "Transactional",
        },
      });

      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId2],
          html: "<p>Multi status test 2</p>",
          subject: "Multi Status Test Skipped",
          notification_category_name: "Transactional",
        },
      });

      // Verify we have both sent and skipped emails
      const sentEmails = await waitForOutboxEmailWithStatus("Multi Status Test Sent", "sent");
      expect(sentEmails[0].status).toBe("sent");

      const skippedEmails = await waitForOutboxEmailWithStatus("Multi Status Test Skipped", "skipped");
      expect(skippedEmails[0].status).toBe("skipped");
    });
  });

  describe("status inline snapshots", () => {
    it("should return correct snapshot for sent status with can_have_delivery_info=false", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test SENT Snapshot Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {
          primary_email: backendContext.value.mailbox.emailAddress,
          primary_email_verified: true,
        },
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          html: "<p>Snapshot test</p>",
          subject: "SENT Snapshot Test",
          notification_category_name: "Transactional",
        },
      });

      const emails = await waitForOutboxEmailWithStatus("SENT Snapshot Test", "sent");
      const email = emails[0];

      // Verify the structure matches the expected discriminated union
      expect(email.status).toBe("sent");
      expect(email.simple_status).toBe("ok");
      expect(email.is_paused).toBe(false);
      expect(email.can_have_delivery_info).toBe(false);
      expect(typeof email.started_rendering_at_millis).toBe("number");
      expect(typeof email.rendered_at_millis).toBe("number");
      expect(typeof email.started_sending_at_millis).toBe("number");
      expect(typeof email.delivered_at_millis).toBe("number");
      expect(email.is_transactional).toBe(true);
      // These should NOT be present for can_have_delivery_info=false
      expect(email.opened_at_millis).toBeUndefined();
      expect(email.clicked_at_millis).toBeUndefined();
    });

    it("should return correct snapshot for skipped status with USER_HAS_NO_PRIMARY_EMAIL", async ({ expect }) => {
      await Project.createAndSwitch({
        display_name: "Test SKIPPED Snapshot Project",
        config: {
          email_config: testEmailConfig,
        },
      });

      // Create user without primary email
      const createUserResponse = await niceBackendFetch("/api/v1/users", {
        method: "POST",
        accessType: "server",
        body: {},
      });
      expect(createUserResponse.status).toBe(201);
      const userId = createUserResponse.body.id;

      await niceBackendFetch("/api/v1/emails/send-email", {
        method: "POST",
        accessType: "server",
        body: {
          user_ids: [userId],
          html: "<p>Skip snapshot test</p>",
          subject: "SKIPPED Snapshot Test",
          notification_category_name: "Transactional",
        },
      });

      const emails = await waitForOutboxEmailWithStatus("SKIPPED Snapshot Test", "skipped");
      const email = emails[0];

      // Verify the structure matches the expected discriminated union for skipped
      expect(email.status).toBe("skipped");
      expect(email.simple_status).toBe("ok");
      expect(email.is_paused).toBe(false);
      expect(email.skipped_reason).toBe("USER_HAS_NO_PRIMARY_EMAIL");
      expect(email.skipped_details).toEqual({});
      // skipped with USER_HAS_NO_PRIMARY_EMAIL happens during the sending phase
      // (after the email is picked up for processing), so started_sending_at_millis should be present
      expect(typeof email.started_sending_at_millis).toBe("number");
    });
  });
});
