import { expect, it } from "vitest";
import { assertAuthoringSchema, validateAuthoringValue, type AuthoringSchema } from "./authoring-schema";
const schema: AuthoringSchema = {
  type: "object", required: ["character", "points"], additionalProperties: false,
  properties: {
    character: { type: "string", "x-resourceType": "game.character-match", "x-requires": true },
    points: { type: "array", minItems: 1, "x-uniqueBy": "id", items: { $ref: "#/$defs/point" } }
  }, $defs: { point: { type: "object", required: ["id", "x", "image"], additionalProperties: false, properties: { id: { type: "string" }, x: { type: "number", minimum: 0, maximum: 100 }, image: { type: "string", "x-mediaType": "image/*" } } } }
};
const context = { resources: [{ id: "actor", type: "game.character-match" }], requires: ["actor"], files: [{ path: "portrait.png", mediaType: "image/png" }] };
it("reports precise structural, reference, media, range and duplicate failures", () => {
  expect(validateAuthoringValue(schema, { character: "actor", points: [{ id: "one", x: 50, image: "portrait.png" }] }, context)).toEqual([]);
  const errors = validateAuthoringValue(schema, { character: "other", extra: true, points: [{ id: "same", x: 101, image: "missing.png" }, { id: "same", x: 0, image: "portrait.png" }] }, context);
  expect(errors.map(e => e.path)).toEqual(expect.arrayContaining(["/character", "/extra", "/points", "/points/0/x", "/points/0/image"]));
  expect(validateAuthoringValue(schema, { character: "actor", points: [] }, { ...context, requires: [] }).some(e => e.message.includes("requires"))).toBe(true);
});
it("checks conditional variants and semantic uniqueness independent of object key order", () => {
  const conditional = { type: "object", properties: { mode: { type: "string" }, count: { type: "integer" } }, allOf: [{ if: { properties: { mode: { const: "limited" } }, required: ["mode"] }, then: { required: ["count"], properties: { count: { minimum: 1 } } } }] };
  expect(validateAuthoringValue(conditional, { mode: "limited" }).some(e => e.path === "/count")).toBe(true);
  expect(validateAuthoringValue(conditional, { mode: "open" })).toEqual([]);
  expect(validateAuthoringValue({ type: "array", uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }])).toHaveLength(1);
});
it("rejects unsupported, invalid and missing references rather than silently accepting them", () => {
  for (const input of [{ format: "email" }, { $ref: "https://example.com/schema" }, { $ref: "#/$defs/missing" }, { type: "string", pattern: "[" }, { type: "array", minItems: -1 }]) expect(() => assertAuthoringSchema(input)).toThrow();
  expect(validateAuthoringValue({ $defs: { self: { $ref: "#/$defs/self" } }, $ref: "#/$defs/self" }, {})).toHaveLength(1);
});

it("validates data-only enum references against the root document", () => {
  const declaration = { type: "object", properties: { ids: { type: "array" }, selected: { "x-enumFrom": "/ids" } } };
  expect(validateAuthoringValue(declaration, { ids: ["first"], selected: "first" })).toEqual([]);
  expect(validateAuthoringValue(declaration, { ids: ["first"], selected: "unknown" })).toEqual([{ path: "/selected", message: "值未在 /ids 中声明" }]);
  expect(validateAuthoringValue(declaration, { selected: "first" })).toHaveLength(1);
  expect(validateAuthoringValue({ properties: { selected: { "x-enumFrom": "/a~1b/~0ids" } } }, { "a/b": { "~ids": ["ok"] }, selected: "ok" })).toEqual([]);
  for (const value of [true, "ids", "/bad~2escape"]) expect(() => assertAuthoringSchema({ "x-enumFrom": value })).toThrow();
});
