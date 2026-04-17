/*
 *  Auto Background — SillyTavern Extension
 *  Detects scene/location changes and auto-generates a background image.
 *  Requires the Image Generation extension to be configured.
 */

var MODULE = "auto-background";

var DEFAULT_DETECTION =
    "Task: Determine if the characters moved to a completely DIFFERENT physical location based ONLY on the text below.\n" +
    "Ignore mere conversations about places, time of day changes, or weather. Look for actual physical movement (e.g., entered a new building, traveled to a new city, teleported).\n\n" +
    "Text to analyze:\n\"{{text}}\"\n\n" +
    "Did the physical location change? Answer with EXACTLY one word: YES or NO.";

var DEFAULTS = {
    enabled:         false,
    cooldownSec:     120,
    minMessages:     4,
    detectionPrompt: DEFAULT_DETECTION,
    notifyUser:      true,
    genOnChatStart:  true,
    startDelaySec:   3,
    silentMode:      false
};

/* ── state ── */
var settings     = null;
var extSettings  = null;
var saveFn       = null;
var genQuiet     = null;
var getCtx       = null;
var eventSrc     = null;
var evtTypes     = null;
var executeSlash = null;
var scriptRef    = null;

var checking       = false;
var lastGenTime    = 0;
var chatStartTimer = null;

function L() { console.log.apply(console,  ["[AutoBG]"].concat(Array.from(arguments))); }
function W() { console.warn.apply(console,  ["[AutoBG]"].concat(Array.from(arguments))); }
function E() { console.error.apply(console, ["[AutoBG]"].concat(Array.from(arguments))); }

L("File loaded");

/* ═════════════════ BOOTSTRAP ═════════════════ */

jQuery(function () {
    L("jQuery ready");
    initAll();
});

async function initAll() {
    try {
        await loadModules();
        loadSettings();
        buildPanel();
        hookEvents();
        L("Fully loaded!");
    } catch (e) {
        E("Init error:", e);
    }
}

async function loadModules() {
    try {
        var m = await import("../../../extensions.js");
        extSettings = m.extension_settings;
        saveFn      = m.saveSettingsDebounced;
        getCtx      = m.getContext;
        L("extensions.js OK");
    } catch (e) { W("extensions.js:", e.message); }

    try {
        scriptRef = await import("../../../../script.js");
        if (typeof scriptRef.generateQuietPrompt === "function")
            genQuiet = scriptRef.generateQuietPrompt;
        if (scriptRef.eventSource)  eventSrc = scriptRef.eventSource;
        if (scriptRef.event_types)  evtTypes = scriptRef.event_types;
        L("script.js OK | quiet:", !!genQuiet, "| events:", !!eventSrc);
    } catch (e) { W("script.js:", e.message); }

    try {
        var sl = await import("../../../slash-commands.js");
        if (typeof sl.executeSlashCommands === "function")
            executeSlash = sl.executeSlashCommands;
        L("slash-commands.js OK");
    } catch (e) { W("slash-commands:", e.message); }
}

function loadSettings() {
    if (extSettings) {
        if (!extSettings[MODULE]) extSettings[MODULE] = {};
        var keys = Object.keys(DEFAULTS);
        for (var i = 0; i < keys.length; i++) {
            if (extSettings[MODULE][keys[i]] === undefined)
                extSettings[MODULE][keys[i]] = DEFAULTS[keys[i]];
        }
        settings = extSettings[MODULE];
    } else {
        settings = {};
        Object.keys(DEFAULTS).forEach(function (k) { settings[k] = DEFAULTS[k]; });
    }
    L("Settings OK, enabled:", settings.enabled);
}

function save() { if (saveFn) saveFn(); }

/* ═════════════════ EVENT HOOKS ═════════════════ */

