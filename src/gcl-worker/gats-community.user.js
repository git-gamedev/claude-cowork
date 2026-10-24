// ==UserScript==
// @name         gats.io Community Login + Presence
// @namespace    https://gats.io/
// @version      3.0
// @description  Community accounts and live presence for gats.io
// @match        https://gats.io/*
// @connect      login-info-handler.gitgames.workers.dev
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @run-at       document-start
// @license      MIT
// ==/UserScript==

// ============================================================================
// MODULE 1 - auth_ui
// Token lives in GM storage (invisible to the game page). All HTTP goes through
// GM_xmlhttpRequest so the page never sees the token and CORS never applies.
// ============================================================================

(function auth_ui() {
    'use strict';

    const WORKER_URL = 'https://login-info-handler.gitgames.workers.dev';
    const SESSION_KEY = 'gcl_session';

    let currentUser = null;   // { username }
    let currentToken = null;

    // ---- session storage (GM, not localStorage) ----------------------------
    function saveSession(token, exp, name) {
        GM_setValue(SESSION_KEY, JSON.stringify({ token, exp, name }));
    }
    function clearSession() {
        GM_deleteValue(SESSION_KEY);
    }
    function loadSession() {
        try {
            const s = JSON.parse(GM_getValue(SESSION_KEY, 'null'));
            if (s && s.token && s.exp * 1000 > Date.now()) return s;
        } catch (e) { /* corrupt, ignore */ }
        return null;
    }

    // ---- worker call -----------------------------------------------------------
    function apiCall(path, { method = 'POST', token = null, body = null } = {}) {
        return new Promise((resolve) => {
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers.Authorization = 'Bearer ' + token;
            GM_xmlhttpRequest({
                method,
                url: WORKER_URL + path,
                headers,
                data: body ? JSON.stringify(body) : undefined,
                timeout: 15000,
                onload: (r) => {
                    let data = {};
                    try { data = JSON.parse(r.responseText); } catch (e) { /* non-JSON */ }
                    resolve({ status: r.status, data });
                },
                onerror: () => resolve({ status: 0, data: { error: 'network' } }),
                ontimeout: () => resolve({ status: 0, data: { error: 'timeout' } }),
            });
        });
    }

    function isLoggedIn() { return !!currentToken; }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ---- UI: style, badge, modal ---------------------------------------------
    const STYLE = `
    #gcl-badge{position:fixed;left:8px;bottom:8px;z-index:2147483000;padding:4px 10px;border-radius:12px;
      background:rgba(20,20,20,.85);color:#fff;font:12px/1.4 Arial,sans-serif;cursor:pointer;user-select:none;opacity:.85}
    #gcl-badge:hover{opacity:1}
    #gcl-badge.on{background:rgba(25,110,50,.9)}
    #gcl-modal-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center}
    #gcl-modal{position:relative;width:300px;max-width:90vw;padding:18px;border-radius:10px;background:#1c1c1c;color:#eee;font:14px Arial,sans-serif}
    #gcl-modal h3{margin:0 0 10px;font-size:16px}
    #gcl-modal input{display:block;width:100%;box-sizing:border-box;margin:6px 0;padding:8px;border:1px solid #444;border-radius:6px;background:#2a2a2a;color:#fff}
    #gcl-modal button{padding:8px 12px;border:0;border-radius:6px;background:#3a3a3a;color:#fff;cursor:pointer;margin-top:6px}
    #gcl-modal button.gcl-primary{background:#2a7d46;width:100%}
    #gcl-modal .gcl-close{position:absolute;right:8px;top:4px;background:none;font-size:20px;margin:0}
    #gcl-modal .gcl-tabs button{margin-right:4px;margin-top:0}
    #gcl-modal .gcl-tabs button.on{background:#2a7d46}
    #gcl-modal .gcl-err{min-height:18px;color:#ff7777;font-size:12px;margin-top:4px}
    #gcl-modal .gcl-ok{color:#7fe08f}
    #gcl-modal .gcl-note{font-size:11px;color:#aaa;margin:6px 0}
    `;

    function injectStyle() {
        if (document.getElementById('gcl-style')) return;
        const s = document.createElement('style');
        s.id = 'gcl-style';
        s.textContent = STYLE;
        document.documentElement.appendChild(s);
    }

    function ensureBadge() {
        let b = document.getElementById('gcl-badge');
        if (!b) {
            b = document.createElement('div');
            b.id = 'gcl-badge';
            b.addEventListener('click', () => (isLoggedIn() ? showAccountModal() : showAuthModal('login')));
            (document.body || document.documentElement).appendChild(b);
        }
        return b;
    }

    function updateBadge() {
        const b = ensureBadge();
        if (isLoggedIn() && currentUser) {
            b.textContent = '\u2714 ' + currentUser.username;
            b.classList.add('on');
        } else {
            b.textContent = 'Community login';
            b.classList.remove('on');
        }
    }

    function closeModal() {
        const overlay = document.getElementById('gcl-modal-overlay');
        if (overlay) overlay.remove();
    }

    function openModal(innerHTML) {
        closeModal();
        const overlay = document.createElement('div');
        overlay.id = 'gcl-modal-overlay';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

        const modal = document.createElement('div');
        modal.id = 'gcl-modal';
        modal.innerHTML = '<button class="gcl-close" data-close>&times;</button>' + innerHTML;
        modal.querySelector('[data-close]').addEventListener('click', closeModal);
        // The game listens for WASD etc. on the window; keep typing from moving the player.
        for (const ev of ['keydown', 'keyup', 'keypress']) modal.addEventListener(ev, (e) => e.stopPropagation());

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        return modal;
    }

    const ERRORS = {
        invalid_credentials: 'Wrong username or password.',
        invalid_username: 'Username must be 3-16 letters, numbers or underscores (some names are reserved).',
        invalid_password: 'Password must be 8-128 characters.',
        username_taken: 'That username is taken.',
        rate_limited: 'Too many attempts. Try again later.',
        banned: 'This account is banned.',
        cooldown: 'You changed your name recently. Try again later.',
        unchanged: 'That is already your username.',
        network: 'Could not reach the server.',
        timeout: 'The server took too long to answer.',
        invalid_token: 'Your session expired. Please log in again.',
    };
    const errText = (d) => ERRORS[d && d.error] || 'Something went wrong (' + ((d && d.error) || 'unknown') + ').';

    function showAuthModal(mode) {
        const reg = mode === 'register';
        const m = openModal(`
            <h3>Community account</h3>
            <div class="gcl-tabs">
                <button data-tab="login" class="${reg ? '' : 'on'}">Log in</button>
                <button data-tab="register" class="${reg ? 'on' : ''}">Register</button>
            </div>
            <input id="gcl-u" placeholder="Username" maxlength="16" autocomplete="username">
            <input id="gcl-p" type="password" placeholder="Password" maxlength="128" autocomplete="${reg ? 'new-password' : 'current-password'}">
            ${reg ? '<input id="gcl-p2" type="password" placeholder="Repeat password" maxlength="128" autocomplete="new-password"><div class="gcl-note">Use a password you use nowhere else (not your gats.io one). There is no password recovery.</div>' : ''}
            <div class="gcl-err" id="gcl-err"></div>
            <button class="gcl-primary" id="gcl-go">${reg ? 'Create account' : 'Log in'}</button>`);

        m.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showAuthModal(b.dataset.tab)));
        const err = m.querySelector('#gcl-err');
        const go = m.querySelector('#gcl-go');

        async function submit() {
            const username = m.querySelector('#gcl-u').value.trim();
            const password = m.querySelector('#gcl-p').value;
            if (reg && password !== m.querySelector('#gcl-p2').value) { err.textContent = 'Passwords do not match.'; return; }
            err.textContent = '';
            go.disabled = true;
            const r = await apiCall(reg ? '/register' : '/login', { body: { username, password } });
            go.disabled = false;
            if (r.status === 200 || r.status === 201) { closeModal(); onLoginSuccess(r.data); }
            else err.textContent = errText(r.data);
        }
        go.addEventListener('click', submit);
        m.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        m.querySelector('#gcl-u').focus();
    }

    function showAccountModal() {
        const m = openModal(`
            <h3>${escapeHtml(currentUser.username)}</h3>
            <input id="gcl-newname" placeholder="New username" maxlength="16">
            <button id="gcl-rename">Change username</button>
            <div class="gcl-err" id="gcl-err"></div>
            <hr style="border-color:#333">
            <button id="gcl-logout">Log out</button>
            <button id="gcl-logout-all">Log out everywhere</button>
            <div class="gcl-note">"Everywhere" invalidates your session on every device.</div>`);
        const err = m.querySelector('#gcl-err');

        m.querySelector('#gcl-rename').addEventListener('click', async () => {
            const username = m.querySelector('#gcl-newname').value.trim();
            err.className = 'gcl-err';
            err.textContent = '';
            const room = window.gclPresence ? window.gclPresence.getRoom() : null;
            const r = await apiCall('/rename', { token: currentToken, body: { username, room } });
            if (r.status === 200) {
                onLoginSuccess(r.data, true);
                err.className = 'gcl-err gcl-ok';
                err.textContent = 'Renamed. Your new name shows in-game from your next spawn.';
            } else {
                if (r.status === 401) performLogout();
                err.textContent = errText(r.data);
            }
        });
        m.querySelector('#gcl-logout').addEventListener('click', () => { closeModal(); performLogout(); });
        m.querySelector('#gcl-logout-all').addEventListener('click', async () => {
            await apiCall('/logout-all', { token: currentToken });
            closeModal();
            performLogout();
        });
    }

    // ---- session lifecycle ---------------------------------------------------------
    function onLoginSuccess(data, quiet) {
        currentToken = data.token;
        currentUser = { username: data.user.username };
        saveSession(data.token, data.exp, data.user.username);
        updateBadge();
        if (!quiet) window.dispatchEvent(new CustomEvent('gcl:login'));
    }

    function performLogout() {
        currentToken = null;
        currentUser = null;
        clearSession();
        updateBadge();
        window.dispatchEvent(new CustomEvent('gcl:logout'));
    }

    async function tryAutoLogin() {
        const s = loadSession();
        if (!s) return;
        // Refresh validates the token against D1 (bans, logout-everywhere) and renews it.
        const r = await apiCall('/refresh', { token: s.token });
        if (r.status === 200) onLoginSuccess(r.data);
        else if (r.status === 401) { clearSession(); updateBadge(); }
        else {                                  // server unreachable: keep the stored session
            currentToken = s.token;
            currentUser = { username: s.name };
            updateBadge();
            window.dispatchEvent(new CustomEvent('gcl:login'));
        }
    }

    function init() {
        injectStyle();
        updateBadge();
        tryAutoLogin();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // Lives in the userscript sandbox; the game page cannot reach it.
    window.gclAuth = {
        isLoggedIn,
        getUser: () => currentUser,
        getToken: () => currentToken,
        logout: performLogout,
    };
})();

