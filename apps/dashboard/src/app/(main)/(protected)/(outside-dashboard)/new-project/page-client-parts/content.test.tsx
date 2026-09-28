// @vitest-environment jsdom

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockPush = vi.hoisted(() => vi.fn());
const mockReplace = vi.hoisted(() => vi.fn());
const mockOwnedProjects = vi.hoisted(() => ({
  current: [] as Array<{
    id: string,
    onboardingStatus?: "config_choice" | "completed",
    onboardingState?: unknown,
  }>,
}));
type MockCreatedProject = {
  id: string,
  app?: object,
};
const mockCreateProject = vi.hoisted(() => vi.fn(async (): Promise<MockCreatedProject> => ({ id: "created-project-id" })));
const mockSendRequest = vi.hoisted(() => vi.fn(async () => new Response(null, { status: 200 })));
const mockCloudOnboarding = vi.hoisted(() => vi.fn());
const mockWindowOpen = vi.hoisted(() => vi.fn());
const mockSearchParams = vi.hoisted(() => ({ current: new URLSearchParams() }));

vi.mock("@/components/design-components", () => ({
  DesignDialog: ({ open, onOpenChange, title, description, footer, children }: {
    open?: boolean,
    onOpenChange?: (open: boolean) => void,
    title?: ReactNode,
    description?: ReactNode,
    footer?: ReactNode,
    children?: ReactNode,
  }) => open ? (
    <div>
      <button type="button" onClick={() => onOpenChange?.(false)}>dismiss dialog</button>
      <h2>{title}</h2>
      <div>{description}</div>
      {children}
      {footer}
    </div>
  ) : null,
}));

vi.mock("@/components/design-components/button", () => ({
  DesignButton: ({ children, type, loading: _loading, variant: _variant, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean, variant?: string }) => (
    <button type={type ?? "button"} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/design-components/input", () => ({
  DesignInput: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/design-components/select", () => ({
  DesignSelectorDropdown: ({ value, onValueChange, options }: {
    value: string,
    onValueChange: (value: string) => void,
    options: Array<{ value: string, label: string }>,
  }) => (
    <select aria-label="team" value={value} onChange={(event) => onValueChange(event.target.value)}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}));

vi.mock("@/components/router", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

vi.mock("@/components/ui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({ children, type, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button type={type ?? "button"} {...props}>{children}</button>
    ),
    Card: passthrough,
    CardContent: passthrough,
    CardDescription: passthrough,
    CardHeader: passthrough,
    CardTitle: passthrough,
    Label: ({ children }: { children?: ReactNode }) => <label>{children}</label>,
    Spinner: () => <div>Loading</div>,
    Typography: passthrough,
  };
});

vi.mock("@/lib/dashboard-user", () => ({
  useDashboardInternalUser: () => ({
    selectedTeam: null,
    useTeams: () => [{ id: "team-id", displayName: "Team" }],
    useOwnedProjects: () => mockOwnedProjects.current,
    createProject: mockCreateProject,
    createTeam: vi.fn(),
    setSelectedTeam: vi.fn(),
  }),
}));

vi.mock("@/lib/env", () => ({
  getPublicEnvVar: () => "false",
}));

vi.mock("@hexclave/next", () => ({}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams.current,
}));

vi.mock("./project-onboarding-wizard", () => ({
  ProjectOnboardingWizard: () => <div>Onboarding wizard</div>,
}));

vi.mock("./cloud-project-onboarding", () => ({
  createInitialCloudOnboardingState: () => ({
    version: 1,
    step: "welcome-to-hexclave",
    journey: "add",
    primary_app_id: null,
    additional_app_ids: [],
    selected_apps: [],
    selected_sign_in_methods: ["credential", "magicLink", "google", "github"],
    selected_email_theme_id: "default",
    project_location: null,
  }),
  CloudProjectOnboarding: (props: unknown) => {
    mockCloudOnboarding(props);
    return <div>Cloud onboarding</div>;
  },
}));

vi.mock("./shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared")>();
  return {
    ...actual,
    getStackAppInternals: () => ({
      sendRequest: mockSendRequest,
      refreshOwnedProjects: vi.fn(),
    }),
  };
});

