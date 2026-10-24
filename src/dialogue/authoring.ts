import { CORE_DIALOGUE_PRIMITIVES } from "./facts";
import { CharacterDialogueResourceSchema } from "./schema";
import { validateAuthoringValue } from "../content/packages/authoring-schema";
import type { DialogueCondition, DialoguePrimitiveDeclaration } from "./types";
export interface DialogueAuthoringIssue { readonly ruleId: string; readonly primitive: string; readonly severity: "error" | "warning"; readonly message: string }
/** Validates data without importing plugin modules. Unknown optional capabilities remain intact. */
export function validateDialogueResource(payload: unknown, primitives: readonly DialoguePrimitiveDeclaration[] = []): DialogueAuthoringIssue[] {
  const program = CharacterDialogueResourceSchema.parse(payload);
  const available = new Map([...CORE_DIALOGUE_PRIMITIVES, ...primitives].map(p => [`${p.id}@${p.apiVersion}`, p]));
  const issues: DialogueAuthoringIssue[] = [];
  const visit = (condition: DialogueCondition, ruleId: string): void => {
    if (!("primitive" in condition)) { ("not" in condition ? [condition.not] : "all" in condition ? condition.all : condition.any).forEach(c => visit(c, ruleId)); return; }
    const primitive = available.get(`${condition.primitive}@${condition.apiVersion}`);
    if (!primitive) { issues.push({ ruleId, primitive: condition.primitive, severity: "warning", message: "可选原语不可用，运行时将跳过整条规则" }); return; }
    const failures = validateAuthoringValue(primitive.parameters, condition.args);
    if ("range" in condition.test && primitive.returnType !== "number") failures.push({ path: "/test", message: "区间只能用于数值原语" });
    if ("eq" in condition.test && condition.test.eq !== null && typeof condition.test.eq !== primitive.returnType) failures.push({ path: "/test", message: "比较值类型与原语不符" });
    failures.forEach(f => issues.push({ ruleId, primitive: condition.primitive, severity: "error", message: `${f.path}: ${f.message}` }));
  };
  program.rules.forEach(r => visit(r.when, r.id));
  return issues;
}
