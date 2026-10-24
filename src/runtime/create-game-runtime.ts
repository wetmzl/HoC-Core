import { builtinMainMenuActions, collectMainMenuActions } from "../presentation/main-menu-actions";
import { gameAudio } from "../audio/game-audio";
import { RuntimeController } from "../runtime/game-runtime";
import { MatchSession } from "../runtime/match-session";
import { LobbyScreen } from "../screens/lobby-screen";
import { SettingsController } from "../runtime/save-settings";
import { SkillLibraryController } from "../screens/skill-library";
import { TutorialController } from "../presentation/tutorial-controller";
import { NotificationController } from "../presentation/notification-controller";
import { FullscreenController } from "../presentation/fullscreen-controller";
import { AiController } from "../presentation/ai-controller";
import { DialoguePresenter } from "../presentation/dialogue-presenter";
import { TableScreen } from "../screens/table-screen";
import { SummaryScreen } from "../screens/summary-screen";
import { RecoveryScreen } from "../screens/recovery-screen";
/** Composition root: each component receives only its named dependencies. */
export function createGameRuntime(): RuntimeController {
    let runtimeController!: RuntimeController;
    let matchSession!: MatchSession;
    let lobbyScreen!: LobbyScreen;
    let settingsController!: SettingsController;
    let skillLibraryController!: SkillLibraryController;
    let tutorialController!: TutorialController;
    let notificationController!: NotificationController;
    let fullscreenController!: FullscreenController;
    let aiController!: AiController;
    let dialoguePresenter!: DialoguePresenter;
    let tableScreen!: TableScreen;
    let summaryScreen!: SummaryScreen;
    let recoveryScreen!: RecoveryScreen;
    const resetTablePresentation = () => {
        tutorialController.discardActiveTutorial();
        aiController.clearAiSchedule();
        dialoguePresenter.dispose();
        notificationController.dispose();
        fullscreenController.dispose();
        tableScreen.dispose();
    };
    runtimeController = new RuntimeController({
        pauseMatch: paused => matchSession.setPaused(paused),
        disposeSession: () => matchSession.dispose(),
        resetPresentation: resetTablePresentation,
        disposePresentation: () => { resetTablePresentation(); aiController.dispose(); tutorialController.dispose(); },
        disposeLobby: () => lobbyScreen.dispose(),
        disposeSkills: () => skillLibraryController.dispose(),
        get stopPluginMatch() { return matchSession.leave; },
        get clearAiSchedule() { return aiController.clearAiSchedule; },
        get autosave() { return matchSession.autosave; },
        clearActiveMatch: () => matchSession.clearActiveMatch(),
        get renderLobby() { return lobbyScreen.renderLobby; },
        get enqueueNotification() { return notificationController.enqueueNotification; },
        get requireAdultContentAcknowledgement() { return tutorialController.requireAdultContentAcknowledgement; },
        createTutorialApi: (packageId, signal) => tutorialController.forPackage(packageId, signal),
        discardActiveTutorial: () => tutorialController.discardActiveTutorial(),
        setTutorialsReady: () => tutorialController.setReady(),
        flushTutorials: () => tutorialController.flush(),
        get dispatch() { return matchSession.dispatch; },
        get writePluginSettings() { return settingsController.writePluginSettings; },
        get scheduleAiTurn() { return aiController.scheduleAiTurn; },
        get devCalibrationCharacterId() { return tableScreen.devCalibrationCharacterId; },
        get renderDevRevolverCalibration() { return tableScreen.renderDevRevolverCalibration; },
        get resumeMatch() { return matchSession.resumeMatch; },
        get renderError() { return recoveryScreen.renderError; },
        get deckQueue() { return skillLibraryController.deckQueue; }
    });
    matchSession = new MatchSession({
        enterMatch: () => runtimeController.navigateScreen(async () => ({ mount: async () => ({ dispose: resetTablePresentation }) })),
        resetDialogue: () => dialoguePresenter.dispose(),
        get selectedCharacterId() { return lobbyScreen.selectedCharacterId; },
        set selectedCharacterId(value) { lobbyScreen.selectedCharacterId = value; },
        get getDeckQueue() { return skillLibraryController.getDeckQueue; },
        get currentAvailableDeckSkills() { return skillLibraryController.currentAvailableDeckSkills; },
        get root() { return runtimeController.root; },
        get openSkillManagement() { return skillLibraryController.openSkillManagement; },
        get skillDrawerOpen() { return tableScreen.skillDrawerOpen; },
        set skillDrawerOpen(value) { tableScreen.skillDrawerOpen = value; },
        get clearAbilityNoticeQueue() { return notificationController.clearAbilityNoticeQueue; },
        get detachFullscreenListener() { return fullscreenController.detachFullscreenListener; },
        get save() { return runtimeController.save; },
        set save(value) { runtimeController.save = value; },
        get enqueueAbilityNotices() { return notificationController.enqueueAbilityNotices; },
        get renderError() { return recoveryScreen.renderError; },
        get tablePortrait() { return dialoguePresenter.tablePortrait; },
        get clearAiSchedule() { return aiController.clearAiSchedule; },
        get repository() { return runtimeController.repository; },
        notifyExtensions: () => runtimeController.extensions?.notify(),
        get renderMatch() { return tableScreen.renderMatch; },
        get runtimeContributions() { return runtimeController.runtimeContributions; },
        get renderSummary() { return summaryScreen.renderSummary; },
        get offerTutorial() { return tutorialController.offerTutorial; },
        get scheduleAiTurn() { return aiController.scheduleAiTurn; },
        get presentDelta() { return notificationController.presentDelta; },
        get showHistoryScreen() { return runtimeController.showHistoryScreen; },
        get renderLobby() { return lobbyScreen.renderLobby; }
    });
    lobbyScreen = new LobbyScreen({
        get mainMenuActions() {
            return collectMainMenuActions(builtinMainMenuActions({
                historyCount: runtimeController.save.history.length,
                openDialog: id => runtimeController.root.querySelector<HTMLDialogElement>(`#${id}`)?.showModal(),
                openSkills: () => skillLibraryController.openSkillManagement(),
                openHistory: runtimeController.showHistoryScreen
            }), runtimeController.runtimeContributions, runtimeController.showUiPage);
        },
        get pluginCredits() { return runtimeController.pluginCredits; },
        navigateScreen: loader => runtimeController.navigateScreen(loader),
        get save() { return runtimeController.save; },
        set save(value) { runtimeController.save = value; },
        get root() { return runtimeController.root; },
        get handScroll() { return tableScreen.handScroll; },
        get stopPluginMatch() { return matchSession.leave; },
        get renderError() { return recoveryScreen.renderError; },
        get discardActiveTutorial() { return tutorialController.discardActiveTutorial; },
        get clearAiSchedule() { return aiController.clearAiSchedule; },
        resetDialogue: () => dialoguePresenter.dispose(),
        get clearAbilityNoticeQueue() { return notificationController.clearAbilityNoticeQueue; },
        get detachFullscreenListener() { return fullscreenController.detachFullscreenListener; },
        clearActiveMatch: () => matchSession.clearActiveMatch(),
        get skillArchetypeArt() { return runtimeController.skillArchetypeArt; },
        get disposeDeckEditor() { return skillLibraryController.disposeDeckEditor; },
        set disposeDeckEditor(value) { skillLibraryController.disposeDeckEditor = value; },
        get requestGameRuntimeExit() { return runtimeController.requestGameRuntimeExit; },
        get updateSettings() { return settingsController.updateSettings; },
        get pluginSettingsSession() { return runtimeController.pluginSettingsSession; },
        get repository() { return runtimeController.repository; },
        get exportSave() { return settingsController.exportSave; },
        get requestImport() { return settingsController.requestImport; },
        get importFile() { return settingsController.importFile; },
        get exportFailedImport() { return settingsController.exportFailedImport; },
        get confirmResetCurrentData() { return settingsController.confirmResetCurrentData; },
        get resetCurrentData() { return settingsController.resetCurrentData; },
        get startMatch() { return matchSession.startMatch; }
    });
    settingsController = new SettingsController({
        get deckQueue() { return skillLibraryController.deckQueue; },
        set deckQueue(value) { skillLibraryController.deckQueue = value; },
        get autosave() { return matchSession.autosave; },
        clearActiveMatch: () => matchSession.clearActiveMatch(),
        get repository() { return runtimeController.repository; },
        get save() { return runtimeController.save; },
        set save(value) { runtimeController.save = value; },
        get pluginSettingsSession() { return runtimeController.pluginSettingsSession; },
        get clearAiSchedule() { return aiController.clearAiSchedule; },
        get renderLobby() { return lobbyScreen.renderLobby; },
        get lobbyLayer() { return lobbyScreen.lobbyLayer; },
        get root() { return runtimeController.root; },
        get runtimeContributions() { return runtimeController.runtimeContributions; }
    });
    skillLibraryController = new SkillLibraryController({
        get save() { return runtimeController.save; },
        set save(value) { runtimeController.save = value; },
        get repository() { return runtimeController.repository; },
        get autosave() { return matchSession.autosave; },
        get root() { return runtimeController.root; }
    });
    tutorialController = new TutorialController({
        pauseAutoActions: () => runtimeController.extensions?.pauseAutoActions() ?? (() => {}),
        flushPendingSaveWrites: async () => {
            await skillLibraryController.deckQueue?.flush();
            await settingsController.flushPluginSettings();
        },
        get save() { return runtimeController.save; },
        set save(value) { runtimeController.save = value; },
        get root() { return runtimeController.root; },
        get repository() { return runtimeController.repository; },
        get autosave() { return matchSession.autosave; },
        get enqueueNotification() { return notificationController.enqueueNotification; }
    });
    notificationController = new NotificationController({
        get root() { return runtimeController.root; },
        get save() { return runtimeController.save; },
        get currentCharacter() { return matchSession.currentCharacter; },
        get offerTutorial() { return tutorialController.offerTutorial; }
    });
    fullscreenController = new FullscreenController({
        get syncAbilityNoticePosition() { return notificationController.syncAbilityNoticePosition; },
        get root() { return runtimeController.root; },
        get detachAbilityNoticePositionListener() { return notificationController.detachAbilityNoticePositionListener; },
        get attachAbilityNoticePositionListener() { return notificationController.attachAbilityNoticePositionListener; },
        get enqueueNotification() { return notificationController.enqueueNotification; }
    });
    aiController = new AiController({
        getState: () => matchSession.autosave?.getState(),
        isPaused: () => runtimeController.extensions?.paused ?? false,
        showThinking: () => tableScreen.showThinking(),
        dispatch: action => matchSession.dispatch(action)
    });
    dialoguePresenter = new DialoguePresenter({
        get dialogueSession() { return matchSession.dialogueSession; },
        get root() { return runtimeController.root; },
        get save() { return runtimeController.save; }
    });
    tableScreen = new TableScreen({
        get dispatch() { return matchSession.dispatch; },
        get root() { return runtimeController.root; },
        get currentCharacter() { return matchSession.currentCharacter; },
        set currentCharacter(value) { matchSession.currentCharacter = value; },
        get currentDialogue() { return dialoguePresenter.currentDialogue; },
        get dialogueKey() { return dialoguePresenter.dialogueKey; },
        captureDialogue: (text, key) => dialoguePresenter.capture(text, key),
        restoreDialogue: (text, key, snapshot) => dialoguePresenter.restore(text, key, snapshot),
        get dialogueSession() { return matchSession.dialogueSession; },
        get portraitState() { return dialoguePresenter.portraitState; },
        get tablePortrait() { return dialoguePresenter.tablePortrait; },
        get portraitAlt() { return dialoguePresenter.portraitAlt; },
        get runtimeContributions() { return runtimeController.runtimeContributions; },
        get enqueueNotification() { return notificationController.enqueueNotification; },
        get attachFullscreenListener() { return fullscreenController.attachFullscreenListener; },
        get syncFullscreenButton() { return fullscreenController.syncFullscreenButton; },
        get syncAbilityNoticePosition() { return notificationController.syncAbilityNoticePosition; },
        get toggleFullscreen() { return fullscreenController.toggleFullscreen; },
        get save() { return runtimeController.save; },
        get lastAction() { return matchSession.lastAction; },
        get lastDomainEvent() { return matchSession.lastDomainEvent; }
    });
    summaryScreen = new SummaryScreen({
        beforeShow: () => {
            resetTablePresentation();
            gameAudio.stopHeartbeat();
        },
        get currentCharacter() { return matchSession.currentCharacter; },
        get save() { return runtimeController.save; },
        get root() { return runtimeController.root; },
        get getDeckQueue() { return skillLibraryController.getDeckQueue; },
        get currentAvailableDeckSkills() { return skillLibraryController.currentAvailableDeckSkills; },
        get deckQueue() { return skillLibraryController.deckQueue; },
        get requestDispatch() { return tableScreen.requestDispatch; },
        get completeMatch() { return matchSession.completeMatch; }
    });
    recoveryScreen = new RecoveryScreen({
        get discardActiveTutorial() { return tutorialController.discardActiveTutorial; },
        get clearAiSchedule() { return aiController.clearAiSchedule; },
        get clearAbilityNoticeQueue() { return notificationController.clearAbilityNoticeQueue; },
        get detachFullscreenListener() { return fullscreenController.detachFullscreenListener; },
        get root() { return runtimeController.root; },
        get boot() { return runtimeController.boot; },
        get confirmResetCurrentData() { return settingsController.confirmResetCurrentData; },
        get repository() { return runtimeController.repository; },
        get exportStatus() { return settingsController.exportStatus; }
    });
    return runtimeController;
}
