/* Deliberately ES5, unbundled: this must run even when the game cannot parse.
 * Only missing startup/storage foundations prompt; UA and CSS never block entry.
 * The player can bypass this notice for the current startup attempt.
 */
(function () {
  var notice = document.getElementById("compatibility-notice");
  var nativeError = document.body.getAttribute("data-native-error") === "true";
  var ua = navigator.userAgent || "";
  var ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var android = /Android/.test(ua) || nativeError;
  var nativeApp = nativeError || !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  var webview = android && (nativeApp || /; wv\)|\bwv\b/.test(ua));
  var chromium = !ios && /(?:Chrome|Chromium)\/([\d.]+)/.exec(ua);
  var firefox = !ios && /Firefox\/([\d.]+)/.exec(ua);
  var safari = /Version\/([\d.]+).*Safari/.exec(ua);
  var engine = chromium ? "Chromium " + chromium[1] : firefox ? "Firefox " + firefox[1] : safari ? "Safari " + safari[1] : "版本未能识别（按实际能力检查）";
  if (ios && !safari) engine = "iOS / iPadOS 浏览器（按实际能力检查）";
  var missing = [];
  var bypass = false;
  var query = window.location.search.slice(1).split("&");
  var remainingQuery = [];
  for (var i = 0; i < query.length; i++) {
    if (query[i] === "hoc-try-anyway=1") bypass = true;
    else if (query[i]) remainingQuery.push(query[i]);
  }
  // Native error pages have no game entry. Carry the choice across one navigation
  // without persisting it in settings, saves, or browser storage.
  if (bypass && window.history && window.history.replaceState) {
    try {
      window.history.replaceState(null, "", window.location.pathname + (remainingQuery.length ? "?" + remainingQuery.join("&") : "") + window.location.hash);
    } catch (error) { /* Some embedded browsers do not expose history writes. */ }
  }

  function requireCapability(ok, label) { if (!ok) missing.push(label); }
  function show(title, message, help, detail) {
    document.getElementById("compatibility-title").textContent = title;
    document.getElementById("compatibility-message").textContent = message;
    document.getElementById("compatibility-help").textContent = help;
    document.getElementById("compatibility-detail").textContent = detail;
    notice.style.display = "block";
    notice.focus();
  }

  document.getElementById("compatibility-retry").onclick = function () {
    if (nativeError) window.location.replace("./");
    else window.location.reload();
  };
  window.__HOC_COMPATIBILITY__ = {
    // This means allowed to try, not a guarantee that all game features work.
    supported: false,
    entryLoaded: false,
    entryFailed: false,
    hideNotice: function () { notice.style.display = "none"; },
    showLoadError: function () {
      window.__HOC_COMPATIBILITY__.entryFailed = true;
      var help = webview
        ? "若问题持续，可在手机设置中检查系统更新，或在自带应用市场检查系统网页组件更新。无需卸载游戏或清除游戏数据。"
        : "若问题持续，可在浏览器设置或手机自带的应用市场检查浏览器更新。无需清除游戏数据。";
      show("游戏页面未能加载", "请检查网络后重试，或关闭并重新打开游戏。", help, "当前环境：" + engine);
    }
  };
  var continueButton = document.getElementById("compatibility-continue");
  continueButton.style.display = "inline-block";
  continueButton.onclick = function () {
    var gate = window.__HOC_COMPATIBILITY__;
    if (nativeError) {
      window.location.replace("./?hoc-try-anyway=1");
    } else if (gate.entryFailed) {
      // Module failures can be cached by the browser; retry with a fresh document.
      window.location.replace(window.location.pathname + (window.location.search ? window.location.search + "&" : "?") + "hoc-try-anyway=1" + window.location.hash);
    } else {
      gate.supported = true;
      document.getElementById("compatibility-title").textContent = "正在尝试进入游戏";
      document.getElementById("compatibility-message").textContent = "已跳过本次提醒。如果仍无法进入，请检查更新后重试。";
      // If the module has not arrived yet, bootstrap will observe supported=true.
      if (gate.start) gate.start();
    }
  };
  window.addEventListener("error", function (event) {
    var target = event.target;
    var gate = window.__HOC_COMPATIBILITY__;
    if (!gate.entryLoaded && (target === window || (target && target.tagName === "SCRIPT" && target.type === "module"))) {
      gate.entryFailed = true;
      if (gate.supported) gate.showLoadError();
    }
  }, true);

  // Secure-context restrictions must not be misreported as an outdated browser.
  if (!bypass && !nativeApp && window.isSecureContext === false) {
    show("请通过安全地址打开游戏", "当前网址未使用安全连接，游戏需要的存储能力不可用。", "请使用此站点的 HTTPS 地址，或联系站点维护者。无需清除游戏数据。", "当前环境：" + engine);
    return;
  }
  if (!bypass) {
    requireCapability("noModule" in document.createElement("script"), "JavaScript 模块");
    requireCapability(typeof window.fetch === "function" && typeof window.Promise === "function", "基础网络能力");
    requireCapability(!!(window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === "function"), "内容数据校验");
    if (!nativeApp) {
      requireCapability(!!(navigator.storage && typeof navigator.storage.getDirectory === "function"), "本地内容目录");
    }
  }

  if (missing.length && !bypass) {
    var title = webview ? "请更新系统网页组件" : "请更新浏览器";
    var message = webview
      ? "手机的网页组件（WebView）缺少游戏加载或内容存储所需的基础能力。建议检查更新，也可跳过提醒尝试进入。"
      : "当前浏览器缺少游戏加载或内容存储所需的基础能力。建议检查更新，也可跳过提醒尝试进入。";
    var help = ios
      ? "请在系统设置中检查 iOS / iPadOS 更新，并更新正在使用的浏览器。无需卸载游戏或清除游戏数据。"
      : webview
        ? "1. 检查手机系统更新。\n华为通常在「设置 → 系统和更新 → 软件更新」。\n\n2. 检查手机自带应用市场的更新。\n华为通常在「应用市场 → 我的 → 应用更新」。如有系统网页组件更新，请一并更新。\n\n若没有可用更新，可展开下方检测信息，截图反馈。仅更新游戏或浏览器不一定能更新此组件；无需卸载游戏或清除游戏数据。"
        : android
          ? "请在手机自带的应用市场更新当前浏览器。华为通常在「应用市场 → 我的 → 应用更新」。\n\n若从微信、QQ 等应用内打开，请复制游戏网址，用更新后的手机浏览器打开。无需清除游戏数据。"
          : "请在浏览器的设置或「关于」页面检查更新；若在其他应用内打开，可改用更新后的独立浏览器。无需清除游戏数据。";
    show(title, message, help, "当前环境：" + (webview ? "系统网页组件 / " : "") + engine + "\n缺少：" + missing.join("、"));
    return;
  }
  if (nativeError) {
    window.__HOC_COMPATIBILITY__.showLoadError();
    return;
  }
  window.__HOC_COMPATIBILITY__.supported = true;
  notice.style.display = "none";
}());
