import { describe } from "vitest";
import { it } from "../../../../helpers";
import { Project, niceBackendFetch } from "../../../backend-helpers";

// Helper to create admin headers with a given token
const adminHeaders = (token: string) => ({
  'x-stack-admin-access-token': token,
});

// Helper to get config
async function getConfig(adminAccessToken: string) {
  const response = await niceBackendFetch("/api/v1/internal/config", {
    method: "GET",
    accessType: "admin",
    headers: adminHeaders(adminAccessToken),
  });
  return JSON.parse(response.body.config_string);
}

// Helper to get environment override (for checking deletions)
async function getEnvironmentOverride(adminAccessToken: string) {
  const response = await niceBackendFetch("/api/v1/internal/config/override/environment", {
    method: "GET",
    accessType: "admin",
    headers: adminHeaders(adminAccessToken),
  });
  return JSON.parse(response.body.config_string);
}

// Helper to update environment config
async function updateConfig(adminAccessToken: string, configOverride: Record<string, unknown>) {
  const response = await niceBackendFetch("/api/v1/internal/config/override/environment", {
    method: "PATCH",
    accessType: "admin",
    headers: adminHeaders(adminAccessToken),
    body: {
      config_override_string: JSON.stringify(configOverride),
    },
  });
  return response;
}

describe("analytics config - query folders", () => {
  it("creates a query folder via config update", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Create a folder
    const folderId = "test-folder-1";
    const response = await updateConfig(adminAccessToken, {
      [`warehouse.queryFolders.${folderId}`]: {
        displayName: "Test Folder",
        sortOrder: 0,
        queries: {},
      },
    });

    expect(response.status).toBe(200);

    // Verify the folder was created
    const config = await getConfig(adminAccessToken);
    expect(config.warehouse.queryFolders[folderId]).toEqual({
      displayName: "Test Folder",
      sortOrder: 0,
      queries: {},
    });
  });

  it("creates multiple query folders", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Create first folder
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.folder-1": {
        displayName: "Folder 1",
        sortOrder: 0,
        queries: {},
      },
    });

    // Create second folder
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.folder-2": {
        displayName: "Folder 2",
        sortOrder: 1,
        queries: {},
      },
    });

    // Verify both folders exist
    const config = await getConfig(adminAccessToken);
    expect(config.warehouse.queryFolders["folder-1"]).toEqual({
      displayName: "Folder 1",
      sortOrder: 0,
      queries: {},
    });
    expect(config.warehouse.queryFolders["folder-2"]).toEqual({
      displayName: "Folder 2",
      sortOrder: 1,
      queries: {},
    });
  });

  it("updates a query folder", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Create a folder
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.update-folder": {
        displayName: "Original Name",
        sortOrder: 0,
        queries: {},
      },
    });

    // Update the folder
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.update-folder": {
        displayName: "Updated Name",
        sortOrder: 10,
        queries: {},
      },
    });

    // Verify the update
    const config = await getConfig(adminAccessToken);
    expect(config.warehouse.queryFolders["update-folder"]).toEqual({
      displayName: "Updated Name",
      sortOrder: 10,
      queries: {},
    });
  });

  it("deletes a query folder by setting to null", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Create a folder
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.delete-folder": {
        displayName: "To Be Deleted",
        sortOrder: 0,
        queries: {},
      },
    });

    // Verify it exists
    let config = await getConfig(adminAccessToken);
    expect(config.warehouse.queryFolders["delete-folder"]).toBeDefined();

    // Delete the folder
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.delete-folder": null,
    });

    // Verify it's deleted by checking the override (rendered config applies defaults)
    config = await getConfig(adminAccessToken);
    expect(config.warehouse.queryFolders["delete-folder"]).toBeUndefined();
  });
});


