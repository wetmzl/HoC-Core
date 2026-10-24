import { describe, expect, it, vi } from "vitest";
import { ABILITY_REGISTRY, installAbilityRegistry } from "../core/abilities/registry";
import { createMatch, previewPendingTrigger } from "../core/match/reducer";
import { CORE_DIALOGUE_PRIMITIVES } from "./facts";
import { IntervalWinners } from "./intervals";
import { DialogueEngine } from "./engine";
import { DialoguePrimitiveRegistry } from "./registry";
import { CharacterDialogueResourceSchema } from "./schema";
import type { CharacterDialogue, DialogueAtom, DialogueCondition, DialoguePrimitive, DialogueRule } from "./types";
const atom = (primitive: string, test: DialogueAtom["test"], args = {}, apiVersion = 1): DialogueAtom => ({ primitive, apiVersion, args, test });
const range = (min: number, max: number, minInclusive = true, maxInclusive = true) => atom("core.roulette-probability", { range: { min, max, minInclusive, maxInclusive } }, { actor: "opponent", basis: "base" });
const program = (conditions: readonly DialogueCondition[]): CharacterDialogue => ({ pools: { fallback: ["兜底"] , ...Object.fromEntries(conditions.map((_c,i) => [`p${i}`, [`台词${i}甲`, `台词${i}乙`]])) }, rules: conditions.map((when,i) => ({ id:`r${i}`, on: [{ type: "core.round-start", apiVersion: 1 }, { type: "core.action", apiVersion: 1 }, { type: "core.trigger-ready", apiVersion: 1 }, { type: "core.trigger-result", apiVersion: 1 }], when, poolId:`p${i}` })), fallbackPoolId:"fallback" });
let sequence = 0;
const sample = (e: DialogueEngine, state: ReturnType<typeof initial>) => e.accept(state, { id: `probe-${++sequence}`, type: "core.round-start", apiVersion: 1, data: { roundIndex: state.roundIndex } });
const initial = () => { const s = createMatch("conditional-dialogue-test"); return { ...s, roulette: { ...s.roulette, opponent: { capacity: 100, bullets: 50 } } }; };
const basePrimitive: DialoguePrimitive = { id: "value", apiVersion: 1, title:"测试", description:"中性测试", parameters:{type:"object",additionalProperties:false}, returnType:"number", dependencies:["roulette"], read:c => c.state.roulette.opponent.bullets };
const register = (registry:DialoguePrimitiveRegistry,p:DialoguePrimitive) => registry.registerPackage("test/conditions", [p], [p]);

