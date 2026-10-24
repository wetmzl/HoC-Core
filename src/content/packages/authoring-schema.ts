import { normalizedRegionError, type NormalizedRegion } from "../../presentation/regions";
/** Portable, data-only JSON Schema subset shared by plugins and authoring tools. */
export interface AuthoringSchema {
  readonly [keyword: string]: unknown;
}
export interface AuthoringIssue { readonly path: string; readonly message: string }
export interface AuthoringContext {
  readonly files?: readonly { path: string; mediaType: string }[];
  readonly resources?: readonly { id: string; type: string }[];
  readonly requires?: readonly string[];
}
const keywords = new Set(["$schema", "$id", "$defs", "$ref", "title", "description", "default", "examples", "type", "enum", "const", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems", "contains", "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "allOf", "anyOf", "oneOf", "if", "then", "else", "x-ui", "x-uniqueBy", "x-mediaType", "x-resourceType", "x-requires", "x-normalized-region", "x-portable-path", "x-enumFrom"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
};
export function assertAuthoringSchema(schema: unknown): asserts schema is AuthoringSchema {
  const visit = (node: unknown, depth: number): void => {
    if (!object(node) || depth > 64) throw new Error("字段 Schema 必须是对象且嵌套不超过 64 层");
    for (const key of Object.keys(node)) if (!keywords.has(key)) throw new Error(`不支持的 Schema 关键字：${key}`);
    if (node.type !== undefined && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(node.type))) throw new Error("Schema type 无效");
    if (node.$ref !== undefined && (typeof node.$ref !== "string" || !/^#\/\$defs\/[A-Za-z0-9_-]+$/.test(node.$ref))) throw new Error("仅支持包内 $defs 引用");
    for (const key of ["title", "description", "pattern", "x-mediaType", "x-resourceType", "x-uniqueBy", "x-enumFrom"]) if (node[key] !== undefined && typeof node[key] !== "string") throw new Error(`${key} 必须是字符串`);
    if (node["x-enumFrom"] !== undefined && !/^\/(?:[^~]|~[01])*$/.test(String(node["x-enumFrom"]))) throw new Error("x-enumFrom 必须是根数据的 JSON Pointer");
    if (node.pattern !== undefined) new RegExp(String(node.pattern));
    for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "minLength", "maxLength"]) {
      if (node[key] !== undefined && (typeof node[key] !== "number" || !Number.isFinite(node[key]))) throw new Error(`${key} 必须是有限数值`);
    }
    for (const key of ["minItems", "maxItems", "minLength", "maxLength"]) if (node[key] !== undefined && (!Number.isInteger(node[key]) || Number(node[key]) < 0)) throw new Error(`${key} 必须是非负整数`);
    if (node.multipleOf !== undefined && Number(node.multipleOf) <= 0) throw new Error("multipleOf 必须为正数");
    for (const key of ["additionalProperties", "uniqueItems", "x-requires", "x-normalized-region", "x-portable-path"]) if (node[key] !== undefined && typeof node[key] !== "boolean") throw new Error(`${key} 必须是布尔值`);
    if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some(v => typeof v !== "string") || new Set(node.required).size !== node.required.length)) throw new Error("required 必须是唯一字符串数组");
    if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length)) throw new Error("enum 必须是非空数组");
    for (const key of ["properties", "$defs"]) if (node[key] !== undefined) {
      if (!object(node[key])) throw new Error(`${key} 必须是对象`);
      for (const child of Object.values(node[key])) visit(child, depth + 1);
    }
    for (const key of ["allOf", "anyOf", "oneOf"]) if (node[key] !== undefined) {
      if (!Array.isArray(node[key]) || !node[key].length) throw new Error(`${key} 必须是非空数组`);
      for (const child of node[key]) visit(child, depth + 1);
    }
    for (const key of ["items", "contains", "if", "then", "else"]) if (node[key] !== undefined) visit(node[key], depth + 1);
  };
  visit(schema, 0);
  const resolve = (node: AuthoringSchema): void => {
    if (node.$ref && !Object.hasOwn((schema as AuthoringSchema).$defs ?? {}, String(node.$ref).split("/").at(-1)!)) throw new Error(`Schema 引用不存在：${node.$ref}`);
    for (const key of ["properties", "$defs"]) if (object(node[key])) Object.values(node[key]).forEach(v => resolve(v as AuthoringSchema));
    for (const key of ["allOf", "anyOf", "oneOf"]) if (Array.isArray(node[key])) node[key].forEach(v => resolve(v as AuthoringSchema));
    for (const key of ["items", "contains", "if", "then", "else"]) if (object(node[key])) resolve(node[key] as AuthoringSchema);
  };
  resolve(schema as AuthoringSchema);
}
export function validateAuthoringValue(schema: AuthoringSchema, value: unknown, context: AuthoringContext = {}): AuthoringIssue[] {
  assertAuthoringSchema(schema);
  const check = (node: AuthoringSchema, data: unknown, path: string, depth: number): AuthoringIssue[] => {
    const issues: AuthoringIssue[] = [];
    const fail = (message: string) => issues.push({ path, message });
    if (depth > 64) { fail("字段嵌套或 Schema 引用超过 64 层"); return issues; }
    if (node.$ref) issues.push(...check((schema.$defs as Record<string, AuthoringSchema>)[String(node.$ref).split("/").at(-1)!], data, path, depth + 1));
    const type = node.type;
    if (type !== undefined) {
      const valid = type === "object" ? object(data) : type === "array" ? Array.isArray(data) : type === "null" ? data === null : type === "integer" ? typeof data === "number" && Number.isInteger(data) : type === "number" ? typeof data === "number" && Number.isFinite(data) : typeof data === type;
      if (!valid) { fail(`需要 ${type}`); return issues; }
    }
    if (Array.isArray(node.enum) && !node.enum.some(v => equal(v, data))) fail("值不在可选范围内");
    if (typeof node["x-enumFrom"] === "string") {
      let options: unknown = value;
      for (const token of node["x-enumFrom"].slice(1).split("/")) {
        const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
        options = (object(options) || Array.isArray(options)) && Object.hasOwn(options, key)
          ? (options as Record<string, unknown>)[key] : undefined;
      }
      if (!Array.isArray(options) || !options.some(option => equal(option, data))) fail(`值未在 ${node["x-enumFrom"]} 中声明`);
    }
    if (Object.hasOwn(node, "const") && !equal(node.const, data)) fail(`必须为 ${JSON.stringify(node.const)}`);
    if (typeof data === "number") {
      if (!Number.isFinite(data)) fail("数值必须有限");
      if (node.minimum !== undefined && data < Number(node.minimum)) fail(`不得小于 ${node.minimum}`);
      if (node.maximum !== undefined && data > Number(node.maximum)) fail(`不得大于 ${node.maximum}`);
      if (node.exclusiveMinimum !== undefined && data <= Number(node.exclusiveMinimum)) fail(`必须大于 ${node.exclusiveMinimum}`);
      if (node.exclusiveMaximum !== undefined && data >= Number(node.exclusiveMaximum)) fail(`必须小于 ${node.exclusiveMaximum}`);
      if (node.multipleOf !== undefined && Math.abs(data / Number(node.multipleOf) - Math.round(data / Number(node.multipleOf))) > 1e-8) fail(`必须为 ${node.multipleOf} 的倍数`);
    }
    if (typeof data === "string") {
      const length = [...data].length;
      if (node.minLength !== undefined && length < Number(node.minLength)) fail(`至少 ${node.minLength} 个字符`);
      if (node.maxLength !== undefined && length > Number(node.maxLength)) fail(`最多 ${node.maxLength} 个字符`);
      if (node.pattern && !new RegExp(String(node.pattern)).test(data)) fail("格式不符合要求");
      if (node["x-portable-path"] && (!/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/.test(data) || data.split("/").some(p => p === "." || p === ".."))) fail("非法包内路径");
      if (node["x-mediaType"] && context.files && !context.files.some(f => f.path === data && (String(node["x-mediaType"]).endsWith("/*") ? f.mediaType.startsWith(String(node["x-mediaType"]).slice(0, -1)) : f.mediaType === node["x-mediaType"]))) fail("媒体文件未声明或类型不符");
      if (node["x-resourceType"] && context.resources && !context.resources.some(r => r.id === data && r.type === node["x-resourceType"])) fail("同包资源引用不存在或类型不符");
      if (node["x-requires"] && context.requires && !context.requires.includes(data)) fail("资源引用必须在 requires 中声明");
    }
    if (node["x-normalized-region"] && object(data)) {
      try { const error = normalizedRegionError(data as unknown as NormalizedRegion); if (error) fail(error); } catch { fail("区域格式无效"); }
    }
    if (object(data)) {
      for (const key of (node.required as string[] | undefined) ?? []) if (!Object.hasOwn(data, key)) issues.push({ path: `${path}/${key}`, message: "必填字段缺失" });
      const properties = (node.properties ?? {}) as Record<string, AuthoringSchema>;
      for (const key of Object.keys(data)) {
        const childPath = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
        if (Object.hasOwn(properties, key)) issues.push(...check(properties[key], data[key], childPath, depth + 1));
        else if (node.additionalProperties === false) issues.push({ path: childPath, message: "未知字段" });
      }
    }
    if (Array.isArray(data)) {
      if (node.minItems !== undefined && data.length < Number(node.minItems)) fail(`至少 ${node.minItems} 项`);
      if (node.maxItems !== undefined && data.length > Number(node.maxItems)) fail(`最多 ${node.maxItems} 项`);
      if (node.uniqueItems && data.some((v, i) => data.slice(0, i).some(other => equal(v, other)))) fail("数组项必须唯一");
      if (node["x-uniqueBy"] && data.some((v, i) => object(v) && data.slice(0, i).some(other => object(other) && equal(v[String(node["x-uniqueBy"])], other[String(node["x-uniqueBy"])])))) fail(`${node["x-uniqueBy"]} 必须唯一`);
      if (object(node.items)) data.forEach((v, i) => issues.push(...check(node.items as AuthoringSchema, v, `${path}/${i}`, depth + 1)));
      if (object(node.contains) && !data.some(v => !check(node.contains as AuthoringSchema, v, path, depth + 1).length)) fail("数组缺少必需项");
    }
    for (const child of (node.allOf as AuthoringSchema[] | undefined) ?? []) issues.push(...check(child, data, path, depth + 1));
    for (const key of ["anyOf", "oneOf"]) if (Array.isArray(node[key])) {
      const candidates = (node[key] as AuthoringSchema[]).map(child => check(child, data, path, depth + 1));
      const count = candidates.filter(v => !v.length).length;
      if (key === "anyOf" ? count === 0 : count !== 1) { fail(`${key} 分支不匹配`); if (count === 0) issues.push(...candidates.reduce((a, b) => a.length <= b.length ? a : b)); }
    }
    if (object(node.if)) {
      const branch = check(node.if as AuthoringSchema, data, path, depth + 1).length ? node.else : node.then;
      if (object(branch)) issues.push(...check(branch as AuthoringSchema, data, path, depth + 1));
    }
    return issues;
  };
  return check(schema, value, "", 0);
}
export function assertAuthoringValue(schema: AuthoringSchema, value: unknown, context: AuthoringContext = {}): void {
  const issues = validateAuthoringValue(schema, value, context);
  if (issues.length) throw new Error(issues.map(i => `${i.path || "/"}: ${i.message}`).join("；"));
}
