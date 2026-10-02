// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import React, { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterProvider, useRouter, useRouterConfirm } from "./router";

const nextRouter = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => nextRouter,
}));

function RouterIdentityProbe() {
  const router = useRouter();
  const firstRouter = useRef(router);
  const [, setRenderCount] = useState(0);

  return (
    <button type="button" onClick={() => setRenderCount((count) => count + 1)}>
      {firstRouter.current === router ? "stable" : "changed"}
    </button>
  );
}

describe("useRouter", () => {
  it("keeps its navigation wrapper stable across unrelated rerenders", () => {
    const view = render(
      <RouterProvider>
        <RouterIdentityProbe />
      </RouterProvider>,
    );
    const button = view.getByRole("button");

    expect(button.textContent).toBe("stable");
    fireEvent.click(button);
    expect(button.textContent).toBe("stable");
  });
});

afterEach(() => {
  cleanup();
});

function Probe(props: { onSameTickUnload: (prevented: boolean) => void }) {
  const { setNeedConfirm } = useRouterConfirm();
  return (
    <>
      <button type="button" onClick={() => setNeedConfirm(true)}>
        Require confirmation
      </button>
      <button
        type="button"
        onClick={() => {
          setNeedConfirm(false);
          const event = new Event("beforeunload", { cancelable: true });
          window.dispatchEvent(event);
          props.onSameTickUnload(event.defaultPrevented);
        }}
      >
        Reset and unload
      </button>
    </>
  );
}

describe("RouterProvider beforeunload confirmation", () => {
  it("cancels beforeunload while navigation confirmation is required", () => {
    const { getByRole } = render(
      <RouterProvider><Probe onSameTickUnload={() => undefined} /></RouterProvider>,
    );
    fireEvent.click(getByRole("button", { name: "Require confirmation" }));

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("does not cancel beforeunload after same-tick confirmation reset", () => {
    let prevented = true;
    const { getByRole } = render(
      <RouterProvider><Probe onSameTickUnload={(value) => { prevented = value; }} /></RouterProvider>,
    );
    fireEvent.click(getByRole("button", { name: "Require confirmation" }));
    fireEvent.click(getByRole("button", { name: "Reset and unload" }));

    expect(prevented).toBe(false);
  });
});
