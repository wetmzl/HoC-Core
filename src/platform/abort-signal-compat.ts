/** Installs the missing API before package-owned modules enter the application. */
export function installAbortSignalAny(): void {
  if (typeof AbortSignal.any === "function") return;

  // Native getters validate the signal brand, including signals from other realms.
  const getAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
  const getReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason")?.get;

  function any(signals: Iterable<AbortSignal>): AbortSignal {
    const iterator = signals?.[Symbol.iterator];
    if (typeof iterator !== "function") {
      throw new TypeError("AbortSignal.any requires an iterable of AbortSignal instances");
    }
    const inputs = [...{ [Symbol.iterator]: () => iterator.call(signals) }];
    // Validate every input before considering an already-aborted signal.
    for (const signal of inputs) getAborted.call(signal);

    const controller = new AbortController();
    for (const signal of inputs) {
      if (getAborted.call(signal)) {
        controller.abort(getReason?.call(signal));
        return controller.signal;
      }
    }

    const listeners = new Map<AbortSignal, EventListener>();
    const cleanup = (): void => {
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
      listeners.clear();
    };
    for (const signal of new Set(inputs)) {
      const onAbort = (): void => {
        if (!getAborted.call(signal) || controller.signal.aborted) return;
        cleanup();
        controller.abort(getReason?.call(signal));
      };
      listeners.set(signal, onAbort);
      // A synthetic event must not consume the listener before a real abort.
      signal.addEventListener("abort", onAbort);
    }
    return controller.signal;
  }

  Object.defineProperty(AbortSignal, "any", {
    value: any,
    writable: true,
    configurable: true,
    enumerable: false
  });
}
