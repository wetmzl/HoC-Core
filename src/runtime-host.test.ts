import { afterEach, expect, it, vi } from "vitest";
const entry = vi.hoisted(() => ({ mountGameRuntime: vi.fn(), requestGameRuntimeExit: vi.fn() }));
vi.mock("./match-screen", () => entry);
afterEach(() => { vi.resetModules(); vi.clearAllMocks(); });
it("retains the exit entry when persistence rejects disposal", async () => {
  const dispose = vi.fn().mockRejectedValueOnce(new Error("storage refused")).mockResolvedValueOnce(undefined);
  entry.mountGameRuntime.mockResolvedValue({ dispose });
  const host = await import("./runtime-host");
  const handle = await host.mountGameRuntime({ root: {} as HTMLDivElement });
  await expect(handle.dispose()).rejects.toThrow("storage refused");
  await host.requestGameRuntimeExit();
  expect(entry.requestGameRuntimeExit).toHaveBeenCalledOnce();
  await handle.dispose();
  await expect(host.requestGameRuntimeExit()).rejects.toThrow("尚未启动");
});
