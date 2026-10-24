import { afterEach, describe, expect, it, vi } from "vitest";
const runtime = vi.hoisted(() => ({ mountGameRuntime: vi.fn(), requestGameRuntimeExit: vi.fn() }));
vi.mock("./runtime/create-game-runtime", () => ({ createGameRuntime: () => runtime }));
afterEach(() => { vi.resetModules(); vi.clearAllMocks(); });
describe("runtime compatibility facade", () => {
  it("rejects concurrent mounts and memoizes disposal", async () => {
    let finish!: (value: { dispose(): Promise<void> }) => void;
    const dispose = vi.fn(async () => undefined);
    runtime.mountGameRuntime.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { mountGameRuntime } = await import("./match-screen");
    const first = mountGameRuntime({ root: {} as HTMLDivElement });
    await expect(mountGameRuntime({ root: {} as HTMLDivElement })).rejects.toThrow("已经存在");
    finish({ dispose });
    const handle = await first;
    await expect(mountGameRuntime({ root: {} as HTMLDivElement })).rejects.toThrow("已经存在");
    await Promise.all([handle.dispose(), handle.dispose()]);
    expect(dispose).toHaveBeenCalledOnce();
    runtime.mountGameRuntime.mockResolvedValue({ dispose });
    const next = await mountGameRuntime({ root: {} as HTMLDivElement });
    await next.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});

it("keeps the mounted runtime after failed disposal and allows retry", async () => {
  const dispose = vi.fn().mockRejectedValueOnce(new Error("storage refused")).mockResolvedValueOnce(undefined);
  runtime.mountGameRuntime.mockResolvedValue({ dispose });
  const { mountGameRuntime, requestGameRuntimeExit } = await import("./match-screen");
  const handle = await mountGameRuntime({ root: {} as HTMLDivElement });
  await expect(handle.dispose()).rejects.toThrow("storage refused");
  await expect(mountGameRuntime({ root: {} as HTMLDivElement })).rejects.toThrow("已经存在");
  await requestGameRuntimeExit();
  expect(runtime.requestGameRuntimeExit).toHaveBeenCalledOnce();
  await handle.dispose();
  expect(dispose).toHaveBeenCalledTimes(2);
});
