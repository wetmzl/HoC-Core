import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAbortSignalAny } from "./abort-signal-compat";

const originalAny = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;

beforeEach(() => {
  Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true, writable: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(AbortSignal, "any", originalAny);
});

function combine(signals: Iterable<AbortSignal>): AbortSignal {
  installAbortSignalAny();
  return AbortSignal.any(signals as AbortSignal[]);
}

describe("AbortSignal.any compatibility", () => {
  it("preserves the native method and its property descriptor", () => {
    Object.defineProperty(AbortSignal, "any", originalAny);
    installAbortSignalAny();
    expect(Object.getOwnPropertyDescriptor(AbortSignal, "any")).toEqual(originalAny);
  });

  it("installs a writable, configurable, non-enumerable method only once", () => {
    installAbortSignalAny();
    const installed = AbortSignal.any;
    installAbortSignalAny();
    expect(AbortSignal.any).toBe(installed);
    expect(Object.getOwnPropertyDescriptor(AbortSignal, "any")).toEqual({
      value: installed, configurable: true, writable: true, enumerable: false
    });
  });

  it("returns a fresh non-aborted signal for an empty iterable", () => {
    const result = combine([]);
    expect(result).toBeInstanceOf(AbortSignal);
    expect(result.aborted).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(combine([])).not.toBe(result);
  });

  it("accepts generators and propagates cancellation synchronously", () => {
    const first = new AbortController();
    const second = new AbortController();
    const result = combine((function* () { yield first.signal; yield second.signal; })());
    const onAbort = vi.fn();
    result.addEventListener("abort", onAbort);
    const reason = new Error("second cancelled");
    second.abort(reason);
    expect(result.aborted).toBe(true);
    expect(result.reason).toBe(reason);
    expect(onAbort).toHaveBeenCalledOnce();
    first.abort("later cancellation");
    expect(result.reason).toBe(reason);
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("uses input order for already-aborted signals without adding listeners", () => {
    const first = new AbortController();
    const second = new AbortController();
    second.abort("aborted earlier");
    first.abort("first in input");
    const addFirst = vi.spyOn(first.signal, "addEventListener");
    const addSecond = vi.spyOn(second.signal, "addEventListener");
    const result = combine([first.signal, second.signal]);
    expect(result.aborted).toBe(true);
    expect(result.reason).toBe("first in input");
    expect(addFirst).not.toHaveBeenCalled();
    expect(addSecond).not.toHaveBeenCalled();
  });

  it("validates the whole iterable before returning an already-aborted signal", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => combine([controller.signal, {} as AbortSignal])).toThrow(TypeError);
  });

  it("rejects non-iterables and objects that only resemble signals", () => {
    for (const input of [undefined, null, 1, {}, { length: 0 }, [null], [{}], "signal", [{ aborted: false, addEventListener() {} }]]) {
      expect(() => combine(input as Iterable<AbortSignal>)).toThrow(TypeError);
    }
  });

  it("does not attach listeners when iteration fails", () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const failure = new Error("iteration failed");
    const inputs = (function* () { yield controller.signal; throw failure; })();
    expect(() => combine(inputs)).toThrow(failure);
    expect(add).not.toHaveBeenCalled();
  });

  it("reads an iterable's iterator method only once", () => {
    const controller = new AbortController();
    const iterator = vi.fn(() => () => [controller.signal][Symbol.iterator]());
    const inputs = Object.defineProperty({}, Symbol.iterator, { get: iterator });
    const result = combine(inputs as Iterable<AbortSignal>);
    controller.abort("iterable cancellation");
    expect(result.reason).toBe("iterable cancellation");
    expect(iterator).toHaveBeenCalledOnce();
  });

  it("deduplicates inputs and removes every input listener on cancellation", () => {
    const first = new AbortController();
    const second = new AbortController();
    const addFirst = vi.spyOn(first.signal, "addEventListener");
    const addSecond = vi.spyOn(second.signal, "addEventListener");
    const removeFirst = vi.spyOn(first.signal, "removeEventListener");
    const removeSecond = vi.spyOn(second.signal, "removeEventListener");
    combine([first.signal, first.signal, second.signal]);
    expect(addFirst).toHaveBeenCalledOnce();
    expect(addSecond).toHaveBeenCalledOnce();
    second.abort();
    expect(removeFirst).toHaveBeenCalledExactlyOnceWith("abort", addFirst.mock.calls[0][1]);
    expect(removeSecond).toHaveBeenCalledExactlyOnceWith("abort", addSecond.mock.calls[0][1]);
  });

  it("ignores synthetic abort events without losing future cancellation", () => {
    const controller = new AbortController();
    const result = combine([controller.signal]);
    controller.signal.dispatchEvent(new Event("abort"));
    expect(result.aborted).toBe(false);
    controller.abort("real cancellation");
    expect(result.aborted).toBe(true);
    expect(result.reason).toBe("real cancellation");
  });

  it("propagates cancellation through nested combined signals", () => {
    const first = new AbortController();
    const second = new AbortController();
    const inner = combine([first.signal]);
    const outer = combine([inner, second.signal]);
    first.abort("nested cancellation");
    expect(outer.aborted).toBe(true);
    expect(outer.reason).toBe("nested cancellation");
  });

  it("uses the controller's default reason when reason support is unavailable", () => {
    const originalReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason")!;
    try {
      Reflect.deleteProperty(AbortSignal.prototype, "reason");
      const controller = new AbortController();
      const result = combine([controller.signal]);
      controller.abort("unavailable reason");
      expect(result.aborted).toBe(true);
      Object.defineProperty(AbortSignal.prototype, "reason", originalReason);
      expect(result.reason).toBeInstanceOf(DOMException);
      expect(result.reason.name).toBe("AbortError");
    } finally {
      Object.defineProperty(AbortSignal.prototype, "reason", originalReason);
    }
  });
});