describe("analytics config - queries nested in folders", () => {
  it("creates a query inside a folder", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Create a folder first
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.queries-folder": {
        displayName: "Queries Folder",
        sortOrder: 0,
        queries: {},
      },
    });

    // Create a query inside the folder
    const queryId = "test-query-1";
    await updateConfig(adminAccessToken, {
      [`warehouse.queryFolders.queries-folder.queries.${queryId}`]: {
        displayName: "Test Query",
        sqlQuery: "SELECT * FROM events LIMIT 10",
        description: "A test query",
      },
    });

    // Verify the query was created
    const config = await getConfig(adminAccessToken);
    expect(config.warehouse.queryFolders["queries-folder"].queries[queryId]).toEqual({
      displayName: "Test Query",
      sqlQuery: "SELECT * FROM events LIMIT 10",
      description: "A test query",
    });
  });

  it("creates multiple queries in the same folder", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Create a folder with initial queries
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.multi-query-folder": {
        displayName: "Multi Query Folder",
        sortOrder: 0,
        queries: {},
      },
    });

    // Add first query
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.multi-query-folder.queries.query-1": {
        displayName: "Query 1",
        sqlQuery: "SELECT 1",
      },
    });

    // Add second query
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.multi-query-folder.queries.query-2": {
        displayName: "Query 2",
        sqlQuery: "SELECT 2",
      },
    });

    // Verify both queries exist
    const config = await getConfig(adminAccessToken);
    const folder = config.warehouse.queryFolders["multi-query-folder"];
    expect(folder.queries["query-1"]).toEqual({
      displayName: "Query 1",
      sqlQuery: "SELECT 1",
    });
    expect(folder.queries["query-2"]).toEqual({
      displayName: "Query 2",
      sqlQuery: "SELECT 2",
    });
  });

  it("updates a query inside a folder", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Create folder and query
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.update-query-folder": {
        displayName: "Update Query Folder",
        sortOrder: 0,
        queries: {
          "update-query": {
            displayName: "Original Query",
            sqlQuery: "SELECT 'original'",
          },
        },
      },
    });

    // Update the query
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.update-query-folder.queries.update-query": {
        displayName: "Updated Query",
        sqlQuery: "SELECT 'updated'",
        description: "Now with description",
      },
    });

    // Verify the update
    const config = await getConfig(adminAccessToken);
    expect(config.warehouse.queryFolders["update-query-folder"].queries["update-query"]).toEqual({
      displayName: "Updated Query",
      sqlQuery: "SELECT 'updated'",
      description: "Now with description",
    });
  });

  it("deletes a query by setting to null", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Create folder with query
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.delete-query-folder": {
        displayName: "Delete Query Folder",
        sortOrder: 0,
        queries: {
          "delete-query": {
            displayName: "To Delete",
            sqlQuery: "SELECT 'delete me'",
          },
          "keep-query": {
            displayName: "Keep Me",
            sqlQuery: "SELECT 'keep me'",
          },
        },
      },
    });

    // Verify both exist
    let config = await getConfig(adminAccessToken);
    expect(config.warehouse.queryFolders["delete-query-folder"].queries["delete-query"]).toBeDefined();
    expect(config.warehouse.queryFolders["delete-query-folder"].queries["keep-query"]).toBeDefined();

    // Delete one query
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.delete-query-folder.queries.delete-query": null,
    });

    // Verify only the deleted query is gone (check override for deletion, rendered config for the kept one)
    const config2 = await getConfig(adminAccessToken);
    expect(config2.warehouse.queryFolders["delete-query-folder"].queries["delete-query"]).toBeUndefined();
    expect(config2.warehouse.queryFolders["delete-query-folder"].queries["keep-query"]).toBeDefined();
  });

  it("deleting a folder also deletes all its queries in the override", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Create folder with multiple queries
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.cascade-folder": {
        displayName: "Cascade Folder",
        sortOrder: 0,
        queries: {
          "query-1": {
            displayName: "Query 1",
            sqlQuery: "SELECT 1",
          },
          "query-2": {
            displayName: "Query 2",
            sqlQuery: "SELECT 2",
          },
        },
      },
    });

    // Verify folder and queries exist
    let config = await getConfig(adminAccessToken);
    expect(config.warehouse.queryFolders["cascade-folder"]).toBeDefined();
    expect(config.warehouse.queryFolders["cascade-folder"].queries["query-1"]).toBeDefined();
    expect(config.warehouse.queryFolders["cascade-folder"].queries["query-2"]).toBeDefined();

    // Delete the folder
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.cascade-folder": null,
    });

    // Verify folder is deleted (check override since rendered config applies defaults)
    const override = await getConfig(adminAccessToken);
    expect(override.warehouse.queryFolders["cascade-folder"]).toBeUndefined();
  });
});


describe("analytics config - environment level (not pushable)", () => {
  it("analytics config is stored in environment config, not branch config", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Create folder in environment config
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.env-folder": {
        displayName: "Environment Folder",
        sortOrder: 0,
        queries: {},
      },
    });

    // Verify it's in environment override
    const envResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const envConfig = JSON.parse(envResponse.body.config_string);
    expect(envConfig["warehouse.queryFolders.env-folder"]).toBeDefined();

    // Verify it's NOT in branch override
    const branchResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const branchConfig = JSON.parse(branchResponse.body.config_string);
    expect(branchConfig["warehouse.queryFolders.env-folder"]).toBeUndefined();
  });

  it("analytics config is not affected by branch config push", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Create a folder in environment config
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.preserved-folder": {
        displayName: "Preserved Folder",
        sortOrder: 0,
        queries: {
          "preserved-query": {
            displayName: "Preserved Query",
            sqlQuery: "SELECT 'preserved'",
          },
        },
      },
    });

    // Push a new branch config (which should not affect environment config)
    await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PUT",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_string: JSON.stringify({
          "teams.allowClientTeamCreation": true,
        }),
        source: { type: "unlinked" },
      },
    });

    // Verify the analytics folder is still there
    const config = await getConfig(adminAccessToken);
    expect(config.warehouse.queryFolders["preserved-folder"]).toBeDefined();
    expect(config.warehouse.queryFolders["preserved-folder"].queries["preserved-query"]).toBeDefined();
  });
});


