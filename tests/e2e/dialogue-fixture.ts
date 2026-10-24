import { expect, type Page } from "@playwright/test";

export async function mountDialogue(page: Page, scenario: "bad-art" | "stale-art" | "primitive" | "tap" | "tap-default" | "ability", restored = false, phase = "turns", finished = false) {
  await page.goto("/");
  await expect(page.locator("[data-start-game]")).toBeEnabled();
  await page.clock.install();
  await page.evaluate(async ({ scenario, restored, phase, finished }) => {
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    await load("/src/table-screen-module.ts");
    await (await load("/src/content/packages/content-loader.ts")).bootstrapContent({ fetch: window.fetch.bind(window) });
    const { loadCharacter, installCharacterDefinitions } = await load("/src/content/characters/loader.ts");
    const { installCharacterCatalog } = await load("/src/content/characters/catalog.ts");
    const { createMatch, gameReducer } = await load("/src/core/match/reducer.ts");
    const { createCard } = await load("/src/core/blackjack/card.ts");
    const { DialogueEngine } = await load("/src/dialogue/engine.ts");
    const { installDialogueRegistry } = await load("/src/dialogue/registry.ts");
    const base = await loadCharacter("chatgpt");
    const atom = (primitive: string, test: unknown, args = {}) => ({ primitive, apiVersion: 1, args, test });
    let plugins: any;
    let contributions: any[] = [];
    if (scenario === "primitive") {
      const declaration = { id: "value", apiVersion: 1, title: "中性原语", description: "生命周期验证", returnType: "number", parameters: { type: "object", additionalProperties: false }, dependencies: ["roulette"] };
      const text: Record<string,string> = { "module.json": JSON.stringify({ module: "plugin.js", style: "plugin.css", provides: [], dialoguePrimitives: [declaration] }), "plugin.css": "", "plugin.js": `export function register() { return { handlers: [], dialoguePrimitives: [{ ...${JSON.stringify(declaration)}, read(context) { globalThis.__dialogueCalls = (globalThis.__dialogueCalls || 0) + 1; return context.state.roulette.opponent.bullets; } }], createRuntime() { return {}; } }; }` };
      const files = await Promise.all(Object.entries(text).map(async ([path,body]) => { const bytes = new TextEncoder().encode(body); const digest = await crypto.subtle.digest("SHA-256", bytes); return { path, bytes: bytes.length, sha256: [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,"0")).join(""), mediaType: path.endsWith(".json") ? "application/json" : path.endsWith(".js") ? "text/javascript" : "text/css" }; }));
      const manifest = { format:"house-of-chances-hocpkg",formatVersion:1,identity:{authorId:"test",packageName:"conditions",version:"1.0.0"},metadata:{title:"中性原语插件",description:"公开接口验证",tags:[],creators:[{displayName:"Test",roles:["design"]}]},resources:[{id:"module",type:"plugin.module",apiVersion:4,entry:"module.json",requires:[]}],files,extensions:{} };
      const access = { packageId:"test/conditions",manifest,readFile:async (path:string)=>new TextEncoder().encode(text[path]),resolveAsset:async()=>({url:""}) };
      plugins = await (await load("/src/content/packages/plugin-modules.ts")).loadPluginModules({packages:async()=>[access]});
      if(plugins.registrations.length!==1)throw Error("API4 primitive plugin did not activate");
      installDialogueRegistry(plugins.dialogueRegistry);
    }
    if (scenario.startsWith("tap")) {
      const { EmbeddedContentSource } = await load("/src/content/packages/content-source.ts");
      const source = new EmbeddedContentSource({ fetch: window.fetch.bind(window) });
      const packages = (await source.packages()).filter((p: any) => p.packageId === "hoc-core/character-tap");
      plugins = await (await load("/src/content/packages/plugin-modules.ts")).loadPluginModules({ packages: async () => packages });
      if (plugins.registrations.length !== 1) throw Error("Tap API5 module did not activate");
      installDialogueRegistry(plugins.dialogueRegistry);
      (await load("/src/dialogue/events.ts")).installDialogueEvents(plugins.eventRegistry);
      const identities = await load("/src/presentation/character-interaction.ts");
      const images = [base.assets.relaxed, base.assets.conflicted, base.assets.threatened].map((url: string) => ({ image: identities.characterImageIdentity(url).path, regions: [
        { id: "first", shape: "rectangle", x: 0, y: 0, width: 1, height: .5 },
        { id: "second", shape: "polygon", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }
      ] }));
      contributions = plugins.registrations.map((p: any) => p.registration.createRuntime({ "plugin.character-tap": [{ packageId: identities.characterImageIdentity(base.assets.relaxed).packageId, value: { characterId: "neutral-conditions", regions: ["first", "second"], images: scenario === "tap-default" ? [] : images } }] }));
    }
    const rules = scenario === "ability" ? [
      { id: "ability", on: [{ type: "core.ability-played", apiVersion: 1 }], when: atom("core.event-ability-id", { eq: "prepaid-premium" }), poolId: "good", portrait: { image: base.assets.conflicted, alt: "技能回应立绘" } },
      { id: "opening", on: [{ type: "core.round-start", apiVersion: 1 }], when: atom("core.round-number", { eq: 1 }), poolId: "bad" }
    ] : scenario === "bad-art" ? [
      { id:"bad",when:atom("core.round-number",{range:{min:1}}),poolId:"bad",portrait:{image:"/characters/missing-dialogue-art.png"} },
      { id:"good",when:atom("core.round-number",{range:{min:1}}),poolId:"good",portrait:{image:base.assets.threatened,alt:"中性规则立绘",scale:1.2,revolverPlacement:{top:30,left:90}} }
    ] : scenario === "stale-art" ? [
      {id:"after",when:atom("core.action-count",{range:{min:2}},{actor:"player",kind:"hit"}),poolId:"good",portrait:{image:base.assets.threatened,alt:"新规则立绘"}},
      {id:"slow",when:atom("core.action-count",{eq:1},{actor:"player",kind:"hit"}),poolId:"bad",portrait:{image:"/characters/dialogue-slow.png"}},
      {id:"initial",when:atom("core.round-number",{range:{min:1}}),poolId:"bad"}
    ] : scenario.startsWith("tap") ? [
      { id: "tap-default", when: atom("hoc-core/character-tap#region", { eq: "full-portrait" }), poolId: "default" },
      { id: "tap-first", when: atom("hoc-core/character-tap#region", { eq: "first" }), poolId: "first", portrait: { image: base.assets.threatened, alt: "拍一拍覆盖立绘", scale: 1.2 } },
      { id: "tap-second", when: atom("hoc-core/character-tap#region", { eq: "second" }), poolId: "second" },
      { id: "tap-keyboard", when: atom("hoc-core/character-tap#x", { eq: null }), poolId: "keyboard" },
      { id: "action", when: atom("core.event-action", { eq: "hit" }), poolId: "good" }
    ] : [{id:"plugin",when:atom("test/conditions#value",{eq:3}),poolId:"good"}];
    for (const rule of rules as any[]) rule.on ??= [{ type: scenario.startsWith("tap") && rule.id !== "action" ? "hoc-core/character-tap#tap" : "core.round-start", apiVersion: 1 }, ...((!scenario.startsWith("tap") || rule.id === "action") ? [{ type: "core.action", apiVersion: 1 }] : [])];
    const character = {...base,id:"neutral-conditions",name:"中性对手",aiSkills:[],tags:[],unlock:undefined,dialogue:{pools:{bad:["旧规则对白"],good:["条件规则对白"],fallback:["角色兜底对白"],first:["上半区对白"],second:["下半区对白"],keyboard:["键盘对白"],default:["整图区域对白"]},rules,fallbackPoolId:"fallback"}};
    installCharacterCatalog([{id:character.id,name:character.name,subtitle:"中性测试",tier:"D",tags:[],previewImage:"/assets/package-cover-fallback.png",portraitScales:character.portraitScales}],character.id);installCharacterDefinitions([character]);
    const start=createMatch("neutral-conditions",{opponentId:character.id});
    const cards=Array.from({length:52},(_,i)=>createCard("spades","2",`neutral-${i}`));
    const player={...start.player,hand:{cards:cards.slice(0,2)}},opponent={...start.opponent,stood:scenario==="stale-art",hand:{cards:cards.slice(2,4)}};
    let match={...start,player,opponent,status:finished?"finished":"active",outcome:finished?{winner:"player",reason:"opponent-killed"}:undefined,shoe:{cards,cursor:4,shuffleIndex:1},roulette:{player:{capacity:6,bullets:0},opponent:{capacity:6,bullets:3}},round:{...start.round,player,opponent,phase,currentActor:phase==="turns"?"player":null,outcome:phase==="turns"?null:{winner:"player",reason:"comparison",penaltyTarget:"opponent",bulletsAdded:1}},history:[{type:"ROUND_STARTED",roundIndex:0}]};
    if (scenario === "ability") match = gameReducer({ ...match, playerSkills: { ...match.playerSkills, drawCount: 1, drawOffer: { id: "neutral-offer", refreshesRemaining: 0, candidateDefinitionIds: ["prepaid-premium"] } } }, { type: "SELECT_SKILL_DRAW", definitionId: "prepaid-premium" });
    const { createDefaultSave,createRuntimeSave }=await load("/src/persistence/boot.ts");const save=createDefaultSave();save.skipTutorial=true;save.settings.reducedMotion=true;save.settings.soundEnabled=false;save.tutorialProgress.completedIds.push("adult-content-warning");
    const repo=(await load("/src/persistence/factory.ts")).createPersistenceService();await repo.saveLongTerm(save);await repo.saveRuntime(createRuntimeSave(match));
    (window as any).__dialogueProbe={plugins,engine:new DialogueEngine(character.dialogue,character.id),match};
    if (scenario.startsWith("tap")) {
      const store = (await load("/src/persistence/presentation.ts")).presentationStore();
      await store.load(); if (!restored) store.clearMatch(match.id);
      (window as any).__tapProbe = { store, match, declaration: JSON.parse(await (await fetch("/characters/character-tap/resources.json")).text()).presentationState, plugins };
    }
    void (await load("/src/match-screen.ts")).mountGameRuntime({root:document.querySelector("#app"),onExitRequest:async()=>{}, contributions});
  }, { scenario, restored, phase, finished });
  await expect(page.locator(".table-bottom")).toBeVisible();
}