function hookEvents() {
    if (!eventSrc || !evtTypes) {
        W("Event system unavailable — auto-detection disabled");
        return;
    }

    var msgEvent = evtTypes.MESSAGE_RECEIVED || "messageReceived";
    eventSrc.on(msgEvent, onMessage);
    L("Hooked:", msgEvent);

    var chatEvent = evtTypes.CHAT_CHANGED || "chatChanged";
    eventSrc.on(chatEvent, function () {
        lastGenTime = 0;
        checking = false;

        // Clear the background message-hiding process when the chat changes
        if (typeof window._autoBgSilentCleanup === "function") {
            L("Chat changed — aborting silent mode intercept");
            window._autoBgSilentCleanup();
        }

        if (chatStartTimer) {
            clearTimeout(chatStartTimer);
            chatStartTimer = null;
        }

        L("Chat changed — state reset");

        if (settings.enabled && settings.genOnChatStart) {
            var delay = (settings.startDelaySec || 3) * 1000;
            L("Will generate start background in", delay / 1000, "s");

            chatStartTimer = setTimeout(function () {
                chatStartTimer = null;
                generateForChatStart();
            }, delay);
        }
    });
}

/* ─── generate background when chat opens ─── */

async function generateForChatStart() {
    if (!settings.enabled || !settings.genOnChatStart) return;
    if (checking) return;

    var ctx = getCtx ? getCtx() : null;
    if (!ctx || !ctx.chat || ctx.chat.length === 0) return;

    if (ctx.chat.length > 1) {
        L("Existing chat (" + ctx.chat.length + " msgs) — skipping start generation");
        return;
    }

    L("New chat detected (1 message), generating background...");
    setStatus("New chat — generating background...");

    if (settings.notifyUser && typeof toastr !== "undefined") {
        toastr.info("Generating background for new scene...", "Auto Background");
    }

    lastGenTime = Date.now();

    try {
        await triggerBackground();
        setStatus("Background generated ✓");
    } catch (e) {
        E("Chat start generation error:", e);
        setStatus("Error: " + e.message);
    }
}

/* ═════════════════ MESSAGE HANDLER ═════════════════ */

async function onMessage(msgIndex) {
    if (!settings.enabled || checking) return;

    if (window._autoBgSilentGenerating) return;
    if (scriptRef && scriptRef.is_send_press) return;

    var ctx = getCtx ? getCtx() : null;
    if (!ctx || !ctx.chat) return;

    var chat = ctx.chat;
    var msg  = (typeof msgIndex === "number") ? chat[msgIndex] : chat[chat.length - 1];
    if (!msg || msg.is_user || msg.is_system) return;

    if (chat.length < settings.minMessages) return;

    var now = Date.now();
    var elapsed = now - lastGenTime;
    if (elapsed < settings.cooldownSec * 1000) {
        L("Cooldown:", Math.round((settings.cooldownSec * 1000 - elapsed) / 1000) + "s left");
        return;
    }

    checking = true;
    setStatus("Checking for scene change...");

    try {
        var msgText = msg.mes || "";
        var changed = await detectChange(msgText);
        L("Scene changed:", changed);

        if (changed) {
            lastGenTime = Date.now();
            setStatus("Scene change detected! Generating...");
            if (settings.notifyUser && typeof toastr !== "undefined")
                toastr.info("Scene change detected — generating background...", "Auto Background");
            await triggerBackground();
            setStatus("Background generated ✓");
        } else {
            setStatus("Monitoring (scene unchanged)");
        }
    } catch (e) {
        E("Detection error:", e);
        setStatus("Error: " + e.message);
    }

    checking = false;
}

/* ═════════════════ SCENE DETECTION ═════════════════ */

async function detectChange(msgText) {
    if (!genQuiet) throw new Error("generateQuietPrompt unavailable");

    var cleanText = msgText.replace(/<[^>]*>?/gm, '').trim();
    if (!cleanText) return false;

    var promptStr = settings.detectionPrompt;

    if (promptStr.includes("{{text}}")) {
        promptStr = promptStr.replace("{{text}}", cleanText);
    } else {
        promptStr = promptStr + "\n\nAnalyze this text:\n\"" + cleanText + "\"";
    }

    var raw = await genQuiet(promptStr);
    var answer = raw.trim().toUpperCase();

    L("LLM says:", JSON.stringify(raw.trim()));

    var match = answer.match(/[A-Z]+/);
    var firstWord = match ? match[0] : "";

    return firstWord === "YES";
}

/* ═════════════════ TRIGGER BACKGROUND ═════════════════ */

