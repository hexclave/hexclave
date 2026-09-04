// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccountDeletionBoundary } from "./account-deletion-boundary";

const previousActEnvironment = globalThis["IS_REACT_ACT_ENVIRONMENT"];
let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  const currentRoot = root;
  const currentContainer = container;
  if (currentRoot != null) {
    act(() => currentRoot.unmount());
  }
  currentContainer?.remove();
  root = undefined;
  container = undefined;
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
});

describe("AccountDeletionBoundary", () => {
  it("unmounts the authenticated subtree before deletion and shows the terminal state", async () => {
    let resolveDeletion: (() => void) | undefined;
    let deletionPromise: Promise<void> | undefined;
    const deletion = new Promise<void>((resolve) => {
      resolveDeletion = resolve;
    });

    const currentRoot = root;
    if (currentRoot == null) {
      throw new Error("Expected a test root");
    }
    act(() => currentRoot.render(
      <AccountDeletionBoundary>
        {(onDeleteAccount) => (
          <button onClick={() => {
            deletionPromise = onDeleteAccount(async () => {
              expect(document.body.textContent).not.toContain("Authenticated settings");
              await deletion;
            });
          }}>
            Authenticated settings
          </button>
        )}
      </AccountDeletionBoundary>,
    ));

    const deleteButton = container?.querySelector("button");
    if (deleteButton == null) {
      throw new Error("Expected the account deletion button");
    }
    act(() => deleteButton.click());

    expect(document.body.textContent).not.toContain("Authenticated settings");
    expect(document.querySelector("[data-hexclave-handler-page]")).not.toBeNull();

    const completeDeletion = resolveDeletion;
    if (completeDeletion == null) {
      throw new Error("Expected the deletion operation to have started");
    }
    if (deletionPromise == null) {
      throw new Error("Expected the deletion promise to be available");
    }
    await act(async () => {
      completeDeletion();
      await deletionPromise;
    });

    expect(document.body.textContent).toContain("Account deleted");
    expect(document.body.textContent).toContain("Your account and its associated data have been deleted. You can close this tab.");
    expect(container?.querySelector("button")).toBeNull();
  });

  it("restores the authenticated subtree and propagates deletion failures", async () => {
    const deletionError = new Error("Deletion failed");
    let deletionPromise: Promise<void> | undefined;

    const currentRoot = root;
    if (currentRoot == null) {
      throw new Error("Expected a test root");
    }
    act(() => currentRoot.render(
      <AccountDeletionBoundary>
        {(onDeleteAccount) => (
          <button onClick={() => {
            deletionPromise = onDeleteAccount(async () => {
              throw deletionError;
            });
          }}>
            Authenticated settings
          </button>
        )}
      </AccountDeletionBoundary>,
    ));

    const deleteButton = container?.querySelector("button");
    if (deleteButton == null) {
      throw new Error("Expected the account deletion button");
    }
    act(() => deleteButton.click());

    if (deletionPromise == null) {
      throw new Error("Expected the deletion operation to have started");
    }
    await act(async () => {
      await expect(deletionPromise).rejects.toBe(deletionError);
    });
    expect(container?.querySelector("button")?.textContent).toBe("Authenticated settings");
    expect(document.body.textContent).not.toContain("Account deleted");
  });
});
