import type { SkillDeck } from "../core/skills/deck";

export type DeckSaveStatus = "saving" | "saved" | "failed";

/** Optimistic ordered writes; a failed dependency cancels its queued descendants. */
export function createDeckSaveQueue(initial: SkillDeck, write: (deck: SkillDeck) => Promise<void>) {
  let current = initial;
  let committed = initial;
  let generation = 0;
  let serial = 0;
  let queue = Promise.resolve();
  const listeners = new Set<(deck: SkillDeck, status: DeckSaveStatus) => void>();
  const emit = (status: DeckSaveStatus) => listeners.forEach((listener) => listener(current, status));
  return {
    get: () => current,
    subscribe(listener: (deck: SkillDeck, status: DeckSaveStatus) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update(next: SkillDeck): Promise<void> {
      current = { carried: [...next.carried], reserve: [...next.reserve] };
      const snapshot = current;
      const token = generation;
      const request = ++serial;
      emit("saving");
      queue = queue.then(async () => {
        if (token !== generation) return;
        try {
          await write(snapshot);
          committed = snapshot;
          if (request === serial) emit("saved");
        } catch {
          generation++;
          current = committed;
          emit("failed");
        }
      });
      return queue;
    },
    flush: () => queue
  };
}
export type DeckSaveQueue = ReturnType<typeof createDeckSaveQueue>;
