// @vitest-environment jsdom

import { hexclaveAppInternalsSymbol, TvProfileRequestError } from "@/lib/hexclave-app-internals";
import { clearToasts, Toaster } from "@/components/ui";
import { getTvBuiltInProfile, type TvDisplayResource, type TvProfileResource } from "@hexclave/shared/dist/interface/admin-tv-mode";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatTvDisplayPairingCode, getPairingFailureNotice, TvDisplayManagement } from "./display-management";

const display: TvDisplayResource = {
  id: "3af6ca2f-20eb-4c6b-a8b2-8f93d940f037",
  displayName: "Office Display",
  profileId: "company-pulse",
  profileDisplayName: "Company Pulse",
  profileFinancialVisibility: "redacted",
  state: "online",
  pairedAt: "2026-08-15T12:00:00.000Z",
  lastSeenAt: "2026-08-15T12:00:05.000Z",
  exactFinancialsAcknowledged: false,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function dispatchPairingInput(input: HTMLInputElement, value: string, selectionStart: number, inputType: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (valueSetter == null) throw new Error("HTMLInputElement value setter is unavailable.");
  valueSetter.call(input, value);
  input.setSelectionRange(selectionStart, selectionStart);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
}

function approvalResponse(overrides: Partial<{ approvedAt: string, expiresAt: string }> = {}): Response {
  return jsonResponse({
    success: true,
    approvedAt: "2026-08-15T11:59:00.000Z",
    expiresAt: "2099-08-15T12:10:00.000Z",
    ...overrides,
  });
}

function getCompanyPulseProfile() {
  const profile = getTvBuiltInProfile("company-pulse");
  if (profile == null) throw new Error("Company Pulse profile is missing.");
  return profile;
}

function renderManagement(adminApp: object, profiles: TvProfileResource[] = [getCompanyPulseProfile()]) {
  return render(<><TvDisplayManagement adminApp={adminApp} profiles={profiles} /><Toaster /></>);
}

afterEach(() => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
});

