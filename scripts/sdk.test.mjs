import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
test('packed SDK works in a source-free Node and TypeScript consumer', { timeout: 120_000 }, async () => {
  const consumer = await mkdtemp(join(tmpdir(), 'hoc-sdk-consumer-'));
  try {
    const sdkPackage = JSON.parse(await readFile(join(root, 'sdk/package.json'), 'utf8'));
    const report = JSON.parse(await readFile(join(root, 'dist/sdk-artifacts/sdk.json'), 'utf8'));
    assert.deepEqual({ name: report.name, version: report.version }, { name: sdkPackage.name, version: sdkPackage.version });
    const archive = await readFile(join(root, 'dist/sdk-artifacts', report.file));
    assert.equal(archive.byteLength, report.bytes);
    assert.equal(createHash('sha256').update(archive).digest('hex'), report.sha256);
    await cp(join(root, 'dist/sdk-artifacts', report.file), join(consumer, 'sdk.tgz'));
    const projectPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    // This consumer also imports the SDK's Vite plugin declaration.
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { 'hoc-core': 'file:sdk.tgz' }, devDependencies: { vite: projectPackage.devDependencies.vite, '@types/node': projectPackage.devDependencies['@types/node'] } }));
    const env = { ...process.env, HOC_CORE_DIR: '/nonexistent-core', NODE_PATH: '' };
    const npmCli = process.env.npm_execpath;
    execFileSync(npmCli ? process.execPath : 'npm', [...(npmCli ? [npmCli] : []), 'install', '--no-audit', '--no-fund'], { cwd: consumer, env, stdio: 'pipe' });
    await writeFile(join(consumer, 'verify.mjs'), `
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      import { createHash } from 'node:crypto';
      import { buildAudio } from 'hoc-core/audio-build';
      import { readFile, writeFile, mkdir } from 'node:fs/promises';
      import { createSkinCharacterPackageDraft, resolvePresentation, CharacterPresentationSchema, SkinUnlockConditionSchema, createCharacterPackageDraft, validateCharacterPackage, HocpkgManifestSchema, FactionResourceSchema, HocpkgResourceKeySchema, ChallengeVictoryRewardsSchema, AbilityDefinitionSchema, AbilityBindingSchema, AbilityRuleSchema, AbilityDisplaySchema, StatusDefinitionSchema, ScalarSchema, SkillCardFilterSchema, ValueExpressionSchema, EncounterFlowResourceSchema, CharacterEncounterPolicySchema } from 'hoc-core/authoring-api';
      import { capabilities } from 'hoc-core/capabilities';
      import { ProgramDefinitionSchema, ProgramTemplateSchema, instantiateProgramTemplate, EncounterProgramResourceSchema, CharacterRuntimeSchema } from 'hoc-core/authoring-api';
      import { SKILL_TAGS } from 'hoc-core/plugin-api';
      import { manifestFiles, mediaType, archiveFiles } from 'hoc-core/package-tools';
      import { buildPackage, imageOptions } from 'hoc-core/image-build';
      const installed = JSON.parse(await readFile(new URL(import.meta.resolve('hoc-core/package.json')), 'utf8'));
      assert.deepEqual({name: installed.name, version: installed.version, exports: installed.exports}, ${JSON.stringify({ name: sdkPackage.name, version: sdkPackage.version, exports: sdkPackage.exports })});
      const draft = createCharacterPackageDraft('sample', 'Sample');
      await mkdir('sample/resources', {recursive:true});
      const dialogue = JSON.parse(draft.files['resources/dialogue.json']);
      for (const pool of Object.values(dialogue.pools)) pool.push('Hello.');
      draft.files['resources/dialogue.json'] = JSON.stringify(dialogue);
      const character = JSON.parse(draft.files['resources/character.json']);
      character.metadata.faction = 'example/factions#guild';
      assert.deepEqual(FactionResourceSchema.parse({ name: 'Sample guild', badge: 'badge.png' }), { name: 'Sample guild', badge: 'badge.png' });
      assert.equal(HocpkgResourceKeySchema.parse(character.metadata.faction), 'example/factions#guild');
      character.metadata.matchMusic = 'bgm/theme.wav';
      character.metadata.badge = { image: 'badge.png', label: 'Sample guild' };
      character.definition.tablePortrait = { anchorY: .95, images: [{ image: 'relaxed.png', anchorY: .9 }] };
      const stage = { id: 'sample-stage', defaultDuration: 'match', rules: [] };
      const defense = {
        id: 'sample-defense', name: 'Sample defense', description: 'Continue once after a fired chamber.',
        sourceKind: 'ai-skill', primaryDomain: 'gunslinger', tags: ['stage'], activation: { type: 'automatic' },
        rules: [{ id: 'continue', trigger: 'before-defeat', limit: { perMatch: 1 },
          conditions: [{ type: 'pending-defeat-can-prevent', target: 'owner' }, { type: 'trigger-result-is', value: 'fired' }],
          effects: [{ type: 'prevent-pending-defeat', target: 'owner' }, { type: "assign-status-values", target: 'owner', statusDefinitionId: stage.id, values: { ['phase']: { type: "numeric", value: { type: 'floor', value: { type: 'divide', left: 5, right: 2 } } } } }] }]
      };
      assert.equal(AbilityDefinitionSchema.parse(defense).id, defense.id);
      assert.equal(AbilityRuleSchema.parse(defense.rules[0]).trigger, 'before-defeat');
      assert.deepEqual(StatusDefinitionSchema.parse(stage), stage);
      assert.equal(AbilityBindingSchema.parse({ definitionId: defense.id, enabled: true, parameters: {} }).level, 1);
      assert.equal(AbilityDisplaySchema.parse({ id: 'phase', target: 'owner', description: 'Phase', content: [{ type: 'number', value: { type: 'status-number', target: 'owner', statusDefinitionId: stage.id, key: 'phase' } }] }).id, 'phase');
      assert.equal(ScalarSchema.safeParse({ type: 'floor', value: 1, extra: true }).success, false);
      assert.equal(SkillCardFilterSchema.safeParse({primaryDomains:['gambler'],tags:['neutral']}).success, true);
      assert.equal(SkillCardFilterSchema.safeParse({primaryDomains:[]}).success, false);
      const inventoryFilter = {primaryDomains:['gambler'],activation:'passive'};
      const publicSuits = {type:'public-hand-card-suit-count',target:'owner',suit:'spades'};
      const inventoryRule = {id:'remove-cards',trigger:'on-round-end',conditions:[{type:'scalar-compare',left:publicSuits,operator:'gt',right:0}],effects:[
        {type:'remove-skill-cards',target:'rival',filter:inventoryFilter,resultKey:'removed'},
        { type: "assign-status-values", target: 'owner', statusDefinitionId: stage.id, values: { ['count']: { type: "numeric", value: {type:'effect-result',key:'removed'} } } }
      ]};
      defense.rules.push(inventoryRule, {id:'transfer-hit',trigger:'before-bust-resolution',effects:[{type:'transfer-hand-card',from:'owner',target:'rival',card:'last-hit-card'}]});
      defense.displays = [{id:'reserve',target:'owner',description:'Reserve',density:'compact',content:[{type:'meter',value:1,max:2,label:'Reserve'}]}];
      defense.displays[0].skillCardMarkers = [{targets:['rival'],filter:inventoryFilter,active:publicSuits,type:'selected',label:'Selected'}];
      defense.displays[0].content.push({type:'number',value:{type:'skill-card-count',target:'rival',filter:inventoryFilter}});
      defense.displays[0].content.push({type:'text-list',items:[{text:'Selected',active:publicSuits}],emptyText:'None'});
      defense.displays[0].skillCardMarkers[0].appearance = 'purple-glow';
      defense.rules.push(
        {id:'return-card',trigger:'after-card-draw',effects:[{type:'move-hand-card-to-draw-pile',target:'owner',card:'last-card',position:'bottom'}]},
        {id:'discard-card',trigger:'after-card-draw',effects:[{type:'discard-hand-card',target:'owner',card:'last-card'}]},
        {id:'observe-card',trigger:'after-card-acquired',effects:[{ type: "assign-status-values", target: 'owner', statusDefinitionId: stage.id, values: { ['reserve']: { type: "numeric", value: {type:'acquired-card-value',aceValue:'one'} } } }]},
        {id:'previous-score',trigger:'before-round-resolution',effects:[{type:'add-to-pending-comparison-score',target:'owner',amount:{type:'round-point-advantage',target:'rival',round:'previous'}}]}
      );
      assert.equal(AbilityDefinitionSchema.safeParse({...defense,sourceKind:'player-skill',drop:{enabled:true,baseWeight:1},skillTags:['gunslinger'],stackable:false,acquisitionLimit:{perMatch:1}}).success,true);
      assert.equal(AbilityDefinitionSchema.safeParse({...defense,acquisitionLimit:{perMatch:1}}).success,false);
      assert.equal(CharacterEncounterPolicySchema.parse(character.metadata.encounter).playerGun.capacity, 6);
      assert.equal(ValueExpressionSchema.safeParse({type:'hand-dominant-suit',target:'owner',tieBreak:['clubs','spades','hearts','diamonds']}).success,true);
      defense.rules.push({id:'assign-values',trigger:'on-round-end',effects:[{type:'assign-status-values',target:'owner',statusDefinitionId:stage.id,values:{rememberedRank:{type:'card-attribute',target:'rival',card:'last-card',attribute:'rank'}}}]});
      const flow = EncounterFlowResourceSchema.parse({id:'sample-flow',ownerId:'sample',name:'Flow',description:'Neutral flow',unlock:{type:'always'},definition:{id:'sample-flow',playerGun:{capacity:3,bullets:0},nodes:[{id:'one',opponentId:'sample',routes:{victory:{type:'finish',result:'victory'},defeat:{type:'finish',result:'defeat'},escaped:{type:'finish',result:'abandoned'}}}]}});
      draft.manifest.resources.push({id:'flow',type:'game.encounter-flow',apiVersion:1,entry:'resources/flow.json',requires:[]});
      draft.files['resources/flow.json'] = JSON.stringify(flow);
      character.aiSkills = [{ resourceId: 'defense', enabled: true, parameters: {} }];
      draft.manifest.resources.find(resource => resource.type === 'game.character-match').requires.push('defense');
      draft.manifest.resources.push(
        { id: 'defense', type: 'game.ai-skill', apiVersion: 4, entry: 'resources/defense.json', requires: ['stage'] },
        { id: 'stage', type: 'game.status', apiVersion: 1, entry: 'resources/stage.json', requires: [] }
      );
      draft.files['resources/defense.json'] = JSON.stringify(defense);
      draft.files['resources/stage.json'] = JSON.stringify(stage);
      draft.files['resources/character.json'] = JSON.stringify(character);
      draft.manifest.resources.push({ id: 'public-card-mechanic', type: 'game.ai-skill', apiVersion: 4, entry: 'resources/public-card-mechanic.json', requires: [] });
      draft.files['resources/public-card-mechanic.json'] = JSON.stringify({
        id: 'neutral-public-card-mechanic', name: 'Public card mechanic', description: 'Generic derived-suit and public-card primitives',
        sourceKind: 'ai-skill', primaryDomain: 'intelligence-officer', tags: ['card-knowledge'], activation: {type:'automatic'},
        rules: [
          {id:'derive',trigger:'after-card-draw',effects:[{type:'replace-hand-card-with-derived',target:'owner',card:'last-card',rank:{type:'static',rank:'A'},suit:{type:'copy-card-suit',card:'last-card'}}]},
          {id:'reveal',trigger:'after-hand-changed',effects:[{type:'reveal-hand-cards-matching-public-suits',target:'rival',suitsFrom:'owner'}]}
        ]
      });

      for (const [path, text] of Object.entries(draft.files)) await writeFile('sample/' + path, text);
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64');
      for (const name of ['cover','relaxed','conflicted','mocking','threatened','unconscious','badge']) await writeFile('sample/' + name + '.png', png);
      await mkdir('sample/bgm', {recursive:true});
      const tone = execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.1','-f','wav','pipe:1']);
      await writeFile('sample/bgm/theme.wav', tone);
      draft.manifest.files = await manifestFiles('sample');
      await writeFile('sample/hocpkg-info.json', JSON.stringify(draft.manifest));
      await validateCharacterPackage({manifest:draft.manifest,readFile:path=>readFile('sample/' + path)});
      const factionManifest = structuredClone(draft.manifest);
      factionManifest.resources.find(resource => resource.type === 'game.character-match').apiVersion = 15;
      const factionCharacter = {...character,metadata:{...character.metadata,unlock:{type:'defeat-faction-count',faction:'example/factions#guild',count:2}}};
      const factionBytes = new TextEncoder().encode(JSON.stringify(factionCharacter));
      Object.assign(factionManifest.files.find(file => file.path === 'resources/character.json'), {bytes:factionBytes.length,sha256:createHash('sha256').update(factionBytes).digest('hex')});
      const factionReadFile = path => path === 'resources/character.json' ? factionBytes : readFile('sample/' + path);
      await validateCharacterPackage({manifest:factionManifest,readFile:factionReadFile});
      factionManifest.resources.find(resource => resource.type === 'game.character-match').apiVersion = 14;
      await assert.rejects(validateCharacterPackage({manifest:factionManifest,readFile:factionReadFile}), /API 15/);
      const built = await buildPackage('.', {manifest:'sample/hocpkg-info.json',packageId:'creator/sample',version:'1.0.0'}, imageOptions(['--images','png']));
      HocpkgManifestSchema.parse(built.manifest);
      assert.equal(JSON.parse(new TextDecoder().decode(built.files['resources/character.json'])).metadata.matchMusic, 'bgm/theme.opus');
      assert.equal(built.manifest.files.find(file => file.path === 'bgm/theme.opus').mediaType, 'audio/ogg');
      assert.ok((await archiveFiles(built.files)).length > png.length);
      assert.equal(mediaType('audio.ogg'), 'audio/ogg');
      const audio = await buildAudio(tone, 'tone.wav');
      assert.equal(audio.record.output, 'tone.opus');
      assert.equal(audio.record.kbps, 64);
      assert.deepEqual((await buildAudio(audio.bytes, 'tone.ogg')).bytes, audio.bytes);
      assert.ok(capabilities.resourceApiVersions['game.character-match'].includes(4));
      assert.ok(capabilities.resourceApiVersions['game.character-match'].includes(5));
      assert.ok(capabilities.resourceApiVersions['game.character-match'].includes(6));
      assert.ok(capabilities.resourceApiVersions['game.character-match'].includes(7));
      assert.deepEqual(capabilities.resourceApiVersions['presentation.faction'], [1, 2]);
      assert.ok(capabilities.resourceApiVersions['game.character-match'].includes(8));
      assert.ok(capabilities.resourceApiVersions['game.character-match'].includes(11));
      assert.ok(capabilities.resourceApiVersions['game.character-match'].includes(12));
      assert.ok(capabilities.resourceApiVersions['game.character-match'].includes(13));
      assert.ok(capabilities.resourceApiVersions['game.character-match'].includes(14));
      assert.ok(capabilities.resourceApiVersions['game.character-match'].includes(15));
      assert.ok(capabilities.resourceApiVersions['game.character-match'].includes(16));
      assert.ok(capabilities.resourceApiVersions['game.character-dialogue'].includes(4));
      assert.deepEqual(capabilities.resourceApiVersions['presentation.character'], [1, 2]);
      assert.deepEqual(SkinUnlockConditionSchema.parse({type:'defeat-character',count:2}), {type:'defeat-character',count:2});
      assert.equal(SkinUnlockConditionSchema.safeParse({type:'defeat-character',count:0}).success, false);
      const skinDraft = createSkinCharacterPackageDraft('skin-sample', 'Skin Sample');
      const appearance = CharacterPresentationSchema.parse(JSON.parse(skinDraft.files['resources/appearance.json']));
      assert.equal(resolvePresentation({ presentationRef: 'text:name' }, appearance, { skinId: 'unavailable', locale: 'en' }), 'Skin Sample');
      assert.equal(skinDraft.manifest.resources.find(r => r.type === 'game.character-match').apiVersion, 13);
      assert.deepEqual(capabilities.resourceApiVersions['game.encounter-flow'],[1, 2]);
      const runtimeTemplate = ProgramTemplateSchema.parse({type:'single-match',opponentId:'sample'});
      const program = ProgramDefinitionSchema.parse(instantiateProgramTemplate(runtimeTemplate));
      assert.equal(program.version, 2);
      assert.equal(program.nodes.find(node => node.id === program.start).next, 'match');
      const programEntry = EncounterProgramResourceSchema.parse({id:program.id,name:'Sample flow',description:'Neutral flow',ownerId:'sample',entry:false,unlock:{type:'always'},definition:program});
      assert.equal(programEntry.program.id, program.id);
      assert.deepEqual(CharacterRuntimeSchema.parse({type:'flow',resourceId:'local-flow'}),{type:'flow',resourceId:'local-flow'});
      for (const type of ['game.ai-skill', 'game.player-skill', 'game.talent']) assert.deepEqual(capabilities.resourceApiVersions[type], [4]);
      assert.ok(capabilities.resourceApiVersions['game.boss-challenge'].includes(6));
      assert.deepEqual(ChallengeVictoryRewardsSchema.parse({ skillDraws: 3, removeBullets: 2, pointAdvantage: 1 }), { skillDraws: 3, removeBullets: 2, pointAdvantage: 1 });
      assert.ok(capabilities.pluginModuleApiVersions.includes(10));
      assert.equal(draft.manifest.resources.find(r => r.type === 'game.character-match').apiVersion, 12);
      assert.ok(SKILL_TAGS.length > 0);
      assert.ok(capabilities.pluginModuleApiVersions.includes(11));
      assert.ok(capabilities.pluginModuleApiVersions.includes(12));
      await assert.rejects(import('hoc-core/src/core/abilities/registry.js'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
      console.log('Node imports, authoring, image builder, archive and export boundary passed');
    `);
    const output = execFileSync(process.execPath, ['verify.mjs'], { cwd: consumer, env, encoding: 'utf8' });
    assert.match(output, /export boundary passed/);
    await writeFile(join(consumer, 'consumer.ts'), `
      import { SKILL_TAGS, type PluginModule, type PluginCharacterPresentationApi, type PluginCharacterSkinUnlocksApi, type CharacterSkinUnlocks, type CharacterAppearance, type PluginRuntimeContext, type PluginGameRuntimeContext, type PluginTutorialDefinition, type PluginTutorialApi } from 'hoc-core/plugin-api';
      import { createCharacterPackageDraft, AbilityDefinitionSchema, ScalarSchema, type CharacterPackageDraft, type AbilityDefinition, type AbilityRule, type StatusDefinition, type ScalarValue, type ActorSelector, type Condition, type Effect, type AbilityDisplay, type SkillCardFilter } from 'hoc-core/authoring-api';
      import { imageOptions, buildPackage } from 'hoc-core/image-build';
      import { buildAudio, type AudioBuildRecord } from 'hoc-core/audio-build';
      import { manifestFiles } from 'hoc-core/package-tools';
      import { instantiateProgramTemplate, type ProgramDefinition, type ProgramTemplate, type MatchInitSpec, type CharacterRuntime } from 'hoc-core/authoring-api';
      const initialization: MatchInitSpec = {playerGun:{mode:'replace',value:{capacity:6,bullets:0}},playerSkills:{mode:'inherit'}};
      const runtimeTemplate: ProgramTemplate = {type:'single-match',opponentId:'sample',init:initialization};
      const runtimeProgram: ProgramDefinition = instantiateProgramTemplate(runtimeTemplate);
      const runtimeReference: CharacterRuntime = {type:'template',template:runtimeTemplate};
      const draft: CharacterPackageDraft = createCharacterPackageDraft('sample', 'Sample');
      const expression: ScalarValue = { type: 'floor', value: { type: 'divide', left: 5, right: 2 } };
      const target: ActorSelector = 'status-owner';
      const condition: Condition = { type: 'pending-defeat-can-prevent', target };
      const effect: Effect = { type: "assign-status-values", target, statusDefinitionId: 'stage', values: { ['phase']: { type: "numeric", value: expression } } };
      const rule: AbilityRule = { id: 'continue', trigger: 'before-defeat', conditions: [condition], effects: [{ type: 'prevent-pending-defeat', target }, effect] };
      const status: StatusDefinition = { id: 'stage', defaultDuration: 'match', rules: [rule] };
      const display: AbilityDisplay = { id: 'phase', target: 'owner', description: 'Phase', content: [{ type: 'number', value: expression }] };
      const definition: AbilityDefinition = { id: 'defense', name: 'Defense', description: 'Neutral fixture', sourceKind: 'ai-skill', primaryDomain: 'gunslinger', tags: ['stage'], activation: { type: 'automatic' }, rules: [rule], displays: [display] };
      const acquired: ScalarValue = {type:'acquired-card-value',aceValue:'effective'};
      const prior: ScalarValue = {type:'round-point-advantage',target:'rival',round:'previous'};
      const recycle: Effect = {type:'move-hand-card-to-draw-pile',target:'owner',card:'last-card',position:'bottom'};
      const reserve: AbilityDisplay = {id:'reserve',target:'owner',description:'Reserve',density:'compact',content:[{type:'meter',value:1,max:2,label:'Reserve'}]};
      const limited: AbilityDefinition = {...definition,sourceKind:'player-skill',drop:{enabled:true,baseWeight:1},skillTags:['gunslinger'],stackable:false,acquisitionLimit:{perMatch:1}};
      AbilityDefinitionSchema.parse(definition); ScalarSchema.parse(expression); ScalarSchema.parse(acquired); ScalarSchema.parse(prior);
      const filter: SkillCardFilter = {primaryDomains:['gambler'],tags:['neutral'],activation:'passive'};
      const count: ScalarValue = {type:'skill-card-count',target:'rival',filter};
      const operation: AbilityRule = {id:'remove',trigger:'on-round-end',effects:[{type:'remove-skill-cards',target:'rival',filter,resultKey:'count'},{ type: "assign-status-values", target: 'owner', statusDefinitionId: 'stage', values: { ['count']: { type: "numeric", value: {type:'effect-result',key:'count'} } } }]};
      const markers: AbilityDisplay = {...reserve,skillCardMarkers:[{targets:['rival'],filter,active:{type:'public-hand-card-suit-count',target:'owner',suit:'spades'},type:'selected',label:'Selected'}]};
      const transfer: Effect = {type:'transfer-hand-card',from:'owner',target:'rival',card:'last-hit-card'};
      void [count,operation,markers,transfer];
      void recycle; void reserve; AbilityDefinitionSchema.parse(limited);
      const plugin: PluginModule = {register: () => ({handlers:[],createRuntime:()=>({})})};
      function context(value: PluginRuntimeContext, game: PluginGameRuntimeContext, signal: AbortSignal) {
        const appearance: PluginCharacterPresentationApi | undefined = value.characterPresentation;
        const current: CharacterAppearance | undefined = appearance?.get('sample');
        return [value.getSave(), game.game.getMatch(), current && appearance?.select('sample', current.skinId, signal)];
      }
      const tutorial: PluginTutorialDefinition = { id: 'intro', title: 'Guide', presentation: 'sidebar', autoSkipMs: null, pages: [{ body: 'Explanation' }] };
      function showTutorial(api: PluginTutorialApi) { const cancel = api.show(tutorial, { replay: true, signal: new AbortController().signal }); cancel(); return api.isCompleted(tutorial.id); }
      async function manageSkins(api: PluginCharacterSkinUnlocksApi) {
        const saved: CharacterSkinUnlocks = { 'creator/sample#match': { blue: true } };
        const list = api.get('sample');
        const unlocked: boolean = api.isUnlocked('sample', 'blue');
        await api.unlock('sample', 'blue');
        await api.lock('sample', 'green');
        await api.setUnlocked('sample', 'blue', true);
        await api.setMany('sample', { blue: true, green: false });
        await api.reset('sample');
        return { saved, list, unlocked };
      }
      void [SKILL_TAGS, draft, plugin, context, imageOptions, buildPackage, manifestFiles, buildAudio, showTutorial, status, manageSkins];
    `);
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,ESNext.Disposable,DOM,DOM.Iterable', 'consumer.ts'], { cwd: consumer, env, stdio: 'inherit' });
  } finally { await rm(consumer, { recursive: true, force: true }); }
});
