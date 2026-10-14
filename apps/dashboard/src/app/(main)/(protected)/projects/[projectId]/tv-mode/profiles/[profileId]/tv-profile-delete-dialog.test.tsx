// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TvProfileDeleteDialog } from "./tv-profile-delete-dialog";

function DialogHarness({ onConfirm }: { onConfirm: () => Promise<void> }) {
  const [open, setOpen] = useState(true);
  return (
    <TvProfileDeleteDialog
      open={open}
      onOpenChange={setOpen}
      profileName="Engineering Office — Production"
      onConfirm={onConfirm}
    />
  );
}

describe("TvProfileDeleteDialog", () => {
  it("names the profile and cancels without deleting", async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(<DialogHarness onConfirm={onConfirm} />);

    expect(screen.getByText(/Engineering Office — Production/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("requires the destructive Delete action to confirm", async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(<DialogHarness onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
  });
});
