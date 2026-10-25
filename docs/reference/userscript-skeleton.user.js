// Verbatim copy of the user-supplied skeleton ("gats.io Community Login + Presence (skeleton)"), shared by fifth-1.
// ==UserScript==
// @name         gats.io Community Login + Presence (skeleton)
// @namespace    https://gats.io/
// @version      2.0-skeleton
// @description  Stable helpers only. Backend wiring and UI removed.
// @match        https://gats.io/*
// @connect      login-info-handler.gitgames.workers.dev
// @license     MIT
// @grant        none
// @run-at       document-start
// ==/UserScript==

// ============================================================================
// MODULE 1 — auth_ui
// Keeps: token storage, generic fetch wrapper, modal open/close, escapeHtml,
//        the window.gclAuth surface other modules depend on.
// ============================================================================

(function auth_ui() {
    'use strict';

    const WORKER_URL = 'https://login-info-handler.gitgames.workers.dev';
    const STORAGE_KEY = 'gcl_session_token';
    const STORAGE_EXPIRES_KEY = 'gcl_session_expires';

    // ---- state ----------------------------------------------------------
    let currentUser = null; // { username } once logged in
    let currentToken = null;

    // [HELPER] session storage ---------------------------------------------
    function saveSession(token, expiresAt) {
        localStorage.setItem(STORAGE_KEY, token);
        localStorage.setItem(STORAGE_EXPIRES_KEY, String(expiresAt));
    }

    function clearSession() {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(STORAGE_EXPIRES_KEY);
    }

    function getStoredToken() {
        const token = localStorage.getItem(STORAGE_KEY);
        const expiresAt = Number(localStorage.getItem(STORAGE_EXPIRES_KEY));
        if (!token || !expiresAt || Date.now() >= expiresAt) {
            return null;
        }
        return token;
    }

    // [HELPER] generic worker call -----------------------------------------
    async function apiCall(path, { method = 'POST', token = null, body = null } = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;

        const res = await fetch(WORKER_URL + path, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });

        let data = {};
        try {
            data = await res.json();
        } catch (e) {
            // non-JSON response, leave data empty
        }
        return { status: res.status, data };
    }

    // [HELPER] login state check -------------------------------------------
    function isLoggedIn() {
        return !!currentToken;
    }

    // [HELPER] HTML escaping -----------------------------------------------
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // [HELPER] modal shell (expects #gcl-modal-overlay / #gcl-modal CSS) ----
    function closeModal() {
        const overlay = document.getElementById('gcl-modal-overlay');
        if (overlay) overlay.remove();
    }

    function openModal(innerHTML) {
        closeModal();
        const overlay = document.createElement('div');
        overlay.id = 'gcl-modal-overlay';
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal();
        });

        const modal = document.createElement('div');
        modal.id = 'gcl-modal';
        modal.innerHTML = `<button class="gcl-close" data-close>&times;</button>` + innerHTML;
        modal.querySelector('[data-close]').addEventListener('click', closeModal);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        return modal;
    }

    // ---- PLUG-IN POINTS (removed, to be rewritten for the new backend) ----
    // [PLUG-IN] STYLE + injectStyle()
    // [PLUG-IN] status badge: ensureBadge(), updateBadge()
    // [PLUG-IN] api wrappers: apiLogin, apiSignup, apiVerify, apiLogout, apiUnregister
    // [PLUG-IN] modals: showLoginModal, showRegisterModal, showAccountModal, setupSwipeConfirm
    // [PLUG-IN] session lifecycle: onLoginSuccess, performLogout, tryAutoLogin
    //           (must set currentUser/currentToken, call saveSession/clearSession,
    //            and dispatch 'gcl:login' / 'gcl:logout' / 'gcl:unregistered')
    // [PLUG-IN] init()

    // [HELPER] public surface used by the other modules ---------------------
    window.gclAuth = {
        isLoggedIn,
        getUser: () => currentUser,
        getToken: () => currentToken,
        // logout: assign performLogout here once it exists
    };
})();

// ============================================================================
// MODULE 2 — ws_hook (WebSocket tap only). UNCHANGED.
// ============================================================================

