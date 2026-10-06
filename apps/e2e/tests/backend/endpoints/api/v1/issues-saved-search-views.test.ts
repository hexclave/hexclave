import { randomUUID } from "node:crypto";
import { it } from "../../../../helpers";
import { Project, niceBackendFetch } from "../../../backend-helpers";

const query = {
  version: 1,
  filters: { record: "issue", hours: "24", limit: "50" },
};

it("round-trips a project saved issue view through the dashboard API", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { observability: { enabled: true } } } });

  const name = `E2E saved view ${randomUUID()}`;
  const create = await niceBackendFetch("/api/v1/internal/issues/search-views", {
    method: "POST",
    accessType: "admin",
    body: { name, visibility: "project", query },
  });
  expect(create.status).toBe(201);
  expect(create.body).toMatchObject({ name, visibility: "project", owner_user_id: null, query });

  if (typeof create.body !== "object" || create.body === null || !("id" in create.body) || typeof create.body.id !== "string") {
    throw new Error("saved issue search view creation did not return an id");
  }
  const viewId = create.body.id;

  const list = await niceBackendFetch("/api/v1/internal/issues/search-views", {
    method: "GET",
    accessType: "admin",
  });
  expect(list.status).toBe(200);
  expect(list.body).toMatchObject({ items: [expect.objectContaining({ id: viewId, name })] });

  const updatedName = `${name} updated`;
  const update = await niceBackendFetch(`/api/v1/internal/issues/search-views/${viewId}`, {
    method: "PUT",
    accessType: "admin",
    body: { name: updatedName, visibility: "project", query },
  });
  expect(update.status).toBe(200);
  expect(update.body).toMatchObject({ id: viewId, name: updatedName });

  const remove = await niceBackendFetch(`/api/v1/internal/issues/search-views/${viewId}`, {
    method: "DELETE",
    accessType: "admin",
  });
  expect(remove.status).toBe(204);

  const afterDelete = await niceBackendFetch("/api/v1/internal/issues/search-views", {
    method: "GET",
    accessType: "admin",
  });
  expect(afterDelete.status).toBe(200);
  expect(afterDelete.body).toMatchObject({ items: expect.not.arrayContaining([expect.objectContaining({ id: viewId })]) });
});