describe("TV display pairing feedback", () => {
  it("starts with placeholders only and requires an entered display name", async () => {
    const sendRequest = vi.fn(async () => jsonResponse({ displays: [] }));
    renderManagement({ [hexclaveAppInternalsSymbol]: { sendRequest } });

    await screen.findByText("No Displays Paired Yet");
    const nameInput = screen.getByLabelText("Display name");
    const codeInput = screen.getByLabelText("Pairing code");
    expect(nameInput).toHaveProperty("value", "");
    expect(nameInput.getAttribute("placeholder")).toBe("Office Display");
    expect(codeInput).toHaveProperty("value", "");
    expect(codeInput.getAttribute("placeholder")).toBe("ABCD-EFGH");

    fireEvent.change(codeInput, { target: { value: "ABCD-EFGH" } });
    const pairButton = screen.getByRole("button", { name: "Pair Display" });
    expect(pairButton.hasAttribute("disabled")).toBe(true);
    fireEvent.change(nameInput, { target: { value: "   " } });
    expect(pairButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(pairButton);
    expect(sendRequest).toHaveBeenCalledTimes(1);

    fireEvent.change(nameInput, { target: { value: "Lobby TV" } });
    expect(pairButton.hasAttribute("disabled")).toBe(false);
  });

  it("clears both fields after each approval without reusing the previous display name", async () => {
    const submittedBodies: unknown[] = [];
    const adminApp = {
      [hexclaveAppInternalsSymbol]: {
        sendRequest: async (_path: string, options: RequestInit) => {
          if (options.method === "POST") {
            if (typeof options.body !== "string") throw new Error("Pairing request body must be JSON text.");
            submittedBodies.push(JSON.parse(options.body));
            return approvalResponse();
          }
          return jsonResponse({ displays: [] });
        },
      },
    };
    renderManagement(adminApp);
    await screen.findByText("No Displays Paired Yet");

    const nameInput = screen.getByLabelText("Display name");
    const codeInput = screen.getByLabelText("Pairing code");
    const pairButton = screen.getByRole("button", { name: "Pair Display" });
    for (const [index, name] of ["Lobby TV", "Kitchen TV"].entries()) {
      fireEvent.change(codeInput, { target: { value: "ABCD-EFGH" } });
      expect(pairButton.hasAttribute("disabled")).toBe(true);
      fireEvent.change(nameInput, { target: { value: `  ${name}  ` } });
      fireEvent.click(pairButton);

      await waitFor(() => expect(nameInput).toHaveProperty("value", ""));
      expect(codeInput).toHaveProperty("value", "");
      expect(nameInput.getAttribute("placeholder")).toBe("Office Display");
      expect(submittedBodies).toHaveLength(index + 1);
      expect(submittedBodies[index]).toMatchObject({ displayName: name });
    }
  });

  it("preserves the entered name and code when approval fails", async () => {
    const adminApp = {
      [hexclaveAppInternalsSymbol]: {
        sendRequest: async (_path: string, options: RequestInit) => {
          if (options.method === "POST") throw new TvProfileRequestError(400);
          return jsonResponse({ displays: [] });
        },
      },
    };
    renderManagement(adminApp);
    await screen.findByText("No Displays Paired Yet");
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "ABCD-EFGH" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Lobby TV" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair Display" }));

    await screen.findByText("Pairing Code Wasn’t Accepted");
    expect(screen.getByLabelText("Display name")).toHaveProperty("value", "Lobby TV");
    expect(screen.getByLabelText("Pairing code")).toHaveProperty("value", "ABCD-EFGH");
    expect(screen.getByRole("button", { name: "Pair Display" }).hasAttribute("disabled")).toBe(false);
  });

  it("formats typed and pasted pairing codes consistently", () => {
    expect(formatTvDisplayPairingCode("abcd")).toBe("ABCD");
    expect(formatTvDisplayPairingCode("abcde")).toBe("ABCD-E");
    expect(formatTvDisplayPairingCode("AB CD EF GH")).toBe("ABCD-EFGH");
    expect(formatTvDisplayPairingCode("abcd efgh extra")).toBe("ABCD-EFGH");
  });

  it("preserves the pairing-code caret when typing in the middle", async () => {
    const sendRequest = vi.fn(async () => jsonResponse({ displays: [] }));
    renderManagement({ [hexclaveAppInternalsSymbol]: { sendRequest } });
    const codeInput = await screen.findByLabelText<HTMLInputElement>("Pairing code");
    fireEvent.change(codeInput, { target: { value: "ABCD-EFGH" } });
    codeInput.setSelectionRange(2, 2);
    fireEvent.change(codeInput, { target: { value: "ABXCD-EFGH", selectionStart: 3, selectionEnd: 3 } });
    expect(codeInput).toHaveProperty("value", "ABXC-DEFG");
    expect(codeInput.selectionStart).toBe(3);
    expect(codeInput.selectionEnd).toBe(3);
  });

  it("deletes the character before the pairing-code separator", async () => {
    const sendRequest = vi.fn(async () => jsonResponse({ displays: [] }));
    renderManagement({ [hexclaveAppInternalsSymbol]: { sendRequest } });
    const codeInput = await screen.findByLabelText<HTMLInputElement>("Pairing code");
    fireEvent.change(codeInput, { target: { value: "ABCD-EFGH" } });
    dispatchPairingInput(codeInput, "ABCDEFGH", 4, "deleteContentBackward");
    expect(codeInput).toHaveProperty("value", "ABCE-FGH");
    expect(codeInput.selectionStart).toBe(3);
    expect(codeInput.selectionEnd).toBe(3);
  });

  it("preserves normal pairing-code character deletion", async () => {
    const sendRequest = vi.fn(async () => jsonResponse({ displays: [] }));
    renderManagement({ [hexclaveAppInternalsSymbol]: { sendRequest } });
    const codeInput = await screen.findByLabelText<HTMLInputElement>("Pairing code");
    fireEvent.change(codeInput, { target: { value: "ABCD-EFGH" } });
    dispatchPairingInput(codeInput, "ABC-EFGH", 3, "deleteContentBackward");
    expect(codeInput).toHaveProperty("value", "ABCE-FGH");
    expect(codeInput.selectionStart).toBe(3);
    expect(codeInput.selectionEnd).toBe(3);
  });

  it("preserves the character before the separator on forward delete", async () => {
    const sendRequest = vi.fn(async () => jsonResponse({ displays: [] }));
    renderManagement({ [hexclaveAppInternalsSymbol]: { sendRequest } });
    const codeInput = await screen.findByLabelText<HTMLInputElement>("Pairing code");
    fireEvent.change(codeInput, { target: { value: "ABCD-EFGH" } });
    dispatchPairingInput(codeInput, "ABCDEFGH", 4, "deleteContentForward");
    expect(codeInput).toHaveProperty("value", "ABCD-EFGH");
    expect(codeInput.selectionStart).toBe(5);
    expect(codeInput.selectionEnd).toBe(5);
  });

  it("recognizes a retried rate-limit failure without exposing its diagnostics", () => {
    const notice = getPairingFailureNotice(new AggregateError([
      new Error("Rate limited, no retry-after header received"),
    ]));

    expect(notice).toEqual({
      variant: "error",
      title: "Pairing Temporarily Paused",
      description: "Too many pairing attempts were received. Wait a few minutes, then use the latest code shown on the display.",
    });
  });

  it("recognizes rate limiting from the typed HTTP response", () => {
    expect(getPairingFailureNotice(new TvProfileRequestError(429))).toMatchObject({
      title: "Pairing Temporarily Paused",
    });
  });

  it("distinguishes a changed exact-financial profile from an invalid code", () => {
    expect(getPairingFailureNotice(new TvProfileRequestError(428))).toMatchObject({
      title: "Profile Privacy Changed",
    });
  });

  it("submits once, shows progress, and reconciles the connected display without a reload", async () => {
    const approval = Promise.withResolvers<Response>();
    let approved = false;
    const requests: Array<{ path: string, method: string }> = [];
    const adminApp = {
      [hexclaveAppInternalsSymbol]: {
        sendRequest: async (path: string, options: RequestInit) => {
          const method = options.method ?? "GET";
          requests.push({ path, method });
          if (method === "POST") {
            const response = await approval.promise;
            approved = true;
            return response;
          }
          return jsonResponse({ displays: approved ? [display] : [] });
        },
      },
    };
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    renderManagement(adminApp);

    await waitFor(() => expect(screen.getByText("No Displays Paired Yet")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "abcd efgh" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Office Display" } });
    expect(screen.getByDisplayValue("ABCD-EFGH")).toBeTruthy();
    const pairButton = screen.getByRole("button", { name: "Pair Display" });
    fireEvent.click(pairButton);
    fireEvent.click(pairButton);

    expect(pairButton.hasAttribute("disabled")).toBe(true);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(screen.getByLabelText("Display name")).toHaveProperty("value", "Office Display");

    await act(async () => {
      approval.resolve(approvalResponse());
      await approval.promise;
    });

    await waitFor(() => expect(screen.getByText("Display Paired")).toBeTruthy());
    expect(screen.getByLabelText("Display name")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Pairing code")).toHaveProperty("value", "");
    expect(screen.getAllByText("Office Display").length).toBeGreaterThan(0);
    expect(alert).not.toHaveBeenCalled();
  });

  it("normalizes formatted codes and defaults to the server-selected profile", async () => {
    const engineering = getTvBuiltInProfile("engineering-office");
    if (engineering == null) throw new Error("Engineering Office profile is missing.");
    const submittedBodies: string[] = [];
    const adminApp = {
      [hexclaveAppInternalsSymbol]: {
        sendRequest: async (_path: string, options: RequestInit) => {
          if (options.method === "POST") {
            if (typeof options.body === "string") submittedBodies.push(options.body);
            return approvalResponse();
          }
          return jsonResponse({ displays: [] });
        },
      },
    };
    render(<>
      <TvDisplayManagement
        adminApp={adminApp}
        profiles={[engineering, getCompanyPulseProfile()]}
        defaultProfileId="company-pulse"
      />
      <Toaster />
    </>);

    await screen.findByText("No Displays Paired Yet");
    expect(screen.getByLabelText("Assigned Profile").textContent).toContain("Company Pulse");
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "ABCD-EFGH" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Office Display" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair Display" }));
    await waitFor(() => expect(submittedBodies).toHaveLength(1));
    const submittedBody = submittedBodies.at(0);
    if (submittedBody == null) throw new Error("Pairing request body is missing.");
    expect(JSON.parse(submittedBody)).toMatchObject({
      pairingCode: "ABCDEFGH",
      profileId: "company-pulse",
    });
  });

  it("expires pending approval correlation before matching a later same-named display", async () => {
    let listRequests = 0;
    const adminApp = {
      [hexclaveAppInternalsSymbol]: {
        sendRequest: async (_path: string, options: RequestInit) => {
          if (options.method === "POST") {
            return approvalResponse({ expiresAt: "2000-01-01T00:00:00.000Z" });
          }
          listRequests += 1;
          return jsonResponse({ displays: listRequests === 1 ? [] : [display] });
        },
      },
    };
    renderManagement(adminApp);

    await screen.findByText("No Displays Paired Yet");
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "ABCD-EFGH" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Office Display" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair Display" }));

    await waitFor(() => expect(screen.getByLabelText("Display name for Office Display")).toBeTruthy());
    expect(screen.queryByText("Display Paired")).toBeNull();
  });

  it("uses the design dialog to confirm unpairing and removes the active display immediately", async () => {
    const requests: Array<{ path: string, method: string }> = [];
    const adminApp = {
      [hexclaveAppInternalsSymbol]: {
        sendRequest: async (path: string, options: RequestInit) => {
          const method = options.method ?? "GET";
          requests.push({ path, method });
          if (method === "DELETE") return jsonResponse({ success: true });
          return jsonResponse({ displays: [display] });
        },
      },
    };
    renderManagement(adminApp);

    await waitFor(() => expect(screen.getByRole("button", { name: "Unpair" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Unpair" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/immediately lose access to TV Mode/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Unpair Display" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Display Unpaired")).toBeTruthy();
    expect(requests.filter((request) => request.method === "DELETE")).toEqual([{
      path: `/internal/tv-mode/displays/${display.id}`,
      method: "DELETE",
    }]);
    expect(screen.getByText("No Displays Paired Yet")).toBeTruthy();
  });

  it("enables assignment saving only after the display configuration changes", async () => {
    const requests: Array<{ path: string, method: string, body: string | null }> = [];
    const adminApp = {
      [hexclaveAppInternalsSymbol]: {
        sendRequest: async (path: string, options: RequestInit) => {
          const method = options.method ?? "GET";
          requests.push({ path, method, body: typeof options.body === "string" ? options.body : null });
          if (method === "PATCH") return jsonResponse({ success: true });
          return jsonResponse({ displays: [display] });
        },
      },
    };
    renderManagement(adminApp);

    const savedButton = await screen.findByRole("button", { name: "Assignment Saved" });
    expect(savedButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Display name for Office Display").getAttribute("maxlength")).toBe("80");

    fireEvent.change(screen.getByLabelText("Display name for Office Display"), {
      target: { value: "Lobby Display" },
    });
    const saveButton = screen.getByRole("button", { name: "Save Assignment" });
    expect(saveButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(saveButton);

    await waitFor(() => expect(screen.getByText("Assignment Updated")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Assignment Saved" }).hasAttribute("disabled")).toBe(true);
    const patchRequests = requests.filter((request) => request.method === "PATCH");
    expect(patchRequests).toHaveLength(1);
    const patchRequest = patchRequests.at(0);
    if (patchRequest == null) throw new Error("Assignment update request is missing.");
    if (patchRequest.body == null) throw new Error("Assignment update request body is missing.");
    expect(JSON.parse(patchRequest.body)).toMatchObject({
      displayName: "Lobby Display",
      profileId: "company-pulse",
    });
  });

  it("reconciles assignment fields when a later list response changes the display", async () => {
    const firstAdminApp = {
      [hexclaveAppInternalsSymbol]: {
        sendRequest: async () => jsonResponse({ displays: [display] }),
      },
    };
    const renamedDisplay = { ...display, displayName: "Lobby Display" };
    const secondAdminApp = {
      [hexclaveAppInternalsSymbol]: {
        sendRequest: async () => jsonResponse({ displays: [renamedDisplay] }),
      },
    };
    const rendered = render(<><TvDisplayManagement adminApp={firstAdminApp} profiles={[getCompanyPulseProfile()]} /><Toaster /></>);

    await screen.findByLabelText("Display name for Office Display");
    rendered.rerender(<><TvDisplayManagement adminApp={secondAdminApp} profiles={[getCompanyPulseProfile()]} /><Toaster /></>);

    const input = await screen.findByLabelText("Display name for Lobby Display");
    expect(input).toHaveProperty("value", "Lobby Display");
    expect(screen.getByRole("button", { name: "Assignment Saved" }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps multiple displays scannable with status, activity, and profile context", async () => {
    const offlineDisplay: TvDisplayResource = {
      ...display,
      id: "4bf7db40-d2cf-4a33-a941-bcec44736ec1",
      displayName: "Lobby Display",
      state: "offline",
      lastSeenAt: "2026-08-15T11:30:00.000Z",
    };
    const adminApp = {
      [hexclaveAppInternalsSymbol]: {
        sendRequest: async () => jsonResponse({ displays: [display, offlineDisplay] }),
      },
    };

    renderManagement(adminApp);

    await screen.findByLabelText("Display name for Office Display");
    expect(screen.getByLabelText("Display name for Lobby Display")).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getAllByText("Profile: Company Pulse")).toHaveLength(2);
  });

  it("preserves exact-financial acknowledgment in the refined pairing form", async () => {
    const baseProfile = getCompanyPulseProfile();
    const exactProfile: TvProfileResource = {
      ...baseProfile,
      configuration: {
        ...baseProfile.configuration,
        financialVisibility: "exact",
      },
    };
    const adminApp = {
      [hexclaveAppInternalsSymbol]: {
        sendRequest: async () => jsonResponse({ displays: [] }),
      },
    };

    renderManagement(adminApp, [exactProfile]);

    await screen.findByText("No Displays Paired Yet");
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "ABCD-EFGH" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Office Display" } });
    const pairButton = screen.getByRole("button", { name: "Pair Display" });
    expect(pairButton.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByText(/I understand that this physical display/));
    expect(pairButton.hasAttribute("disabled")).toBe(false);
  });
});
