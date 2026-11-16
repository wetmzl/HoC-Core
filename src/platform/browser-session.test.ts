import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import { startBrowserSession } from "./browser-session";

function root() {
  const button = { onclick: undefined as undefined | (() => void) };
  return Object.assign({ innerHTML: "", querySelector: () => button }, { button }) as unknown as HTMLDivElement;
}

function browser() {
  let held = false;
  const request = vi.fn(async (_name: string, _options: LockOptions, callback: LockGrantedCallback<unknown>) => {
    if (held) return callback(null);
    held = true;
    try { return await callback({} as Lock); }
    finally { held = false; }
  });
  vi.stubGlobal("navigator", { locks: { request } });
  return { request };
}

beforeEach(() => { vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(false); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("holds ownership after startup completes, blocking every later document", async () => {
  browser();
  const first = vi.fn(async () => {}), second = vi.fn(async () => {});
  await startBrowserSession(root(), first);
  await startBrowserSession(root(), second);
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
});

it("takes ownership before a slow initializer can write", async () => {
  browser();
  let finish!: () => void;
  const initializing = new Promise<void>(resolve => { finish = resolve; });
  const first = vi.fn(() => initializing), second = vi.fn(async () => {});
  const starting = startBrowserSession(root(), first);
  await startBrowserSession(root(), second);
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
  finish(); await starting;
});

it("keeps ownership after partial startup fails so delayed writers remain isolated", async () => {
  browser();
  const second = vi.fn(async () => {});
  await expect(startBrowserSession(root(), async () => { throw new Error("startup failed"); })).rejects.toThrow("startup failed");
  await startBrowserSession(root(), second);
  expect(second).not.toHaveBeenCalled();
});

it.each(["missing", "reject", "throw"])("never initializes storage when lock acquisition is %s", async failure => {
  const { request } = browser();
  if (failure === "missing") vi.stubGlobal("navigator", {});
  else if (failure === "reject") request.mockRejectedValue(new Error("denied"));
  else request.mockImplementation(() => { throw new Error("denied"); });
  const start = vi.fn(async () => {});
  await startBrowserSession(root(), start);
  expect(start).not.toHaveBeenCalled();
});

it("starts the single-task native app without browser locks", async () => {
  const { request } = browser();
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  const start = vi.fn(async () => {});
  await startBrowserSession(root(), start);
  expect(start).toHaveBeenCalledOnce();
  expect(request).not.toHaveBeenCalled();
});
