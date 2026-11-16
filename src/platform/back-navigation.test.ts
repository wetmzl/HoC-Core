import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { installBackNavigation, registerBackHandler, requestBack } from "./back-navigation";

vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn() } }));

const disposers: Array<() => void | Promise<void>> = [];

function browser(initialState: unknown = { unrelated: "kept" }, precedingPage = true) {
  const target = new EventTarget();
  const entries: unknown[] = precedingPage ? [null, initialState] : [initialState];
  let index = entries.length - 1;
  let left = false;
  const history = {
    get state() { return entries[index]; },
    get length() { return entries.length; },
    replaceState: vi.fn((state: unknown, _title: string) => { entries[index] = state; }),
    pushState: vi.fn((state: unknown, _title: string) => {
      entries.splice(index + 1); entries.push(state); index += 1;
    }),
    go: vi.fn((delta: number) => {
      const next = index + delta;
      if (next < 0 || next >= entries.length) return;
      index = next;
      if (index === 0 && precedingPage) left = true;
      else target.dispatchEvent(new Event("popstate"));
    })
  };
  vi.stubGlobal("window", Object.assign(target, { history }));
  return { target, history, entries, left: () => left };
}

function handler(options: Parameters<typeof registerBackHandler>[0]) {
  const remove = registerBackHandler(options);
  disposers.push(remove);
  return remove;
}

async function install(options: Parameters<typeof installBackNavigation>[0] = { onNativeRoot() {} }) {
  const dispose = await installBackNavigation(options);
  disposers.push(dispose);
  return dispose;
}

function escape(target: EventTarget, prevented = false) {
  const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
  if (prevented) event.preventDefault();
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => { vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(false); });
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("unified back handlers", () => {
  it("closes one enabled layer by priority and registration order", async () => {
    const calls: string[] = [];
    handler({ handle: () => { calls.push("page"); } });
    handler({ priority: 20, handle: () => { calls.push("disabled"); }, enabled: () => false });
    handler({ priority: 10, handle: () => { calls.push("old overlay"); } });
    const top = handler({ priority: 10, handle: () => { calls.push("new overlay"); } });
    await requestBack("native"); top(); await requestBack("browser");
    expect(calls).toEqual(["new overlay", "old overlay"]);
  });

  it("removes aborted owners and refuses late registration", async () => {
    const lifetime = new AbortController();
    const handle = vi.fn();
    handler({ handle, signal: lifetime.signal });
    lifetime.abort();
    handler({ handle, signal: lifetime.signal });
    expect(await requestBack("escape")).toBe(false);
    expect(handle).not.toHaveBeenCalled();
  });

  it("consumes rapid repeated input and recovers after a rejected handler", async () => {
    let finish!: () => void;
    const handle = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    handler({ handle });
    const first = requestBack("browser");
    expect(await requestBack("native")).toBe(true);
    expect(handle).toHaveBeenCalledOnce();
    finish(); await first;
    handle.mockRejectedValueOnce(new Error("save failed"));
    await expect(requestBack("escape")).rejects.toThrow("save failed");
    const retry = requestBack("native"); finish(); await retry;
    expect(handle).toHaveBeenCalledTimes(3);
  });

  it("can cancel a new overlay while the page return awaits confirmation", async () => {
    let finish!: () => void;
    const pageBack = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    handler({ handle: pageBack });
    const pending = requestBack("native");
    const overlay = handler({ priority: 10, handle: () => { finish(); overlay(); } });
    expect(await requestBack("browser")).toBe(true);
    await pending;
    expect(pageBack).toHaveBeenCalledOnce();
  });
});

