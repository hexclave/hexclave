import { describe, expect, it, vi } from "vitest";
import { FlyApiError, type FlyMachine } from "./client.js";
import { startMachineWhenSettled } from "./provider.js";

// A redeploy onto a machine that autostop had parked (`min_instances: 0` server, idle) is
// the case: Fly's update leaves it stopped after a `replacing` transition, and rejects a
// start until that transition is over. These test only whether a start gets REQUESTED —
// the caller's started-wait is what decides whether the boot happened.

const lease = { assertOwned: async () => {} } as never;

function machine(state: string): FlyMachine {
  return { id: "m-1", name: "web-0", state, region: "iad", instance_id: "inst-1", config: { image: "example/image" } };
}

function rejectedStart(state: string): FlyApiError {
  return new FlyApiError(412, "machines POST /apps/app/machines/m-1/start", `failed to change machine state: unable to start machine from current state: '${state}'`);
}

describe("startMachineWhenSettled", () => {
  it("starts a stopped machine once", async () => {
    const fly = { getMachine: vi.fn(async () => machine("stopped")), startMachine: vi.fn(async () => {}) };
    await startMachineWhenSettled(fly, "app", "m-1", lease, { pollMillis: 1 });
    expect(fly.startMachine).toHaveBeenCalledTimes(1);
  });

  it("waits out the post-update transition before starting, and retries a start Fly rejected", async () => {
    // The production sequence: the update has answered but the machine is still
    // `replacing`; a start fired now is refused; a few seconds later it is `stopped` and a
    // start is accepted. Previously the refused start was swallowed and never retried.
    const states = ["replacing", "replacing", "stopped", "stopped"];
    const fly = {
      getMachine: vi.fn(async () => machine(states.shift() ?? "stopped")),
      startMachine: vi.fn(async () => {}),
    };
    fly.startMachine.mockRejectedValueOnce(rejectedStart("replacing"));
    await startMachineWhenSettled(fly, "app", "m-1", lease, { pollMillis: 1 });
    // Not called while `replacing` (the poll saw the state first); the rejected attempt is
    // retried once the machine has settled.
    expect(fly.startMachine).toHaveBeenCalledTimes(2);
  });

  it("starts a suspended machine — that is what autostop leaves behind", async () => {
    const fly = { getMachine: vi.fn(async () => machine("suspended")), startMachine: vi.fn(async () => {}) };
    await startMachineWhenSettled(fly, "app", "m-1", lease, { pollMillis: 1 });
    expect(fly.startMachine).toHaveBeenCalledTimes(1);
  });

  it("does nothing when Fly is already booting the machine", async () => {
    const fly = { getMachine: vi.fn(async () => machine("starting")), startMachine: vi.fn(async () => {}) };
    await startMachineWhenSettled(fly, "app", "m-1", lease, { pollMillis: 1 });
    expect(fly.startMachine).not.toHaveBeenCalled();
  });

  it("gives up quietly at the budget so the started-wait can report the failure", async () => {
    const fly = { getMachine: vi.fn(async () => machine("replacing")), startMachine: vi.fn(async () => {}) };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await startMachineWhenSettled(fly, "app", "m-1", lease, { budgetMillis: 20, pollMillis: 1 });
      // The one trace it leaves: previously the swallowed start left no record at all.
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
    expect(fly.startMachine).not.toHaveBeenCalled();
  });

  it("rethrows a lost lease instead of retrying past it", async () => {
    const { ReconciliationLeaseLostError } = await import("../reconciliation-lock.js");
    const lost = {
      assertOwned: async () => {
        throw new ReconciliationLeaseLostError("lease lost");
      },
    } as never;
    const fly = { getMachine: vi.fn(async () => machine("stopped")), startMachine: vi.fn(async () => {}) };
    await expect(startMachineWhenSettled(fly, "app", "m-1", lost, { pollMillis: 1 })).rejects.toBeInstanceOf(ReconciliationLeaseLostError);
    expect(fly.startMachine).not.toHaveBeenCalled();
  });
});