(function ws_hook() {
    'use strict';

    const RealWebSocket = window.WebSocket;

    let activeSocket = null;
    let currentServerUrl = null;
    let realHandler = null;

    // --------------------------------------------------------------------
    // Registered callbacks — other modules plug in here. Each is optional.
    // --------------------------------------------------------------------

    let onFrameObserved = null;
    const frameTransformers = [];
    const postDispatchHooks = [];
    let onBatchCompleteFn = null;
    let onSocketCloseFn = null;

    function onBatchComplete(fn) {
        onBatchCompleteFn = fn;
    }

    function onEveryFrame(fn) {
        onFrameObserved = fn;
    }

    function addFrameTransformer(fn) {
        frameTransformers.push(fn);
    }

    function addPostDispatchHook(fn) {
        postDispatchHooks.push(fn);
    }

    function onSocketClose(fn) { onSocketCloseFn = fn; }

    // --------------------------------------------------------------------
    // Raw dispatch helper
    // --------------------------------------------------------------------

    function dispatchRawToRealHandler(rawMessage) {
        if (!realHandler) return false;
        const bytes = new Uint8Array(rawMessage.length);
        for (let i = 0; i < rawMessage.length; i++) bytes[i] = rawMessage.charCodeAt(i);
        realHandler(new MessageEvent('message', { data: bytes.buffer }));
        return true;
    }

    // --------------------------------------------------------------------
    // Core dispatcher — runs on every message from the tapped socket.
    // --------------------------------------------------------------------

    function ourDispatcher(event) {
        try {
            if (event.data === undefined) {
                if (realHandler) realHandler(event);
                return;
            }

            const isString = typeof event.data === 'string';
            const text = isString
                ? event.data
                : String.fromCharCode.apply(null, new Uint8Array(event.data));

            const frames = text.split('|');
            const totalFrames = frames.length;

            const patchedFrames = frames.map((frame, index) => {
                const meta = { frame_id: index, total_frames: totalFrames };

                if (onFrameObserved) {
                    try { onFrameObserved(frame, meta); } catch (e) { console.error('[gcl-ws-hook] onFrameObserved error:', e); }
                }

                let out = frame;
                for (const transform of frameTransformers) {
                    try { out = transform(out, meta); } catch (e) { console.error('[gcl-ws-hook] frameTransformer error:', e); }
                }
                return out;
            });

            const patchedText = patchedFrames.join('|');

            if (realHandler) {
                if (patchedText === text) {
                    realHandler(event);
                } else {
                    const patchedData = isString
                        ? patchedText
                        : (() => {
                            const buf = new Uint8Array(patchedText.length);
                            for (let i = 0; i < patchedText.length; i++) {
                                buf[i] = patchedText.charCodeAt(i);
                            }
                            return buf.buffer;
                        })();
                    realHandler(new MessageEvent('message', { data: patchedData }));
                }

                for (const frame of frames) {
                    for (const hook of postDispatchHooks) {
                        try { hook(frame, realHandler); } catch (e) { console.error('[gcl-ws-hook] postDispatchHook error:', e); }
                    }
                }
            } else {
                console.log('[gcl-ws-hook] dispatcher fired but realHandler not yet set — frame dropped', { text });
            }

            if (onBatchCompleteFn) {
                try { onBatchCompleteFn(); } catch (e) { console.error('[gcl-ws-hook] onBatchComplete error:', e); }
            }
        } catch (e) {
            console.error('[gcl-ws-hook] error in dispatcher, forwarding original event untouched:', e);
            if (realHandler) realHandler(event);
        }
    }

    // --------------------------------------------------------------------
    // WebSocket wrap
    // --------------------------------------------------------------------

    function HookedWebSocket(url, protocols) {
        const socket = protocols !== undefined
            ? new RealWebSocket(url, protocols)
            : new RealWebSocket(url);

        if (typeof url === 'string' && !url.includes('/ping')) {
            activeSocket = socket;
            currentServerUrl = url;
            realHandler = null;

            Object.defineProperty(socket, 'onmessage', {
                configurable: true,
                get() { return realHandler; },
                set(fn) { realHandler = fn; },
            });

            socket.addEventListener('message', ourDispatcher);

            socket.addEventListener('close', () => {
                if (activeSocket === socket) {
                    activeSocket = null;
                    currentServerUrl = null;
                    realHandler = null;
                }
                if (onSocketCloseFn) {
                    try { onSocketCloseFn(); } catch (e) { console.error('[gcl-ws-hook] onSocketClose error:', e); }
                }
            });
        }

        return socket;
    }

    HookedWebSocket.prototype = RealWebSocket.prototype;
    HookedWebSocket.CONNECTING = RealWebSocket.CONNECTING;
    HookedWebSocket.OPEN = RealWebSocket.OPEN;
    HookedWebSocket.CLOSING = RealWebSocket.CLOSING;
    HookedWebSocket.CLOSED = RealWebSocket.CLOSED;

    window.WebSocket = HookedWebSocket;

    // --------------------------------------------------------------------
    // Public API
    // --------------------------------------------------------------------

    window.gclWsHook = {
        getActiveSocket: () => activeSocket,
        getCurrentServerUrl: () => currentServerUrl,
        getRealHandler: () => realHandler,
        dispatchRawToRealHandler,
        onEveryFrame,
        addFrameTransformer,
        addPostDispatchHook,
        onBatchComplete,
        onSocketClose
    };
})();

// ============================================================================
// MODULE 3 — hook_handler
// Keeps: frame decoding, blank-aware merge, deferred player rebuild.
// ============================================================================

