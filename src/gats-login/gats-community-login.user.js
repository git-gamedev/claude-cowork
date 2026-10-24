// ==UserScript==
// @name         gats.io Community Login + Presence
// @namespace    https://gats.io/
// @version      3.0
// @description  Community accounts and presence for gats.io (token kept in GM storage, one presence socket)
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

(function () {
    'use strict';

    const CFG = {
        WORKER_URL: 'https://login-info-handler.gitgames.workers.dev',
        PBKDF2_ITER: 310000,        // client-side password stretching (server enforces >= 200000)
        STRICT_NAME_MATCH: true,    // only show a community name if the claimed in-game name matches the 'd' frame
        DEBUG: false,
    };

    const PAGE = unsafeWindow;                 // the game's real window
    const NativeWebSocket = PAGE.WebSocket;    // captured BEFORE we hook it; presence socket uses this
    const dlog = (...a) => { if (CFG.DEBUG) console.log('[gcl]', ...a); };

    // ========================================================================
    // MODULE 1 — auth_ui: token storage, API calls, modals, badge
    // The token lives in GM storage, so the game page's scripts cannot read it.
    // ========================================================================

    const auth = (function () {
        const SESSION_KEY = 'gcl_session';
        let currentUser = null;   // { id, username }
        let currentToken = null;
        let online = false;       // presence socket state, for the badge
        const listeners = { login: [], logout: [] };

        function on(evt, fn) { listeners[evt].push(fn); }
        function emit(evt) {
            for (const fn of listeners[evt]) {
                try { fn(); } catch (e) { console.error('[gcl]', e); }
            }
        }

        // [HELPER] session storage ------------------------------------------
        function saveSession(s) { GM_setValue(SESSION_KEY, JSON.stringify(s)); }
        function clearSession() { GM_deleteValue(SESSION_KEY); }
        function loadSession() {
            try {
                const s = JSON.parse(GM_getValue(SESSION_KEY, 'null'));
                if (s && s.token && s.expiresAt > Date.now()) return s;
            } catch (e) { /* corrupt, ignore */ }
            return null;
        }

        // [HELPER] worker call (GM_xmlhttpRequest avoids CORS entirely) -------
        function apiCall(path, { method = 'POST', token = null, body = null } = {}) {
            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method,
                    url: CFG.WORKER_URL + path,
                    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
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

        // [HELPER] base64url + client-side password stretching ----------------
        const b64u = {
            enc(bytes) {
                let s = '';
                for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
                return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            },
            dec(str) {
                let s = str.replace(/-/g, '+').replace(/_/g, '/');
                while (s.length % 4) s += '=';
                const bin = atob(s);
                const out = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
                return out;
            },
        };

        // The password never leaves the browser; only this derived key is sent.
        async function deriveKey(password, saltB64, iter) {
            const n = Math.min(Math.max(iter | 0, 100000), 2000000);
            const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
            const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64u.dec(saltB64), iterations: n }, base, 256);
            return b64u.enc(new Uint8Array(bits));
        }

        // [HELPER] API wrappers -------------------------------------------------
        async function getKdf(username) {
            const r = await apiCall('/prelogin', { body: { username } });
            if (r.status !== 200) throw new Error(r.data.error || 'network');
            return r.data;
        }
        async function apiLogin(username, password) {
            const kdf = await getKdf(username);
            const key = await deriveKey(password, kdf.salt, kdf.iter);
            return apiCall('/login', { body: { username, key } });
        }
        async function apiSignup(username, password) {
            const salt = b64u.enc(crypto.getRandomValues(new Uint8Array(16)));
            const iter = CFG.PBKDF2_ITER;
            const key = await deriveKey(password, salt, iter);
            return apiCall('/signup', { body: { username, salt, iter, key } });
        }
        const apiRename = (username) => apiCall('/rename', { token: currentToken, body: { username } });
        const apiLogoutAll = () => apiCall('/logout_all', { token: currentToken });
        async function apiUnregister(password) {
            const kdf = await getKdf(currentUser.username);
            const key = await deriveKey(password, kdf.salt, kdf.iter);
            return apiCall('/unregister', { token: currentToken, body: { key } });
        }

        // [HELPER] HTML escaping -----------------------------------------------
        function escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        // [HELPER] modal shell ---------------------------------------------------
        function closeModal() {
            const overlay = document.getElementById('gcl-modal-overlay');
            if (overlay) overlay.remove();
        }
        function openModal(innerHTML) {
            closeModal();
            const overlay = document.createElement('div');
            overlay.id = 'gcl-modal-overlay';
            overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
            // Keep typing in our inputs from reaching the game's key handlers (WASD, chat, ...).
            for (const ev of ['keydown', 'keyup', 'keypress']) overlay.addEventListener(ev, (e) => e.stopPropagation());

            const modal = document.createElement('div');
            modal.id = 'gcl-modal';
            modal.innerHTML = '<button class="gcl-close" data-close>&times;</button>' + innerHTML;
            modal.querySelector('[data-close]').addEventListener('click', closeModal);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            return modal;
        }
        function setMsg(modal, text, ok) {
            const el = modal.querySelector('.gcl-msg');
            if (!el) return;
            el.textContent = text || '';
            el.className = 'gcl-msg' + (ok ? ' ok' : '');
        }
        async function busy(modal, btn, label, fn) {
            const old = btn.textContent;
            btn.disabled = true;
            btn.textContent = label;
            try { await fn(); }
            catch (e) { setMsg(modal, errText({ data: { error: e.message } })); }
            finally { btn.disabled = false; btn.textContent = old; }
        }
        function errText(r) {
            const e = (r.data && r.data.error) || 'unknown';
            const map = {
                invalid_credentials: 'Wrong username or password.',
                locked: 'Too many attempts. Try again in ' + Math.ceil(((r.data && r.data.retryAfter) || 600) / 60) + ' min.',
                banned: 'This account is banned.',
                name_taken: 'That username is taken.',
                bad_username: 'Username: 3-15 letters, numbers or _.',
                rate_limited: 'Too many sign-ups from your network. Try later.',
                rename_cooldown: 'You can rename once per day.',
                network: 'Could not reach the login server.',
                timeout: 'The login server timed out.',
            };
            return map[e] || 'Error: ' + e;
        }

        // [UI] style + badge ------------------------------------------------------
        function injectStyle() {
            const st = document.createElement('style');
            st.textContent = `
#gcl-badge{position:fixed;left:8px;bottom:8px;z-index:99998;font:12px/1 sans-serif;background:rgba(20,20,28,.85);color:#fff;padding:6px 10px;border-radius:14px;cursor:pointer;user-select:none;border:1px solid #444}
#gcl-badge .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#888;margin-right:6px}
#gcl-badge.online .dot{background:#3ddc84}
#gcl-modal-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center}
#gcl-modal{position:relative;width:300px;background:#1b1b24;color:#eee;padding:20px;border-radius:10px;font:14px sans-serif;box-shadow:0 8px 30px #000}
#gcl-modal h3{margin:0 0 12px;font-size:16px}
#gcl-modal input{width:100%;box-sizing:border-box;margin:4px 0 8px;padding:8px;border-radius:6px;border:1px solid #444;background:#111;color:#fff}
#gcl-modal .gcl-btn{width:100%;padding:9px;border:0;border-radius:6px;background:#3b82f6;color:#fff;cursor:pointer;margin-top:4px}
#gcl-modal .gcl-btn.alt{background:#444}
#gcl-modal .gcl-btn.danger{background:#c0392b}
#gcl-modal .gcl-btn:disabled{opacity:.6;cursor:wait}
#gcl-modal .gcl-close{position:absolute;top:6px;right:10px;background:none;border:0;color:#aaa;font-size:20px;cursor:pointer}
#gcl-modal .gcl-msg{min-height:16px;color:#ff8a80;margin:2px 0 6px;font-size:12px}
#gcl-modal .gcl-msg.ok{color:#8aff9b}
#gcl-modal a{color:#8ab4ff;cursor:pointer;font-size:12px}
#gcl-modal hr{border:0;border-top:1px solid #333;margin:12px 0}`;
            document.documentElement.appendChild(st);
        }
        function ensureBadge() {
            let b = document.getElementById('gcl-badge');
            if (!b) {
                b = document.createElement('div');
                b.id = 'gcl-badge';
                b.addEventListener('click', () => (isLoggedIn() ? showAccountModal() : showLoginModal()));
                document.body.appendChild(b);
            }
            return b;
        }
        function updateBadge() {
            if (!document.body) return;
            const b = ensureBadge();
            b.className = online ? 'online' : '';
            b.innerHTML = '<span class="dot"></span>' + (currentUser ? escapeHtml(currentUser.username) : 'Community login');
            b.title = currentUser ? (online ? 'Connected to presence' : 'Logged in') : 'Click to log in';
        }
        function setOnline(flag) { online = flag; updateBadge(); }

        // [UI] modals ---------------------------------------------------------------
        function showLoginModal(note) {
            const m = openModal(`<h3>Community login</h3>
<input id="gcl-u" placeholder="Username" maxlength="15" autocomplete="username">
<input id="gcl-p" type="password" placeholder="Password" autocomplete="current-password">
<div class="gcl-msg">${escapeHtml(note || '')}</div>
<button class="gcl-btn" id="gcl-go">Log in</button>
<div style="margin-top:8px"><a id="gcl-reg">Create an account</a></div>`);
            const go = m.querySelector('#gcl-go');
            const run = () => busy(m, go, 'Logging in…', async () => {
                const u = m.querySelector('#gcl-u').value.trim();
                const p = m.querySelector('#gcl-p').value;
                if (!u || !p) return setMsg(m, 'Enter username and password.');
                const r = await apiLogin(u, p);
                if (r.status === 200) { onLoginSuccess(r.data); closeModal(); }
                else setMsg(m, errText(r));
            });
            go.addEventListener('click', run);
            m.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
            m.querySelector('#gcl-reg').addEventListener('click', () => showRegisterModal());
        }

        function showRegisterModal() {
            const m = openModal(`<h3>Create account</h3>
<input id="gcl-u" placeholder="Username (3-15: letters, numbers, _)" maxlength="15" autocomplete="username">
<input id="gcl-p" type="password" placeholder="Password (8+ characters)" autocomplete="new-password">
<input id="gcl-p2" type="password" placeholder="Repeat password" autocomplete="new-password">
<div class="gcl-msg"></div>
<button class="gcl-btn" id="gcl-go">Sign up</button>
<div style="margin-top:8px"><a id="gcl-back">Back to login</a></div>`);
            const go = m.querySelector('#gcl-go');
            const run = () => busy(m, go, 'Creating…', async () => {
                const u = m.querySelector('#gcl-u').value.trim();
                const p = m.querySelector('#gcl-p').value;
                if (!/^[A-Za-z0-9_]{3,15}$/.test(u)) return setMsg(m, errText({ data: { error: 'bad_username' } }));
                if (p.length < 8) return setMsg(m, 'Password must be at least 8 characters.');
                if (p !== m.querySelector('#gcl-p2').value) return setMsg(m, 'Passwords do not match.');
                const r = await apiSignup(u, p);
                if (r.status === 201) { onLoginSuccess(r.data); closeModal(); }
                else setMsg(m, errText(r));
            });
            go.addEventListener('click', run);
            m.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
            m.querySelector('#gcl-back').addEventListener('click', () => showLoginModal());
        }

        function showAccountModal() {
            if (!currentUser) return showLoginModal();
            const m = openModal(`<h3>${escapeHtml(currentUser.username)}</h3>
<input id="gcl-n" placeholder="New username" maxlength="15">
<button class="gcl-btn" id="gcl-ren">Rename (once per day)</button>
<div class="gcl-msg"></div>
<button class="gcl-btn alt" id="gcl-out">Log out</button>
<button class="gcl-btn alt" id="gcl-outall">Log out everywhere</button>
<hr>
<input id="gcl-dp" type="password" placeholder="Password to confirm" autocomplete="current-password">
<button class="gcl-btn danger" id="gcl-del">Delete account</button>`);
            const ren = m.querySelector('#gcl-ren');
            ren.addEventListener('click', () => busy(m, ren, 'Renaming…', async () => {
                const n = m.querySelector('#gcl-n').value.trim();
                if (!/^[A-Za-z0-9_]{3,15}$/.test(n)) return setMsg(m, errText({ data: { error: 'bad_username' } }));
                const r = await apiRename(n);
                if (r.status === 200) { onLoginSuccess(r.data, true); closeModal(); }
                else setMsg(m, errText(r));
            }));
            m.querySelector('#gcl-out').addEventListener('click', () => { performLogout(); closeModal(); });
            const all = m.querySelector('#gcl-outall');
            all.addEventListener('click', () => busy(m, all, 'Working…', async () => {
                const r = await apiLogoutAll();
                if (r.status === 200) { performLogout(); closeModal(); } else setMsg(m, errText(r));
            }));
            const del = m.querySelector('#gcl-del');
            del.addEventListener('click', () => busy(m, del, 'Deleting…', async () => {
                const p = m.querySelector('#gcl-dp').value;
                if (!p) return setMsg(m, 'Enter your password to confirm.');
                if (!confirm('Permanently delete your community account?')) return;
                const r = await apiUnregister(p);
                if (r.status === 200) { performLogout(); closeModal(); } else setMsg(m, errText(r));
            }));
        }

        // [LIFECYCLE] ------------------------------------------------------------------
        function isLoggedIn() { return !!currentToken; }

        function onLoginSuccess(data, silent) {
            currentToken = data.token;
            currentUser = data.user;
            saveSession({ token: data.token, expiresAt: data.expiresAt, user: data.user });
            updateBadge();
            if (!silent) emit('login');
        }

        function performLogout(note) {
            currentToken = null;
            currentUser = null;
            online = false;
            clearSession();
            updateBadge();
            emit('logout');
            if (note && document.body) showLoginModal(note);
        }

        // Re-validates the stored token (ban/revocation/rename aware) and swaps in a fresh one.
        async function refreshSession() {
            if (!currentToken) return false;
            const r = await apiCall('/refresh', { token: currentToken });
            if (r.status === 200) { onLoginSuccess(r.data, true); return true; }
            if (r.status === 401 || r.status === 403) {
                performLogout(r.data.error === 'banned' ? 'This account is banned.' : 'Session expired, please log in again.');
            }
            return false;
        }

        function tryAutoLogin() {
            const s = loadSession();
            if (!s) return;
            currentToken = s.token;
            currentUser = s.user;
            emit('login');
            refreshSession();
        }

        function init() { injectStyle(); updateBadge(); }

        return {
            isLoggedIn, on, setOnline, refreshSession, tryAutoLogin, init, showLoginModal, performLogout,
            getUser: () => currentUser,
            getToken: () => currentToken,
        };
    })();

    // ========================================================================
    // MODULE 2 — ws_hook: WebSocket tap (unchanged logic, now hooks the page's window)
    // ========================================================================

    const wsHook = (function () {
        const RealWebSocket = NativeWebSocket;

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
                                for (let i = 0; i < patchedText.length; i++) buf[i] = patchedText.charCodeAt(i);
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
                    dlog('dispatcher fired but realHandler not yet set — frame dropped');
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

        PAGE.WebSocket = HookedWebSocket;

        return {
            getActiveSocket: () => activeSocket,
            getCurrentServerUrl: () => currentServerUrl,
            getRealHandler: () => realHandler,
            dispatchRawToRealHandler,
            onEveryFrame, addFrameTransformer, addPostDispatchHook, onBatchComplete, onSocketClose,
        };
    })();

    // ========================================================================
    // MODULE 3 — hook_handler + presence
    // ========================================================================

    (function hook_handler() {
        // ---- state ---------------------------------------------------------
        const ghosts = {};                 // in-game id -> last known player data
        const LAZY_IDS = {};               // in-game id -> community name to show
        const claims = new Map();          // in-game id -> { name, gname } learned from the presence room
        const pending = new Map();         // in-game id -> { tries, next } for lookups
        const INJECT_MESSAGES = [];        // frames appended to the next incoming batch
        const self = { gid: null, gname: null };
        const LOOKUP_BACKOFF = [2000, 8000, 30000];

        // [HELPER] blank check / merge ------------------------------------------
        function isFilled(v) { return v !== undefined && v !== ''; }
        function mergeFields(target, source, fields) {
            for (const f of fields) if (isFilled(source[f])) target[f] = source[f];
        }

        // [HELPER] parse a raw frame ----------------------------------------------
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

        // The community name to display for a player, or null.
        function nameFor(gid, ingameName) {
            const c = claims.get(gid);
            if (!c) return null;
            if (CFG.STRICT_NAME_MATCH && c.gname !== ingameName) return null;
            return c.name;
        }

        // [HELPER] queue a re-init + status frame carrying the community name ----
        function rebuildPlayer(id, ghost) {
            // Wait for a real status frame: before that colorCode/radius/hp may be blank and injecting wipes the body.
            if (!ghost.hasStatus) return;
            const name = LAZY_IDS[id] || ghost.username;
            ghost.shown = name === ghost.username ? null : name;

            const PLAYER_REINIT = [
                'd', id, ghost.classCode, ghost.colorCode, ghost.x, ghost.y, ghost.radius,
                ghost.playerAngle, ghost.armorAmount, ghost.hp, ghost.maxBullets, name,
                ghost.ghillie, ghost.invincible, ghost.isLeader, ghost.isPremiumMember,
                ghost.teamCode, ghost.chatBoxOpen,
            ].join(',');

            const PLAYER_UPDATE = [
                'c', id, ghost.currentBullets, ghost.shooting, ghost.reloading, ghost.hp,
                ghost.beingHit, ghost.armorAmount, ghost.radius, ghost.ghillie, ghost.maxBullets,
                ghost.invincible, ghost.dashing, ghost.chatBoxOpen, ghost.isLeader, ghost.colorCode,
                ghost.chatMessage ?? '',
            ].join(',');

            INJECT_MESSAGES.push(PLAYER_REINIT, PLAYER_UPDATE);
            dlog('rebuild', id, name);
        }

        // Apply whatever the room told us about this player.
        function resolve(gid) {
            const g = ghosts[gid];
            if (!g) return;
            const n = nameFor(gid, g.username);
            if (n && g.shown !== n) {
                LAZY_IDS[gid] = n;
                rebuildPlayer(gid, g);
            }
        }
        function resolveAll() { for (const gid of Object.keys(ghosts)) resolve(gid); }

        // ---- presence socket --------------------------------------------------------
        const presence = { ws: null, room: null, open: false, everOpened: false, want: false, backoff: 1000, hb: null, retry: null, lastPong: 0 };

        function roomFromUrl(u) {
            try { return new URL(u).host.toLowerCase(); } catch (e) { return null; }
        }
        function psend(obj) {
            if (presence.ws && presence.open) presence.ws.send(JSON.stringify(obj));
        }
        function sendClaim() {
            if (self.gid) psend({ t: 'claim', gid: self.gid, gname: self.gname || '' });
        }

        function stopTimers() {
            clearInterval(presence.hb); presence.hb = null;
            clearTimeout(presence.retry); presence.retry = null;
        }

        function presenceClose() {
            presence.want = false;
            stopTimers();
            const ws = presence.ws;
            presence.ws = null;
            presence.open = false;
            presence.room = null;
            if (ws) { try { ws.close(1000); } catch (e) { /* ignore */ } }
            auth.setOnline(false);
        }

        function presenceConnect(room) {
            if (!auth.isLoggedIn() || !room) return;
            if (presence.ws && presence.room === room) return;
            presenceClose();
            presence.room = room;
            presence.want = true;
            presence.everOpened = false;
            openSocket();
        }

        function openSocket() {
            if (!presence.want || !auth.isLoggedIn()) return;
            const url = CFG.WORKER_URL.replace(/^http/, 'ws') + '/presence?room=' + encodeURIComponent(presence.room);
            let ws;
            try {
                // Token goes in the subprotocol list (kept out of the URL); never sent to the game server.
                ws = new NativeWebSocket(url, ['gcl.v1', 'tok.' + auth.getToken()]);
            } catch (e) {
                console.error('[gcl] presence connect failed', e);
                return scheduleReconnect();
            }
            presence.ws = ws;

            ws.onopen = () => {
                presence.open = true;
                presence.everOpened = true;
                presence.backoff = 1000;
                presence.lastPong = Date.now();
                clearInterval(presence.hb);
                presence.hb = setInterval(() => {
                    if (Date.now() - presence.lastPong > 70000) { try { ws.close(); } catch (e) { /* ignore */ } return; }
                    try { ws.send('ping'); } catch (e) { /* ignore */ }
                }, 25000);
                auth.setOnline(true);
                sendClaim();
            };
            ws.onmessage = (e) => onPresenceMessage(e.data);
            ws.onclose = () => {
                if (presence.ws !== ws) return;     // replaced or closed on purpose
                presence.ws = null;
                presence.open = false;
                clearInterval(presence.hb); presence.hb = null;
                auth.setOnline(false);
                if (!presence.want) return;
                if (!presence.everOpened) {
                    // Rejected before the upgrade (expired/revoked token?) - re-validate, then retry.
                    auth.refreshSession().then((ok) => { if (ok) scheduleReconnect(); });
                } else {
                    scheduleReconnect();
                }
            };
            ws.onerror = () => { /* onclose follows */ };
        }

        function scheduleReconnect() {
            if (!presence.want) return;
            clearTimeout(presence.retry);
            presence.retry = setTimeout(openSocket, presence.backoff);
            presence.backoff = Math.min(presence.backoff * 2, 60000);
        }

        function onPresenceMessage(raw) {
            if (raw === 'pong') { presence.lastPong = Date.now(); return; }
            let m;
            try { m = JSON.parse(raw); } catch (e) { return; }
            switch (m.t) {
                case 'roster':
                    claims.clear();
                    for (const gid of Object.keys(m.players || {})) claims.set(gid, m.players[gid]);
                    resolveAll();
                    break;
                case 'join':
                    claims.set(m.gid, { name: m.name, gname: m.gname });
                    pending.delete(m.gid);
                    resolve(m.gid);
                    break;
                case 'leave':
                    claims.delete(m.gid);
                    break;
                case 'rename': {
                    const c = claims.get(m.gid);
                    if (c) { c.name = m.name; resolve(m.gid); }
                    break;
                }
                case 'names':
                    for (const gid of Object.keys(m.players || {})) {
                        claims.set(gid, { name: m.players[gid].name, gname: m.players[gid].gname });
                        resolve(gid);
                    }
                    break;
                case 'denied':
                    dlog('claim denied for', m.gid);
                    break;
                case 'kick':
                    if (m.reason === 'banned' || m.reason === 'deleted' || m.reason === 'revoked') {
                        presenceClose();
                        auth.performLogout(m.reason === 'banned' ? 'This account is banned.' : 'You were logged out.');
                    } else {
                        presenceClose();   // 'replaced' (another tab took over) or 'stale'
                    }
                    break;
            }
        }

        // Ask the room about players we saw but could not resolve (backoff, max 3 tries each).
        function pumpLookups() {
            if (!presence.open || pending.size === 0) return;
            const now = Date.now();
            const ids = [];
            for (const [id, st] of pending) {
                const g = ghosts[id];
                if (!g || (g.shown && g.shown !== g.username)) { pending.delete(id); continue; }
                if (now < st.next) continue;
                ids.push(id);
                st.tries++;
                if (st.tries >= LOOKUP_BACKOFF.length) pending.delete(id);
                else st.next = now + LOOKUP_BACKOFF[st.tries];
                if (ids.length >= 50) break;
            }
            if (ids.length) psend({ t: 'lookup', ids });
        }

        function resetGameState() {
            for (const k of Object.keys(ghosts)) delete ghosts[k];
            for (const k of Object.keys(LAZY_IDS)) delete LAZY_IDS[k];
            pending.clear();
            INJECT_MESSAGES.length = 0;
        }

        // ---- wire into the websocket tap ------------------------------------------------
        wsHook.onEveryFrame((frame) => {
            const d = decodeRelevant(frame);
            if (!d) return;
            switch (d.code) {
                case 'a':
                    resetGameState();
                    self.gid = d.id;
                    self.gname = d.msg[18];
                    if (auth.isLoggedIn()) {
                        presenceConnect(roomFromUrl(wsHook.getCurrentServerUrl()));
                        sendClaim();
                    }
                    break;
                case 'b': {
                    const g = ghosts[d.id];
                    if (g) mergeFields(g, d, ['x', 'y', 'spdX', 'spdY', 'playerAngle']);
                    break;
                }
                case 'c': {
                    const g = ghosts[d.id];
                    if (!g) break;
                    mergeFields(g, d, ['currentBullets', 'shooting', 'reloading', 'hp', 'beingHit', 'armorAmount', 'radius',
                        'ghillie', 'maxBullets', 'invincible', 'dashing', 'chatBoxOpen', 'isLeader', 'colorCode', 'chatMessage']);
                    if (!g.hasStatus && isFilled(g.radius) && isFilled(g.colorCode)) {
                        g.hasStatus = true;
                        resolve(d.id);     // retry a rebuild that was deferred until real data existed
                    }
                    break;
                }
                case 'd': {
                    const g = Object.assign({}, d);
                    g.hasStatus = isFilled(d.radius) && isFilled(d.colorCode);
                    g.shown = nameFor(d.id, d.username);    // the transformer below swaps the name in this very frame
                    ghosts[d.id] = g;
                    if (!g.shown) pending.set(d.id, { tries: 0, next: Date.now() + LOOKUP_BACKOFF[0] });
                    break;
                }
                case 'e':
                    delete ghosts[d.id];
                    delete LAZY_IDS[d.id];
                    pending.delete(d.id);
                    break;
            }
        });

        wsHook.addFrameTransformer((frame, meta) => {
            let out = frame;
            const c0 = frame.charCodeAt(0);
            if ((c0 === 97 || c0 === 100) && frame.charCodeAt(1) === 44) {   // 'a,' or 'd,'
                const parts = frame.split(',');
                if (parts[0] === 'a' && auth.isLoggedIn() && parts.length > 18) {
                    const myName = auth.getUser().username;
                    if (parts[23] === parts[18]) parts[23] = myName;
                    parts[18] = myName;
                    out = parts.join(',');
                } else if (parts[0] === 'd' && parts.length > 11) {
                    const n = nameFor(parts[1], parts[11]);
                    if (n) { parts[11] = n; out = parts.join(','); }
                }
            }
            if (meta.frame_id === meta.total_frames - 1 && INJECT_MESSAGES.length) {
                out += '|' + INJECT_MESSAGES.join('|');
                INJECT_MESSAGES.length = 0;
            }
            return out;
        });

        wsHook.onBatchComplete(pumpLookups);

        wsHook.onSocketClose(() => {
            presenceClose();
            claims.clear();
            resetGameState();
            self.gid = null;
            self.gname = null;
        });

        auth.on('login', () => {
            const url = wsHook.getCurrentServerUrl();
            if (url) presenceConnect(roomFromUrl(url));
        });
        auth.on('logout', () => {
            presenceClose();
            claims.clear();
        });

        PAGE.addEventListener('pagehide', () => { if (presence.ws) try { presence.ws.close(1000); } catch (e) { /* ignore */ } });
    })();

    // ---- boot ---------------------------------------------------------------------------
    auth.tryAutoLogin();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auth.init);
    else auth.init();
})();