async function triggerBackground() {
    L("Triggering background generation...");

    if (settings.silentMode) {
        await triggerBackgroundSilent();
        return;
    }

    var success = await triggerGenCommands();
    if (!success) {
        var errMsg = "Cannot trigger background generation. Is Image Generation extension configured?";
        E(errMsg);
        if (typeof toastr !== "undefined") toastr.error(errMsg, "Auto Background");
    }
}

async function triggerGenCommands() {
    var btn = findBgButton();
    if (btn) {
        L("Found button, clicking");
        $(btn).trigger("click");
        return true;
    }

    if (executeSlash) {
        var cmds = [
            "/sd type=background",
            "/imagine type=background",
            "/img type=background"
        ];
        for (var i = 0; i < cmds.length; i++) {
            try {
                L("Trying:", cmds[i]);
                await executeSlash(cmds[i]);
                L("Command OK:", cmds[i]);
                return true;
            } catch (e) {
                W("Command failed:", cmds[i]);
            }
        }
    }
    return false;
}

/* ═════════════════════════════════════════════════════════════════
   SILENT MODE (REFACTORED WITH POLLING)
   ════════════════════════════════════════════════════════════════ */

async function triggerBackgroundSilent() {
    L("Silent mode: arming intercept...");
    window._autoBgSilentGenerating = true;

    var ctx = getCtx ? getCtx() : null;
    if (!ctx || !ctx.chat) {
        await triggerGenCommands();
        return;
    }

    var chatArrayRef = ctx.chat;
    var chatLenBefore = ctx.chat.length;

    var interceptDone = false;
    var guardTimer = null;
    var checkInterval = null;

    function cleanup() {
        if (interceptDone) return;
        interceptDone = true;
        if (guardTimer) clearTimeout(guardTimer);
        if (checkInterval) clearInterval(checkInterval);
        window._autoBgSilentGenerating = false;
        window._autoBgSilentCleanup = null;
    }
    window._autoBgSilentCleanup = cleanup;

    /* Instead of unreliable event listeners, use a stable local interval
       that monitors the chat array for a new SD system message */
    checkInterval = setInterval(function() {
        var ctx2 = getCtx ? getCtx() : null;
        
        // If the user switched to a different chat — cancel hiding
        if (!ctx2 || ctx2.chat !== chatArrayRef) {
            cleanup();
            return;
        }

        // Wait until a new message appears in the array
        if (ctx2.chat.length > chatLenBefore) {
            for (var idx = chatLenBefore; idx < ctx2.chat.length; idx++) {
                var msg = ctx2.chat[idx];
                if (!msg) continue;

                var textStr = typeof msg.mes === "string" ? msg.mes : "";
                
                // Check: is this a system message? Does it contain an image or background generation tags?
                var isSystem = msg.is_system === true;
                var hasImgText = textStr.indexOf("<img") !== -1 || textStr.indexOf("![") !== -1;
                var hasExtraImg = msg.extra && (msg.extra.image || msg.extra.inline_image);
                
                if (isSystem || hasImgText || hasExtraImg) {
                    L("Silent: Caught background message at index", idx);
                    cleanup();
                    removeSilentMessage(chatArrayRef, idx);
                    return;
                }
            }
        }
    }, 250);

    /* Maximum wait time for a generator response (30 seconds) */
    guardTimer = setTimeout(function () {
        if (!interceptDone) {
            L("Silent: guard timeout (30s), cleaning up");
            cleanup();
        }
    }, 360000);

    // Kick off the actual generation
    var success = await triggerGenCommands();
    if (!success) {
        cleanup();
        var errMsg = "Cannot trigger background generation. Is Image Generation extension configured?";
        E(errMsg);
        if (typeof toastr !== "undefined") toastr.error(errMsg, "Auto Background");
    }
}

/* ── Remove the BG message from ctx.chat + DOM ── */
function removeSilentMessage(chatArrayRef, removeIdx) {
    var ctx2 = getCtx ? getCtx() : null;
    if (!ctx2 || ctx2.chat !== chatArrayRef) return;
    if (removeIdx >= ctx2.chat.length) return;

    // First remove the element from the HTML page
    $("#chat .mes").each(function () {
        if (parseInt($(this).attr("mesid"), 10) === removeIdx) {
            $(this).remove();
            return false; // Break $.each
        }
    });

    // Then splice the message out of the chat array
    ctx2.chat.splice(removeIdx, 1);

    // Rewrite mesid indices in the DOM so the chat does not break
    $("#chat .mes").each(function (i) {
        $(this).attr("mesid", i);
    });

    // Persist the clean chat
    if (scriptRef && typeof scriptRef.saveChatConditional === "function") {
        scriptRef.saveChatConditional();
    } else if (executeSlash) {
        try { executeSlash("/save"); } catch (e) { /* ignore */ }
    }

    L("Silent: BG message removed ✓");
}

