import { beforeEach, vi } from "vitest";
import { installBuiltinContentForTests, publicFileFetch } from "./builtin-content";

const nativeFetch = globalThis.fetch;

await installBuiltinContentForTests();

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("/characters/")) return publicFileFetch(input);
    return nativeFetch(input, init);
  });
});
