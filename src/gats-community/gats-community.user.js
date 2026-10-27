// ==UserScript==
// @name         gats.io Community Login + Presence
// @namespace    https://gats.io/
// @version      3.0
// @description  Community accounts and live name display for gats.io
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

// Private shared object. Nothing is attached to the page's window, so game scripts cannot
// reach the token or any of these modules.
const GCL = {
    cfg: { WORKER_URL: 'https://login-info-handler.gitgames.workers.dev' },
    events: new EventTarget(),
};

// ============================================================================
// MODULE 1 — auth_ui: token storage (GM_setValue), API calls, login/register/account UI
// ============================================================================
(function auth_ui() {
    'use strict';

    const { WORKER_URL } = GCL.cfg;
    const SESSION_KEY = 'gcl_session';
    const PBKDF2_ITERATIONS = 600000; // runs in YOUR browser, so no Worker CPU cap applies
    let currentUser = null;
    let currentToken = null;

    // ---- session storage (GM storage is invisible to the page) ----
    const saveSession = (token, exp) => GM_setValue(SESSION_KEY, { token, exp });
    const clearSession = () => GM_deleteValue(SESSION_KEY);
    function getStoredSession() {
        const s = GM_getValue(SESSION_KEY, null);
        return s && s.token && Date.now() < s.exp ? s : null;
    }
    function decodeClaims(token) {
        try {
            const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            return JSON.parse(atob(p + '='.repeat((4 - (p.length % 4)) % 4)));
        } catch (e) { return null; }
    }

    // ---- worker call via GM_xmlhttpRequest (no CORS involved) ----
    function apiCall(path, { method = 'POST', token = null, body = null } = {}) {
        return new Promise((resolve, reject) => {
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers.Authorization = `Bearer ${token}`;
            GM_xmlhttpRequest({
                method, url: WORKER_URL + path, headers, timeout: 15000,
                data: body ? JSON.stringify(body) : undefined,
                onload: (r) => {
                    let data = {};
                    try { data = JSON.parse(r.responseText); } catch (e) { /* non-JSON */ }
                    resolve({ status: r.status, data });
                },
                onerror: () => reject(new Error('network')),
                ontimeout: () => reject(new Error('timeout')),
            });
        });
    }

    // ---- client-side password stretching: the server only ever sees this derived key ----
    async function deriveKey(login, password) {
        const enc = new TextEncoder();
        const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('gats-community-v1:' + login.toLowerCase()), iterations: PBKDF2_ITERATIONS },
            base, 256);
        let s = '';
        for (const b of new Uint8Array(bits)) s += String.fromCharCode(b);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ---- session lifecycle ----
    function setSession({ token, exp }) {
        const c = decodeClaims(token);
        if (!c) return false;
        currentToken = token;
        currentUser = { id: c.uid, username: c.name };
        saveSession(token, exp);
        updateBadge();
        GCL.events.dispatchEvent(new Event('login'));
        return true;
    }

    function performLogout() {
        clearSession();
        currentToken = null;
        currentUser = null;
        updateBadge();
        GCL.events.dispatchEvent(new Event('logout'));
    }

    async function refreshSession() {
        if (!currentToken) return;
        try {
            const r = await apiCall('/refresh', { token: currentToken });
            if (r.status === 200) setSession(r.data);
            else if (r.status === 401 || r.status === 403) performLogout();
        } catch (e) { /* offline: keep the session */ }
    }

    function tryAutoLogin() {
        const s = getStoredSession();
        if (!s) return;
        setSession(s);
        if (s.exp - Date.now() < 3.5 * 24 * 3600 * 1000) refreshSession(); // renew when past half-life
    }

    const ERRORS = {
        invalid_credentials: 'Wrong username or password.',
        name_taken: 'That name is taken.',
        invalid_input: 'Use 3-16 letters, numbers, _ . or -.',
        rate_limited: 'Too many attempts. Wait a few minutes.',
        banned: 'This account is banned.',
        revoked: 'Session expired. Log in again.',
    };
    const errText = (r) => {
        const e = r.data && r.data.error;
        if (e === 'rename_cooldown') { // worker /rename 429 {retryAfter: seconds} (#41)
            const sec = Number(r.data.retryAfter) || 0;
            const wait = sec >= 3600 ? Math.ceil(sec / 3600) + ' h' : Math.max(1, Math.ceil(sec / 60)) + ' min';
            return 'You can rename once per day. Try again in about ' + wait + '.';
        }
        return ERRORS[e] || 'Something went wrong. Try again.';
    };

    // ---- UI ----
    const CSS = `
    #gcl-badge{position:fixed;left:8px;bottom:8px;z-index:99998;background:rgba(0,0,0,.65);color:#fff;font:12px sans-serif;padding:4px 9px;border-radius:4px;cursor:pointer;user-select:none}
    #gcl-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:center;justify-content:center}
    #gcl-modal{position:relative;background:#222;color:#eee;font:14px sans-serif;padding:20px;border-radius:8px;width:300px;box-sizing:border-box}
    #gcl-modal h3{margin:0 0 12px}
    #gcl-modal input{display:block;width:100%;box-sizing:border-box;margin:6px 0;padding:7px;border-radius:4px;border:1px solid #555;background:#111;color:#fff}
    #gcl-modal button{padding:7px 12px;border:0;border-radius:4px;background:#3a7;color:#fff;cursor:pointer;margin:6px 6px 0 0}
    #gcl-modal button.alt{background:#555}
    #gcl-modal .gcl-close{position:absolute;right:8px;top:4px;background:none;font-size:20px;margin:0}
    #gcl-msg{min-height:18px;margin-top:6px;color:#f88;font-size:12px}`;

    function injectStyle() {
        const st = document.createElement('style');
        st.textContent = CSS;
        document.head.appendChild(st);
    }

    function closeModal() {
        const o = document.getElementById('gcl-modal-overlay');
        if (o) o.remove();
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
        // keep typing from reaching the game's key handlers
        ['keydown', 'keyup', 'keypress'].forEach((t) => modal.addEventListener(t, (e) => e.stopPropagation()));
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        return modal;
    }

    function ensureBadge() {
        if (document.getElementById('gcl-badge') || !document.body) return;
        const b = document.createElement('div');
        b.id = 'gcl-badge';
        b.addEventListener('click', () => (isLoggedIn() ? showAccountModal() : showAuthModal('login')));
        document.body.appendChild(b);
        updateBadge();
    }

    function updateBadge() {
        const b = document.getElementById('gcl-badge');
        if (b) b.textContent = currentUser ? 'Community: ' + currentUser.username : 'Community: log in';
    }

    function showAuthModal(mode) {
        const reg = mode === 'register';
        const m = openModal(`
            <h3>${reg ? 'Create account' : 'Log in'}</h3>
            <input id="gcl-u" placeholder="Username" autocomplete="username" maxlength="16">
            <input id="gcl-p" type="password" placeholder="Password" autocomplete="${reg ? 'new-password' : 'current-password'}">
            ${reg ? '<input id="gcl-p2" type="password" placeholder="Repeat password" autocomplete="new-password">' : ''}
            <button id="gcl-go">${reg ? 'Sign up' : 'Log in'}</button>
            <button class="alt" id="gcl-sw">${reg ? 'I have an account' : 'Create account'}</button>
            <div id="gcl-msg"></div>`);
        const msg = (t) => { m.querySelector('#gcl-msg').textContent = t; };
        m.querySelector('#gcl-sw').addEventListener('click', () => showAuthModal(reg ? 'login' : 'register'));
        m.querySelector('#gcl-go').addEventListener('click', async () => {
            const u = m.querySelector('#gcl-u').value.trim();
            const p = m.querySelector('#gcl-p').value;
            if (!/^[A-Za-z0-9_.-]{3,16}$/.test(u)) return msg(ERRORS.invalid_input);
            if (p.length < 8) return msg('Password must be at least 8 characters.');
            if (reg && p !== m.querySelector('#gcl-p2').value) return msg('Passwords do not match.');
            msg('Working...');
            try {
                const key = await deriveKey(u, p);
                const r = await apiCall(reg ? '/register' : '/login', { body: reg ? { username: u, key } : { login: u, key } });
                if (r.status === 200 && setSession(r.data)) closeModal();
                else msg(errText(r));
            } catch (e) { msg('Network error.'); }
        });
    }

    function showAccountModal() {
        const m = openModal(`
            <h3>${escapeHtml(currentUser.username)}</h3>
            <input id="gcl-n" placeholder="New display name" maxlength="16">
            <button id="gcl-rn">Rename</button>
            <button class="alt" id="gcl-lo">Log out</button>
            <div id="gcl-msg"></div>`);
        const msg = (t) => { m.querySelector('#gcl-msg').textContent = t; };
        m.querySelector('#gcl-lo').addEventListener('click', () => { performLogout(); closeModal(); });
        m.querySelector('#gcl-rn').addEventListener('click', async () => {
            const n = m.querySelector('#gcl-n').value.trim();
            if (!/^[A-Za-z0-9_.-]{3,16}$/.test(n)) return msg(ERRORS.invalid_input);
            try {
                const r = await apiCall('/rename', { token: currentToken, body: { username: n, room: GCL.presence ? GCL.presence.getRoom() : null } });
                if (r.status === 200 && setSession(r.data)) closeModal();
                else if (r.status === 401) { performLogout(); closeModal(); }
                else msg(errText(r));
            } catch (e) { msg('Network error.'); }
        });
    }

    const isLoggedIn = () => !!currentToken;

    GCL.auth = {
        isLoggedIn,
        getUser: () => currentUser,
        getToken: () => currentToken,
        logout: performLogout,
        refresh: refreshSession,
    };

    tryAutoLogin();
    document.addEventListener('DOMContentLoaded', () => { injectStyle(); ensureBadge(); });
})();