/* ═════════════════ FIND BG BUTTON ═════════════════ */

function findBgButton() {
    var ids = ["sd_gen_background", "sd_background", "sd_background_gen", "sd_bg"];
    for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (el) return el;
    }

    var found = null;
    var containers = document.querySelectorAll('[id*="sd"], #extensionsMenuHolder, #extensionsMenu');
    for (var c = 0; c < containers.length; c++) {
        var items = containers[c].querySelectorAll(".list-group-item, div");
        for (var j = 0; j < items.length; j++) {
            if (items[j].textContent.trim() === "Background" && items[j].children.length === 0) {
                found = items[j];
                break;
            }
        }
        if (found) break;
    }

    if (!found) {
        var allItems = document.querySelectorAll(".list-group-item");
        for (var k = 0; k < allItems.length; k++) {
            if (allItems[k].textContent.trim() === "Background" && allItems[k].children.length === 0) {
                found = allItems[k];
                break;
            }
        }
    }

    return found;
}

/* ═════════════════ SETTINGS UI ═════════════════ */

function buildPanel() {
    var $c = $("#extensions_settings2");
    if (!$c.length) $c = $("#extensions_settings");
    if (!$c.length) { W("No settings container"); return; }

    var h = '';
    h += '<div id="abg-settings">';
    h += '<div class="inline-drawer">';
    h += '<div class="inline-drawer-toggle inline-drawer-header">';
    h += '<b><i class="fa-solid fa-panorama"></i> Auto Background</b>';
    h += '<div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>';
    h += '</div>';
    h += '<div class="inline-drawer-content">';

    h += '<div class="abg-row"><label class="checkbox_label">';
    h += '<input type="checkbox" id="abg-on">';
    h += '<span>Enable auto background generation</span>';
    h += '</label></div>';

    h += '<div class="abg-row"><label class="checkbox_label">';
    h += '<input type="checkbox" id="abg-chatstart">';
    h += '<span>Generate background when opening a chat</span>';
    h += '</label></div>';

    h += '<div class="abg-row" id="abg-delay-row">';
    h += '<label><small>Delay before start generation: ';
    h += '<b><span id="abg-dl-v">3</span>s</b></small></label>';
    h += '<input type="range" id="abg-dl" min="1" max="10" step="1">';
    h += '</div>';

    h += '<div class="abg-row"><label class="checkbox_label">';
    h += '<input type="checkbox" id="abg-notify">';
    h += '<span>Show notifications</span>';
    h += '</label></div>';

    h += '<div class="abg-row"><label class="checkbox_label">';
    h += '<input type="checkbox" id="abg-silent">';
    h += '<span>Silent mode — do not leave a message in chat after generation</span>';
    h += '</label></div>';
    h += '<small class="abg-hint"><i class="fa-solid fa-triangle-exclamation"></i> ';
    h += 'Silent mode removes the generated image message from chat so other extensions do not react to it. ';
    h += 'The background is still applied normally.</small>';

    h += '<div class="abg-row">';
    h += '<label><small>Cooldown between generations: ';
    h += '<b><span id="abg-cd-v">120</span>s</b></small></label>';
    h += '<input type="range" id="abg-cd" min="30" max="600" step="10">';
    h += '</div>';

    h += '<div class="abg-row">';
    h += '<label><small>Min messages before scene checks: ';
    h += '<b><span id="abg-mm-v">4</span></b></small></label>';
    h += '<input type="range" id="abg-mm" min="2" max="30" step="1">';
    h += '</div>';

    h += '<hr>';

    h += '<div class="abg-row">';
    h += '<label><small>Scene change detection prompt:</small></label>';
    h += '<textarea id="abg-prompt" class="text_pole textarea_compact" rows="5"></textarea>';
    h += '</div>';

    h += '<div class="abg-row abg-btns">';
    h += '<input id="abg-reset" class="menu_button" type="button" value="Reset prompt">';
    h += '<input id="abg-test"  class="menu_button" type="button" value="&#x1F50D; Test detection">';
    h += '<input id="abg-gen"   class="menu_button" type="button" value="&#x1F5BC; Generate now">';
    h += '</div>';

    h += '<div class="abg-row">';
    h += '<small id="abg-status" class="abg-status">Status: idle</small>';
    h += '</div>';

    h += '<hr>';
    h += '<small class="abg-hint">';
    h += '<i class="fa-solid fa-circle-info"></i> ';
    h += 'Requires <b>Image Generation</b> extension to be configured. ';
    h += 'Each scene check uses one small LLM call. ';
    h += 'Disabled by default to avoid unexpected API costs.';
    h += '</small>';

    h += '</div></div></div>';

    $c.append(h);

    $("#abg-on").prop("checked", settings.enabled).on("change", function () {
        settings.enabled = this.checked; save();
        setStatus(this.checked ? "Enabled — monitoring" : "Disabled");
    });

    $("#abg-chatstart").prop("checked", settings.genOnChatStart).on("change", function () {
        settings.genOnChatStart = this.checked; save();
        $("#abg-delay-row").toggle(this.checked);
    });
    $("#abg-delay-row").toggle(settings.genOnChatStart);

    $("#abg-dl").val(settings.startDelaySec).on("input", function () {
        settings.startDelaySec = parseInt(this.value, 10);
        $("#abg-dl-v").text(this.value); save();
    });
    $("#abg-dl-v").text(settings.startDelaySec);

    $("#abg-notify").prop("checked", settings.notifyUser).on("change", function () {
        settings.notifyUser = this.checked; save();
    });

    $("#abg-silent").prop("checked", settings.silentMode).on("change", function () {
        settings.silentMode = this.checked; save();
        L("Silent mode:", settings.silentMode);
    });

    $("#abg-cd").val(settings.cooldownSec).on("input", function () {
        settings.cooldownSec = parseInt(this.value, 10);
        $("#abg-cd-v").text(this.value); save();
    });
    $("#abg-cd-v").text(settings.cooldownSec);

    $("#abg-mm").val(settings.minMessages).on("input", function () {
        settings.minMessages = parseInt(this.value, 10);
        $("#abg-mm-v").text(this.value); save();
    });
    $("#abg-mm-v").text(settings.minMessages);

    $("#abg-prompt").val(settings.detectionPrompt).on("input", function () {
        settings.detectionPrompt = this.value; save();
    });

    $("#abg-reset").on("click", function () {
        settings.detectionPrompt = DEFAULT_DETECTION;
        $("#abg-prompt").val(DEFAULT_DETECTION); save();
        if (typeof toastr !== "undefined") toastr.info("Prompt reset.");
    });

    $("#abg-test").on("click", async function () {
        if (checking) return;
        if (!genQuiet) {
            if (typeof toastr !== "undefined") toastr.error("API not connected");
            return;
        }
        checking = true;
        setStatus("Testing detection...");
        $(this).prop("disabled", true);
        try {
            var changed = await detectChange("The knight opens the heavy oak door and steps into the bustling marketplace.");
            var msg = changed
                ? "YES — scene changed (would generate background)"
                : "NO — scene is the same (no action)";
            setStatus("Test result: " + msg);
            if (typeof toastr !== "undefined")
                toastr.info(msg, "Auto Background — Test");
        } catch (e) {
            setStatus("Test error: " + e.message);
            E(e);
        }
        checking = false;
        $(this).prop("disabled", false);
    });

    $("#abg-gen").on("click", async function () {
        setStatus("Manual generation triggered...");
        $(this).prop("disabled", true);
        try {
            await triggerBackground();
            setStatus("Background generation triggered ✓");
            lastGenTime = Date.now();
        } catch (e) {
            setStatus("Error: " + e.message);
        }
        $(this).prop("disabled", false);
    });

    setStatus(settings.enabled ? "Enabled — monitoring" : "Disabled");
    L("Panel OK");
}

function setStatus(msg) {
    $("#abg-status").text("Status: " + msg);
}