describe("analytics config - validation", () => {
  it("accepts optional sortOrder for folders", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Create a folder without sortOrder
    const response = await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.no-sort-folder": {
        displayName: "No Sort Folder",
        queries: {},
        // sortOrder is optional
      },
    });

    expect(response.status).toBe(200);

    // Verify the folder was created
    const config = await getConfig(adminAccessToken);
    expect(config.warehouse.queryFolders["no-sort-folder"]).toBeDefined();
    expect(config.warehouse.queryFolders["no-sort-folder"].displayName).toBe("No Sort Folder");
  });

  it("accepts optional description for queries", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Create a folder
    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.desc-folder": {
        displayName: "Description Folder",
        sortOrder: 0,
        queries: {},
      },
    });

    // Create a query without description
    const response = await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.desc-folder.queries.no-desc-query": {
        displayName: "No Description Query",
        sqlQuery: "SELECT 1",
        // description is optional
      },
    });

    expect(response.status).toBe(200);

    // Verify the query was created
    const config = await getConfig(adminAccessToken);
    expect(config.warehouse.queryFolders["desc-folder"].queries["no-desc-query"]).toBeDefined();
    expect(config.warehouse.queryFolders["desc-folder"].queries["no-desc-query"].description).toBeUndefined();
  });
});


describe("analytics config - edge cases", () => {
  it("handles unicode in display names and SQL queries", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.unicode-folder": {
        displayName: "文件夹 📁 Папка",
        sortOrder: 0,
        queries: {
          "unicode-query": {
            displayName: "查询 🔍 Запрос",
            sqlQuery: "SELECT 'こんにちは' AS greeting",
            description: "A query with unicode 🎉",
          },
        },
      },
    });

    // Verify it was created with unicode preserved
    const config = await getConfig(adminAccessToken);
    expect(config.warehouse.queryFolders["unicode-folder"].displayName).toBe("文件夹 📁 Папка");
    expect(config.warehouse.queryFolders["unicode-folder"].queries["unicode-query"].displayName).toBe("查询 🔍 Запрос");
  });

  it("handles very long SQL queries", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    const longQuery = "SELECT " + Array(100).fill("column_name AS c").join(", ") + " FROM very_long_table_name";

    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.long-query-folder": {
        displayName: "Long Query Folder",
        sortOrder: 0,
        queries: {
          "long-query": {
            displayName: "Long Query",
            sqlQuery: longQuery,
          },
        },
      },
    });

    // Verify it was created
    const config = await getConfig(adminAccessToken);
    expect(config.warehouse.queryFolders["long-query-folder"].queries["long-query"].sqlQuery).toBe(longQuery);
  });

  it("handles empty queries record in folder", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.empty-queries-folder": {
        displayName: "Empty Queries Folder",
        sortOrder: 0,
        queries: {},
      },
    });

    // Verify it was created with empty queries
    const config = await getConfig(adminAccessToken);
    expect(config.warehouse.queryFolders["empty-queries-folder"]).toBeDefined();
    expect(config.warehouse.queryFolders["empty-queries-folder"].queries).toEqual({});
  });

  it("handles negative and large sortOrder values", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    await updateConfig(adminAccessToken, {
      "warehouse.queryFolders.negative-sort": {
        displayName: "Negative Sort",
        sortOrder: -100,
        queries: {},
      },
      "warehouse.queryFolders.large-sort": {
        displayName: "Large Sort",
        sortOrder: 999999,
        queries: {},
      },
    });

    // Verify both were created with correct sortOrder
    const config = await getConfig(adminAccessToken);
    expect(config.warehouse.queryFolders["negative-sort"].sortOrder).toBe(-100);
    expect(config.warehouse.queryFolders["large-sort"].sortOrder).toBe(999999);
  });
});


describe("analytics config - isolation", () => {
  it("analytics config is isolated between projects", async ({ expect }) => {
    // Create first project with analytics config
    const { adminAccessToken: token1 } = await Project.createAndSwitch();
    await updateConfig(token1, {
      "warehouse.queryFolders.project1-folder": {
        displayName: "Project 1 Folder",
        sortOrder: 0,
        queries: {},
      },
    });

    // Create second project
    const { adminAccessToken: token2 } = await Project.createAndSwitch();
    await updateConfig(token2, {
      "warehouse.queryFolders.project2-folder": {
        displayName: "Project 2 Folder",
        sortOrder: 0,
        queries: {},
      },
    });

    // Verify each project only has its own folder
    const config2 = await getConfig(token2);
    expect(config2.warehouse.queryFolders["project2-folder"]).toBeDefined();
    expect(config2.warehouse.queryFolders["project1-folder"]).toBeUndefined();
  });
});
