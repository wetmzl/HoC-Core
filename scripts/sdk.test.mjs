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
      import { STORY_API_VERSION, StorySceneSchema, StoryBindingSchema, createStoryRun, skipStory, chooseStory } from 'hoc-core/authoring-api';
      assert.equal(STORY_API_VERSION, 1);
      const archiveUnlock = {type:'compare',left:{type:'query',query:{id:'context.value',key:'progression.completedFlows.neutral-trial'}},operator:'eq',right:{type:'literal',value:true}};
      assert.deepEqual(StorySceneSchema.parse({archiveUnlock,entry:'end',nodes:[{id:'end',type:'end'}]}).archiveUnlock,archiveUnlock);
      assert.deepEqual(capabilities.resourceApiVersions['story.scene'], [1]);
      assert.deepEqual(capabilities.resourceApiVersions['story.binding'], [1]);
      const storyScene = StorySceneSchema.parse({ entry:'hello', nodes:[
        {id:'hello',type:'say',segments:[{text:'Hello'}],next:'choice'},
        {id:'choice',type:'choice',options:[{id:'yes',text:'Continue',next:'end'}]},
        {id:'end',type:'end',result:'accepted'}
      ] });
      const storyContext = {resolveScene:id=>id==='neutral#intro'?storyScene:undefined};
      const skippedStory = skipStory(createStoryRun('neutral#intro', storyContext), storyContext);
      assert.equal(skippedStory.waiting.type,'choice');
      assert.equal(chooseStory(skippedStory,'yes',storyContext).status,'skipped');
      const optionalCommandScene = StorySceneSchema.parse({entry:'invite',nodes:[
        {id:'invite',type:'command',command:{type:'neutral.invite',apiVersion:1,args:{}},onSkip:'omit',next:'end'},
        {id:'end',type:'end'}
      ]});
      const optionalCommandContext = {resolveScene:id=>id==='neutral#optional'?optionalCommandScene:undefined};
      const waitingCommand = createStoryRun('neutral#optional',optionalCommandContext);
      assert.equal(waitingCommand.waiting.type,'command');
      const omittedCommand = skipStory(waitingCommand,optionalCommandContext);
      assert.equal(omittedCommand.status,'skipped');
      assert.deepEqual(omittedCommand.receipts,[]);
      assert.equal(StoryBindingSchema.safeParse({sceneId:'intro',trigger:{on:['core.game-started']},frequency:'save'}).success,true);
      import { ProgramDefinitionSchema, ProgramTemplateSchema, instantiateProgramTemplate, EncounterProgramResourceSchema, CharacterRuntimeSchema } from 'hoc-core/authoring-api';
      import { SKILL_TAGS, MUSIC_PRIORITIES, PUBLIC_EVENT_API_VERSION, PUBLIC_EVENT_CATALOG, PublicTriggerSpecSchema, PublicQuerySchema, readPublicQuery, selectPublicTriggerEvents, snapshotPublicEventBatch } from 'hoc-core/plugin-api';
      assert.equal(PUBLIC_EVENT_API_VERSION,1);
      assert.ok(PUBLIC_EVENT_CATALOG.some(item=>item.type==='rule.before-card-draw'));
      assert.equal(PublicTriggerSpecSchema.safeParse({on:['match.NOT_REAL']}).success,false);
      assert.equal(PublicQuerySchema.safeParse({id:'match.NOT_REAL'}).success,false);
      const publicEvent = {apiVersion:1,id:'sdk-event',type:'program.node-entered',scopes:{game:'sdk-game',program:'sdk-program'},data:{nodeId:'intro'}};
      const publicBatch = snapshotPublicEventBatch({id:'sdk-batch',facts:[publicEvent],restored:false,context:{program:{id:'sdk-program',nodeId:'intro',status:'waiting'}}});
      const publicTrigger = PublicTriggerSpecSchema.parse({on:['program.node-entered'],scope:{name:'game',id:'sdk-game'},when:{type:'compare',left:{type:'query',query:{id:'program.status'}},operator:'eq',right:{type:'literal',value:'waiting'}}});
      assert.equal(selectPublicTriggerEvents(publicTrigger,publicBatch)[0].id,publicEvent.id);
      assert.equal(readPublicQuery({id:'program.node-id'},{batch:publicBatch}),'intro');
      assert.equal(Object.isFrozen(publicBatch.context.program),true);
      // The installed SDK has no host ability registry. Semantic values must survive as host data.
      const hostQueries = {legalActionTypes:['PLAY_ABILITY'],playablePlayerSkill:true,activeBustLimits:{player:27,opponent:21},comparisonModified:true,passiveSkillPresent:true,skillLifetimes:[{definitionId:'external-only-skill',instanceId:'external-card',hasLifetime:true}]};
      const hostedMatchBatch = snapshotPublicEventBatch({...publicBatch,context:{match:{},matchQueries:hostQueries}});
      assert.equal(readPublicQuery({id:'match.action-available',action:'PLAY_ABILITY'},{batch:hostedMatchBatch}),true);
      assert.equal(readPublicQuery({id:'match.bust-limit',actor:'player'},{batch:hostedMatchBatch}),27);
      assert.equal(readPublicQuery({id:'match.comparison-modified'},{batch:hostedMatchBatch}),true);
      assert.equal(readPublicQuery({id:'match.inspected-skill-lifetime'},{batch:hostedMatchBatch,presentation:{inspectedSkill:{definitionId:'external-only-skill',instanceId:'external-card'}}}),true);
      const missingHostModel = snapshotPublicEventBatch({...publicBatch,context:{match:{}}});
      assert.equal(readPublicQuery({id:'match.bust-limit',actor:'player'},{batch:missingHostModel}),undefined);
      assert.equal(readPublicQuery({id:'match.action-available',action:'PLAY_ABILITY'},{match:{}}),undefined);
      import { MusicResourceSchema } from 'hoc-core/authoring-api';
      import { ACHIEVEMENT_API_VERSION, AchievementCatalogSchema, AchievementDefinitionSchema, StandardAchievementDefinitionSchema, StandardAchievementCatalogSchema, AchievementConditionSchema, AchievementKeySchema, AchievementObservationSchema, AchievementObservationContractSchema, AchievementLedgerSchema, createAchievementLedger, advanceAchievements, validateAchievementInputs, assertAchievementObservationContract, evaluateAchievementNumber, evaluateAchievementValue, evaluateAchievementCondition, validateAchievementPackage, projectAchievement, projectAchievementList, createAchievementCommitPort, AchievementCheckpointSchema, restoreAchievementCheckpoint, meetsAchievementUnlockRequirement } from 'hoc-core/authoring-api';
      assert.equal(MUSIC_PRIORITIES.conditional, 50);
      MusicResourceSchema.parse({tracks:{theme:{path:'bgm/theme.opus'}},rules:[{id:'lobby',scene:'lobby',track:'theme',priority:'override'}]});
      const achievement = {
        id:'ten-cards',revision:1,name:'Ten cards',description:'Collect ten cards in one match.',icon:'icons/cards.png',progressDisplay:{metric:'removed',target:10},
        tracking:{scope:'match',completion:'immediate',continuity:'continuous',allowDebug:false,tracks:[{id:'removed',on:[{type:'example.skills-removed',apiVersion:1}],progress:{type:'sum',value:{type:'skill-card-count',collection:'removed'}}}],completeWhen:{type:'scalar-compare',left:{type:'metric',id:'removed'},operator:'gte',right:10}}
      };
      assert.equal(ACHIEVEMENT_API_VERSION,1);
      AchievementDefinitionSchema.parse(achievement);
      const achievementCatalog = AchievementCatalogSchema.parse({achievements:[achievement]});
      assert.deepEqual(achievementCatalog.achievements[0].progressDisplay,{metric:'removed',target:10});
      const inheritedRule = Object.create({type:'not'});
      Object.getPrototypeOf(inheritedRule).condition = inheritedRule;
      assert.equal(AchievementConditionSchema.safeParse(inheritedRule).success,false);
      assert.equal(AchievementKeySchema.parse('example/achievements#main/ten-cards'),'example/achievements#main/ten-cards');
      const achievementFiles = {'achievements.json':new TextEncoder().encode(JSON.stringify(achievementCatalog)),'icons/cards.png':new Uint8Array([1,2,3])};
      const achievementManifest = {
        format:'house-of-chances-hocpkg',formatVersion:1,identity:{authorId:'example',packageName:'achievements',version:'1.0.0'},
        metadata:{title:'Achievements',description:'Neutral achievement package',tags:[],creators:[{displayName:'Example',roles:['design']}]},
        resources:[{id:'main',type:'achievement.catalog',apiVersion:1,entry:'achievements.json',requires:[]}],
        files:Object.entries(achievementFiles).map(([path,bytes])=>({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),mediaType:path.endsWith('.json')?'application/json':'image/png'})),extensions:{}
      };
      await validateAchievementPackage({manifest:achievementManifest,readFile:async path=>achievementFiles[path]});
      await assert.rejects(validateAchievementPackage({manifest:achievementManifest,readFile:async path=>achievementFiles[path]},{standard:true}),/标准成就必须声明封面/);
      const standardAchievement = StandardAchievementDefinitionSchema.parse({...achievement,cover:'icons/cards.png',hidden:true,name:'Private achievement name',description:'Private achievement condition'});
      const standardCatalog = StandardAchievementCatalogSchema.parse({achievements:[standardAchievement]});
      const standardFiles = {...achievementFiles,'achievements.json':new TextEncoder().encode(JSON.stringify(standardCatalog))};
      const standardManifest = {...achievementManifest,files:achievementManifest.files.map(file=>({...file,bytes:standardFiles[file.path].length,sha256:createHash('sha256').update(standardFiles[file.path]).digest('hex')}))};
      await validateAchievementPackage({manifest:standardManifest,readFile:async path=>standardFiles[path]},{standard:true});
      const presentationEntry = {key:'example/achievements#main/ten-cards',definition:standardAchievement,coverUrl:'blob:private-cover',iconUrl:'blob:private-icon'};
      const hiddenPresentation = projectAchievement(presentationEntry,createAchievementLedger('sdk-profile'));
      assert.equal(hiddenPresentation.status,'hidden');
      for(const secret of [presentationEntry.key,standardAchievement.name,standardAchievement.description,'blob:private-cover','blob:private-icon','icons/cards.png','tracking','progressDisplay']) assert.equal(JSON.stringify(hiddenPresentation).includes(secret),false);
      assert.deepEqual(projectAchievementList([presentationEntry],createAchievementLedger('sdk-profile')),{rows:[],hiddenCount:1});
      const achievementObservation = AchievementObservationSchema.parse({apiVersion:1,streamId:'sdk-profile',sequence:0,at:'2026-11-09T00:00:00Z',topic:{type:'example.checkpoint',apiVersion:1},scopes:{},debugUsed:false,values:{},skillCards:{}});
      const achievementContract = AchievementObservationContractSchema.parse({topic:achievementObservation.topic,values:{},skillCollections:[]});
      assertAchievementObservationContract(achievementObservation,achievementContract);
      const achievementResult = advanceAchievements([],createAchievementLedger('sdk-profile'),achievementObservation,[achievementContract]);
      assert.equal(achievementResult.ledger.nextSequence,1);
      assert.deepEqual(achievementResult.completed,[]);
      const unlockEntry = {...presentationEntry,definition:StandardAchievementDefinitionSchema.parse({...standardAchievement,progressDisplay:{metric:'n',target:1},tracking:{scope:'profile',tracks:[{id:'n',on:[achievementObservation.topic],progress:{type:'count'}}],completeWhen:{type:'scalar-compare',left:{type:'metric',id:'n'},operator:'gte',right:1}}})};
      const unlockResult = advanceAchievements([unlockEntry],createAchievementLedger('sdk-profile'),achievementObservation,[achievementContract]);
      let savedCheckpoint, failSave = true;
      const port = createAchievementCommitPort({initial:createAchievementLedger('sdk-profile'),requiredConsumers:['telemetry','reward'],save:async checkpoint=>{if(failSave) throw new Error('disk unavailable');savedCheckpoint=JSON.parse(JSON.stringify(checkpoint));}});
      let notices=0;
      port.subscribeCommitted(()=>{notices++;});
      await assert.rejects(port.submit(unlockResult.ledger),/disk unavailable/);
      assert.equal(notices,0);
      assert.equal(meetsAchievementUnlockRequirement(port.committed.ledger,{type:'achievement-unlocked',key:unlockEntry.key}),false);
      failSave=false;
      await port.submit(unlockResult.ledger);
      assert.equal(notices,1);
      assert.equal(AchievementCheckpointSchema.parse(savedCheckpoint).pending.length,1);
      const stableDelivery=port.committed.pending[0].id;
      await port.drain('telemetry',async delivery=>assert.equal(delivery.id,stableDelivery));
      assert.equal(port.committed.pending.length,1);
      const restoredPort=createAchievementCommitPort({initial:restoreAchievementCheckpoint(savedCheckpoint),requiredConsumers:['telemetry','reward'],save:async checkpoint=>{savedCheckpoint=JSON.parse(JSON.stringify(checkpoint));}});
      let rewardCalls=0;
      await restoredPort.drain('reward',async delivery=>{assert.equal(delivery.id,stableDelivery);rewardCalls++;});
      await restoredPort.drain('reward',async()=>{rewardCalls++;});
      assert.equal(rewardCalls,1);
      assert.equal(restoredPort.committed.pending.length,0);
      assert.equal(meetsAchievementUnlockRequirement(restoredPort.committed.ledger,{type:'achievement-unlocked',key:unlockEntry.key}),true);
      assert.equal(projectAchievement(unlockEntry,restoredPort.committed.ledger).status,'completed');
      const restoredAchievementLedger = AchievementLedgerSchema.parse(JSON.parse(JSON.stringify(achievementResult.ledger)));
      assert.equal(advanceAchievements([],restoredAchievementLedger,achievementObservation,[achievementContract]).replayed,true);
      assert.deepEqual(validateAchievementInputs(achievement,[{topic:{type:'example.skills-removed',apiVersion:1},values:{},skillCollections:['removed']}]),[]);
      const debugBoundary = {...achievementObservation,topic:{type:'future.lifecycle',apiVersion:99},debugUsed:true,scopes:{match:'sdk-match'},boundary:{scope:'match',phase:'begin'}};
      const debugResult = advanceAchievements([{key:'example/achievements#main/ten-cards',definition:achievement}],createAchievementLedger('sdk-profile'),debugBoundary,[{topic:{type:'example.skills-removed',apiVersion:1},values:{},skillCollections:['removed']}]);
      assert.equal(debugResult.ledger.records['example/achievements#main/ten-cards'].invalidated,true);
      const achievementReadContext = {observation:achievementObservation,metrics:{}};
      assert.equal(evaluateAchievementNumber(7,achievementReadContext),7);
      assert.equal(evaluateAchievementValue({type:'literal',value:'ready'},achievementReadContext),'ready');
      assert.equal(evaluateAchievementCondition({type:'scalar-compare',left:7,operator:'gte',right:7},achievementReadContext),true);
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
      const transferRule = {
        id:'select-transfer', trigger:'after-hand-changed',
        effects:[{type:'transfer-hand-card',from:'rival',target:'owner',card:{type:'matching-transfer',candidate:'reaches-bust-limit',pick:'first'}}]
      };
      AbilityRuleSchema.parse(transferRule);
      AbilityRuleSchema.parse({id:'invoke-active',trigger:'after-card-draw',effects:[{type:'invoke-random-active-skill',target:'rival',filter:{activation:'action',tags:['neutral']}}]});
      const countingRule = {id:'exclude-derived',trigger:'after-card-acquired',effects:[{type:'set-matching-hand-cards-counted',target:'rival',attribute:'source',equals:{type:'literal',value:'derived'},counted:false}]};
      const acquisitionTransferRule = {id:'transfer-acquired',trigger:'after-card-acquired',conditions:[{type:'acquired-card-is-held',target:'owner'}],effects:[{type:'transfer-hand-card',from:'owner',target:'rival',card:'acquired-card'}]};
      AbilityRuleSchema.parse(countingRule);
      AbilityRuleSchema.parse(acquisitionTransferRule);
      draft.manifest.resources.push({id:'versioned-transfer',type:'game.ai-skill',apiVersion:5,entry:'resources/versioned-transfer.json',requires:[]});
      draft.files['resources/versioned-transfer.json'] = JSON.stringify({
        id:'neutral-versioned-transfer',name:'Versioned transfer',description:'Generic transfer candidate selection',
        sourceKind:'ai-skill',primaryDomain:'cheater',tags:['neutral'],activation:{type:'automatic'},rules:[transferRule,countingRule,acquisitionTransferRule]
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
      const legacyTransferManifest = structuredClone(draft.manifest);
      legacyTransferManifest.resources.find(resource=>resource.id==='versioned-transfer').apiVersion = 4;
      await assert.rejects(validateCharacterPackage({manifest:legacyTransferManifest,readFile:path=>readFile('sample/' + path)}), /资源 API 5/);
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
      for (const type of ['game.ai-skill', 'game.player-skill', 'game.talent']) assert.deepEqual(capabilities.resourceApiVersions[type], [4, 5]);
      assert.deepEqual(capabilities.resourceApiVersions['game.status'], [1, 2]);
      assert.ok(capabilities.resourceApiVersions['game.boss-challenge'].includes(6));
      assert.deepEqual(ChallengeVictoryRewardsSchema.parse({ skillDraws: 3, removeBullets: 2, pointAdvantage: 1 }), { skillDraws: 3, removeBullets: 2, pointAdvantage: 1 });
      assert.ok(capabilities.pluginModuleApiVersions.includes(10));
      assert.equal(draft.manifest.resources.find(r => r.type === 'game.character-match').apiVersion, 12);
      assert.ok(SKILL_TAGS.length > 0);
      assert.ok(capabilities.pluginModuleApiVersions.includes(11));
      assert.ok(capabilities.pluginModuleApiVersions.includes(12));
      assert.ok(capabilities.pluginModuleApiVersions.includes(13));
      assert.deepEqual(capabilities.resourceApiVersions['presentation.music'], [1]);
      assert.deepEqual(capabilities.resourceApiVersions['achievement.catalog'], [1]);
      assert.equal(capabilities.authoringApiVersion, 2);
      await assert.rejects(import('hoc-core/src/core/abilities/registry.js'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
      console.log('Node imports, authoring, image builder, archive and export boundary passed');
    `);
    const output = execFileSync(process.execPath, ['verify.mjs'], { cwd: consumer, env, encoding: 'utf8' });
    assert.match(output, /export boundary passed/);
    await writeFile(join(consumer, 'consumer.ts'), `
      import { SKILL_TAGS, type PluginModule, type PluginMainMenuQuote, type PluginRuntimeContribution, type PluginCharacterPresentationApi, type PluginCharacterSkinUnlocksApi, type CharacterSkinUnlocks, type CharacterAppearance, type PluginRuntimeContext, type PluginGameRuntimeContext, type PluginTutorialDefinition, type PluginTutorialApi, type PluginMusicApi, type MusicContext } from 'hoc-core/plugin-api';
      import { createCharacterPackageDraft, AbilityDefinitionSchema, ScalarSchema, type CharacterPackageDraft, type AbilityDefinition, type AbilityRule, type StatusDefinition, type ScalarValue, type ActorSelector, type Condition, type Effect, type AbilityDisplay, type SkillCardFilter } from 'hoc-core/authoring-api';
      import { imageOptions, buildPackage } from 'hoc-core/image-build';
      import { buildAudio, type AudioBuildRecord } from 'hoc-core/audio-build';
      import { manifestFiles } from 'hoc-core/package-tools';
      import { instantiateProgramTemplate, type ProgramDefinition, type ProgramTemplate, type MatchInitSpec, type CharacterRuntime } from 'hoc-core/authoring-api';
      import type { StoryNode } from 'hoc-core/authoring-api';
      import { AchievementDefinitionSchema, AchievementCatalogSchema, StandardAchievementDefinitionSchema, StandardAchievementCatalogSchema, AchievementKeySchema, AchievementLedgerSchema, createAchievementLedger, advanceAchievements, validateAchievementPackage, projectAchievement, projectAchievementList, createAchievementCommitPort, type AchievementCheckpoint, type AchievementCommitPortOptions, type AchievementUnlockDelivery, type AchievementDefinition, type AchievementDefinitionEntry, type AchievementCatalog, type StandardAchievementDefinition, type StandardAchievementCatalog, type AchievementPresentation, type AchievementListPresentation, type AchievementObservation, type AchievementObservationContract, type AchievementLedger, type AchievementEvaluation } from 'hoc-core/authoring-api';
      const quote: PluginMainMenuQuote = {lines:[{text:"A neutral quote",emphasis:true}]};
      const quoteContribution: PluginRuntimeContribution = {mainMenuQuote:quote};
      const optionalStoryCommand: StoryNode = {id:'invite',type:'command',command:{type:'neutral.invite',apiVersion:1,args:{}},onSkip:'omit',next:'end'};
      void optionalStoryCommand;
      void quoteContribution;
      const achievement: AchievementDefinition = {id:'ten-cards',revision:1,name:'Ten cards',description:'Collect ten cards.',tracking:{scope:'match',completion:'immediate',continuity:'continuous',allowDebug:false,tracks:[{id:'removed',on:[{type:'example.skills-removed',apiVersion:1}],progress:{type:'sum',value:{type:'skill-card-count',collection:'removed'}}}],completeWhen:{type:'scalar-compare',left:{type:'metric',id:'removed'},operator:'gte',right:10}}};
      const achievementCatalog: AchievementCatalog = {achievements:[achievement]};
      const achievementEntry: AchievementDefinitionEntry = {key:AchievementKeySchema.parse('example/achievements#main/ten-cards'),definition:achievement};
      AchievementDefinitionSchema.parse(achievement); AchievementCatalogSchema.parse(achievementCatalog);
      void [achievementEntry,validateAchievementPackage];
      const achievementObservation: AchievementObservation = {apiVersion:1,streamId:'sdk-profile',sequence:0,at:'2026-11-09T00:00:00Z',topic:{type:'example.checkpoint',apiVersion:1},scopes:{},debugUsed:false,values:{},skillCards:{}};
      const achievementContract: AchievementObservationContract = {topic:achievementObservation.topic,values:{},skillCollections:[]};
      const achievementLedger: AchievementLedger = createAchievementLedger('sdk-profile');
      const standardAchievement: StandardAchievementDefinition = {...achievement,cover:'icons/cards.png',hidden:true};
      const standardCatalog: StandardAchievementCatalog = {achievements:[standardAchievement]};
      StandardAchievementDefinitionSchema.parse(standardAchievement); StandardAchievementCatalogSchema.parse(standardCatalog);
      const presentationEntry = {key:achievementEntry.key,definition:standardAchievement,coverUrl:'blob:cover'};
      const achievementPresentation: AchievementPresentation = projectAchievement(presentationEntry,achievementLedger);
      const achievementList: AchievementListPresentation = projectAchievementList([presentationEntry],achievementLedger);
      void [achievementPresentation,achievementList];
      const achievementResult: AchievementEvaluation = advanceAchievements([],achievementLedger,achievementObservation,[achievementContract]);
      const restoredAchievementLedger: AchievementLedger = AchievementLedgerSchema.parse(JSON.parse(JSON.stringify(achievementResult.ledger)));
      void restoredAchievementLedger;
      const commitOptions: AchievementCommitPortOptions = {initial:achievementLedger,requiredConsumers:['reward'],save:async (checkpoint:AchievementCheckpoint)=>{const delivery:AchievementUnlockDelivery|undefined=checkpoint.pending[0];void delivery;}};
      const commitPort=createAchievementCommitPort(commitOptions);
      void commitPort;
      const musicCondition = (music: PluginMusicApi, context: MusicContext) => { if(context.match) music.set('phase',{track:'example/music#main/theme',priority:'conditional',scope:'match'}); };
      void musicCondition;
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
      const matchingTransfer: Effect = {type:'transfer-hand-card',from:'rival',target:'owner',card:{type:'matching-transfer',candidate:'reaches-bust-limit',pick:'first'}};
      const stood: Condition = {type:'actor-stood',target:'rival',expected:true};
      const winningComparison: Condition = {type:'comparison-would-win',target:'owner'};
      const matchingCandidate: Condition = {type:'hand-transfer-candidate-exists',from:'rival',target:'owner',candidate:'reaches-bust-limit'};
      const invokeActive: Effect = {type:'invoke-random-active-skill',target:'rival',filter:{activation:'action',tags:['neutral']}};
      const counting: Effect = {type:'set-matching-hand-cards-counted',target:'owner',attribute:'source',equals:{type:'literal',value:'derived'},counted:false};
      const acquiredHeldCondition: Condition = {type:'acquired-card-is-held',target:'owner'};
      const transferAcquired: Effect = {type:'transfer-hand-card',from:'owner',target:'rival',card:'acquired-card'};
      void [counting,acquiredHeldCondition,transferAcquired];
      void [count,operation,markers,transfer,matchingTransfer,stood,winningComparison,matchingCandidate,invokeActive];
      void recycle; void reserve; AbilityDefinitionSchema.parse(limited);
      const plugin: PluginModule = {register: () => ({handlers:[],createRuntime:()=>({})})};
      function context(value: PluginRuntimeContext, game: PluginGameRuntimeContext, signal: AbortSignal) {
        const releaseEvents = game.game.events?.subscribeTrigger('resolved', {on:['program.node-entered'],scope:{name:'program'}}, (batch,lifetime) => {
          const program: string | undefined = batch.facts[0]?.scopes.program;
          void [program,lifetime.aborted];
        }, {signal,scopes:{game:'sdk-game'}});
        releaseEvents?.();
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