describe("ordered conditional dialogue", () => {
  it("compiles overlapping numeric intervals, singleton points, open edges and file priority", () => {
    const s=initial(), p=program([range(1,1),range(.5,1,false),range(0,.5)]), e=new DialogueEngine(p,"neutral");
    for (const [bullets,pool] of [[0,"p2"],[50,"p2"],[51,"p1"],[99,"p1"],[100,"p0"]] as const) expect(sample(e,{...s,roulette:{...s.roulette,opponent:{capacity:100,bullets}}}).poolId).toBe(pool);
    const reordered = new DialogueEngine(program([range(.5,1,false),range(1,1)]),"neutral");
    expect(reordered.select({...s,roulette:{...s.roulette,opponent:{capacity:100,bullets:100}}}).poolId).toBe("p0");
    expect(new DialogueEngine(program([range(.5,1,false,false)]),"neutral").select(s).poolId).toBe("fallback");
  });
  it("falls through any/not when any referenced primitive is missing, incompatible or throws", () => {
    const warn=vi.spyOn(console,"warn").mockImplementation(()=>{}), registry=new DialoguePrimitiveRegistry();
    const throws={...basePrimitive,read:()=>{throw Error("fail");}}; const release=register(registry,throws);
    const missing=atom("missing/provider#value",{eq:1}), badVersion=atom("test/conditions#value",{eq:1},{},2), bad=atom("test/conditions#value",{eq:1});
    const always=atom("core.round-number",{range:{min:1}});
    const e=new DialogueEngine(program([{any:[always,missing]},{not:missing},badVersion,{any:[always,bad]}]),"neutral",registry);
    expect(e.select(initial()).poolId).toBe("fallback"); expect(e.diagnostics.map(d=>d.ruleId)).toEqual(expect.arrayContaining(["r0","r1","r2","r3"]));
    release(); expect(e.select(initial()).poolId).toBe("fallback"); warn.mockRestore();
  });
  it("shares queries and caches redraws; skips callbacks behind unrelated phase guards",()=>{
    const registry=new DialoguePrimitiveRegistry(), read=vi.fn(basePrimitive.read), p={...basePrimitive,read}; register(registry,p);
    const q=atom("test/conditions#value",{range:{min:0}}), s=initial();
    const phase=atom("core.phase",{eq:"nonexistent"});
    const unrelated=Array.from({length:1000},()=>({all:[phase,q]} as DialogueCondition));
    const e=new DialogueEngine(program([...unrelated,{all:[q,q]}]),"neutral",registry);
    const result=e.select(s);expect(read).toHaveBeenCalledTimes(1);expect(e.select(s)).toBe(result);expect(read).toHaveBeenCalledTimes(1);
    e.select({...s,round:{...s.round,currentActor:null}});expect(read).toHaveBeenCalledTimes(1);
    e.select({...s,roulette:{...s.roulette,opponent:{capacity:100,bullets:60}}});expect(read).toHaveBeenCalledTimes(1);sample(e,s);expect(read).toHaveBeenCalledTimes(2);
    const unrelatedOnly=new DialogueEngine(program(unrelated),"neutral",registry);unrelatedOnly.select(s);expect(read).toHaveBeenCalledTimes(2);
  });
  it("uses a frozen detached full-state snapshot and never changes domain RNG or state",()=>{
    const warn=vi.spyOn(console,"warn").mockImplementation(()=>{}), registry=new DialoguePrimitiveRegistry(), s=initial(), before=structuredClone(s);
    const p={...basePrimitive,read:(c:Parameters<DialoguePrimitive["read"]>[0])=>{(c.state.roulette.opponent as {bullets:number}).bullets=100;return 1;}};register(registry,p);
    const e=new DialogueEngine(program([atom("test/conditions#value",{eq:1})]),"neutral",registry);expect(e.select(s).poolId).toBe("fallback");expect(s).toEqual(before);warn.mockRestore();
  });
  it("keeps a line/key within one rule; rerolls only on new actions or rule changes, including restore",()=>{
    const s=initial(), p=program([range(0,.8),range(.8,1)]),e=new DialogueEngine(p,"neutral"), first=e.select(s);
    const next={...s,roulette:{...s.roulette,opponent:{capacity:100,bullets:60}}};expect(e.select(next).key).toBe(first.key);expect(e.select(next).line).toBe(first.line);
    const hit={...next,history:[...next.history,{type:"PLAYER_HIT" as const,value:15}]};expect(e.select(hit).key).not.toBe(first.key);
    expect(new DialogueEngine(p,"neutral").select(structuredClone(hit))).toEqual(e.select(hit));
    expect(e.select({...hit,history:[...hit.history,{type:"TURN_SKIPPED" as const,actor:"opponent" as const,sourceInstanceId:"neutral"}]})).toEqual(e.select(hit));
  });
  it("skips a failed portrait and recomputes compiled interval winners",()=>{
    const warn=vi.spyOn(console,"warn").mockImplementation(()=>{}),p=program([range(0,1),range(0,1)]);
    const rules:DialogueRule[]=p.rules.map((r,i)=>({...r,portrait:{image:`${i}.png`}}));const e=new DialogueEngine({...p,rules},"neutral"),s=initial();expect(e.select(s).poolId).toBe("p0");expect(e.rejectPortrait("r0").poolId).toBe("p1");expect(e.rejectPortrait("r1").poolId).toBe("fallback");warn.mockRestore();
  });
  it("supports enabling, unloading, namespace isolation and duplicate registration rejection",()=>{
    const warn=vi.spyOn(console,"warn").mockImplementation(()=>{}), registry=new DialoguePrimitiveRegistry(),e=new DialogueEngine(program([atom("test/conditions#value",{range:{min:0}})]),"neutral",registry),s=initial();
    expect(e.select(s).poolId).toBe("fallback");const release=register(registry,basePrimitive);expect(sample(e,s).poolId).toBe("p0");expect(()=>register(registry,basePrimitive)).toThrow("重复");registry.registerPackage("other/conditions",[basePrimitive],[basePrimitive]);release();expect(sample(e,s).poolId).toBe("fallback");warn.mockRestore();
  });
  it("reads actual hidden hand totals and pending/result probabilities without consuming preview state",()=>{
    const s=initial(), before=structuredClone(s), total=CORE_DIALOGUE_PRIMITIVES.find(p=>p.id==="core.hand-total")!;
    expect(total.read({state:s},{actor:"opponent"})).toBeGreaterThan(0);
    const window={...s,round:{...s.round,phase:"roulette-trigger" as const,outcome:{winner:"player" as const,reason:"comparison" as const,penaltyTarget:"opponent" as const,bulletsAdded:1}}};
    const preview=previewPendingTrigger(window)!;const e=new DialogueEngine(program([atom("core.roulette-probability",{eq:preview.probability},{actor:"opponent",basis:"effective"})]),"neutral");expect(e.select(window).poolId).toBe("p0");expect(s).toEqual(before);
    const result={...s,round:{...s.round,phase:"roulette-result" as const},history:[...s.history,{type:"TRIGGER_PULLED" as const,actor:"opponent" as const,probability:.25,baseProbability:1,misfireChance:.75,result:"misfire" as const,fired:false}]};
    expect(new DialogueEngine(program([atom("core.roulette-probability",{eq:.25},{actor:"opponent",basis:"effective"})]),"neutral").select(result).poolId).toBe("p0");
  });
  it("rejects absent fallback, dangling pools, unsafe media paths, empty intervals and excessive nesting",()=>{
    const p=program([range(0,1)]);expect(()=>CharacterDialogueResourceSchema.parse({...p,fallbackPoolId:"missing"})).toThrow();expect(()=>CharacterDialogueResourceSchema.parse({...p,rules:[{...p.rules[0],poolId:"missing"}]})).toThrow();expect(()=>CharacterDialogueResourceSchema.parse({...p,rules:[{...p.rules[0],portrait:{image:"../bad.png"}}]})).toThrow();expect(()=>CharacterDialogueResourceSchema.parse(program([range(1,1,false)]))).toThrow();
    let condition:DialogueCondition=range(0,1);for(let i=0;i<40;i++)condition={not:condition};expect(()=>CharacterDialogueResourceSchema.parse(program([condition]))).toThrow();
  });
});
it("updates every interval group sharing a fact even when an earlier group warms its cache",()=>{
  const s=initial(), phase=atom("core.phase",{eq:s.round.phase}),p=program([range(.8,1),{all:[phase,range(.5,.8)]}]),e=new DialogueEngine(p,"neutral");
  expect(e.select(s).poolId).toBe("p1");expect(sample(e,{...s,roulette:{...s.roulette,opponent:{capacity:100,bullets:90}}}).poolId).toBe("p0");expect(sample(e,{...s,roulette:{...s.roulette,opponent:{capacity:100,bullets:60}}}).poolId).toBe("p1");
});
it("compiled interval winners agree with ordered predicates across many overlapping open/closed ranges",()=>{
 const s=initial(),conditions:DialogueCondition[]=Array.from({length:150},(_,i)=>range((i*17%97)/100,(i*17%97+3)/100,i%2===0,i%3!==0));const e=new DialogueEngine(program(conditions),"neutral");
 for(let bullets=0;bullets<=1000;bullets++){const probability=bullets/1000;const expected=conditions.findIndex(c=>{const a=c as DialogueAtom;if(!("range" in a.test))return false;const r=a.test.range;return (r.minInclusive===false?probability>r.min!:probability>=r.min!)&&(r.maxInclusive===false?probability<r.max!:probability<=r.max!);});expect(sample(e,{...s,roulette:{...s.roulette,opponent:{capacity:1000,bullets}}}).poolId).toBe(expected<0?"fallback":`p${expected}`);}
});

