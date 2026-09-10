import { it } from "../helpers";
import { localhostUrl } from "../helpers/ports";

it("renders the dashboard root so the SDK can consume browser actions before navigation", async ({ expect }) => {
  const url = new URL(localhostUrl("01"));
  url.searchParams.set("hexclave_action_id", "test-action");
  const response = await fetch(url, { redirect: "manual" });

  expect(response.status).toMatchInlineSnapshot(`200`);
  expect(response.headers.get("location")).toMatchInlineSnapshot(`null`);
});
