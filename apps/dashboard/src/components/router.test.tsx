// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { RouterProvider, useRouterConfirm } from "./router";

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
