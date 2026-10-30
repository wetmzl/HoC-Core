// The classic notice can defer startup, but the player can always request it.
declare global {
  interface Window {
    __HOC_COMPATIBILITY__?: {
      supported: boolean;
      entryLoaded: boolean;
      start?: () => void;
      hideNotice(): void;
      showLoadError(): void;
    };
  }
}

const notice = window.__HOC_COMPATIBILITY__;
if (notice) {
  let started = false;
  notice.start = () => {
    if (started) return;
    started = true;
    notice.hideNotice();
    try {
      // Production preload helpers can throw before returning a promise on an
      // environment that the player explicitly chose to try anyway.
      void import("./main").catch(() => notice.showLoadError());
    } catch {
      notice.showLoadError();
    }
  };
  notice.entryLoaded = true;
  if (notice.supported) notice.start();
}

export {};