it("pending probabilities include discarded gun and misfire modifiers and cancellation stays unavailable",()=>{
 const original=ABILITY_REGISTRY;
 try {
  const definition={id:"neutral-preview",name:"中性预览",description:"中性验证",sourceKind:"ai-skill",primaryDomain:"gunslinger",tags:["neutral"],activation:{type:"automatic"},rules:[{id:"modify",trigger:"before-trigger-pull",effects:[{type:"add-gun-bullets",target:"owner",amount:1},{type:"add-to-pending-trigger-misfire-chance",target:"owner",amount:.25}]}]};
  installAbilityRegistry([...original.definitions,definition],original.statuses,original.catalogVersion);
  const base=createMatch("preview-modifiers",{opponentAiSkills:[{definitionId:definition.id,enabled:true,parameters:{}}]}),s={...base,roulette:{...base.roulette,opponent:{capacity:6,bullets:3}},round:{...base.round,phase:"roulette-trigger" as const,outcome:{winner:"player" as const,reason:"comparison" as const,penaltyTarget:"opponent" as const,bulletsAdded:1}}},before=structuredClone(s);
  const p=program([{all:[atom("core.roulette-probability",{eq:4/6},{actor:"opponent",basis:"base"}),atom("core.roulette-probability",{eq:.5},{actor:"opponent",basis:"effective"})]}]);
  expect(new DialogueEngine(p,"neutral").select(s).poolId).toBe("p0");expect(s).toEqual(before);
  const cancel={...definition,rules:[{id:"cancel",trigger:"before-trigger-pull",effects:[{type:"cancel-pending-trigger",target:"owner"}]}]};installAbilityRegistry([...original.definitions,cancel],original.statuses,original.catalogVersion);
  const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});try{expect(new DialogueEngine(p,"neutral").select(s).poolId).toBe("fallback");expect(s).toEqual(before);}finally{warn.mockRestore();}
 } finally {installAbilityRegistry(original.definitions,original.statuses,original.catalogVersion);}
});
it("uses one compiled interval lookup per event instead of testing every overlapping range", () => {
  const select = vi.spyOn(IntervalWinners.prototype, "select"), registry = new DialoguePrimitiveRegistry(), read = vi.fn(() => .5);
  const primitive = { ...basePrimitive, dependencies: ["event" as const], read }; register(registry, primitive);
  const conditions = Array.from({ length: 500 }, () => atom("test/conditions#value", { range: { min: .5, max: 1 } }));
  const e = new DialogueEngine(program(conditions), "neutral", registry), state = initial();
  e.commit(sample(e, state)); expect(read).toHaveBeenCalledTimes(1); expect(select).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 100; i++) e.peek(state); expect(read).toHaveBeenCalledTimes(1); expect(select).toHaveBeenCalledTimes(1);
  select.mockRestore();
});
it("does not compile contradictory phase predicates into a numeric winner", () => {
  const state = initial(), contradictory = { all: [atom("core.phase", { eq: "turns" }), atom("core.phase", { eq: "roulette-result" }), range(0, 1)] };
  const engine = new DialogueEngine(program([contradictory, range(0, 1)]), "neutral");
  expect(engine.select(state).poolId).toBe("p1");
});