vi.mock("./components", () => ({
  NewProjectEntryPage: ({ onSelect }: { onSelect: (choice: "setup-new" | "deploy") => void }) => (
    <div>
      <h1>Welcome to Hexclave!</h1>
      <button type="button" onClick={() => onSelect("setup-new")}>Add Hexclave to a project</button>
      <button type="button" onClick={() => onSelect("deploy")}>Deploy my Hexclave project to production</button>
      <button type="button" onClick={() => window.open("https://preview.hexclave.com", "_blank", "noopener,noreferrer")}>
        I just want to look around
      </button>
    </div>
  ),
  PreProjectSetupFlow: ({ onBack, onDeploy }: {
    onBack: () => void,
    onDeploy: (source: "local" | "github") => void,
  }) => (
    <div>
      <h1>Set up the Hexclave SDK</h1>
      <button type="button" onClick={onBack}>Go back</button>
      <button type="button" onClick={() => onDeploy("local")}>Deploy from local setup</button>
      <button type="button" onClick={() => onDeploy("github")}>Deploy from GitHub setup</button>
    </div>
  ),
  ProductSelectionPage: ({
    initialPrimaryAppId,
    onLetAiDecide,
    onPrimaryAppSelected,
    onClearPrimaryApp,
    onContinue,
  }: {
    initialPrimaryAppId?: "authentication" | null,
    onLetAiDecide: () => void,
    onPrimaryAppSelected: (appId: "authentication") => void,
    onClearPrimaryApp: () => void,
    onContinue: (appIds: Set<"analytics" | "authentication">) => void,
  }) => (
    <div>
      {initialPrimaryAppId == null ? (
        <>
          <h1>What will you use Hexclave for?</h1>
          <button type="button" onClick={onLetAiDecide}>Not sure / Decide later</button>
          <button type="button" onClick={() => onPrimaryAppSelected("authentication")}>Choose Authentication</button>
        </>
      ) : (
        <>
          <h1>Do you want to install any other apps?</h1>
          <p>Primary: {initialPrimaryAppId}</p>
          <button type="button" onClick={onClearPrimaryApp}>Clear primary app</button>
          <button type="button" onClick={() => onContinue(new Set(["authentication", "analytics"]))}>Continue with products</button>
        </>
      )}
    </div>
  ),
  parseOnboardingAppSearchParam: (value: string | null) => (
    value === "authentication" ? "authentication" : null
  ),
  ProductConfigurationWizard: ({ selectedApps, onDeploy }: {
    selectedApps: Set<"analytics">,
    onDeploy: (source: "local" | "github") => void,
  }) => (
    <div>
      Configure selected products: {[...selectedApps].join(", ")}
      <button type="button" onClick={() => onDeploy("local")}>Deploy configured project locally</button>
      <button type="button" onClick={() => onDeploy("github")}>Deploy configured project from GitHub</button>
    </div>
  ),
}));

import PageClient from "./content";

afterEach(() => {
  cleanup();
  mockPush.mockClear();
  mockReplace.mockClear();
  mockOwnedProjects.current = [];
  mockCreateProject.mockReset();
  mockCreateProject.mockResolvedValue({ id: "created-project-id" });
  mockSendRequest.mockClear();
  mockSendRequest.mockResolvedValue(new Response(null, { status: 200 }));
  mockCloudOnboarding.mockClear();
  mockWindowOpen.mockReset();
  mockSearchParams.current = new URLSearchParams();
  window.open = mockWindowOpen;
});

function throwMissingInput(): never {
  throw new Error("The project name input was not rendered.");
}

function throwMissingForm(): never {
  throw new Error("The project creation form was not rendered.");
}

describe("new project page", () => {
  it("starts with the project naming dialog when no project id is provided", () => {
    render(<PageClient />);

    expect(screen.getByText("Name your project")).not.toBeNull();
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it.each(["link-existing", "deploy-local", "deploy-github"])(
    "keeps completed projects in the re-link flow for %s mode",
    (mode) => {
      mockOwnedProjects.current = [{
        id: "completed-project-id",
        onboardingStatus: "completed",
        onboardingState: null,
      }];
      mockSearchParams.current = new URLSearchParams({
        project_id: "completed-project-id",
        mode,
      });

      render(<PageClient />);

      expect(screen.getByText("Onboarding wizard")).not.toBeNull();
      expect(mockReplace).not.toHaveBeenCalledWith("/projects/completed-project-id");
    },
  );

  it("creates and initializes the project before entering onboarding", async () => {
    const { container } = render(<PageClient />);

    fireEvent.change(container.querySelector("#project-name") ?? throwMissingInput(), { target: { value: "My Project" } });
    fireEvent.submit(container.querySelector("form") ?? throwMissingForm());

    await waitFor(() => {
      expect(mockCreateProject).toHaveBeenCalledWith({
        displayName: "My Project",
        teamId: "team-id",
        onboardingStatus: "config_choice",
      });
      expect(mockSendRequest).toHaveBeenCalledWith(
        "/internal/projects/current",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"step":"welcome-to-hexclave"'),
        }),
        "admin",
      );
      expect(mockReplace).toHaveBeenCalledWith("/new-project?project_id=created-project-id");
    });
  });

  it("preserves a valid app query when creating the project", async () => {
    mockSearchParams.current = new URLSearchParams("app=authentication");
    const { container } = render(<PageClient />);

    fireEvent.change(container.querySelector("#project-name") ?? throwMissingInput(), { target: { value: "My Project" } });
    fireEvent.submit(container.querySelector("form") ?? throwMissingForm());

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/new-project?project_id=created-project-id&app=authentication");
    });
  });

  it("opens the name dialog immediately for integration create flows", () => {
    mockSearchParams.current = new URLSearchParams("display_name=Neon+App&redirect_to_neon_confirm_with=foo%3D1");
    render(<PageClient />);

    expect(screen.getByText("Name your project")).not.toBeNull();
    expect((screen.getByDisplayValue("Neon App") as HTMLInputElement).value).toBe("Neon App");
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it("renders cloud onboarding solely from the selected project's persisted state", () => {
    const persistedState = {
      version: 1,
      step: "setup-github-workflow",
      journey: "deploy-existing",
      primary_app_id: null,
      additional_app_ids: [],
      selected_apps: [],
      selected_sign_in_methods: [],
      selected_email_theme_id: "default",
      project_location: "github",
    };
    mockOwnedProjects.current = [{
      id: "project-id",
      onboardingStatus: "config_choice",
      onboardingState: persistedState,
    }];
    mockSearchParams.current = new URLSearchParams("project_id=project-id&mode=obsolete");

    render(<PageClient />);

    expect(screen.getByText("Cloud onboarding")).not.toBeNull();
    expect(mockCloudOnboarding).toHaveBeenCalledWith(expect.objectContaining({
      onboardingState: persistedState,
      primaryAppFromQuery: null,
    }));
  });
});
