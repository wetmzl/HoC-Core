import { expect, it } from "vitest";
import { collectMainMenuQuote, selectMainMenuQuote, validatePluginMainMenuQuote } from "./plugin-ui";
import { renderLobbyMarkup } from "../../lobby-screen-module";
import { createDefaultSave } from "../../persistence/boot";

const quote = { lines: [{ text: 'A <b>bold</b> choice' }, { text: 'Make it count.', emphasis: true }] };
const view = { save: createDefaultSave(), menuActions: [], guests: [], defeated: [], visibleDefeated: [], defeatedRemaining: 0 };

it("validates bounded plain-text quotes, explicit hiding and the API baseline", () => {
  expect(validatePluginMainMenuQuote(undefined, 2)).toBeUndefined();
  expect(() => validatePluginMainMenuQuote(quote, 12)).toThrow("API 13");
  expect(validatePluginMainMenuQuote(quote, 13)).toEqual(quote);
  expect(validatePluginMainMenuQuote({ lines: [] }, 13)).toEqual({ lines: [] });
  for (const invalid of [null, {}, { lines: [{ text: ' ' }] }, { lines: [{ text: 'x', html: true }] }, { lines: [{ text: 'x', emphasis: 'true' }] }, { lines: Array(9).fill({ text: 'x' }) }, { lines: [{ text: 'x'.repeat(501) }] }]) {
    expect(() => validatePluginMainMenuQuote(invalid, 13)).toThrow();
  }
});

it("resolves overrides without treating absent or explicitly hidden quotes as defaults", () => {
  const second = { lines: [{ text: 'Second' }] };
  expect(collectMainMenuQuote([])).toBeUndefined();
  expect(collectMainMenuQuote([{ mainMenuQuote: quote }, {}, { mainMenuQuote: second }])).toEqual(second);
  expect(collectMainMenuQuote([{ mainMenuQuote: second }, { mainMenuQuote: quote }])).toEqual(quote);
  expect(collectMainMenuQuote([{ mainMenuQuote: quote }, { mainMenuQuote: { lines: [] } }, {}])).toEqual({ lines: [] });
  expect(collectMainMenuQuote([{}])).toBeUndefined();
});

it("renders only the active menu quote, escapes HTML and omits empty quote containers", () => {
  expect(renderLobbyMarkup({ ...view, layer: 'menu' })).not.toContain('menu-oath');
  expect(renderLobbyMarkup({ ...view, layer: 'menu', mainMenuQuote: { lines: [] } })).not.toContain('menu-oath');
  const markup = renderLobbyMarkup({ ...view, layer: 'menu', mainMenuQuote: quote });
  expect(markup).toContain('<p>A &lt;b&gt;bold&lt;/b&gt; choice</p><strong>Make it count.</strong>');
  expect(markup).not.toContain('<b>bold</b>');
  expect(renderLobbyMarkup({ ...view, layer: 'characters', mainMenuQuote: quote })).not.toContain('menu-oath');
});

it("uses saved plugin priority with deterministic defaults and skips non-providers", () => {
  const hidden = { lines: [] };
  const modules = [{ packageId: "test/b", contribution: { mainMenuQuote: hidden } }, { packageId: "test/a", contribution: { mainMenuQuote: quote } }, { packageId: "test/other", contribution: {} }];
  expect(selectMainMenuQuote(modules, [])).toEqual(quote);
  expect(selectMainMenuQuote(modules, ["test/other", "test/b", "test/a"])).toEqual(hidden);
  expect(modules[0].packageId).toBe("test/b");
});
