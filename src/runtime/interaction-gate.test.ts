import { expect, it } from "vitest";
import { InteractionGate } from "./interaction-gate";

it("keeps gameplay blocked until every independent surface has released its lease", () => {
  const gate = new InteractionGate();
  const story = gate.acquire(), tutorial = gate.acquire();
  story(); story();
  expect(gate.blocked).toBe(true);
  tutorial();
  expect(gate.blocked).toBe(false);
});
