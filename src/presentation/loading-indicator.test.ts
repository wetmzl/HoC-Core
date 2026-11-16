import { describe, expect, it } from "vitest";
import { loadingIndicatorMarkup } from "./loading-indicator";

describe("loading progress semantics", () => {
  it.each([undefined, 0, -1, NaN, Infinity])("keeps an unknown total indeterminate (%s)", total => {
    const markup = loadingIndicatorMarkup({ label: "写入资源", completed: 10, total });
    expect(markup).not.toContain("aria-valuenow");
    expect(markup).toContain("hoc-loading-unknown");
  });

  it.each([undefined, NaN, Infinity])("does not publish an invalid completed count (%s)", completed => {
    expect(loadingIndicatorMarkup({ label: "校验资源", completed, total: 100 })).not.toContain("aria-valuenow");
  });

  it("does not round incomplete work up to 100 percent", () => {
    expect(loadingIndicatorMarkup({ label: "写入资源", completed: 999, total: 1000 })).toContain('aria-valuenow="99"');
  });

  it.each([[-2, 0], [100, 100], [150, 100]])("bounds completed count %s at %s percent", (completed, percent) => {
    expect(loadingIndicatorMarkup({ label: "写入资源", completed, total: 100 })).toContain(`aria-valuenow="${percent}"`);
  });

  it("escapes a label in both visible text and accessibility attributes", () => {
    const markup = loadingIndicatorMarkup({ label: '读取 <包> & "资源"' });
    expect(markup).toContain('aria-label="读取 &lt;包&gt; &amp; &quot;资源&quot;"');
    expect(markup).not.toContain("<包>");
  });
});