(function hook_handler() {
    'use strict';

    const WORKER_URL = 'https://login-info-handler.gitgames.workers.dev';

    // ---- state the helpers touch ----------------------------------------
    const ghosts = {};        // id -> last known player data
    let LAZY_IDS = {};        // id -> resolved community username
    let INJECT_MESSAGES = []; // frames to append to the next outgoing frame

    // [HELPER] blank check ---------------------------------------------------
    function isFilled(v) {
        return v !== undefined && v !== '';
    }

    // [HELPER] copy only non-blank fields (the game delta-encodes frames) ----
    function mergeFields(target, source, fields) {
        for (const f of fields) {
            if (isFilled(source[f])) target[f] = source[f];
        }
    }

    // [HELPER] parse a raw frame into a named object -------------------------
    function decodeRelevant(raw) {

        if (!raw || raw.length === 0) return null;
        const parts = raw.split(',');
        switch (parts[0]) {
            case 'a': //self player init
                return {
                    code: 'a', id: parts[1], msg: parts
                };
            case 'b': //position update
                return {
                    code: 'b', id: parts[1], x: parts[2], y: parts[3],
                    spdX: parts[4], spdY: parts[5], playerAngle: parts[6]
                };
            case 'c': //status update
                return {
                    code: 'c', id: parts[1], currentBullets: parts[2],
                    shooting: parts[3], reloading: parts[4], hp: parts[5],
                    beingHit: parts[6], armorAmount: parts[7], radius: parts[8],
                    ghillie: parts[9], maxBullets: parts[10], invincible: parts[11],
                    dashing: parts[12], chatBoxOpen: parts[13], isLeader: parts[14],
                    colorCode: parts[15], chatMessage: parts[16]
                };
            case 'd': //new player join
                return {
                    code: 'd', id: parts[1], classCode: parts[2], colorCode: parts[3],
                    x: parts[4], y: parts[5], radius: parts[6], playerAngle: parts[7],
                    armorAmount: parts[8], hp: parts[9], maxBullets: parts[10],
                    username: parts[11], ghillie: parts[12], invincible: parts[13],
                    isLeader: parts[14], isPremiumMember: parts[15], teamCode: parts[16],
                    chatBoxOpen: parts[17]
                };
            case 'e': //player left
                return { code: 'e', id: parts[1] };
            case 's': //despawn
                return { code: 's' };
            default:
                return { code: parts[0] };
        }
    }

    // [HELPER] queue a re-init + status frame carrying the community name ----
    function rebuildPlayer(id, ghost) {
        // Don't inject until we've seen a real 'c' frame for this player.
        // Before that, colorCode/radius/hp are blank and injecting them wipes
        // the player's body. The 'c' handler retries once data exists.
        if (!ghost.hasStatus) {
            console.log('[gcl-trace] rebuildPlayer — deferred for id', id, '(no real status frame yet)');
            return;
        }

        const name = LAZY_IDS[id] || ghost.username;
        console.log('[gcl-trace] rebuildPlayer CALLED for id:', id, 'new username:', name);
        ghost.rebuilt = true;

        const PLAYER_REINIT = [
            'd', id, ghost.classCode, ghost.colorCode, ghost.x, ghost.y, ghost.radius,
            ghost.playerAngle, ghost.armorAmount, ghost.hp, ghost.maxBullets, name,
            ghost.ghillie, ghost.invincible, ghost.isLeader, ghost.isPremiumMember,
            ghost.teamCode, ghost.chatBoxOpen
        ].join(',');

        // 17 fields — matches the real 'c' frame (chatMessage is the last one).
        const PLAYER_UPDATE = [
            'c', id, ghost.currentBullets, ghost.shooting, ghost.reloading, ghost.hp,
            ghost.beingHit, ghost.armorAmount, ghost.radius, ghost.ghillie, ghost.maxBullets,
            ghost.invincible, ghost.dashing, ghost.chatBoxOpen, ghost.isLeader, ghost.colorCode,
            ghost.chatMessage ?? ''
        ].join(',');

        INJECT_MESSAGES.push(PLAYER_REINIT);
        INJECT_MESSAGES.push(PLAYER_UPDATE);
        console.log('[gcl-trace] REBUILT D:', PLAYER_REINIT);
        console.log('[gcl-trace] REBUILT C:', PLAYER_UPDATE);
    }

    // ---- PLUG-IN POINTS (removed, to be rewritten for the new backend) ----
    // [PLUG-IN] window.gclWsHook.onEveryFrame(...)   — switch on a/b/c/d/e/s
    //           (c-case sets g.hasStatus once radius + colorCode are filled)
    // [PLUG-IN] window.gclWsHook.addFrameTransformer(...) — swap in self-name
    //           frame, append INJECT_MESSAGES, then clear it
    // [PLUG-IN] window.gclWsHook.onBatchComplete(...) — send unresolved ids
    // [PLUG-IN] window.gclWsHook.onSocketClose(...)   — reset all state
    // [PLUG-IN] window 'gcl:login' and 'pagehide' listeners
    // [PLUG-IN] network calls: self presence set/clear, id lookup, lazy re-check
    // [PLUG-IN] lookup throttling state (in-flight set, retry/backoff timers)
})();
