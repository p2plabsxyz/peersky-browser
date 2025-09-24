(function () {
    "use strict";

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

    function logInfo(...args) {}

    function injectProxy(
        enableStyleSheetsProxy,
        enableCustomElementRegistryProxy
    ) {
        document.dispatchEvent(
            new CustomEvent("__darkreader__inlineScriptsAllowed")
        );
        const cleaners = [];
        function cleanUp() {
            cleaners.forEach((clean) => clean());
            cleaners.splice(0);
        }
        function documentEventListener(type, listener, options) {
            document.addEventListener(type, listener, options);
            cleaners.push(() => document.removeEventListener(type, listener));
        }
        function disableConflictingPlugins() {
            const disableWPDarkMode = () => {
                if (window?.WPDarkMode?.deactivate) {
                    window.WPDarkMode.deactivate();
                }
            };
            disableWPDarkMode();
        }
        documentEventListener("__darkreader__cleanUp", cleanUp);
        documentEventListener(
            "__darkreader__disableConflictingPlugins",
            disableConflictingPlugins
        );
        function overrideProperty(cls, prop, overrides) {
            const proto = cls.prototype;
            const oldDescriptor = Object.getOwnPropertyDescriptor(proto, prop);
            if (!oldDescriptor) {
                return;
            }
            const newDescriptor = {...oldDescriptor};
            Object.keys(overrides).forEach((key) => {
                const factory = overrides[key];
                newDescriptor[key] = factory(oldDescriptor[key]);
            });
            Object.defineProperty(proto, prop, newDescriptor);
            cleaners.push(() =>
                Object.defineProperty(proto, prop, oldDescriptor)
            );
        }
        function override(cls, prop, factory) {
            overrideProperty(cls, prop, {value: factory});
        }
        function isDRElement(element) {
            return element?.classList?.contains("darkreader");
        }
        function isDRSheet(sheet) {
            return isDRElement(sheet.ownerNode);
        }
        const updateSheetEvent = new CustomEvent("__darkreader__updateSheet");
        const adoptedSheetChangeEvent = new CustomEvent(
            "__darkreader__adoptedStyleSheetChange"
        );
        const shadowDomAttachingEvent = new CustomEvent(
            "__darkreader__shadowDomAttaching",
            {bubbles: true}
        );
        const adoptedSheetOwners = new WeakMap();
        const adoptedDeclarationSheets = new WeakMap();
        function onAdoptedSheetChange(sheet) {
            const owners = adoptedSheetOwners.get(sheet);
            owners?.forEach((node) => {
                if (node.isConnected) {
                    node.dispatchEvent(adoptedSheetChangeEvent);
                } else {
                    owners.delete(node);
                }
            });
        }
        function reportSheetChange(sheet) {
            if (sheet.ownerNode && !isDRSheet(sheet)) {
                sheet.ownerNode.dispatchEvent(updateSheetEvent);
            }
            if (adoptedSheetOwners.has(sheet)) {
                onAdoptedSheetChange(sheet);
            }
        }
        function reportSheetChangeAsync(sheet, promise) {
            const {ownerNode} = sheet;
            if (
                ownerNode &&
                !isDRSheet(sheet) &&
                promise &&
                promise instanceof Promise
            ) {
                promise.then(() => ownerNode.dispatchEvent(updateSheetEvent));
            }
            if (adoptedSheetOwners.has(sheet)) {
                if (promise && promise instanceof Promise) {
                    promise.then(() => onAdoptedSheetChange(sheet));
                }
            }
        }
        override(
            CSSStyleSheet,
            "addRule",
            (native) =>
                function (selector, style, index) {
                    native.call(this, selector, style, index);
                    reportSheetChange(this);
                    return -1;
                }
        );
        override(
            CSSStyleSheet,
            "insertRule",
            (native) =>
                function (rule, index) {
                    const returnValue = native.call(this, rule, index);
                    reportSheetChange(this);
                    return returnValue;
                }
        );
        override(
            CSSStyleSheet,
            "deleteRule",
            (native) =>
                function (index) {
                    native.call(this, index);
                    reportSheetChange(this);
                }
        );
        override(
            CSSStyleSheet,
            "removeRule",
            (native) =>
                function (index) {
                    native.call(this, index);
                    reportSheetChange(this);
                }
        );
        override(
            CSSStyleSheet,
            "replace",
            (native) =>
                function (cssText) {
                    const returnValue = native.call(this, cssText);
                    reportSheetChangeAsync(this, returnValue);
                    return returnValue;
                }
        );
        override(
            CSSStyleSheet,
            "replaceSync",
            (native) =>
                function (cssText) {
                    native.call(this, cssText);
                    reportSheetChange(this);
                }
        );
        override(
            Element,
            "attachShadow",
            (native) =>
                function (options) {
                    this.dispatchEvent(shadowDomAttachingEvent);
                    return native.call(this, options);
                }
        );
        const shouldWrapHTMLElement =
            location.hostname === "baidu.com" ||
            location.hostname.endsWith(".baidu.com");
        if (shouldWrapHTMLElement) {
            override(
                Element,
                "getElementsByTagName",
                (native) =>
                    function (tagName) {
                        if (tagName !== "style") {
                            return native.call(this, tagName);
                        }
                        const getCurrentElementValue = () => {
                            const elements = native.call(this, tagName);
                            return Object.setPrototypeOf(
                                [...elements].filter(
                                    (element) =>
                                        element && !isDRElement(element)
                                ),
                                NodeList.prototype
                            );
                        };
                        let elements = getCurrentElementValue();
                        const nodeListBehavior = {
                            get: function (_, property) {
                                return getCurrentElementValue()[
                                    Number(property) || property
                                ];
                            }
                        };
                        elements = new Proxy(elements, nodeListBehavior);
                        return elements;
                    }
            );
        }
        const shouldProxyChildNodes = ["brilliant.org", "www.vy.no"].includes(
            location.hostname
        );
        if (shouldProxyChildNodes) {
            overrideProperty(Node, "childNodes", {
                get: (native) =>
                    function () {
                        const childNodes = native.call(this);
                        return Object.setPrototypeOf(
                            [...childNodes].filter((element) => {
                                return !isDRElement(element);
                            }),
                            NodeList.prototype
                        );
                    }
            });
        }
        function resolveCustomElement(tag) {
            customElements.whenDefined(tag).then(() => {
                document.dispatchEvent(
                    new CustomEvent("__darkreader__isDefined", {detail: {tag}})
                );
            });
        }
        documentEventListener("__darkreader__addUndefinedResolver", (e) =>
            resolveCustomElement(e.detail.tag)
        );
        if (enableCustomElementRegistryProxy) {
            override(
                CustomElementRegistry,
                "define",
                (native) =>
                    function (name, constructor, options) {
                        resolveCustomElement(name);
                        native.call(this, name, constructor, options);
                    }
            );
        }
        let blobURLAllowed = null;
        function checkBlobURLSupport() {
            if (blobURLAllowed != null) {
                document.dispatchEvent(
                    new CustomEvent("__darkreader__blobURLCheckResponse", {
                        detail: {blobURLAllowed}
                    })
                );
                return;
            }
            const svg =
                '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="transparent"/></svg>';
            const bytes = new Uint8Array(svg.length);
            for (let i = 0; i < svg.length; i++) {
                bytes[i] = svg.charCodeAt(i);
            }
            const blob = new Blob([bytes], {type: "image/svg+xml"});
            const objectURL = URL.createObjectURL(blob);
            const image = new Image();
            image.onload = () => {
                blobURLAllowed = true;
                sendBlobURLCheckResponse();
            };
            image.onerror = () => {
                blobURLAllowed = false;
                sendBlobURLCheckResponse();
            };
            image.src = objectURL;
        }
        function sendBlobURLCheckResponse() {
            document.dispatchEvent(
                new CustomEvent("__darkreader__blobURLCheckResponse", {
                    detail: {blobURLAllowed}
                })
            );
        }
        documentEventListener(
            "__darkreader__blobURLCheckRequest",
            checkBlobURLSupport
        );
        if (enableStyleSheetsProxy) {
            overrideProperty(Document, "styleSheets", {
                get: (native) =>
                    function () {
                        const getCurrentValue = () => {
                            const docSheets = native.call(this);
                            const filteredSheets = [...docSheets].filter(
                                (styleSheet) =>
                                    styleSheet.ownerNode &&
                                    !isDRSheet(styleSheet)
                            );
                            filteredSheets.item = (item) =>
                                filteredSheets[item];
                            return Object.setPrototypeOf(
                                filteredSheets,
                                StyleSheetList.prototype
                            );
                        };
                        let elements = getCurrentValue();
                        const styleSheetListBehavior = {
                            get: function (_, property) {
                                return getCurrentValue()[property];
                            }
                        };
                        elements = new Proxy(elements, styleSheetListBehavior);
                        return elements;
                    }
            });
        }
        {
            const adoptedSheetsSourceProxies = new WeakMap();
            const adoptedSheetsProxySources = new WeakMap();
            const adoptedSheetsChangeEvent = new CustomEvent(
                "__darkreader__adoptedStyleSheetsChange"
            );
            const adoptedSheetOverrideCache = new WeakSet();
            const adoptedSheetsSnapshots = new WeakMap();
            const isDRAdoptedSheetOverride = (sheet) => {
                if (!sheet || !sheet.cssRules) {
                    return false;
                }
                if (adoptedSheetOverrideCache.has(sheet)) {
                    return true;
                }
                if (
                    sheet.cssRules.length > 0 &&
                    sheet.cssRules[0].cssText.startsWith(
                        "#__darkreader__adoptedOverride"
                    )
                ) {
                    adoptedSheetOverrideCache.add(sheet);
                    return true;
                }
                return false;
            };
            const areArraysEqual = (a, b) => {
                return a.length === b.length && a.every((x, i) => x === b[i]);
            };
            const onAdoptedSheetsChange = (node) => {
                const prev = adoptedSheetsSnapshots.get(node);
                const curr = (node.adoptedStyleSheets || []).filter(
                    (s) => !isDRAdoptedSheetOverride(s)
                );
                adoptedSheetsSnapshots.set(node, curr);
                if (!prev || !areArraysEqual(prev, curr)) {
                    curr.forEach((sheet) => {
                        if (!adoptedSheetOwners.has(sheet)) {
                            adoptedSheetOwners.set(sheet, new Set());
                        }
                        adoptedSheetOwners.get(sheet).add(node);
                        for (const rule of sheet.cssRules) {
                            const declaration = rule.style;
                            if (declaration) {
                                adoptedDeclarationSheets.set(
                                    declaration,
                                    sheet
                                );
                            }
                        }
                    });
                    node.dispatchEvent(adoptedSheetsChangeEvent);
                }
            };
            const proxyAdoptedSheetsArray = (node, source) => {
                if (adoptedSheetsProxySources.has(source)) {
                    return source;
                }
                if (adoptedSheetsSourceProxies.has(source)) {
                    return adoptedSheetsSourceProxies.get(source);
                }
                const proxy = new Proxy(source, {
                    deleteProperty(target, property) {
                        delete target[property];
                        return true;
                    },
                    set(target, property, value) {
                        target[property] = value;
                        if (property === "length") {
                            onAdoptedSheetsChange(node);
                        }
                        return true;
                    }
                });
                adoptedSheetsSourceProxies.set(source, proxy);
                adoptedSheetsProxySources.set(proxy, source);
                return proxy;
            };
            [Document, ShadowRoot].forEach((ctor) => {
                overrideProperty(ctor, "adoptedStyleSheets", {
                    get: (native) =>
                        function () {
                            const source = native.call(this);
                            return proxyAdoptedSheetsArray(this, source);
                        },
                    set: (native) =>
                        function (source) {
                            if (adoptedSheetsProxySources.has(source)) {
                                source = adoptedSheetsProxySources.get(source);
                            }
                            native.call(this, source);
                            onAdoptedSheetsChange(this);
                        }
                });
            });
            const adoptedDeclarationChangeEvent = new CustomEvent(
                "__darkreader__adoptedStyleDeclarationChange"
            );
            ["setProperty", "removeProperty"].forEach((key) => {
                override(CSSStyleDeclaration, key, (native) => {
                    return function (...args) {
                        const returnValue = native.apply(this, args);
                        const sheet = adoptedDeclarationSheets.get(this);
                        if (sheet) {
                            const owners = adoptedSheetOwners.get(sheet);
                            if (owners) {
                                owners.forEach((node) => {
                                    node.dispatchEvent(
                                        adoptedDeclarationChangeEvent
                                    );
                                });
                            }
                        }
                        return returnValue;
                    };
                });
            });
        }
    }

    document.currentScript && document.currentScript.remove();
    const key = "darkreaderProxyInjected";
    const EVENT_DONE = "__darkreader__stylesheetProxy__done";
    const EVENT_ARG = "__darkreader__stylesheetProxy__arg";
    const registeredScriptPath = !document.currentScript;
    function injectProxyAndCleanup(args) {
        injectProxy(
            args.enableStyleSheetsProxy,
            args.enableCustomElementRegistryProxy
        );
        doneReceiver();
        document.dispatchEvent(new CustomEvent(EVENT_DONE));
    }
    function regularPath() {
        const argString = document.currentScript.dataset.arg;
        if (argString !== undefined) {
            document.documentElement.dataset[key] = "true";
            const args = JSON.parse(argString);
            injectProxyAndCleanup(args);
        }
    }
    function dataReceiver(e) {
        document.removeEventListener(EVENT_ARG, dataReceiver);
        if (document.documentElement.dataset[key] !== undefined) {
            return;
        }
        document.documentElement.dataset[key] = "true";
        logInfo(
            `MV3 proxy injector: ${registeredScriptPath ? "registered" : "dedicated"} path runs injectProxy(${e.detail}).`
        );
        injectProxyAndCleanup(e.detail);
    }
    function doneReceiver() {
        document.removeEventListener(EVENT_ARG, dataReceiver);
        document.removeEventListener(EVENT_DONE, doneReceiver);
    }
    function dedicatedPath() {
        const listenerOptions = {
            passive: true,
            once: true
        };
        document.addEventListener(EVENT_ARG, dataReceiver, listenerOptions);
        document.addEventListener(EVENT_DONE, doneReceiver, listenerOptions);
    }
    function inject() {
        if (document.documentElement.dataset[key] !== undefined) {
            return;
        }
        document.currentScript && regularPath();
        dedicatedPath();
    }
    inject();
})();