// ============================================================================
// MODULE 2 — ws_hook (WebSocket tap). Same logic as before; only the page-realm plumbing
// changed (unsafeWindow) because the token now lives in a sandboxed userscript.
// ============================================================================
(function ws_hook() {
    'use strict';

    const RealWebSocket = unsafeWindow.WebSocket;
    GCL.NativeWebSocket = RealWebSocket; // presence socket uses this one so it is never tapped

    let activeSocket = null;
    let currentServerUrl = null;
    let realHandler = null;

    let onFrameObserved = null;
    const frameTransformers = [];
    const postDispatchHooks = [];
    let onBatchCompleteFn = null;
    let onSocketCloseFn = null;

    // Build page-realm ArrayBuffers so the game's own `instanceof ArrayBuffer` checks pass.
    function toPageBuffer(text) {
        const bytes = new unsafeWindow.Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
        return bytes.buffer;
    }

    function dispatchRawToRealHandler(rawMessage) {
        if (!realHandler) return false;
        realHandler(new unsafeWindow.MessageEvent('message', { data: toPageBuffer(rawMessage) }));
        return true;
    }

    function ourDispatcher(event) {
        try {
            if (event.data === undefined) { if (realHandler) realHandler(event); return; }

            const isString = typeof event.data === 'string';
            const text = isString ? event.data : String.fromCharCode.apply(null, new Uint8Array(event.data));

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
                if (patchedText === text) realHandler(event);
                else realHandler(new unsafeWindow.MessageEvent('message', { data: isString ? patchedText : toPageBuffer(patchedText) }));

                for (const frame of frames) {
                    for (const hook of postDispatchHooks) {
                        try { hook(frame, realHandler); } catch (e) { console.error('[gcl-ws-hook] postDispatchHook error:', e); }
                    }
                }
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
        const socket = protocols !== undefined ? new RealWebSocket(url, protocols) : new RealWebSocket(url);

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
                if (activeSocket === socket) { activeSocket = null; currentServerUrl = null; realHandler = null; }
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

    unsafeWindow.WebSocket = HookedWebSocket;

    GCL.ws = {
        getActiveSocket: () => activeSocket,
        getCurrentServerUrl: () => currentServerUrl,
        getRealHandler: () => realHandler,
        dispatchRawToRealHandler,
        onEveryFrame: (fn) => { onFrameObserved = fn; },
        addFrameTransformer: (fn) => frameTransformers.push(fn),
        addPostDispatchHook: (fn) => postDispatchHooks.push(fn),
        onBatchComplete: (fn) => { onBatchCompleteFn = fn; },
        onSocketClose: (fn) => { onSocketCloseFn = fn; },
    };
})();

// ============================================================================
// MODULE 3 — presence_client: ONE WebSocket to /presence (heartbeat, join/leave/rename, lookups)
// ============================================================================
(function presence_client() {
    'use strict';

    const WS_URL = GCL.cfg.WORKER_URL.replace(/^http/, 'wss') + '/presence';
    let sock = null, room = null, selfPid = null, selfGname = null;
    let hbTimer = null, retryTimer = null, retries = 0, want = false;
    let handlers = {};

    const isOpen = () => !!sock && sock.readyState === 1;
    const send = (o) => { if (isOpen()) sock.send(JSON.stringify(o)); };

    function schedule() {
        if (retryTimer || !want) return;
        retries++;
        if (retries === 3) GCL.auth.refresh(); // repeated failures may mean a revoked token
        if (retries > 8) {                      // stop: endless retries would burn the Worker's free request cap
            want = false;
            console.warn('[gcl] presence gave up after repeated failures. Room name sent: "' + room + '". If you run this system yourself, check that it matches ALLOWED_ROOM_SUFFIX in wrangler.toml.');
            return;
        }
        const delay = Math.min(60000, 2000 * 2 ** retries) + Math.random() * 1000;
        retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
    }

    function connect() {
        if (sock || !room || !GCL.auth.isLoggedIn()) return;
        want = true;
        let s;
        if (retries === 0) console.info('[gcl] presence room:', room);
        try {
            // Token rides in the subprotocol header, not the URL.
            s = new GCL.NativeWebSocket(`${WS_URL}?room=${encodeURIComponent(room)}`, ['gcl.v1', GCL.auth.getToken()]);
        } catch (e) { schedule(); return; }
        sock = s;
        s.onopen = () => {
            retries = 0;
            hbTimer = setInterval(() => { if (s.readyState === 1) s.send('ping'); }, 25000);
            if (selfPid) send({ t: 'hello', pid: selfPid, gname: selfGname || '' });
        };
        s.onmessage = (ev) => {
            if (ev.data === 'pong') return;
            let m;
            try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (handlers[m.t]) handlers[m.t](m);
        };
        s.onclose = (ev) => {
            clearInterval(hbTimer);
            if (sock === s) sock = null;
            if (ev.code === 4002) { want = false; GCL.auth.logout(); return; } // revoked / banned
            if (ev.code === 4000) { want = false; return; }                    // replaced by another tab
            schedule();
        };
        s.onerror = () => {};
    }

    function disconnect() {
        want = false;
        clearTimeout(retryTimer); retryTimer = null;
        if (sock) { send({ t: 'bye' }); try { sock.close(1000); } catch (e) {} sock = null; }
    }

    GCL.presence = {
        setHandlers: (h) => { handlers = h; },
        setRoom: (r) => { if (r !== room) { room = r; if (sock) disconnect(); } if (GCL.auth.isLoggedIn()) { want = true; connect(); } },
        getRoom: () => room,
        hello: (pid, gname) => { selfPid = pid; if (typeof gname === 'string') selfGname = gname; if (isOpen()) send({ t: 'hello', pid, gname: selfGname || '' }); else connect(); },
        bye: () => { selfPid = null; selfGname = null; send({ t: 'bye' }); },
        lookup: (ids) => send({ t: 'lookup', ids }),
        isOpen,
        disconnect,
    };

    GCL.events.addEventListener('login', () => { if (room) { want = true; connect(); } });
    GCL.events.addEventListener('logout', disconnect);
    window.addEventListener('pagehide', disconnect);
})();

// ============================================================================
// MODULE 4 — hook_handler: frame decoding, name swap, blank-aware merge, deferred rebuild
// ============================================================================
(function hook_handler() {
    'use strict';

    const ghosts = {};         // id -> last known player data
    const LAZY_IDS = {};       // id -> resolved community username
    const PRESENCE_CLAIMS = {}; // id -> { name, gname }; accepted only when gname matches the d-frame username
    let INJECT_MESSAGES = [];  // frames appended to the next outgoing batch
    const lookupState = {};    // id -> { tries, next }
    let nextLookupAt = 0;
    let selfId = null;
    let selfGname = null;

    const isFilled = (v) => v !== undefined && v !== '';
    function mergeFields(target, source, fields) {
        for (const f of fields) if (isFilled(source[f])) target[f] = source[f];
    }
    const clearObj = (o) => { for (const k of Object.keys(o)) delete o[k]; };

    function decodeRelevant(raw) {
        if (!raw || raw.length === 0) return null;
        const parts = raw.split(',');
        switch (parts[0]) {
            case 'a': return { code: 'a', id: parts[1], msg: parts };
            case 'b': return { code: 'b', id: parts[1], x: parts[2], y: parts[3], spdX: parts[4], spdY: parts[5], playerAngle: parts[6] };
            case 'c': return {
                code: 'c', id: parts[1], currentBullets: parts[2], shooting: parts[3], reloading: parts[4], hp: parts[5],
                beingHit: parts[6], armorAmount: parts[7], radius: parts[8], ghillie: parts[9], maxBullets: parts[10],
                invincible: parts[11], dashing: parts[12], chatBoxOpen: parts[13], isLeader: parts[14],
                colorCode: parts[15], chatMessage: parts[16],
            };
            case 'd': return {
                code: 'd', id: parts[1], classCode: parts[2], colorCode: parts[3], x: parts[4], y: parts[5], radius: parts[6],
                playerAngle: parts[7], armorAmount: parts[8], hp: parts[9], maxBullets: parts[10], username: parts[11],
                ghillie: parts[12], invincible: parts[13], isLeader: parts[14], isPremiumMember: parts[15],
                teamCode: parts[16], chatBoxOpen: parts[17],
            };
            case 'e': return { code: 'e', id: parts[1] };
            case 's': return { code: 's' };
            default: return { code: parts[0] };
        }
    }

    // Queue a re-init + status frame carrying the community name.
    function rebuildPlayer(id, ghost) {
        // No injection until a real 'c' frame filled colorCode/radius/hp, or we would wipe the body.
        if (!ghost.hasStatus) return;
        const name = LAZY_IDS[id] || ghost.username;
        if (ghost.shownName === name) return;
        ghost.shownName = name;

        const PLAYER_REINIT = [
            'd', id, ghost.classCode, ghost.colorCode, ghost.x, ghost.y, ghost.radius, ghost.playerAngle,
            ghost.armorAmount, ghost.hp, ghost.maxBullets, name, ghost.ghillie, ghost.invincible,
            ghost.isLeader, ghost.isPremiumMember, ghost.teamCode, ghost.chatBoxOpen,
        ].join(',');
        const PLAYER_UPDATE = [
            'c', id, ghost.currentBullets, ghost.shooting, ghost.reloading, ghost.hp, ghost.beingHit,
            ghost.armorAmount, ghost.radius, ghost.ghillie, ghost.maxBullets, ghost.invincible, ghost.dashing,
            ghost.chatBoxOpen, ghost.isLeader, ghost.colorCode, ghost.chatMessage ?? '',
        ].join(',');
        INJECT_MESSAGES.push(PLAYER_REINIT, PLAYER_UPDATE);
    }

    function applyName(pid, name, gname) {
        if (pid === selfId) return;
        if (typeof name !== 'string' || typeof gname !== 'string' || !gname) {
            delete LAZY_IDS[pid];
            delete PRESENCE_CLAIMS[pid];
            return;
        }
        PRESENCE_CLAIMS[pid] = { name, gname };
        const ghost = ghosts[pid];
        if (!ghost) { delete LAZY_IDS[pid]; return; }
        if (ghost.username !== gname) {
            // pid reuse or an unverified claim: do not display this community identity.
            delete LAZY_IDS[pid];
            delete PRESENCE_CLAIMS[pid];
            return;
        }
        LAZY_IDS[pid] = name;
        rebuildPlayer(pid, ghost);
    }

    // ---- observe every frame ----
    GCL.ws.onEveryFrame((raw) => {
        const f = decodeRelevant(raw);
        if (!f) return;
        switch (f.code) {
            case 'a': {
                clearObj(ghosts); clearObj(LAZY_IDS); clearObj(PRESENCE_CLAIMS); clearObj(lookupState);
                selfId = f.id;
                selfGname = typeof f.msg[18] === 'string' ? f.msg[18] : '';
                try { GCL.presence.setRoom(new URL(GCL.ws.getCurrentServerUrl()).host.toLowerCase()); } catch (e) {}
                if (GCL.auth.isLoggedIn()) GCL.presence.hello(selfId, selfGname);
                break;
            }
            case 'b': {
                // Movement updates do not create entities; only a real d-frame initializes a player.
                const g = ghosts[f.id];
                if (!g) break;
                mergeFields(g, f, ['x', 'y', 'spdX', 'spdY', 'playerAngle']);
                break;
            }
            case 'c': {
                // Aux/status updates for an unknown id can arrive late after an e-frame; ignore them.
                const g = ghosts[f.id];
                if (!g) break;
                mergeFields(g, f, ['currentBullets', 'shooting', 'reloading', 'hp', 'beingHit', 'armorAmount', 'radius',
                    'ghillie', 'maxBullets', 'invincible', 'dashing', 'chatBoxOpen', 'isLeader', 'colorCode']);
                g.chatMessage = f.chatMessage; // blank = no message: assign, never delta-merge (else rebuild replays old chat)
                if (isFilled(g.radius) && isFilled(g.colorCode)) g.hasStatus = true;
                if (g.hasStatus && LAZY_IDS[f.id]) rebuildPlayer(f.id, g); // retry deferred rebuilds
                break;
            }
            case 'd': {
                if (f.id === selfId) break;
                const g = ghosts[f.id] = {};
                mergeFields(g, f, ['classCode', 'colorCode', 'x', 'y', 'radius', 'playerAngle', 'armorAmount', 'hp', 'maxBullets',
                    'username', 'ghillie', 'invincible', 'isLeader', 'isPremiumMember', 'teamCode', 'chatBoxOpen']);
                g.shownName = f.username; // the transformer below overrides this when it swaps the name
                const claim = PRESENCE_CLAIMS[f.id];
                if (claim) applyName(f.id, claim.name, claim.gname);
                break;
            }
            case 'e':
                delete ghosts[f.id]; delete LAZY_IDS[f.id]; delete PRESENCE_CLAIMS[f.id]; delete lookupState[f.id];
                break;
        }
    });

    // ---- rewrite frames on the way to the game ----
    GCL.ws.addFrameTransformer((frame, meta) => {
        let out = frame;
        if (frame.charCodeAt(0) === 97 || frame.charCodeAt(0) === 100) { // 'a' or 'd'
            const p = frame.split(',');
            if (p[0] === 'a' && GCL.auth.isLoggedIn()) {
                p[18] = GCL.auth.getUser().username; // own display name
                if (p.length > 23) p[23] = GCL.auth.getUser().username; // isolatedUsername is a separate field
                out = p.join(',');
            } else if (p[0] === 'd' && LAZY_IDS[p[1]] && p[1] !== selfId) {
                p[11] = LAZY_IDS[p[1]];
                out = p.join(',');
                if (ghosts[p[1]]) ghosts[p[1]].shownName = LAZY_IDS[p[1]];
            }
        }
        if (meta.frame_id === meta.total_frames - 1 && INJECT_MESSAGES.length) {
            out += '|' + INJECT_MESSAGES.join('|');
            INJECT_MESSAGES = [];
        }
        return out;
    });

    // ---- ask the room about players we still can't name (throttled, with backoff) ----
    GCL.ws.onBatchComplete(() => {
        const now = Date.now();
        if (now < nextLookupAt || !GCL.presence.isOpen()) return;
        const ids = [];
        for (const id of Object.keys(ghosts)) {
            if (id === selfId || LAZY_IDS[id]) continue;
            const s = lookupState[id] || (lookupState[id] = { tries: 0, next: 0 });
            if (s.tries >= 4 || now < s.next) continue;
            s.tries++;
            s.next = now + 15000 * 2 ** (s.tries - 1);
            ids.push(id);
            if (ids.length >= 50) break;
        }
        if (ids.length) { nextLookupAt = now + 2000; GCL.presence.lookup(ids); }
    });

    GCL.ws.onSocketClose(() => {
        clearObj(ghosts); clearObj(LAZY_IDS); clearObj(lookupState);
        INJECT_MESSAGES = []; selfId = null;
        GCL.presence.bye();
    });

    // ---- presence pushes ----
    GCL.presence.setHandlers({
        roster: (m) => { for (const p of m.players || []) applyName(p.pid, p.name, p.gname); },
        join: (m) => applyName(m.pid, m.name, m.gname),
        rename: (m) => applyName(m.pid, m.name, m.gname),
        names: (m) => { for (const [pid, claim] of Object.entries(m.names || {})) applyName(pid, claim && claim.name, claim && claim.gname); },
        leave: (m) => { delete LAZY_IDS[m.pid]; delete PRESENCE_CLAIMS[m.pid]; },
    });

    GCL.events.addEventListener('login', () => { if (selfId) GCL.presence.hello(selfId, selfGname); });
})();
