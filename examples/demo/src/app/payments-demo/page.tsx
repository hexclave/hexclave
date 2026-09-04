"use client";

import { useStackApp, useUser } from "@hexclave/next";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { Button, Card, CardContent, CardFooter, CardHeader, Input, Typography } from "@hexclave/ui";
import Link from "next/link";
import { useMemo, useState } from "react";

type ActionResult = {
  label: string,
  detail: string,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatDate(value: Date | null): string {
  if (value === null) {
    return "none";
  }
  return value.toLocaleString();
}

async function readJson(response: Response): Promise<unknown> {
  const value: unknown = await response.json();
  if (!response.ok) {
    if (isRecord(value) && typeof value.error === "string") {
      throw new Error(value.error);
    }
    throw new Error(`Request failed with ${response.status}`);
  }
  return value;
}

async function createCheckoutUrl(options: { teamId: string, productId: "team_pro" | "extra_seats", returnUrl: string }): Promise<string> {
  const response = await fetch("/payments-demo/api/create-checkout-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  const data = await readJson(response);
  const url = readStringField(data, "url");
  if (url === null) {
    throw new Error("Checkout route returned an invalid response.");
  }
  return url;
}

function resolveTeamPlan(products: ReadonlyArray<{ id: string | null, type?: string }>): string {
  const activeSubscriptionIds = new Set(
    products.filter((p) => p.type === "subscription" && p.id != null).map((p) => p.id),
  );
  return activeSubscriptionIds.has("team_pro") ? "team_pro" : "none";
}

function ProductList(props: { team: ReturnType<NonNullable<ReturnType<typeof useUser>>["useTeams"]>[number] }) {
  const products = props.team.useProducts();
  const seats = props.team.useItem("seats");
  const activePlan = resolveTeamPlan(products);

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <Typography type="h3">{props.team.displayName}</Typography>
            <Typography className="text-sm text-gray-600 dark:text-gray-400">
              {props.team.id}
            </Typography>
          </div>
          <div className="rounded-md border px-3 py-2 text-sm">
            <div className="font-semibold uppercase tracking-wide">{activePlan}</div>
            <div className="text-gray-600 dark:text-gray-400">active plan</div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Metric label="Seats granted" value={seats.quantity.toLocaleString()} />
          <Metric label="Seats available" value={seats.nonNegativeQuantity.toLocaleString()} />
        </div>

        <div className="overflow-auto rounded-md border">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-gray-50 text-gray-700 dark:bg-gray-900 dark:text-gray-300">
              <tr>
                <th className="px-3 py-2 font-medium">Product</th>
                <th className="px-3 py-2 font-medium">Quantity</th>
                <th className="px-3 py-2 font-medium">Subscription</th>
                <th className="px-3 py-2 font-medium">Period end</th>
                <th className="px-3 py-2 font-medium">Cancelable</th>
              </tr>
            </thead>
            <tbody>
              {products.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-gray-600 dark:text-gray-400">
                    No products returned yet. Wait a few seconds after team creation, then refresh.
                  </td>
                </tr>
              ) : products.map((product, index) => (
                <tr key={`${product.id ?? "inline"}-${index}`} className="border-t">
                  <td className="px-3 py-2">
                    <div className="font-medium">{product.displayName}</div>
                    <div className="font-mono text-xs text-gray-600 dark:text-gray-400">{product.id ?? "inline"}</div>
                  </td>
                  <td className="px-3 py-2">{product.quantity}</td>
                  <td className="px-3 py-2">
                    {product.subscription === null ? "none" : (
                      product.subscription.cancelAtPeriodEnd ? "canceling at period end" : "active"
                    )}
                  </td>
                  <td className="px-3 py-2">{product.subscription === null ? "none" : formatDate(product.subscription.currentPeriodEnd)}</td>
                  <td className="px-3 py-2">{product.subscription?.isCancelable ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <CheckoutButton team={props.team} productId="team_pro" label="Buy Team Pro" />
        <CheckoutButton team={props.team} productId="extra_seats" label="Buy Extra Seat (add-on)" />
      </CardFooter>
    </Card>
  );
}

function Metric(props: { label: string, value: string }) {
  return (
    <div className="rounded-md border bg-white p-3 dark:bg-black">
      <div className="text-xl font-semibold">{props.value}</div>
      <div className="text-sm text-gray-600 dark:text-gray-400">{props.label}</div>
    </div>
  );
}

function CheckoutButton(props: {
  team: ReturnType<NonNullable<ReturnType<typeof useUser>>["useTeams"]>[number],
  productId: "team_pro" | "extra_seats",
  label: string,
}) {
  const [loading, setLoading] = useState(false);

  return (
    <Button
      disabled={loading}
      onClick={() => runAsynchronouslyWithAlert(async () => {
        setLoading(true);
        try {
          const checkoutUrl = await createCheckoutUrl({
            teamId: props.team.id,
            productId: props.productId,
            returnUrl: window.location.href,
          });
          window.location.assign(checkoutUrl);
        } finally {
          setLoading(false);
        }
      })}
    >
      {loading ? "Opening..." : props.label}
    </Button>
  );
}

export default function PaymentsDemoPage() {
  const app = useStackApp();
  const project = app.useProject();
  const user = useUser({ or: "redirect" });
  const teams = user.useTeams();
  const [teamName, setTeamName] = useState(() => `Payments demo ${new Date().toISOString()}`);
  const [emailCount, setEmailCount] = useState("1");
  const [result, setResult] = useState<ActionResult | null>(null);
  const internalDashboardUrl = useMemo(() => {
    const portPrefix = process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX ?? "81";
    const host = portPrefix === "91" ? "a.localhost" : portPrefix === "92" ? "b.localhost" : portPrefix === "93" ? "c.localhost" : "localhost";
    return `http://${host}:${portPrefix}01/projects/internal`;
  }, []);

  const createTeam = async () => {
    const trimmedName = teamName.trim();
    if (trimmedName === "") {
      throw new Error("Team name is required.");
    }
    const team = await user.createTeam({ displayName: trimmedName });
    await user.setSelectedTeam(team);
    setResult({
      label: "Created team",
      detail: `${team.displayName} (${team.id}). The team starts with no products — buy Team Pro below to start a subscription.`,
    });
    setTeamName(`Payments demo ${new Date().toISOString()}`);
  };

  const sendTestEmails = async () => {
    const count = Number(emailCount);
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      throw new Error("Email count must be an integer between 1 and 10.");
    }
    const response = await fetch("/payments-demo/api/send-test-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count }),
    });
    const data = await readJson(response);
    setResult({
      label: "Sent test emails",
      detail: stringifyJson(data),
    });
  };

  const runConfigCheck = async () => {
    const response = await fetch("/payments-demo/api/config-check");
    const data = await readJson(response);
    setResult({
      label: "Config check",
      detail: stringifyJson(data),
    });
  };

  return (
    <main className="w-full bg-gray-50 p-4 dark:bg-neutral-950 md:p-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <Typography type="h1">Payments Demo</Typography>
            <Typography className="max-w-3xl text-gray-600 dark:text-gray-400">
              Manual test surface for the demo team plans (Team Pro + Extra Seats add-on), Stripe checkout, subscription ending, and seat item quantities.
            </Typography>
          </div>
          <Link className="text-sm font-medium underline" href={internalDashboardUrl}>
            Open internal project dashboard
          </Link>
        </div>

        <Card>
          <CardHeader>
            <Typography type="h3">Test Flow</Typography>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <Input value={teamName} onChange={(e) => setTeamName(e.target.value)} />
              <Button onClick={() => runAsynchronouslyWithAlert(createTeam)}>Create team and select it</Button>
            </div>

            <div className="grid gap-3 md:grid-cols-[160px_auto_1fr]">
              <Input value={emailCount} onChange={(e) => setEmailCount(e.target.value)} inputMode="numeric" />
              <Button onClick={() => runAsynchronouslyWithAlert(sendTestEmails)}>Send test emails</Button>
              <Button variant="secondary" onClick={() => runAsynchronouslyWithAlert(runConfigCheck)}>
                Check free/config guardrails
              </Button>
            </div>

            <div className="rounded-md border bg-white p-3 text-sm dark:bg-black">
              <div><span className="font-medium">Project:</span> {project.displayName} ({project.id})</div>
              <div><span className="font-medium">Selected team:</span> {user.selectedTeam?.displayName ?? "none"}</div>
              <div><span className="font-medium">Manual Stripe end test:</span> buy Team Pro, end that customer subscription in Stripe Connect, wait for the webhook, then refresh here. The paid plan should disappear.</div>
            </div>

            {result && (
              <div className="rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950">
                <div className="font-medium">{result.label}</div>
                <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs">{result.detail}</pre>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-5">
          {teams.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-gray-600 dark:text-gray-400">
                Create a team to start the free-plan grant test.
              </CardContent>
            </Card>
          ) : teams.map((team) => (
            <ProductList key={team.id} team={team} />
          ))}
        </div>
      </div>
    </main>
  );
}
