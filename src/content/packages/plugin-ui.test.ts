import { expect, it } from "vitest";
import { validatePluginUiActions } from "./plugin-ui";

const action = { id: "catalog", slot: "main-menu.secondary", label: "示例目录", mount: () => ({ dispose() {} }) };
it("gates the new contract while retaining older plugins without UI contributions", () => {
  expect(validatePluginUiActions(undefined, 2)).toBeUndefined();
  expect(() => validatePluginUiActions([], 7)).toThrow("API 8");
  expect(validatePluginUiActions([action], 8)).toEqual([action]);
});
it("rejects malformed, duplicate, unbounded and executable-markup contributions", () => {
  for (const actions of [
    [{ ...action, slot: "match" }], [{ ...action, id: "" }], [{ ...action, label: " " }],
    [{ ...action, order: Infinity }], [{ ...action, order: 0.5 }], [{ ...action, mount: "code" }],
    [{ ...action, html: "<button>" }], [action, action], Array.from({ length: 33 }, (_, i) => ({ ...action, id: `entry-${i}` }))
  ]) expect(() => validatePluginUiActions(actions, 8)).toThrow();
});
