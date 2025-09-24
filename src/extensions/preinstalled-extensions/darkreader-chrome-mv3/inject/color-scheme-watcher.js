(function () {
    "use strict";

    const isNavigatorDefined = typeof navigator !== "undefined";
    const userAgent = isNavigatorDefined
        ? navigator.userAgentData &&
          Array.isArray(navigator.userAgentData.brands)
            ? navigator.userAgentData.brands
                  .map(
                      (brand) => `${brand.brand.toLowerCase()} ${brand.version}`
                  )
                  .join(" ")
            : navigator.userAgent.toLowerCase()
        : "some useragent";
    const platform = isNavigatorDefined
        ? navigator.userAgentData &&
          typeof navigator.userAgentData.platform === "string"
            ? navigator.userAgentData.platform.toLowerCase()
            : navigator.platform.toLowerCase()
        : "some platform";
    userAgent.includes("vivaldi");
    userAgent.includes("yabrowser");
    userAgent.includes("opr") || userAgent.includes("opera");
    userAgent.includes("edg");
    platform.startsWith("win");
    platform.startsWith("mac");
    isNavigatorDefined && navigator.userAgentData
        ? navigator.userAgentData.mobile
        : userAgent.includes("mobile");
    (isNavigatorDefined &&
        navigator.userAgentData &&
        ["Linux", "Android"].includes(navigator.userAgentData.platform)) ||
        platform.startsWith("linux");
    (() => {
        const m = userAgent.match(/chrom(?:e|ium)(?:\/| )([^ ]+)/);
        if (m && m[1]) {
            return m[1];
        }
        return "";
    })();
    (() => {
        const m = userAgent.match(/(?:firefox|librewolf)(?:\/| )([^ ]+)/);
        if (m && m[1]) {
            return m[1];
        }
        return "";
    })();
    (() => {
        try {
            document.querySelector(":defined");
            return true;
        } catch (err) {
            return false;
        }
    })();

    let query = null;
    const onChange = ({matches}) =>
        listeners.forEach((listener) => listener(matches));
    const listeners = new Set();
    function runColorSchemeChangeDetector(callback) {
        listeners.add(callback);
        if (query) {
            return;
        }
        query = matchMedia("(prefers-color-scheme: dark)");
        {
            query.addEventListener("change", onChange);
        }
    }
    function stopColorSchemeChangeDetector() {
        if (!query || !onChange) {
            return;
        }
        {
            query.removeEventListener("change", onChange);
        }
        listeners.clear();
        query = null;
    }
    const isSystemDarkModeEnabled = () =>
        (query || matchMedia("(prefers-color-scheme: dark)")).matches;

    var MessageTypeUItoBG;
    (function (MessageTypeUItoBG) {
        MessageTypeUItoBG["GET_DATA"] = "ui-bg-get-data";
        MessageTypeUItoBG["GET_DEVTOOLS_DATA"] = "ui-bg-get-devtools-data";
        MessageTypeUItoBG["SUBSCRIBE_TO_CHANGES"] =
            "ui-bg-subscribe-to-changes";
        MessageTypeUItoBG["UNSUBSCRIBE_FROM_CHANGES"] =
            "ui-bg-unsubscribe-from-changes";
        MessageTypeUItoBG["CHANGE_SETTINGS"] = "ui-bg-change-settings";
        MessageTypeUItoBG["SET_THEME"] = "ui-bg-set-theme";
        MessageTypeUItoBG["TOGGLE_ACTIVE_TAB"] = "ui-bg-toggle-active-tab";
        MessageTypeUItoBG["MARK_NEWS_AS_READ"] = "ui-bg-mark-news-as-read";
        MessageTypeUItoBG["MARK_NEWS_AS_DISPLAYED"] =
            "ui-bg-mark-news-as-displayed";
        MessageTypeUItoBG["LOAD_CONFIG"] = "ui-bg-load-config";
        MessageTypeUItoBG["APPLY_DEV_DYNAMIC_THEME_FIXES"] =
            "ui-bg-apply-dev-dynamic-theme-fixes";
        MessageTypeUItoBG["RESET_DEV_DYNAMIC_THEME_FIXES"] =
            "ui-bg-reset-dev-dynamic-theme-fixes";
        MessageTypeUItoBG["APPLY_DEV_INVERSION_FIXES"] =
            "ui-bg-apply-dev-inversion-fixes";
        MessageTypeUItoBG["RESET_DEV_INVERSION_FIXES"] =
            "ui-bg-reset-dev-inversion-fixes";
        MessageTypeUItoBG["APPLY_DEV_STATIC_THEMES"] =
            "ui-bg-apply-dev-static-themes";
        MessageTypeUItoBG["RESET_DEV_STATIC_THEMES"] =
            "ui-bg-reset-dev-static-themes";
        MessageTypeUItoBG["START_ACTIVATION"] = "ui-bg-start-activation";
        MessageTypeUItoBG["RESET_ACTIVATION"] = "ui-bg-reset-activation";
        MessageTypeUItoBG["COLOR_SCHEME_CHANGE"] = "ui-bg-color-scheme-change";
        MessageTypeUItoBG["HIDE_HIGHLIGHTS"] = "ui-bg-hide-highlights";
    })(MessageTypeUItoBG || (MessageTypeUItoBG = {}));
    var MessageTypeBGtoUI;
    (function (MessageTypeBGtoUI) {
        MessageTypeBGtoUI["CHANGES"] = "bg-ui-changes";
    })(MessageTypeBGtoUI || (MessageTypeBGtoUI = {}));
    var DebugMessageTypeBGtoUI;
    (function (DebugMessageTypeBGtoUI) {
        DebugMessageTypeBGtoUI["CSS_UPDATE"] = "debug-bg-ui-css-update";
        DebugMessageTypeBGtoUI["UPDATE"] = "debug-bg-ui-update";
    })(DebugMessageTypeBGtoUI || (DebugMessageTypeBGtoUI = {}));
    var MessageTypeBGtoCS;
    (function (MessageTypeBGtoCS) {
        MessageTypeBGtoCS["ADD_CSS_FILTER"] = "bg-cs-add-css-filter";
        MessageTypeBGtoCS["ADD_DYNAMIC_THEME"] = "bg-cs-add-dynamic-theme";
        MessageTypeBGtoCS["ADD_STATIC_THEME"] = "bg-cs-add-static-theme";
        MessageTypeBGtoCS["ADD_SVG_FILTER"] = "bg-cs-add-svg-filter";
        MessageTypeBGtoCS["CLEAN_UP"] = "bg-cs-clean-up";
        MessageTypeBGtoCS["FETCH_RESPONSE"] = "bg-cs-fetch-response";
        MessageTypeBGtoCS["UNSUPPORTED_SENDER"] = "bg-cs-unsupported-sender";
    })(MessageTypeBGtoCS || (MessageTypeBGtoCS = {}));
    var DebugMessageTypeBGtoCS;
    (function (DebugMessageTypeBGtoCS) {
        DebugMessageTypeBGtoCS["RELOAD"] = "debug-bg-cs-reload";
    })(DebugMessageTypeBGtoCS || (DebugMessageTypeBGtoCS = {}));
    var MessageTypeCStoBG;
    (function (MessageTypeCStoBG) {
        MessageTypeCStoBG["COLOR_SCHEME_CHANGE"] = "cs-bg-color-scheme-change";
        MessageTypeCStoBG["DARK_THEME_DETECTED"] = "cs-bg-dark-theme-detected";
        MessageTypeCStoBG["DARK_THEME_NOT_DETECTED"] =
            "cs-bg-dark-theme-not-detected";
        MessageTypeCStoBG["FETCH"] = "cs-bg-fetch";
        MessageTypeCStoBG["DOCUMENT_CONNECT"] = "cs-bg-document-connect";
        MessageTypeCStoBG["DOCUMENT_FORGET"] = "cs-bg-document-forget";
        MessageTypeCStoBG["DOCUMENT_FREEZE"] = "cs-bg-document-freeze";
        MessageTypeCStoBG["DOCUMENT_RESUME"] = "cs-bg-document-resume";
    })(MessageTypeCStoBG || (MessageTypeCStoBG = {}));
    var DebugMessageTypeCStoBG;
    (function (DebugMessageTypeCStoBG) {
        DebugMessageTypeCStoBG["LOG"] = "debug-cs-bg-log";
    })(DebugMessageTypeCStoBG || (DebugMessageTypeCStoBG = {}));
    var MessageTypeCStoUI;
    (function (MessageTypeCStoUI) {
        MessageTypeCStoUI["EXPORT_CSS_RESPONSE"] = "cs-ui-export-css-response";
    })(MessageTypeCStoUI || (MessageTypeCStoUI = {}));
    var MessageTypeUItoCS;
    (function (MessageTypeUItoCS) {
        MessageTypeUItoCS["EXPORT_CSS"] = "ui-cs-export-css";
    })(MessageTypeUItoCS || (MessageTypeUItoCS = {}));

    let documentVisibilityListener = null;
    let documentIsVisible_ = !document.hidden;
    const listenerOptions = {
        capture: true,
        passive: true
    };
    function watchForDocumentVisibility() {
        document.addEventListener(
            "visibilitychange",
            documentVisibilityListener,
            listenerOptions
        );
        window.addEventListener(
            "pageshow",
            documentVisibilityListener,
            listenerOptions
        );
        window.addEventListener(
            "focus",
            documentVisibilityListener,
            listenerOptions
        );
    }
    function stopWatchingForDocumentVisibility() {
        document.removeEventListener(
            "visibilitychange",
            documentVisibilityListener,
            listenerOptions
        );
        window.removeEventListener(
            "pageshow",
            documentVisibilityListener,
            listenerOptions
        );
        window.removeEventListener(
            "focus",
            documentVisibilityListener,
            listenerOptions
        );
    }
    function setDocumentVisibilityListener(callback) {
        const alreadyWatching = Boolean(documentVisibilityListener);
        documentVisibilityListener = () => {
            if (!document.hidden) {
                removeDocumentVisibilityListener();
                callback();
                documentIsVisible_ = true;
            }
        };
        if (!alreadyWatching) {
            watchForDocumentVisibility();
        }
    }
    function removeDocumentVisibilityListener() {
        stopWatchingForDocumentVisibility();
        documentVisibilityListener = null;
    }
    function documentIsVisible() {
        return documentIsVisible_;
    }

    function cleanup() {
        stopColorSchemeChangeDetector();
        removeDocumentVisibilityListener();
    }
    function sendMessage(message) {
        const responseHandler = (response) => {
            if (response === "unsupportedSender") {
                cleanup();
            }
        };
        try {
            const promise = chrome.runtime.sendMessage(message);
            promise.then(responseHandler).catch(cleanup);
        } catch (error) {
            if (error.message === "Extension context invalidated.") {
                console.log(
                    "Dark Reader: instance of old CS detected, cleaning up."
                );
                cleanup();
            } else {
                console.log(
                    "Dark Reader: unexpected error during message passing."
                );
            }
        }
    }
    function notifyOfColorScheme(isDark) {
        sendMessage({
            type: MessageTypeCStoBG.COLOR_SCHEME_CHANGE,
            data: {isDark}
        });
    }
    function updateEventListeners() {
        notifyOfColorScheme(isSystemDarkModeEnabled());
        if (documentIsVisible()) {
            runColorSchemeChangeDetector(notifyOfColorScheme);
        } else {
            stopColorSchemeChangeDetector();
        }
    }
    setDocumentVisibilityListener(updateEventListeners);
    updateEventListeners();
})();
