import { expect, it, vi } from "vitest";
import { createHocpkgResourceHandlers, createCharacterDialogueResourceHandler } from "./resources";
import { loadHocpkgResources } from "./loader";
import { HocpkgManifestSchema } from "./schema";
import { createCharacterDraft, validateCharacterPackage } from "../../authoring-api";
import { sha256 } from "../storage/encoding";
import { DialoguePrimitiveRegistry } from "../../dialogue/registry";
import type { CharacterDialogue } from "../../dialogue/types";
import { CharacterDialogueResourceSchema, CharacterDialogueSchema } from "../../dialogue/schema";

it("normalizes API3 pool objects and preserves opaque package data without changing legacy lines", async () => {
 const {draft,manifest}=await fixture();
 const payload={...draft.dialogue,pools:{...draft.dialogue.pools,MATCH_START:{lines:["中性回应"],extensions:{"example/pool-effects":{effect:"spark"}}}}};
 const descriptor={...manifest.resources[1],apiVersion:3};
 const handler=createCharacterDialogueResourceHandler();
 const context={manifest,descriptor,dependencies:new Map(),packageBaseUrl:"/",resolvePath:(p:string)=>p};
 const parsed=await handler.parse(payload,context);
 expect(parsed.pools.MATCH_START).toEqual(["中性回应"]);
 expect(parsed.poolExtensions?.MATCH_START).toEqual({"example/pool-effects":{effect:"spark"}});
 expect(CharacterDialogueSchema.parse(parsed)).toEqual(parsed);
 expect(CharacterDialogueResourceSchema.parse(draft.dialogue)).toEqual(draft.dialogue);
 await expect(handler.parse(payload,{...context,descriptor:{...descriptor,apiVersion:2}})).rejects.toThrow("API 3");
 expect(CharacterDialogueResourceSchema.safeParse({...payload,poolExtensions:{MISSING:{"example/effect":{}}}}).success).toBe(false);
 expect(CharacterDialogueResourceSchema.safeParse({...payload,pools:{MATCH_START:{lines:[],extensions:{"example/effect":{}}}}}).success).toBe(false);
});

async function fixture() {
 const draft=createCharacterDraft("neutral","中性角色");
 Reflect.deleteProperty(draft.match.metadata, "encounter");
 for(const pool of Object.values(draft.dialogue.pools)) (pool as string[]).push("测试对白");
 const bodies:Record<string,Uint8Array>={"match.json":new TextEncoder().encode(JSON.stringify(draft.match)),"dialogue.json":new TextEncoder().encode(JSON.stringify(draft.dialogue))};
 for(const name of ["cover","relaxed","conflicted","mocking","threatened","unconscious"])bodies[`${name}.png`]=new Uint8Array([1]);
 const manifest=HocpkgManifestSchema.parse({format:"house-of-chances-hocpkg",formatVersion:1,identity:{authorId:"test",packageName:"neutral",version:"1.0.0"},metadata:{title:"中性角色",description:"测试",tags:[],creators:[{displayName:"Test",roles:["design"]}]},resources:[{id:"match",type:"game.character-match",apiVersion:4,entry:"match.json",requires:["dialogue"]},{id:"dialogue",type:"game.character-dialogue",apiVersion:2,entry:"dialogue.json",requires:[]}],files:await Promise.all(Object.entries(bodies).map(async([path,bytes])=>({path,bytes:bytes.length,sha256:await sha256(bytes),mediaType:path.endsWith(".json")?"application/json":"image/png"}))),extensions:{}});
 return {draft,manifest,bodies};
}
it("loads independent dialogue resources, rejects API3 and enforces only the same-package dialogue dependency",async()=>{
 const {manifest,bodies}=await fixture();const options={handlers:createHocpkgResourceHandlers(),readJson:async(path:string)=>JSON.parse(new TextDecoder().decode(bodies[path])),resolvePath:(path:string)=>path};
 expect((await loadHocpkgResources(manifest,options)).map(r=>r.state)).toEqual(["active","active"]);
 const old={...manifest,resources:manifest.resources.map(r=>r.id==="match"?{...r,apiVersion:3}:r)};expect((await loadHocpkgResources(old,options))[0].reason).toBe("api-version-unsupported");
 const noDependency={...manifest,resources:manifest.resources.map(r=>r.id==="match"?{...r,requires:[]}:r)};expect((await loadHocpkgResources(noDependency,options))[0].state).toBe("invalid");
});
it("preserves optional unknown primitive data during authoring and avoids reading its portrait",async()=>{
 const {draft,manifest}=await fixture();const dialogue:CharacterDialogue={...draft.dialogue,rules:[{id:"optional",on:[{type:"core.round-start",apiVersion:1}],poolId:"MATCH_START",when:{primitive:"test/optional#value",apiVersion:1,args:{},test:{eq:true}},portrait:{image:"relaxed.png"}}]};
 const resolvePath=vi.fn(async()=>"blob:portrait");const descriptor=manifest.resources[1];
 await createCharacterDialogueResourceHandler(new DialoguePrimitiveRegistry()).parse(dialogue,{manifest,descriptor,dependencies:new Map(),packageBaseUrl:"/",resolvePath});expect(resolvePath).not.toHaveBeenCalled();
 const bytes=new TextEncoder().encode(JSON.stringify(dialogue)),{bodies}=await fixture();bodies["dialogue.json"]=bytes;const updated={...manifest,files:manifest.files.map(f=>f.path==="dialogue.json"?{...f,bytes:bytes.length,sha256:""}:f)};updated.files.find(f=>f.path==="dialogue.json")!.sha256=await sha256(bytes);
 await validateCharacterPackage({manifest:updated,readFile:async path=>bodies[path]});
});
it("missing optional portrait files do not invalidate the runtime resource but fail strict authoring",async()=>{
 const {draft,manifest,bodies}=await fixture();const dialogue={...draft.dialogue,rules:[{id:"optional-art",on:[{type:"core.round-start",apiVersion:1}],poolId:"MATCH_START",when:{primitive:"core.round-number",apiVersion:1,args:{},test:{range:{min:1}}},portrait:{image:"missing.png"}}]};const bytes=new TextEncoder().encode(JSON.stringify(dialogue));bodies["dialogue.json"]=bytes;manifest.files.find(f=>f.path==="dialogue.json")!.bytes=bytes.length;manifest.files.find(f=>f.path==="dialogue.json")!.sha256=await sha256(bytes);
 const loaded=await loadHocpkgResources(manifest,{handlers:createHocpkgResourceHandlers(),readJson:async path=>JSON.parse(new TextDecoder().decode(bodies[path])),resolvePath:path=>path});expect(loaded.map(r=>r.state)).toEqual(["active","active"]);await expect(validateCharacterPackage({manifest,readFile:async path=>bodies[path]})).rejects.toThrow("立绘未声明");
});