// ============================================================================
// MODULE 2 - ws_hook (WebSocket tap).
// Same as the skeleton, with two changes forced by using GM_* grants: the hook is
// installed on unsafeWindow (the page's real window), and the untouched native
// WebSocket is exposed so the presence socket is not tapped by our own hook.
// ============================================================================

(function ws_hook() {
    'use strict';

    const pageWin = unsafeWindow;
    const RealWebSocket = pageWin.WebSocket;

    let activeSocket = null;
    let currentServerUrl = null;
    let realHandler = null;

    let onFrameObserved = null;
    const frameTransformers = [];
    const postDispatchHooks = [];
    let onBatchCompleteFn = null;
    let onSocketCloseFn = null;

    function onBatchComplete(fn) { onBatchCompleteFn = fn; }
    function onEveryFrame(fn) { onFrameObserved = fn; }
    function addFrameTransformer(fn) { frameTransformers.push(fn); }
    function addPostDispatchHook(fn) { postDispatchHooks.push(fn); }
    function onSocketClose(fn) { onSocketCloseFn = fn; }

    function dispatchRawToRealHandler(rawMessage) {
        if (!realHandler) return false;
        const bytes = new Uint8Array(rawMessage.length);
        for (let i = 0; i < rawMessage.length; i++) bytes[i] = rawMessage.charCodeAt(i);
        realHandler(new MessageEvent('message', { data: bytes.buffer }));
        return true;
    }

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
                console.log('[gcl-ws-hook] dispatcher fired but realHandler not yet set - frame dropped', { text });
            }

            if (onBatchCompleteFn) {
                try { onBatchCompleteFn(); } catch (e) { console.error('[gcl-ws-hook] onBatchComplete error:', e); }
            }
        } catch (e) {
            console.error('[gcl-ws-hook] error in dispatcher, forwarding original event untouched:', e);
            if (realHandler) realHandler(event);
        }
    }

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

    pageWin.WebSocket = HookedWebSocket;

    window.gclWsHook = {
        getActiveSocket: () => activeSocket,
        getCurrentServerUrl: () => currentServerUrl,
        getRealHandler: () => realHandler,
        NativeWebSocket: RealWebSocket,
        dispatchRawToRealHandler,
        onEveryFrame,
        addFrameTransformer,
        addPostDispatchHook,
        onBatchComplete,
        onSocketClose,
    };
})();

