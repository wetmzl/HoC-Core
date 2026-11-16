import { gameAudio } from "./game-audio";
import type { PluginSound } from "./plugin-audio";
import type { StoryPresenterAudio } from "../presentation/story-presenter";

/** Scene-owned handles reuse the ordinary sound setting and music arbitration. */
export function createStoryAudio(resolveAsset: (path: string) => string | Promise<string>): StoryPresenterAudio {
  const voices = new Map<string, PluginSound>();
  let releaseMusic: (() => void) | undefined;
  let paused = false;
  const stop = (channel: string) => {
    if (channel === "music") { releaseMusic?.(); releaseMusic = undefined; }
    else { voices.get(channel)?.dispose(); voices.delete(channel); }
  };
  const clear = () => { for (const channel of [...voices.keys()]) stop(channel); stop("music"); };
  return {
    async perform(action, context) {
      stop(action.channel);
      if (action.operation === "stop" || context.skip || context.signal.aborted || !action.src) return;
      const url = await resolveAsset(action.src);
      if (context.signal.aborted) return;
      if (action.channel === "music") {
        releaseMusic = gameAudio.musicDirector.holdTrack(url, { loop: action.loop, transitionMs: action.fadeMs });
        context.signal.addEventListener("abort", () => stop("music"), { once: true });
        return;
      }
      const voice = gameAudio.createEffect(url, () => {});
      voices.set(action.channel, voice);
      voice.setPaused?.(paused);
      const finished = voice.playAndWait?.({ volume: action.volume, signal: context.signal, loop: action.loop }) ?? Promise.resolve();
      const release = () => {
        if (voices.get(action.channel) === voice) voices.delete(action.channel);
        voice.dispose();
      };
      if (action.wait) { try { await finished; } finally { release(); } }
      else void finished.finally(release);
    },
    setPaused(value) { paused = value; for (const voice of voices.values()) voice.setPaused?.(value); },
    fastForward: clear,
    dispose: clear
  };
}
