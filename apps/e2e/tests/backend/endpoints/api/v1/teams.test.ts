import { it } from "../../../../helpers";
import { Auth, InternalApiKey, Project, Team, Webhook, bumpEmailAddress, niceBackendFetch } from "../../../backend-helpers";
import { withInternalDatabase } from "./external-db-sync-utils";


it("is not allowed to list all the teams in a project on the client", async ({ expect }) => {
  await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/v1/teams", { accessType: "client" });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 403,
      "body": "Client can only list teams for their own user. user_id must be either \\"me\\" or the ID of the current user",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("lists all the teams in a project with server access", async ({ expect }) => {
  // Not the default (internal) project: it accumulates teams across runs, and past 200 the response is paginated.
  await Project.createAndSwitch();
  await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/v1/teams", { accessType: "server" });
  expect(response).toMatchObject({
    status: 200,
    body: {
      items: expect.any(Array),
      is_paginated: false,
    },
    headers: expect.anything(),
  });
});

it("lists all the teams the current user has on the client", async ({ expect }) => {
  await Project.createAndSwitch();
  const { userId } = await Auth.fastSignUp();
  const response1 = await niceBackendFetch("/api/v1/teams?user_id=me", { accessType: "client" });
  expect(response1).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const response2 = await niceBackendFetch(`/api/v1/teams?user_id=${userId}`, { accessType: "client" });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("lists all the teams the current user has on the server", async ({ expect }) => {
  await Project.createAndSwitch();
  const { userId } = await Auth.fastSignUp();
  const response1 = await niceBackendFetch("/api/v1/teams?user_id=me", { accessType: "server" });
  expect(response1).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const response2 = await niceBackendFetch(`/api/v1/teams?user_id=${userId}`, { accessType: "server" });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("paginates teams across two pages without duplicates or skips", async ({ expect }) => {
  await Project.createAndSwitch();

  // Create 5 teams. Use a stable, ordered display name so we can assert the
  // sequence after pagination.
  const teamCount = 5;
  for (let i = 0; i < teamCount; i++) {
    const createResponse = await niceBackendFetch("/api/v1/teams", {
      accessType: "server",
      method: "POST",
      body: { display_name: `Pagination team ${i.toString().padStart(2, "0")}` },
    });
    expect(createResponse.status).toBe(201);
  }

  const limit = 3;
  const page1 = await niceBackendFetch(`/api/v1/teams?limit=${limit}`, { accessType: "server" });
  expect(page1.status).toBe(200);
  expect(page1.body.is_paginated).toBe(true);
  expect(page1.body.items).toHaveLength(limit);
  const cursor = page1.body.pagination?.next_cursor;
  expect(cursor).toEqual(expect.any(String));

  // Cursor should be the position of the last item we received, not a peek-ahead.
  expect(cursor).toBe(`${page1.body.items[limit - 1].created_at_millis}_${page1.body.items[limit - 1].id}`);

  const page2 = await niceBackendFetch(`/api/v1/teams?limit=${limit}&cursor=${encodeURIComponent(cursor)}`, { accessType: "server" });
  expect(page2.status).toBe(200);
  expect(page2.body.items.length).toBe(teamCount - limit);

  const page1Ids = new Set(page1.body.items.map((t: any) => t.id));
  const page2Ids = page2.body.items.map((t: any) => t.id);
  for (const id of page2Ids) {
    expect(page1Ids.has(id)).toBe(false); // no duplicates across pages
  }
  expect(page1.body.items.length + page2.body.items.length).toBe(teamCount); // no skips
  expect(page2.body.pagination?.next_cursor ?? null).toBeNull();
});

async function createTeams(count: number, body: (index: number) => Record<string, unknown> = () => ({}), batchSize = 20) {
  const ids: string[] = [];
  // Batches run one after another, so only teams in different batches are guaranteed increasing created_at.
  for (let batchStart = 0; batchStart < count; batchStart += batchSize) {
    const responses = await Promise.all(Array.from({ length: Math.min(batchSize, count - batchStart) }, (_, i) => niceBackendFetch("/api/v1/teams", {
      accessType: "server",
      method: "POST",
      body: { display_name: `Team ${batchStart + i}`, ...body(batchStart + i) },
    })));
    for (const response of responses) {
      if (response.status !== 201) throw new Error(`Failed to create team: ${response.status}`);
      ids.push(response.body.id);
    }
  }
  return ids;
}

async function listAllTeamIds(query: string, limit = 7) {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await niceBackendFetch(`/api/v1/teams?${query}&limit=${limit}${cursor == null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`, { accessType: "server" });
    if (response.status !== 200) throw new Error(`Failed to list teams: ${response.status}`);
    ids.push(...response.body.items.map((team: { id: string }) => team.id));
    cursor = response.body.pagination.next_cursor;
  } while (cursor != null);
  return ids;
}

it("returns up to 500 teams unpaginated without a limit, and rejects the request past 500", async ({ expect }) => {
  await Project.createAndSwitch();
  const ids = await createTeams(500);

  const response = await niceBackendFetch("/api/v1/teams", { accessType: "server" });
  expect(response.status).toBe(200);
  expect(response.body.is_paginated).toBe(false);
  expect(response.body.pagination).toBeUndefined();
  expect(new Set(response.body.items.map((team: { id: string }) => team.id))).toEqual(new Set(ids));
  expect(response.body.items).toHaveLength(500);

  ids.push(...await createTeams(1));
  const tooMany = await niceBackendFetch("/api/v1/teams", { accessType: "server" });
  expect(tooMany).toMatchInlineSnapshot();

  // Paginating still reaches every team.
  const paginated = await listAllTeamIds("order_by=created_at", 200);
  expect(new Set(paginated)).toEqual(new Set(ids));
  expect(paginated).toHaveLength(501);
}, 300_000);

it("applies the 500-team cap without a limit only to the user's own teams, for client and server", async ({ expect }) => {
  await Project.createAndSwitch();
  const { userId } = await Auth.fastSignUp();
  const ids = await createTeams(500, () => ({ creator_user_id: userId }));
  // Teams the user isn't in must not count towards the cap.
  await createTeams(5);

  for (const accessType of ["client", "server"] as const) {
    const response = await niceBackendFetch("/api/v1/teams?user_id=me", { accessType });
    expect(response.status).toBe(200);
    expect(response.body.is_paginated).toBe(false);
    expect(response.body.pagination).toBeUndefined();
    expect(new Set(response.body.items.map((team: { id: string }) => team.id))).toEqual(new Set(ids));
    expect(response.body.items).toHaveLength(500);
  }

  await createTeams(1, () => ({ creator_user_id: userId }));
  for (const accessType of ["client", "server"] as const) {
    const response = await niceBackendFetch("/api/v1/teams?user_id=me", { accessType });
    expect(response.status).toBe(400);
    expect(response.body).toContain("More than 500 teams match this request");
  }
}, 300_000);

it("pages through teams in both directions without duplicates or skips", async ({ expect }) => {
  await Project.createAndSwitch();
  const ids = await createTeams(45);

  const ascending = await listAllTeamIds("order_by=created_at");
  expect(new Set(ascending)).toEqual(new Set(ids));
  expect(ascending).toHaveLength(45);

  const descending = await listAllTeamIds("order_by=created_at&desc=true");
  expect(descending).toEqual([...ascending].reverse());
});

it("combines query, user_id, and pagination", async ({ expect }) => {
  await Project.createAndSwitch();
  const { userId } = await Auth.fastSignUp();
  const matching = await createTeams(9, (i) => ({ display_name: `Needle ${i}`, creator_user_id: userId }));
  await createTeams(4, (i) => ({ display_name: `Haystack ${i}`, creator_user_id: userId }));
  await createTeams(3, (i) => ({ display_name: `Needle not mine ${i}` }));

  expect(new Set(await listAllTeamIds(`user_id=${userId}&query=needle`))).toEqual(new Set(matching));

  // A team ID matches exactly, but only among the user's own teams.
  const [notMine] = await createTeams(1);
  const byOwnId = await niceBackendFetch(`/api/v1/teams?user_id=me&query=${matching[3]}`, { accessType: "client" });
  expect(byOwnId.body.items.map((team: { id: string }) => team.id)).toEqual([matching[3]]);
  const byOtherId = await niceBackendFetch(`/api/v1/teams?user_id=me&query=${notMine}`, { accessType: "client" });
  expect(byOtherId.body.items).toEqual([]);
});

it("rejects invalid pagination parameters", async ({ expect }) => {
  await Project.createAndSwitch();
  const [teamId] = await createTeams(1);

  const cursorWithoutLimit = await niceBackendFetch(`/api/v1/teams?cursor=${teamId}`, { accessType: "server" });
  expect(cursorWithoutLimit).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "\`cursor\` requires \`limit\` to also be set.",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  for (const limit of ["0", "201", "-1", "1.5"]) {
    const response = await niceBackendFetch(`/api/v1/teams?limit=${limit}`, { accessType: "server" });
    expect(response.status).toBe(400);
  }
  for (const cursor of [
    "", "null", "undefined", "not-a-cursor", "123", `abc_${teamId}`, `123_not-a-uuid`, `-5_${teamId}`, `1.5_${teamId}`,
    ` 1_${teamId}`, `1_${teamId}\n`, `1_${teamId}_x`,
    // Digit strings past the largest valid Date (8.64e15 ms) must be rejected, not turned into an Invalid Date.
    `8640000000000001_${teamId}`, `99999999999999999999_${teamId}`, `${"9".repeat(400)}_${teamId}`,
  ]) {
    const response = await niceBackendFetch(`/api/v1/teams?limit=5&cursor=${encodeURIComponent(cursor)}`, { accessType: "server" });
    expect(response.status).toBe(400);
  }
});

it("accepts cursors at the edges of the valid range and in any letter case", async ({ expect }) => {
  await Project.createAndSwitch();
  const ids = await createTeams(3, () => ({}), 1);
  const listIds = async (query: string) => {
    const response = await niceBackendFetch(`/api/v1/teams?${query}`, { accessType: "server" });
    expect(response.status).toBe(200);
    return { ids: response.body.items.map((team: { id: string }) => team.id), nextCursor: response.body.pagination.next_cursor };
  };
  const minCursor = encodeURIComponent("0_00000000-0000-0000-0000-000000000000");
  const maxCursor = encodeURIComponent("8640000000000000_ffffffff-ffff-ffff-ffff-ffffffffffff");

  expect(await listIds(`limit=10&cursor=${minCursor}`)).toEqual({ ids, nextCursor: null });
  expect(await listIds(`limit=10&cursor=${maxCursor}`)).toEqual({ ids: [], nextCursor: null });
  expect(await listIds(`desc=true&limit=10&cursor=${maxCursor}`)).toEqual({ ids: [...ids].reverse(), nextCursor: null });
  expect(await listIds(`desc=true&limit=10&cursor=${minCursor}`)).toEqual({ ids: [], nextCursor: null });

  const { nextCursor } = await listIds("limit=1");
  expect(await listIds(`limit=10&cursor=${encodeURIComponent(nextCursor.toUpperCase())}`)).toEqual({ ids: ids.slice(1), nextCursor: null });
  // Legacy bare-ID cursors were validated case-insensitively before positions were encoded, so they still are.
  expect(await listIds(`limit=10&cursor=${ids[0].toUpperCase()}`)).toEqual({ ids: ids.slice(1), nextCursor: null });
});

it("returns no trailing empty page when the total is a multiple of the limit", async ({ expect }) => {
  await Project.createAndSwitch();
  expect((await niceBackendFetch("/api/v1/teams?limit=5", { accessType: "server" })).body).toEqual({ items: [], is_paginated: true, pagination: { next_cursor: null } });
  expect((await niceBackendFetch("/api/v1/teams", { accessType: "server" })).body).toEqual({ items: [], is_paginated: false });

  const ids = await createTeams(12, () => ({}), 1);
  for (const limit of [1, 3, 4, 6, 11, 12, 13]) {
    let cursor: string | null = null;
    const seen: string[] = [];
    let pages = 0;
    do {
      const response: { body: { items: { id: string }[], pagination: { next_cursor: string | null } } } = await niceBackendFetch(`/api/v1/teams?limit=${limit}${cursor == null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`, { accessType: "server" });
      expect(response.body.items.length).toBeGreaterThan(0);
      seen.push(...response.body.items.map((team) => team.id));
      cursor = response.body.pagination.next_cursor;
      pages++;
    } while (cursor != null);
    expect(seen, `limit=${limit}`).toEqual(ids);
    expect(pages, `limit=${limit}`).toBe(Math.ceil(12 / limit));
  }
}, 120_000);

it("pages through teams with identical created_at timestamps, ties broken by team ID", async ({ expect }) => {
  const { projectId } = await Project.createAndSwitch();
  const ids = await createTeams(30);
  // Teams created via the API rarely share a millisecond, so force tie groups that straddle page boundaries.
  const order = await withInternalDatabase(async (client) => {
    const tenancyId = (await client.query(`SELECT id FROM "Tenancy" WHERE "projectId" = $1 AND "branchId" = 'main'`, [projectId])).rows[0].id;
    await client.query(`UPDATE "Team" SET "createdAt" = '2020-01-01 00:00:00.123' WHERE "tenancyId" = $1 AND "teamId" = ANY($2::uuid[])`, [tenancyId, ids.slice(0, 20)]);
    await client.query(`UPDATE "Team" SET "createdAt" = '2020-01-01 00:00:00.124' WHERE "tenancyId" = $1 AND "teamId" = ANY($2::uuid[])`, [tenancyId, ids.slice(20)]);
    const rows = await client.query(`SELECT "teamId" FROM "Team" WHERE "tenancyId" = $1 ORDER BY "createdAt", "teamId"`, [tenancyId]);
    return rows.rows.map((row) => row.teamId);
  });

  for (const limit of [1, 7, 19, 20, 21]) {
    expect(await listAllTeamIds("order_by=created_at", limit), `limit=${limit}`).toEqual(order);
    expect(await listAllTeamIds("order_by=created_at&desc=true", limit), `desc limit=${limit}`).toEqual([...order].reverse());
  }

  // Deleting a cursor team in the middle of a tie group doesn't skip or repeat its tied neighbours.
  const page = await niceBackendFetch("/api/v1/teams?limit=10", { accessType: "server" });
  expect((await niceBackendFetch(`/api/v1/teams/${order[9]}`, { accessType: "server", method: "DELETE" })).status).toBe(200);
  const rest = await niceBackendFetch(`/api/v1/teams?limit=200&cursor=${encodeURIComponent(page.body.pagination.next_cursor)}`, { accessType: "server" });
  expect(rest.body.items.map((team: { id: string }) => team.id)).toEqual(order.slice(10));
}, 120_000);

it("returns an empty last page when every team after the cursor was deleted", async ({ expect }) => {
  await Project.createAndSwitch();
  const ids = await createTeams(5, () => ({}), 1);
  const page = await niceBackendFetch("/api/v1/teams?limit=2", { accessType: "server" });
  for (const teamId of ids.slice(1)) {
    expect((await niceBackendFetch(`/api/v1/teams/${teamId}`, { accessType: "server", method: "DELETE" })).status).toBe(200);
  }
  const rest = await niceBackendFetch(`/api/v1/teams?limit=2&cursor=${encodeURIComponent(page.body.pagination.next_cursor)}`, { accessType: "server" });
  expect(rest.body).toEqual({ items: [], is_paginated: true, pagination: { next_cursor: null } });
});

it("does not drop teams when the cursor team stops matching the filters between pages", async ({ expect }) => {
  await Project.createAndSwitch();
  const { userId } = await Auth.fastSignUp();
  const ids = await createTeams(5, (i) => ({ display_name: `Paged ${i}`, creator_user_id: userId }), 1);

  const page1 = await niceBackendFetch(`/api/v1/teams?user_id=me&limit=1`, { accessType: "client" });
  expect(page1.body.items.map((team: { id: string }) => team.id)).toEqual([ids[0]]);
  const cursor = page1.body.pagination.next_cursor;

  // The user leaves the cursor team, so it no longer matches the user_id filter.
  const leave = await niceBackendFetch(`/api/v1/team-memberships/${ids[0]}/${userId}`, { accessType: "server", method: "DELETE" });
  expect(leave.status).toBe(200);
  const afterLeave = await niceBackendFetch(`/api/v1/teams?user_id=me&limit=10&cursor=${cursor}`, { accessType: "client" });
  expect(afterLeave.status).toBe(200);
  expect(afterLeave.body.items.map((team: { id: string }) => team.id)).toEqual(ids.slice(1));

  // The cursor team is renamed so it no longer matches `query`. This and the descending case below use legacy cursors
  // (bare team IDs, the format before positions were encoded), which must keep working.
  const rename = await niceBackendFetch(`/api/v1/teams/${ids[1]}`, { accessType: "server", method: "PATCH", body: { display_name: "Renamed" } });
  expect(rename.status).toBe(200);
  const afterRename = await niceBackendFetch(`/api/v1/teams?user_id=me&query=paged&limit=10&cursor=${ids[1]}`, { accessType: "client" });
  expect(afterRename.body.items.map((team: { id: string }) => team.id)).toEqual(ids.slice(2));

  // Descending pages resume from the same position.
  const descending = await niceBackendFetch(`/api/v1/teams?user_id=me&desc=true&limit=10&cursor=${ids[3]}`, { accessType: "client" });
  expect(descending.body.items.map((team: { id: string }) => team.id)).toEqual([ids[2], ids[1]]);
});

it("keeps paginating from a cursor after its team is deleted, in both directions", async ({ expect }) => {
  await Project.createAndSwitch();
  const ids = await createTeams(4, () => ({}), 1);

  const ascending = await niceBackendFetch(`/api/v1/teams?limit=2`, { accessType: "server" });
  expect(ascending.body.items.map((team: { id: string }) => team.id)).toEqual(ids.slice(0, 2));
  const descending = await niceBackendFetch(`/api/v1/teams?desc=true&limit=2`, { accessType: "server" });
  expect(descending.body.items.map((team: { id: string }) => team.id)).toEqual([ids[3], ids[2]]);

  for (const teamId of [ids[1], ids[2]]) {
    const del = await niceBackendFetch(`/api/v1/teams/${teamId}`, { accessType: "server", method: "DELETE" });
    expect(del.status).toBe(200);
  }

  const ascendingRest = await niceBackendFetch(`/api/v1/teams?limit=10&cursor=${encodeURIComponent(ascending.body.pagination.next_cursor)}`, { accessType: "server" });
  expect(ascendingRest.status).toBe(200);
  expect(ascendingRest.body.items.map((team: { id: string }) => team.id)).toEqual([ids[3]]);
  const descendingRest = await niceBackendFetch(`/api/v1/teams?desc=true&limit=10&cursor=${encodeURIComponent(descending.body.pagination.next_cursor)}`, { accessType: "server" });
  expect(descendingRest.status).toBe(200);
  expect(descendingRest.body.items.map((team: { id: string }) => team.id)).toEqual([ids[0]]);
});

it("rejects a legacy (bare team ID) cursor whose team was deleted", async ({ expect }) => {
  await Project.createAndSwitch();
  const [teamId] = await createTeams(2);
  const del = await niceBackendFetch(`/api/v1/teams/${teamId}`, { accessType: "server", method: "DELETE" });
  expect(del.status).toBe(200);

  const response = await niceBackendFetch(`/api/v1/teams?limit=10&cursor=${teamId}`, { accessType: "server" });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "The team referenced by \`cursor\` does not exist (it may have been deleted). Restart pagination without a cursor.",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("creates a team on the client", async ({ expect }) => {
  await Auth.fastSignUp();
  await Team.createWithCurrentAsCreator();
});

it("does not allow creating a team when not signed in", async ({ expect }) => {
  const { userId } = await Auth.fastSignUp();
  await Auth.signOut();
  const response = await niceBackendFetch("/api/v1/teams", {
    accessType: "client",
    method: "POST",
    body: {
      display_name: "New Team",
      creator_user_id: userId,
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 401,
      "body": {
        "code": "USER_AUTHENTICATION_REQUIRED",
        "error": "User authentication required for this endpoint.",
      },
      "headers": Headers {
        "x-stack-known-error": "USER_AUTHENTICATION_REQUIRED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("does not allow creating teams on the client for a different creator", async ({ expect }) => {
  await Project.createAndSwitch({ config: { client_team_creation_enabled: true } });
  const { userId: userId1 } = await Auth.fastSignUp();
  await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/v1/teams", {
    accessType: "client",
    method: "POST",
    body: {
      display_name: "New Team",
      creator_user_id: userId1,
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 403,
      "body": "You cannot create a team as a user that is not yourself. Make sure you set the creator_user_id to 'me'.",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("creates a team on the server", async ({ expect }) => {
  await Auth.fastSignUp();
  await Team.createWithCurrentAsCreator({ accessType: "server" });
});

it("creates a team on the server without a creator", async ({ expect }) => {
  await Auth.fastSignUp();
  await Team.create({ accessType: "server" });
});

it("creates a team with a specific creator user id", async ({ expect }) => {
  const { userId } = await Auth.fastSignUp();
  await Team.create({ accessType: "server", creatorUserId: userId });
});

it("does not create a team when the creator user id does not exist", async ({ expect }) => {
  await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/v1/teams", {
    accessType: "server",
    method: "POST",
    body: {
      display_name: "New Team",
      creator_user_id: "12345678-1234-4234-9234-123456789012",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 404,
      "body": {
        "code": "USER_NOT_FOUND",
        "error": "User not found.",
      },
      "headers": Headers {
        "x-stack-known-error": "USER_NOT_FOUND",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("gets a specific team on the client", async ({ expect }) => {
  await Auth.fastSignUp();
  const { createTeamResponse: response, teamId } = await Team.createWithCurrentAsCreator();
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "client_metadata": null,
        "client_read_only_metadata": null,
        "created_at_millis": <stripped field 'created_at_millis'>,
        "display_name": "New Team",
        "id": "<stripped UUID>",
        "profile_image_url": null,
        "server_metadata": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const response2 = await niceBackendFetch(`/api/v1/teams/${teamId}`, { accessType: "client" });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "client_metadata": null,
        "client_read_only_metadata": null,
        "display_name": "New Team",
        "id": "<stripped UUID>",
        "profile_image_url": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("gets a specific team that the user is not part of on the client", async ({ expect }) => {
  await Auth.fastSignUp();
  const { createTeamResponse: response, teamId } = await Team.createWithCurrentAsCreator();

  await Auth.fastSignUp();

  const response2 = await niceBackendFetch(`/api/v1/teams/${teamId}`, { accessType: "client" });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 404,
      "body": {
        "code": "TEAM_MEMBERSHIP_NOT_FOUND",
        "details": {
          "team_id": "<stripped UUID>",
          "user_id": "<stripped UUID>",
        },
        "error": "User <stripped UUID> is not found in team <stripped UUID>.",
      },
      "headers": Headers {
        "x-stack-known-error": "TEAM_MEMBERSHIP_NOT_FOUND",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("gets a team that the user is not part of on the server", async ({ expect }) => {
  await Auth.fastSignUp();
  const { teamId } = await Team.createWithCurrentAsCreator();

  await Auth.fastSignUp();
  const { createTeamResponse: response } = await Team.createWithCurrentAsCreator();
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "client_metadata": null,
        "client_read_only_metadata": null,
        "created_at_millis": <stripped field 'created_at_millis'>,
        "display_name": "New Team",
        "id": "<stripped UUID>",
        "profile_image_url": null,
        "server_metadata": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const response3 = await niceBackendFetch(`/api/v1/teams/${teamId}`, { accessType: "server" });
  expect(response3).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "client_metadata": null,
        "client_read_only_metadata": null,
        "created_at_millis": <stripped field 'created_at_millis'>,
        "display_name": "New Team",
        "id": "<stripped UUID>",
        "profile_image_url": null,
        "server_metadata": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should not be allowed to get a team that the user is not part of on the client", async ({ expect }) => {
  await Auth.fastSignUp();
  const { teamId } = await Team.createWithCurrentAsCreator();

  await Auth.fastSignUp();
  const { createTeamResponse: response } = await Team.createWithCurrentAsCreator();
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "client_metadata": null,
        "client_read_only_metadata": null,
        "created_at_millis": <stripped field 'created_at_millis'>,
        "display_name": "New Team",
        "id": "<stripped UUID>",
        "profile_image_url": null,
        "server_metadata": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const response3 = await niceBackendFetch(`/api/v1/teams/${teamId}`, { accessType: "client" });
  expect(response3).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 404,
      "body": {
        "code": "TEAM_MEMBERSHIP_NOT_FOUND",
        "details": {
          "team_id": "<stripped UUID>",
          "user_id": "<stripped UUID>",
        },
        "error": "User <stripped UUID> is not found in team <stripped UUID>.",
      },
      "headers": Headers {
        "x-stack-known-error": "TEAM_MEMBERSHIP_NOT_FOUND",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("updates a team on the client", async ({ expect }) => {
  const { userId } = await Auth.fastSignUp();
  const { teamId } = await Team.createWithCurrentAsCreator();

  // grant permission to update a team
  await niceBackendFetch(`/api/v1/team-permissions/${teamId}/${userId}/$update_team`, {
    accessType: "server",
    method: "POST",
    body: {},
  });

  // Has permission to update a team
  const response2 = await niceBackendFetch(`/api/v1/teams/${teamId}`, {
    accessType: "client",
    method: "PATCH",
    body: {
      display_name: "My Updated Team",
    },
  });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "client_metadata": null,
        "client_read_only_metadata": null,
        "display_name": "My Updated Team",
        "id": "<stripped UUID>",
        "profile_image_url": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("can set a team's display name to the empty string", async ({ expect }) => {
  const { userId } = await Auth.fastSignUp();
  const { teamId } = await Team.createWithCurrentAsCreator();

  // grant permission to update a team
  await niceBackendFetch(`/api/v1/team-permissions/${teamId}/${userId}/$update_team`, {
    accessType: "server",
    method: "POST",
    body: {},
  });

  // Has permission to update a team
  const response2 = await niceBackendFetch(`/api/v1/teams/${teamId}`, {
    accessType: "client",
    method: "PATCH",
    body: {
      display_name: "",
    },
  });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "client_metadata": null,
        "client_read_only_metadata": null,
        "display_name": "",
        "id": "<stripped UUID>",
        "profile_image_url": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("updates team client metadata on the client", async ({ expect }) => {
  const { userId } = await Auth.fastSignUp();
  const { teamId } = await Team.createWithCurrentAsCreator();

  // grant permission to update a team
  await niceBackendFetch(`/api/v1/team-permissions/${teamId}/${userId}/$update_team`, {
    accessType: "server",
    method: "POST",
    body: {},
  });

  // Has permission to update a team
  const response2 = await niceBackendFetch(`/api/v1/teams/${teamId}`, {
    accessType: "client",
    method: "PATCH",
    body: {
      client_metadata: {
        test: "test-value"
      },
    },
  });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "client_metadata": { "test": "test-value" },
        "client_read_only_metadata": null,
        "display_name": "New Team",
        "id": "<stripped UUID>",
        "profile_image_url": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should not be able to update team client read only metadata on the client", async ({ expect }) => {
  const { userId } = await Auth.fastSignUp();
  const { teamId } = await Team.createWithCurrentAsCreator();

  // grant permission to update a team
  await niceBackendFetch(`/api/v1/team-permissions/${teamId}/${userId}/$update_team`, {
    accessType: "server",
    method: "POST",
    body: {},
  });

  // Has permission to update a team
  const response2 = await niceBackendFetch(`/api/v1/teams/${teamId}`, {
    accessType: "client",
    method: "PATCH",
    body: {
      client_read_only_metadata: {
        test: "test-value"
      },
    },
  });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on PATCH /api/v1/teams/<stripped UUID>:
              - body contains unknown properties: client_read_only_metadata
          \`,
        },
        "error": deindent\`
          Request validation failed on PATCH /api/v1/teams/<stripped UUID>:
            - body contains unknown properties: client_read_only_metadata
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should not update a team without permission on the client", async ({ expect }) => {
  const { userId } = await Auth.fastSignUp();
  const { teamId } = await Team.create();

  // add user to the team
  await Team.addMember(teamId, userId);

  // Does not have permission to update a team
  const response1 = await niceBackendFetch(`/api/v1/teams/${teamId}`, {
    accessType: "client",
    method: "PATCH",
    body: {
      display_name: "My Updated Team",
    },
  });
  expect(response1).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 401,
      "body": {
        "code": "TEAM_PERMISSION_REQUIRED",
        "details": {
          "permission_id": "$update_team",
          "team_id": "<stripped UUID>",
          "user_id": "<stripped UUID>",
        },
        "error": "User <stripped UUID> does not have permission $update_team in team <stripped UUID>.",
      },
      "headers": Headers {
        "x-stack-known-error": "TEAM_PERMISSION_REQUIRED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("updates a team on the server", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.fastSignUp();
  const { teamId } = await Team.createWithCurrentAsCreator({ accessType: "server" });

  const response1 = await niceBackendFetch(`/api/v1/teams/${teamId}`, {
    accessType: "server",
    method: "PATCH",
    body: {
      display_name: "My Updated Team",
      profile_image_url: "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
      server_metadata: {
        "test": "test-value"
      },
    },
  });
  expect(response1).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "client_metadata": null,
        "client_read_only_metadata": null,
        "created_at_millis": <stripped field 'created_at_millis'>,
        "display_name": "My Updated Team",
        "id": "<stripped UUID>",
        "profile_image_url": "http://localhost:<$NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX>21/stack-storage/team-profile-images/<stripped UUID>.gif",
        "server_metadata": { "test": "test-value" },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const response2 = await niceBackendFetch("/api/v1/teams?user_id=me", { accessType: "server" });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [
          {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "created_at_millis": <stripped field 'created_at_millis'>,
            "display_name": "My Updated Team",
            "id": "<stripped UUID>",
            "profile_image_url": "http://localhost:<$NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX>21/stack-storage/team-profile-images/<stripped UUID>.gif",
            "server_metadata": { "test": "test-value" },
          },
        ],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("updates team client read only metadata on the server", async ({ expect }) => {
  await Auth.fastSignUp();
  const { teamId } = await Team.createWithCurrentAsCreator({ accessType: "server" });

  const response1 = await niceBackendFetch(`/api/v1/teams/${teamId}`, {
    accessType: "server",
    method: "PATCH",
    body: {
      client_read_only_metadata: {
        test: "test-value"
      },
    },
  });
  expect(response1).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "client_metadata": null,
        "client_read_only_metadata": { "test": "test-value" },
        "created_at_millis": <stripped field 'created_at_millis'>,
        "display_name": "New Team",
        "id": "<stripped UUID>",
        "profile_image_url": null,
        "server_metadata": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // check on the client
  const response2 = await niceBackendFetch(`/api/v1/teams/${teamId}`, { accessType: "client" });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "client_metadata": null,
        "client_read_only_metadata": { "test": "test-value" },
        "display_name": "New Team",
        "id": "<stripped UUID>",
        "profile_image_url": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("deletes a team on the client", async ({ expect }) => {
  const { userId } = await Auth.fastSignUp();
  const { teamId } = await Team.createWithCurrentAsCreator();

  // grant permission to delete a team
  await niceBackendFetch(`/api/v1/team-permissions/${teamId}/${userId}/$delete_team`, {
    accessType: "server",
    method: "POST",
    body: {},
  });

  // Has permission to delete a team
  const response2 = await niceBackendFetch(`/api/v1/teams/${teamId}`, {
    accessType: "client",
    method: "DELETE",
    body: {
      display_name: "My Updated Team",
    },
  });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "success": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should not delete a team without permission on the client", async ({ expect }) => {
  const { userId } = await Auth.fastSignUp();
  const { teamId } = await Team.create();

  // add user to the team
  await Team.addMember(teamId, userId);

  // Does not have permission to delete a team
  const response1 = await niceBackendFetch(`/api/v1/teams/${teamId}`, {
    accessType: "client",
    method: "DELETE",
    body: {
      display_name: "My Updated Team",
    },
  });
  expect(response1).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 401,
      "body": {
        "code": "TEAM_PERMISSION_REQUIRED",
        "details": {
          "permission_id": "$delete_team",
          "team_id": "<stripped UUID>",
          "user_id": "<stripped UUID>",
        },
        "error": "User <stripped UUID> does not have permission $delete_team in team <stripped UUID>.",
      },
      "headers": Headers {
        "x-stack-known-error": "TEAM_PERMISSION_REQUIRED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("deletes a team on the server", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.fastSignUp();
  const { teamId } = await Team.createWithCurrentAsCreator({ accessType: "server" });

  const response1 = await niceBackendFetch(`/api/v1/teams/${teamId}`, {
    accessType: "server",
    method: "DELETE",
    body: {},
  });
  expect(response1).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "success": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const response2 = await niceBackendFetch("/api/v1/teams?user_id=me", { accessType: "server" });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("enables create team on sign up", async ({ expect }) => {
  const { adminAccessToken } = await Project.createAndGetAdminToken();
  const response = await niceBackendFetch("/api/v1/internal/projects/current", {
    accessType: "admin",
    method: "PATCH",
    body: {
      config: {
        create_team_on_sign_up: true,
        magic_link_enabled: true,
      }
    },
    headers: {
      "x-stack-admin-access-token": adminAccessToken,
    },
  });

  expect(response.body.config.create_team_on_sign_up).toBe(true);

  await InternalApiKey.createAndSetProjectKeys(adminAccessToken);

  await bumpEmailAddress();
  await Auth.fastSignUp();

  const response2 = await niceBackendFetch("/api/v1/teams?user_id=me", { accessType: "server" });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [
          {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "created_at_millis": <stripped field 'created_at_millis'>,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
            "server_metadata": null,
          },
        ],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should trigger team webhook when a team is created", async ({ expect }) => {
  const { projectId, svixToken, endpointId } = await Webhook.createProjectWithEndpoint();

  const createTeamResponse = await niceBackendFetch("/api/v1/teams", {
    method: "POST",
    accessType: "server",
    body: {
      display_name: "Test Team"
    }
  });
  expect(createTeamResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "client_metadata": null,
        "client_read_only_metadata": null,
        "created_at_millis": <stripped field 'created_at_millis'>,
        "display_name": "Test Team",
        "id": "<stripped UUID>",
        "profile_image_url": null,
        "server_metadata": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const attemptResponse = await Webhook.findWebhookAttempt(projectId, endpointId, svixToken, event => true);

  expect(attemptResponse).toMatchInlineSnapshot(`
    {
      "channels": null,
      "eventId": null,
      "eventType": "team.created",
      "id": "<stripped svix message id>",
      "payload": {
        "data": {
          "client_metadata": null,
          "client_read_only_metadata": null,
          "created_at_millis": <stripped field 'created_at_millis'>,
          "display_name": "Test Team",
          "id": "<stripped UUID>",
          "profile_image_url": null,
          "server_metadata": null,
        },
        "type": "team.created",
      },
      "timestamp": <stripped field 'timestamp'>,
    }
  `);
});

it("should trigger team webhook when a team is updated", async ({ expect }) => {
  const { projectId, svixToken, endpointId } = await Webhook.createProjectWithEndpoint();

  const createTeamResponse = await niceBackendFetch("/api/v1/teams", {
    method: "POST",
    accessType: "server",
    body: {
      display_name: "Test Team"
    }
  });

  expect(createTeamResponse.status).toBe(201);
  const teamId = createTeamResponse.body.id;

  const updateTeamResponse = await niceBackendFetch(`/api/v1/teams/${teamId}`, {
    method: "PATCH",
    accessType: "server",
    body: {
      display_name: "Updated Team Name"
    }
  });

  expect(updateTeamResponse.status).toBe(200);

  const teamUpdatedEvent = await Webhook.findWebhookAttempt(projectId, endpointId, svixToken, event => event.eventType === "team.updated");

  expect(teamUpdatedEvent).toMatchInlineSnapshot(`
    {
      "channels": null,
      "eventId": null,
      "eventType": "team.updated",
      "id": "<stripped svix message id>",
      "payload": {
        "data": {
          "client_metadata": null,
          "client_read_only_metadata": null,
          "created_at_millis": <stripped field 'created_at_millis'>,
          "display_name": "Updated Team Name",
          "id": "<stripped UUID>",
          "profile_image_url": null,
          "server_metadata": null,
        },
        "type": "team.updated",
      },
      "timestamp": <stripped field 'timestamp'>,
    }
  `);
});

it("should trigger team webhook when a team is deleted", async ({ expect }) => {
  const { projectId, svixToken, endpointId } = await Webhook.createProjectWithEndpoint();

  const createTeamResponse = await niceBackendFetch("/api/v1/teams", {
    method: "POST",
    accessType: "server",
    body: {
      display_name: "Test Team"
    }
  });

  expect(createTeamResponse.status).toBe(201);
  const teamId = createTeamResponse.body.id;

  const deleteTeamResponse = await niceBackendFetch(`/api/v1/teams/${teamId}`, {
    method: "DELETE",
    accessType: "server"
  });

  expect(deleteTeamResponse.status).toBe(200);

  const teamDeletedEvent = await Webhook.findWebhookAttempt(projectId, endpointId, svixToken, event => event.eventType === "team.deleted");

  expect(teamDeletedEvent).toMatchInlineSnapshot(`
    {
      "channels": null,
      "eventId": null,
      "eventType": "team.deleted",
      "id": "<stripped svix message id>",
      "payload": {
        "data": { "id": "<stripped UUID>" },
        "type": "team.deleted",
      },
      "timestamp": <stripped field 'timestamp'>,
    }
  `);
});