describe("browser and keyboard adapter", () => {
  it("reuses one guard across returns, cancellations and reinstall/reload", async () => {
    const page = browser();
    const handle = vi.fn();
    handler({ handle });
    const dispose = await install();
    expect(page.history.length).toBe(3);
    expect(page.history.state).toMatchObject({ unrelated: "kept" });
    page.history.go(-1); await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
    page.history.go(-1); await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(2));
    expect(page.history.length).toBe(3);
    await dispose(); await install();
    expect(page.history.length).toBe(3);
    expect(page.history.replaceState).toHaveBeenCalledTimes(1);
    // No URL argument is supplied, retaining query strings, hashes and paths.
    expect(page.history.pushState.mock.calls.every(call => call.length === 2)).toBe(true);
  });

  it("leaves the site in one root return and supports forward re-entry", async () => {
    const page = browser();
    await install();
    page.history.go(-1);
    await vi.waitFor(() => expect(page.left()).toBe(true));
    expect(page.history.go).toHaveBeenLastCalledWith(-1);
    // Re-entering the base page rearms its existing forward slot.
    const handle = vi.fn(); handler({ handle });
    page.history.go(1);
    expect(handle).not.toHaveBeenCalled();
    expect(page.history.length).toBe(3);
    page.history.go(-1);
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
  });

  it("respects already consumed Escape and removes listeners on disposal", async () => {
    const page = browser();
    const handle = vi.fn();
    handler({ handle });
    const dispose = await install();
    escape(page.target, true);
    expect(handle).not.toHaveBeenCalled();
    expect(escape(page.target).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
    await dispose();
    expect(escape(page.target).defaultPrevented).toBe(false);
    page.history.go(-1);
    expect(handle).toHaveBeenCalledOnce();
  });

  it("preserves primitive history state and reports failures without leaving", async () => {
    const page = browser("existing state");
    const onError = vi.fn();
    handler({ handle: () => { throw new Error("cannot close"); } });
    await install({ onNativeRoot() {}, onError });
    expect(page.history.state).toMatchObject({ previousState: "existing state" });
    page.history.go(-1);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(page.left()).toBe(false);
    expect(page.history.length).toBe(3);
  });

  it("keeps keyboard handling available when an embedded browser denies History API writes", async () => {
    const page = browser();
    page.history.pushState.mockImplementation(() => { throw new Error("denied"); });
    const handle = vi.fn(); handler({ handle });
    const onError = vi.fn();
    await install({ onNativeRoot() {}, onError });
    expect(onError).toHaveBeenCalledOnce();
    expect(escape(page.target).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
  });

  it("disarms root return in a fresh PWA and rearms when another page opens", async () => {
    const page = browser(null, false);
    await install();
    expect(page.history.length).toBe(2);
    page.history.go(-1);
    await vi.waitFor(() => expect(page.history.go).toHaveBeenCalledTimes(2));
    expect(page.history.state).toMatchObject({ __hocBackNavigation: { position: "base" } });
    const handle = vi.fn(); handler({ handle });
    expect(page.history.state).toMatchObject({ __hocBackNavigation: { position: "guard" } });
    expect(page.history.length).toBe(2);
    page.history.go(-1);
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
  });

  it("rearms a dynamically enabled overlay after a root return and disconnects its observer", async () => {
    const page = browser(null, false);
    let changed!: () => void;
    const disconnect = vi.fn();
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: () => void) { changed = callback; }
      observe() {}
      disconnect = disconnect;
    });
    let enabled = false;
    const handle = vi.fn(); handler({ handle, enabled: () => enabled });
    const dispose = await install();
    page.history.go(-1);
    await vi.waitFor(() => expect(page.history.go).toHaveBeenCalledTimes(2));
    enabled = true; changed();
    expect(page.history.state).toMatchObject({ __hocBackNavigation: { position: "guard" } });
    page.history.go(-1);
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
    await dispose();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

describe("native adapter", () => {
  it("binds the system button without web history, serializes root exit and releases its listener", async () => {
    const page = browser();
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    let nativeBack!: () => void;
    const remove = vi.fn(async () => undefined);
    vi.mocked(App.addListener).mockImplementation(async (_name: string, callback: any) => {
      nativeBack = callback; return { remove };
    });
    let finish!: () => void;
    const onNativeRoot = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const dispose = await install({ onNativeRoot });
    expect(App.addListener).toHaveBeenCalledWith("backButton", expect.any(Function));
    expect(page.history.pushState).not.toHaveBeenCalled();
    const handle = vi.fn(); const unregister = handler({ handle });
    nativeBack(); await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
    expect(onNativeRoot).not.toHaveBeenCalled();
    unregister(); nativeBack();
    await vi.waitFor(() => expect(onNativeRoot).toHaveBeenCalledOnce());
    const closeOverlay = vi.fn(() => { finish(); unregisterOverlay(); });
    const unregisterOverlay = handler({ priority: 10, handle: closeOverlay });
    nativeBack();
    await vi.waitFor(() => expect(closeOverlay).toHaveBeenCalledOnce());
    expect(onNativeRoot).toHaveBeenCalledOnce();
    await dispose(); await dispose(); nativeBack();
    expect(remove).toHaveBeenCalledOnce();
    expect(onNativeRoot).toHaveBeenCalledOnce();
  });
});