// ============================================================================
// MODULE 3 - hook_handler
// Frame decoding, blank-aware merge, deferred player rebuild, plus the presence
// WebSocket (heartbeat, join/leave, lookups) that feeds community names in.
// ============================================================================

(function hook_handler() {
    'use strict';

    const WS_BASE = 'wss://login-info-handler.gitgames.workers.dev';
    const HEARTBEAT_MS = 25000;
    const MAX_RECONNECTS = 8;

    // ---- game-side state -----------------------------------------------------
    const ghosts = {};        // game id -> last known player data
    let LAZY_IDS = {};        // game id -> community username (per-session cache)
    let INJECT_MESSAGES = []; // frames to append to the next incoming batch
    let selfId = null;

    // ---- presence state --------------------------------------------------------
    let ps = null;            // presence WebSocket
    let psRoom = null;
    let hbTimer = null;
    let retryTimer = null;
    let backoff = 1000;
    let attempts = 0;

    // ---- lookup throttling --------------------------------------------------------
    const unresolved = new Set();
    const lookups = new Map(); // id -> { t, n }
    let lastScan = 0;

    function isFilled(v) { return v !== undefined && v !== ''; }

    function mergeFields(target, source, fields) {
        for (const f of fields) {
            if (isFilled(source[f])) target[f] = source[f];
        }
    }

    function decodeRelevant(raw) {
        if (!raw || raw.length === 0) return null;
        const parts = raw.split(',');
        switch (parts[0]) {
            case 'a': // self player init
                return { code: 'a', id: parts[1], msg: parts };
            case 'b': // position update
                return {
                    code: 'b', id: parts[1], x: parts[2], y: parts[3],
                    spdX: parts[4], spdY: parts[5], playerAngle: parts[6],
                };
            case 'c': // status update
                return {
                    code: 'c', id: parts[1], currentBullets: parts[2],
                    shooting: parts[3], reloading: parts[4], hp: parts[5],
                    beingHit: parts[6], armorAmount: parts[7], radius: parts[8],
                    ghillie: parts[9], maxBullets: parts[10], invincible: parts[11],
                    dashing: parts[12], chatBoxOpen: parts[13], isLeader: parts[14],
                    colorCode: parts[15], chatMessage: parts[16],
                };
            case 'd': // new player join
                return {
                    code: 'd', id: parts[1], classCode: parts[2], colorCode: parts[3],
                    x: parts[4], y: parts[5], radius: parts[6], playerAngle: parts[7],
                    armorAmount: parts[8], hp: parts[9], maxBullets: parts[10],
                    username: parts[11], ghillie: parts[12], invincible: parts[13],
                    isLeader: parts[14], isPremiumMember: parts[15], teamCode: parts[16],
                    chatBoxOpen: parts[17],
                };
            case 'e': // player left
                return { code: 'e', id: parts[1] };
            case 's': // despawn
                return { code: 's' };
            default:
                return { code: parts[0] };
        }
    }

    // Queue a re-init + status frame carrying the community name.
    // Deferred until a real 'c' frame has filled colour/radius, otherwise the
    // injected frames would blank the player's body.
    function rebuildPlayer(id, ghost) {
        if (!ghost.hasStatus) return;

        const name = LAZY_IDS[id] || ghost.username;
        ghost.shownName = name;

        const PLAYER_REINIT = [
            'd', id, ghost.classCode, ghost.colorCode, ghost.x, ghost.y, ghost.radius,
            ghost.playerAngle, ghost.armorAmount, ghost.hp, ghost.maxBullets, name,
            ghost.ghillie, ghost.invincible, ghost.isLeader, ghost.isPremiumMember,
            ghost.teamCode, ghost.chatBoxOpen,
        ].join(',');

        // 17 fields, same as the real 'c' frame (chatMessage last, intentionally empty).
        const PLAYER_UPDATE = [
            'c', id, ghost.currentBullets, ghost.shooting, ghost.reloading, ghost.hp,
            ghost.beingHit, ghost.armorAmount, ghost.radius, ghost.ghillie, ghost.maxBullets,
            ghost.invincible, ghost.dashing, ghost.chatBoxOpen, ghost.isLeader, ghost.colorCode,
            '',
        ].join(',');

        INJECT_MESSAGES.push(PLAYER_REINIT, PLAYER_UPDATE);
    }

    // Show the community name for this game id if it differs from what is on screen.
    function applyName(id) {
        const g = ghosts[id];
        const name = LAZY_IDS[id];
        if (g && name && g.shownName !== name) rebuildPlayer(id, g);
    }

    function setName(id, name) {
        if (id === selfId) return;
        LAZY_IDS[id] = name;
        unresolved.delete(id);
        applyName(id);
    }

    // ---- presence socket ------------------------------------------------------------
    const roomFromUrl = (u) => { try { return new URL(u).host.toLowerCase(); } catch (e) { return null; } };

    function sendPresence(obj) {
        if (ps && ps.readyState === 1) ps.send(JSON.stringify(obj));
    }

    function announceSelf() {
        if (selfId) sendPresence({ t: 'join', gid: selfId });
    }

    function closePresence() {
        clearInterval(hbTimer);
        clearTimeout(retryTimer);
        if (ps) {
            ps.onclose = null;
            try { ps.close(1000); } catch (e) { /* already closed */ }
        }
        ps = null;
        psRoom = null;
    }

    function handlePresenceMessage(data) {
        let m;
        try { m = JSON.parse(data); } catch (e) { return; }
        switch (m.t) {
            case 'welcome':
                for (const [gid, name] of m.roster || []) setName(String(gid), name);
                break;
            case 'join':
            case 'rename':
                setName(String(m.gid), m.name);
                break;
            case 'leave':
                delete LAZY_IDS[String(m.gid)];
                break;
            case 'names':
                for (const gid in (m.map || {})) setName(gid, m.map[gid]);
                break;
            case 'revoked':
                window.gclAuth.logout();
                break;
            default: break; // joined / denied: nothing to do
        }
    }

    function connectPresence() {
        const auth = window.gclAuth;
        const hook = window.gclWsHook;
        if (!auth || !auth.isLoggedIn() || !hook.getActiveSocket()) return;
        const room = roomFromUrl(hook.getCurrentServerUrl());
        if (!room) return;
        if (ps && psRoom === room && ps.readyState <= 1) return;

        closePresence();
        psRoom = room;
        // Token travels as a WebSocket subprotocol, not in the URL.
        const sock = new hook.NativeWebSocket(
            WS_BASE + '/presence?room=' + encodeURIComponent(room),
            ['gcl.v1', auth.getToken()]
        );
        ps = sock;

        sock.onopen = () => {
            backoff = 1000;
            attempts = 0;
            hbTimer = setInterval(() => { if (sock.readyState === 1) sock.send('ping'); }, HEARTBEAT_MS);
            announceSelf();
        };
        sock.onmessage = (ev) => handlePresenceMessage(ev.data);
        sock.onclose = (ev) => {
            clearInterval(hbTimer);
            if (ps !== sock) return;
            ps = null;
            if (ev.code === 4001) { auth.logout(); return; }  // revoked (ban / logout everywhere)
            if (ev.code === 4000) return;                      // another tab took over
            if (hook.getActiveSocket() && auth.isLoggedIn() && attempts < MAX_RECONNECTS) {
                attempts++;
                retryTimer = setTimeout(connectPresence, backoff);
                backoff = Math.min(backoff * 2, 30000);
            }
        };
    }

    function resetGameState() {
        for (const k in ghosts) delete ghosts[k];
        LAZY_IDS = {};
        INJECT_MESSAGES = [];
        unresolved.clear();
        lookups.clear();
        selfId = null;
    }

    // ---- wiring: observe every frame ---------------------------------------------------
    window.gclWsHook.onEveryFrame((raw) => {
        const f = decodeRelevant(raw);
        if (!f) return;

        switch (f.code) {
            case 'a': // our own (re)spawn; others get re-announced by the server
                for (const k in ghosts) delete ghosts[k];
                unresolved.clear();
                lookups.clear();
                selfId = f.id;
                connectPresence();
                announceSelf();
                break;

            case 'b': {
                const g = ghosts[f.id];
                if (g) mergeFields(g, f, ['x', 'y', 'spdX', 'spdY', 'playerAngle']);
                break;
            }

            case 'c': {
                const g = ghosts[f.id];
                if (!g) break;
                mergeFields(g, f, [
                    'currentBullets', 'shooting', 'reloading', 'hp', 'beingHit', 'armorAmount',
                    'radius', 'ghillie', 'maxBullets', 'invincible', 'dashing', 'chatBoxOpen',
                    'isLeader', 'colorCode',
                ]); // chatMessage is deliberately not merged: it is per-message, not state
                if (!g.hasStatus && isFilled(g.radius) && isFilled(g.colorCode)) {
                    g.hasStatus = true;
                    applyName(f.id); // retry any rebuild that was deferred
                }
                break;
            }

            case 'd': {
                const g = Object.assign({}, f);
                delete g.code;
                g.hasStatus = false;
                g.shownName = LAZY_IDS[f.id] || f.username; // the transformer swaps known names in
                ghosts[f.id] = g;
                if (!LAZY_IDS[f.id]) unresolved.add(f.id);
                break;
            }

            case 'e':
                delete ghosts[f.id];
                unresolved.delete(f.id);
                lookups.delete(f.id);
                break;

            case 's': // we despawned: free our id in the room until the next 'a'
                sendPresence({ t: 'leave' });
                break;

            default: break;
        }
    });

    // ---- wiring: rewrite frames ------------------------------------------------------------
    window.gclWsHook.addFrameTransformer((frame, meta) => {
        let out = frame;
        const user = window.gclAuth.getUser();

        if (frame.startsWith('a,') && user) {                 // our own name
            const p = frame.split(',');
            if (p.length > 18) { p[18] = user.username; out = p.join(','); }
        } else if (frame.startsWith('d,')) {                   // someone already resolved
            const p = frame.split(',');
            const name = LAZY_IDS[p[1]];
            if (name && p.length > 11) { p[11] = name; out = p.join(','); }
        }

        if (INJECT_MESSAGES.length && meta.frame_id === meta.total_frames - 1) {
            out += '|' + INJECT_MESSAGES.join('|');
            INJECT_MESSAGES = [];
        }
        return out;
    });

    // ---- wiring: ask the room about ids we could not resolve ------------------------------------
    window.gclWsHook.onBatchComplete(() => {
        const now = Date.now();
        if (now - lastScan < 1000 || !unresolved.size) return;
        lastScan = now;
        if (!ps || ps.readyState !== 1) return;

        const ids = [];
        for (const id of unresolved) {
            const st = lookups.get(id);
            if (!st || (now - st.t > 20000 && st.n < 3)) {
                ids.push(id);
                lookups.set(id, { t: now, n: st ? st.n + 1 : 1 });
                if (ids.length >= 50) break;
            }
        }
        if (ids.length) sendPresence({ t: 'lookup', ids });
    });

    window.gclWsHook.onSocketClose(() => {
        sendPresence({ t: 'leave' });
        closePresence();
        resetGameState();
    });

    window.addEventListener('gcl:login', () => {
        attempts = 0;
        connectPresence();
    });
    window.addEventListener('gcl:logout', () => {
        closePresence();
        LAZY_IDS = {};
    });
    unsafeWindow.addEventListener('pagehide', () => closePresence());

    window.gclPresence = { getRoom: () => psRoom };
})();
