import { expect, it, vi } from "vitest";
import { createDeckSaveQueue } from "./deck-save-queue";
import type { SkillDeck } from "../core/skills/deck";

it("serializes rapid edits and does not replace a newer optimistic state with an older completion", async () => {
  const writes: SkillDeck[] = [];
  let release!: () => void;
  const queue = createDeckSaveQueue({ carried: ["a"], reserve: ["b", "c"] }, async (deck) => {
    writes.push(deck);
    if (writes.length === 1) await new Promise<void>((resolve) => { release = resolve; });
  });
  const first = { carried: ["a", "b"], reserve: ["c"] };
  const second = { carried: ["c", "a", "b"], reserve: [] };
  void queue.update(first);
  await Promise.resolve();
  void queue.update(second);
  expect(queue.get()).toEqual(second);
  release();
  await queue.flush();
  expect(writes).toEqual([first, second]);
  expect(queue.get()).toEqual(second);
});

it("rolls back to the last successful write, cancels dependent edits and permits retry", async () => {
  const initial = { carried: ["a"], reserve: ["b", "c"] };
  const write = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
  const queue = createDeckSaveQueue(initial, write);
  const successful = { carried: ["a", "b"], reserve: ["c"] };
  await queue.update(successful);
  void queue.update({ carried: ["b", "a"], reserve: ["c"] });
  void queue.update({ carried: ["b", "a", "c"], reserve: [] });
  await queue.flush();
  expect(queue.get()).toEqual(successful);
  expect(write).toHaveBeenCalledTimes(2);
  await queue.update(initial);
  expect(queue.get()).toEqual(initial);
  expect(write).toHaveBeenCalledTimes(3);
});
