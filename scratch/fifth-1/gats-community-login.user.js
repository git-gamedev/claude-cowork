// ==UserScript==
// @name         gats.io Community Login + Presence
// @namespace    https://gats.io/
// @version      3.0
// @description  Community accounts for gats.io: log in, pick a display name, and see other community players' names in game.
// @match        https://gats.io/*
// @connect      login-info-handler.gitgames.workers.dev
// @license      MIT
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

// Private channel between the modules below. It is a plain variable in this
// script's scope (NOT a property of window), so the game page and its ad
// scripts cannot reach the token or any of these functions.
const GCL = Object.create(null);

// The game's own window. With @grant (needed for GM_setValue) this script runs
// in a sandbox, so the WebSocket hook has to be installed on unsafeWindow.
const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

// ============================================================================
// MODULE 1 — auth_ui
// Token storage (GM_setValue), worker calls (GM_xmlhttpRequest), PBKDF2 on the
// client, login / register / account UI inside a closed shadow root.
// ============================================================================

(function auth_ui() {
    'use strict';

    const WORKER_URL = 'https://login-info-handler.gitgames.workers.dev';
    const SESSION_KEY = 'gcl_session';
    const LAST_USER_KEY = 'gcl_last_username';
    const KDF_ITER = 250000;          // used for new accounts
    const KDF_MIN = 100000;           // refuse server-supplied values outside this range
    const KDF_MAX = 2000000;

    // ---- state ----------------------------------------------------------
    let currentUser = null; // { id, username } once logged in
    let currentToken = null;
    let currentExp = 0;

    // ---- tiny event emitter (private; replaces window 'gcl:*' events) -------
    const listeners = {};
    function on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); }
    function emit(name, detail) {
        (listeners[name] || []).forEach((fn) => {
            try { fn(detail); } catch (e) { console.error('[gcl] listener error', name, e); }
        });
    }

    // [HELPER] session storage ---------------------------------------------
    function saveSession(token, expiresAt) {
        GM_setValue(SESSION_KEY, JSON.stringify({ token, exp: expiresAt }));
    }

    function clearSession() {
        GM_deleteValue(SESSION_KEY);
    }

    function getStoredSession() {
        let s = null;
        try { s = JSON.parse(GM_getValue(SESSION_KEY, 'null')); } catch (e) { s = null; }
        if (!s || !s.token || !s.exp || Date.now() / 1000 >= s.exp) return null;
        return s;
    }

    // [HELPER] base64url ---------------------------------------------------
    function b64uEncode(bytes) {
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function b64uDecode(str) {
        const pad = '='.repeat((4 - (str.length % 4)) % 4);
        const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    // The payload is only decoded for display; the worker verifies the signature.
    function decodeTokenPayload(token) {
        try {
            const p = JSON.parse(new TextDecoder().decode(b64uDecode(String(token).split('.')[0])));
            return p && p.u && p.n ? p : null;
        } catch (e) { return null; }
    }

    // [HELPER] generic worker call -----------------------------------------
    function apiCall(path, { method = 'POST', token = null, body = null } = {}) {
        return new Promise((resolve) => {
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers.Authorization = `Bearer ${token}`;
            GM_xmlhttpRequest({
                method,
                url: WORKER_URL + path,
                headers,
                data: body ? JSON.stringify(body) : undefined,
                timeout: 15000,
                anonymous: true,
                onload: (res) => {
                    let data = {};
                    try { data = JSON.parse(res.responseText); } catch (e) { /* non-JSON */ }
                    resolve({ status: res.status, data });
                },
                onerror: () => resolve({ status: 0, data: {} }),
                ontimeout: () => resolve({ status: 0, data: {} }),
            });
        });
    }

    // [HELPER] password stretching -------------------------------------------
    // The password never leaves the browser. We run PBKDF2 here (no CPU cap) and
    // send only the 32-byte result; the worker stores a hash of that.
    async function derivePh(password, saltB64u, iter) {
        const enc = new TextEncoder();
        const prefix = enc.encode('gcl-v1|');
        const saltBytes = b64uDecode(saltB64u);
        const salt = new Uint8Array(prefix.length + saltBytes.length);
        salt.set(prefix, 0);
        salt.set(saltBytes, prefix.length);
        const key = await crypto.subtle.importKey(
            'raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']
        );
        const bits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256
        );
        return b64uEncode(new Uint8Array(bits));
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

    // ---- api wrappers -----------------------------------------------------
    async function apiSignup(username, password) {
        const salt = b64uEncode(crypto.getRandomValues(new Uint8Array(16)));
        const ph = await derivePh(password, salt, KDF_ITER);
        return apiCall('/signup', { body: { username, salt, ph, iter: KDF_ITER } });
    }

    async function fetchPh(username, password) {
        const s = await apiCall('/login/salt', { body: { username } });
        if (s.status !== 200 || !s.data.ok) return { fail: s };
        const iter = Number(s.data.iter);
        if (!Number.isInteger(iter) || iter < KDF_MIN || iter > KDF_MAX) {
            return { fail: { status: 0, data: { error: 'bad_server_reply' } } };
        }
        return { ph: await derivePh(password, s.data.salt, iter) };
    }

    async function apiLogin(username, password) {
        const r = await fetchPh(username, password);
        if (r.fail) return r.fail;
        return apiCall('/login', { body: { username, ph: r.ph } });
    }

    function apiRename(name) {
        const room = GCL.presence ? GCL.presence.getRoom() : null;
        return apiCall('/rename', { token: currentToken, body: { name, room } });
    }

    async function apiUnregister(password) {
        const r = await fetchPh(currentUser.username, password);
        if (r.fail) return r.fail;
        return apiCall('/unregister', { token: currentToken, body: { ph: r.ph } });
    }

    // ---- session lifecycle --------------------------------------------------
    // data = { token, exp, user: { id, username } }
    function onLoginSuccess(data) {
        currentToken = data.token;
        currentExp = data.exp;
        currentUser = { id: data.user.id, username: data.user.username };
        saveSession(data.token, data.exp);
        GM_setValue(LAST_USER_KEY, currentUser.username);
        updateBadge();
        emit('login', { username: currentUser.username });
    }

    function performLogout() {
        const was = !!currentToken;
        currentToken = null;
        currentUser = null;
        currentExp = 0;
        clearSession();
        updateBadge();
        if (was) emit('logout', {});
    }

    // Token rejected by the server (revoked, expired, account deleted).
    function sessionRejected(message) {
        performLogout();
        showLoginModal(message || 'Your session ended. Please log in again.');
    }

    function tryAutoLogin() {
        const s = getStoredSession();
        if (!s) { clearSession(); return false; }
        const p = decodeTokenPayload(s.token);
        if (!p) { clearSession(); return false; }
        currentToken = s.token;
        currentExp = s.exp;
        currentUser = { id: p.u, username: p.n };
        emit('login', { username: currentUser.username });
        return true;
    }

    // ---- UI: closed shadow root so the page can't query our inputs ----------
    const STYLE = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
      #gcl-badge { position: fixed; left: 10px; bottom: 10px; z-index: 2147483647; background: rgba(20,20,24,.82);
        color: #fff; font-size: 12px; padding: 6px 10px; border-radius: 14px; cursor: pointer; user-select: none;
        border: 1px solid rgba(255,255,255,.18); }
      #gcl-badge:hover { background: rgba(40,40,48,.92); }
      #gcl-badge .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: #888; }
      #gcl-badge.on .dot { background: #3ddc84; }
      #gcl-badge.warn .dot { background: #f5a623; }
      #gcl-modal-overlay { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.55);
        display: flex; align-items: center; justify-content: center; }
      #gcl-modal { position: relative; width: 340px; max-width: 92vw; background: #1c1c22; color: #eee;
        border-radius: 10px; padding: 20px; border: 1px solid #333; box-shadow: 0 10px 40px rgba(0,0,0,.6); }
      #gcl-modal h2 { margin: 0 0 6px; font-size: 18px; }
      #gcl-modal p.sub { margin: 0 0 12px; font-size: 12px; color: #aaa; line-height: 1.4; }
      #gcl-modal label { display: block; font-size: 12px; color: #bbb; margin: 8px 0 3px; }
      #gcl-modal input[type=text], #gcl-modal input[type=password] { width: 100%; padding: 8px; border-radius: 6px;
        border: 1px solid #444; background: #101014; color: #fff; font-size: 14px; }
      #gcl-modal button { margin-top: 12px; padding: 9px 12px; border-radius: 6px; border: 0; cursor: pointer;
        background: #3b82f6; color: #fff; font-size: 14px; width: 100%; }
      #gcl-modal button.secondary { background: #34343c; }
      #gcl-modal button:disabled { opacity: .55; cursor: default; }
      #gcl-modal .gcl-close { position: absolute; top: 6px; right: 8px; width: auto; margin: 0; padding: 2px 8px;
        background: transparent; font-size: 20px; color: #aaa; }
      #gcl-modal .link { display: block; margin-top: 10px; text-align: center; font-size: 12px; color: #8ab4ff; cursor: pointer; }
      #gcl-modal .gcl-msg { min-height: 16px; margin-top: 8px; font-size: 12px; color: #ff8a8a; }
      #gcl-modal .gcl-msg.ok { color: #7be3a0; }
      #gcl-modal hr { border: 0; border-top: 1px solid #333; margin: 16px 0 4px; }
      #gcl-modal .danger { font-size: 12px; color: #ff9d9d; margin-top: 8px; }
      #gcl-modal input[type=range] { width: 100%; margin-top: 6px; }
    `;

    let uiRoot = null;

    function ensureUi() {
        if (uiRoot) return uiRoot;
        if (!document.body) return null;
        const host = document.createElement('div');
        document.body.appendChild(host);
        uiRoot = host.attachShadow({ mode: 'closed' });
        const st = document.createElement('style');
        st.textContent = STYLE;
        uiRoot.appendChild(st);
        // The game listens for keys/mouse on the page: keep our UI's events to ourselves.
        ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'contextmenu', 'wheel',
         'pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach((ev) => {
            uiRoot.addEventListener(ev, (e) => e.stopPropagation());
        });
        return uiRoot;
    }

    // [HELPER] status badge ---------------------------------------------------
    function ensureBadge() {
        const root = ensureUi();
        if (!root) return null;
        let b = root.getElementById('gcl-badge');
        if (!b) {
            b = document.createElement('div');
            b.id = 'gcl-badge';
            b.addEventListener('click', () => (isLoggedIn() ? showAccountModal() : showLoginModal()));
            root.appendChild(b);
        }
        return b;
    }

    function updateBadge() {
        const b = ensureBadge();
        if (!b) return;
        b.className = isLoggedIn() ? 'on' : '';
        b.innerHTML = isLoggedIn()
            ? `<span class="dot"></span>${escapeHtml(currentUser.username)}`
            : `<span class="dot"></span>Community login`;
    }

    // [HELPER] modal shell ----------------------------------------------------
    function closeModal() {
        if (!uiRoot) return;
        const overlay = uiRoot.getElementById('gcl-modal-overlay');
        if (overlay) overlay.remove();
    }

    function openModal(innerHTML) {
        const root = ensureUi();
        if (!root) return null;
        closeModal();
        const overlay = document.createElement('div');
        overlay.id = 'gcl-modal-overlay';
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal(); });

        const modal = document.createElement('div');
        modal.id = 'gcl-modal';
        modal.innerHTML = `<button class="gcl-close" data-close>&times;</button>` + innerHTML;
        modal.querySelector('[data-close]').addEventListener('click', closeModal);
        modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

        overlay.appendChild(modal);
        root.appendChild(overlay);
        const first = modal.querySelector('input');
        if (first) first.focus();
        return modal;
    }

    // [HELPER] error text -------------------------------------------------------
    function mins(sec) { return Math.max(1, Math.ceil(sec / 60)); }
    function errText(res) {
        const e = res.data && res.data.error;
        if (res.status === 0) return "Can't reach the login server. Try again in a moment.";
        switch (e) {
            case 'invalid_credentials': return 'Wrong username or password.';
            case 'locked': return `Too many wrong passwords. Try again in ${mins(res.data.retry_after || 900)} min.`;
            case 'banned': return 'This account has been banned.';
            case 'username_taken': return 'That username is taken.';
            case 'bad_username': return 'Usernames are 3-16 letters, numbers or underscores.';
            case 'cooldown': return `You can rename again in ${mins(res.data.retry_after || 60)} min.`;
            case 'rate_limited': return 'Too many attempts. Wait a minute and try again.';
            case 'bad_token': case 'revoked': return 'Your session ended. Please log in again.';
            default: return 'Something went wrong. Try again.';
        }
    }

    function setMsg(modal, text, ok) {
        const el = modal.querySelector('.gcl-msg');
        el.textContent = text || '';
        el.className = 'gcl-msg' + (ok ? ' ok' : '');
    }

    // ---- modals ----------------------------------------------------------------
    function showLoginModal(notice) {
        const last = GM_getValue(LAST_USER_KEY, '') || '';
        const modal = openModal(`
          <h2>Community login</h2>
          <p class="sub">This is the community account, not gats.io's own login.</p>
          <label>Username</label>
          <input type="text" id="gcl-user" autocomplete="username" maxlength="16" value="${escapeHtml(last)}">
          <label>Password</label>
          <input type="password" id="gcl-pass" autocomplete="current-password">
          <div class="gcl-msg"></div>
          <button id="gcl-submit">Log in</button>
          <a class="link" id="gcl-switch">Create an account</a>`);
        if (!modal) return;
        if (notice) setMsg(modal, notice);
        const submit = modal.querySelector('#gcl-submit');
        const run = async () => {
            const u = modal.querySelector('#gcl-user').value.trim();
            const p = modal.querySelector('#gcl-pass').value;
            if (!u || !p) { setMsg(modal, 'Enter your username and password.'); return; }
            submit.disabled = true; setMsg(modal, 'Logging in...', true);
            const res = await apiLogin(u, p);
            if (res.status === 200 && res.data.ok) { onLoginSuccess(res.data); closeModal(); return; }
            submit.disabled = false; setMsg(modal, errText(res));
        };
        submit.addEventListener('click', run);
        modal.querySelector('#gcl-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
        modal.querySelector('#gcl-switch').addEventListener('click', showRegisterModal);
    }

    function showRegisterModal() {
        const modal = openModal(`
          <h2>Create account</h2>
          <p class="sub">Pick a password you don't use anywhere else, and not your real gats.io password.
          Your password is scrambled in your browser and never sent as text.</p>
          <label>Username (3-16 letters, numbers, _)</label>
          <input type="text" id="gcl-user" autocomplete="username" maxlength="16">
          <label>Password (8+ characters)</label>
          <input type="password" id="gcl-pass" autocomplete="new-password">
          <label>Repeat password</label>
          <input type="password" id="gcl-pass2" autocomplete="new-password">
          <div class="gcl-msg"></div>
          <button id="gcl-submit">Sign up</button>
          <a class="link" id="gcl-switch">I already have an account</a>`);
        if (!modal) return;
        const submit = modal.querySelector('#gcl-submit');
        const run = async () => {
            const u = modal.querySelector('#gcl-user').value.trim();
            const p = modal.querySelector('#gcl-pass').value;
            const p2 = modal.querySelector('#gcl-pass2').value;
            if (!/^[A-Za-z0-9_]{3,16}$/.test(u)) { setMsg(modal, errText({ status: 400, data: { error: 'bad_username' } })); return; }
            if (p.length < 8) { setMsg(modal, 'Use at least 8 characters.'); return; }
            if (p !== p2) { setMsg(modal, "Passwords don't match."); return; }
            submit.disabled = true; setMsg(modal, 'Creating account...', true);
            const res = await apiSignup(u, p);
            if (res.status === 201 && res.data.ok) { onLoginSuccess(res.data); closeModal(); return; }
            submit.disabled = false; setMsg(modal, errText(res));
        };
        submit.addEventListener('click', run);
        modal.querySelector('#gcl-pass2').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
        modal.querySelector('#gcl-switch').addEventListener('click', () => showLoginModal());
    }

    function showAccountModal() {
        if (!isLoggedIn()) { showLoginModal(); return; }
        const modal = openModal(`
          <h2>${escapeHtml(currentUser.username)}</h2>
          <p class="sub">Logged in. Other community players see this name on you.</p>
          <label>New display name</label>
          <input type="text" id="gcl-newname" maxlength="16" autocomplete="off">
          <button id="gcl-rename">Rename</button>
          <div class="gcl-msg"></div>
          <button class="secondary" id="gcl-logout">Log out</button>
          <hr>
          <div class="danger">Delete account: type your password, then drag the slider all the way right.</div>
          <input type="password" id="gcl-delpass" autocomplete="current-password" placeholder="Password">
          <input type="range" id="gcl-swipe" min="0" max="100" value="0">`);
        if (!modal) return;

        modal.querySelector('#gcl-rename').addEventListener('click', async (ev) => {
            const name = modal.querySelector('#gcl-newname').value.trim();
            if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) { setMsg(modal, errText({ status: 400, data: { error: 'bad_username' } })); return; }
            ev.target.disabled = true; setMsg(modal, 'Renaming...', true);
            const res = await apiRename(name);
            ev.target.disabled = false;
            if (res.status === 200 && res.data.ok) {
                onLoginSuccess(res.data);       // new token carries the new name
                emit('renamed', { username: currentUser.username });
                setMsg(modal, 'Done. Your new name shows on your next respawn.', true);
            } else if (res.data && (res.data.error === 'bad_token' || res.data.error === 'revoked')) {
                sessionRejected();
            } else {
                setMsg(modal, errText(res));
            }
        });

        modal.querySelector('#gcl-logout').addEventListener('click', () => { performLogout(); closeModal(); });

        setupSwipeConfirm(modal.querySelector('#gcl-swipe'), async () => {
            const pw = modal.querySelector('#gcl-delpass').value;
            if (!pw) { setMsg(modal, 'Type your password first.'); return; }
            setMsg(modal, 'Deleting...', true);
            const res = await apiUnregister(pw);
            if (res.status === 200 && res.data.ok) {
                performLogout();
                emit('unregistered', {});
                closeModal();
            } else {
                setMsg(modal, errText(res));
            }
        });
    }

    // [HELPER] "drag to confirm" slider -------------------------------------------
    function setupSwipeConfirm(range, onConfirm) {
        let fired = false;
        range.addEventListener('input', () => {
            if (!fired && Number(range.value) >= 100) { fired = true; onConfirm(); }
        });
        const reset = () => {
            if (Number(range.value) < 100) range.value = 0;
            else setTimeout(() => { range.value = 0; fired = false; }, 400);
        };
        range.addEventListener('change', reset);
        range.addEventListener('pointerup', reset);
    }

    // ---- init ------------------------------------------------------------------
    function initUi() { updateBadge(); }

    // [HELPER] public surface used by the other modules --------------------------
    GCL.auth = {
        isLoggedIn,
        getUser: () => currentUser,
        getToken: () => currentToken,
        logout: performLogout,
        sessionRejected,
        on,
    };

    tryAutoLogin(); // storage only, no DOM needed
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUi, { once: true });
    else initUi();
})();

// ============================================================================
// MODULE 2 — ws_hook (WebSocket tap only).
// Same logic as before. Only two changes: the hook is installed on the page's
// window (PAGE), and the public API lives on GCL instead of window.
// ============================================================================

(function ws_hook() {
    'use strict';

    const RealWebSocket = PAGE.WebSocket;

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
        realHandler(new PAGE.MessageEvent('message', { data: bytes.buffer }));
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
                    realHandler(new PAGE.MessageEvent('message', { data: patchedData }));
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

    PAGE.WebSocket = HookedWebSocket;

    // --------------------------------------------------------------------
    // Internal API (RealWebSocket is exposed so module 3 can open its own
    // presence socket WITHOUT going through the hook)
    // --------------------------------------------------------------------

    GCL.wsHook = {
        RealWebSocket,
        getActiveSocket: () => activeSocket,
        getCurrentServerUrl: () => currentServerUrl,
        getRealHandler: () => realHandler,
        dispatchRawToRealHandler,
        onEveryFrame,
        addFrameTransformer,
        addPostDispatchHook,
        onBatchComplete,
        onSocketClose,
    };
})();

// ============================================================================
// MODULE 3 — hook_handler
// Frame decoding, blank-aware merge, deferred player rebuild, plus the
// presence client (one WebSocket to the worker's /presence endpoint).
// ============================================================================

(function hook_handler() {
    'use strict';

    const PRESENCE_URL = 'wss://login-info-handler.gitgames.workers.dev/presence';
    const PING_MS = 25000;        // heartbeat; the DO answers "pong" without waking up
    const DEAD_MS = 150000;       // no pong for this long -> reconnect
    const MAX_LOOKUP = 50;

    // ---- state the helpers touch ----------------------------------------
    const ghosts = {};        // id -> last known player data
    let LAZY_IDS = {};        // id -> resolved community username
    let INJECT_MESSAGES = []; // frames to append to the next outgoing frame
    const asked = new Set();  // ids already sent in a lookup (this game session)
    const pending = new Set();// ids waiting to be sent in a lookup
    let selfId = null;

    // presence socket state
    let ws = null;
    let wsRoom = null;        // room the current socket was opened for
    let wantRoom = null;      // room we should be connected to (derived from the game server)
    let wsReady = false;      // 'hello' received
    let pingTimer = null;
    let reconnectTimer = null;
    let backoff = 1000;
    let lastRx = 0;
    let replaced = false;     // another tab took over this account's presence

    const D_FIELDS = ['classCode', 'colorCode', 'x', 'y', 'radius', 'playerAngle', 'armorAmount', 'hp',
        'maxBullets', 'username', 'ghillie', 'invincible', 'isLeader', 'isPremiumMember', 'teamCode', 'chatBoxOpen'];
    const B_FIELDS = ['x', 'y', 'spdX', 'spdY', 'playerAngle'];
    // chatMessage is deliberately NOT merged: a rebuild must never replay chat.
    const C_FIELDS = ['currentBullets', 'shooting', 'reloading', 'hp', 'beingHit', 'armorAmount', 'radius',
        'ghillie', 'maxBullets', 'invincible', 'dashing', 'chatBoxOpen', 'isLeader', 'colorCode'];

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

    // Names go straight into comma/pipe-delimited frames: never trust the network.
    function isSafeName(n) {
        return typeof n === 'string' && /^[A-Za-z0-9_]{1,24}$/.test(n);
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

    // ---- name bookkeeping -------------------------------------------------------
    function setName(id, name) {
        if (!isSafeName(name) || id === selfId) return;
        LAZY_IDS[id] = name;
        const g = ghosts[id];
        if (g) { g.rebuilt = false; rebuildPlayer(id, g); }
    }

    function forgetName(id) {
        delete LAZY_IDS[id];
        asked.delete(id);
        pending.delete(id);
    }

    function resetState() {
        for (const k of Object.keys(ghosts)) delete ghosts[k];
        LAZY_IDS = {};
        INJECT_MESSAGES = [];
        asked.clear();
        pending.clear();
        selfId = null;
    }

    // ---- presence socket ----------------------------------------------------------
    function roomFromUrl(url) {
        try {
            const u = new URL(url);
            const room = (u.hostname + (u.port ? ':' + u.port : '')).toLowerCase();
            return /^[a-z0-9._:-]{1,64}$/.test(room) ? room : null;
        } catch (e) { return null; }
    }

    function sendJson(obj) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    }

    function clearTimers() {
        clearInterval(pingTimer); pingTimer = null;
        clearTimeout(reconnectTimer); reconnectTimer = null;
    }

    function closePresence() {
        clearTimers();
        wsReady = false;
        wsRoom = null;
        const old = ws;
        ws = null;
        if (old) { try { old.close(1000); } catch (e) { /* already closed */ } }
    }

    function scheduleReconnect() {
        if (reconnectTimer || replaced || !wantRoom || !GCL.auth.isLoggedIn()) return;
        const wait = backoff + Math.floor(Math.random() * 500);
        backoff = Math.min(backoff * 2, 60000);
        reconnectTimer = setTimeout(() => { reconnectTimer = null; connectPresence(); }, wait);
    }

    function connectPresence() {
        if (replaced || !wantRoom || !GCL.auth.isLoggedIn()) return;
        if (ws && wsRoom === wantRoom && ws.readyState <= 1) return; // already connecting/open
        closePresence();

        let sock;
        try {
            sock = new GCL.wsHook.RealWebSocket(
                `${PRESENCE_URL}?room=${encodeURIComponent(wantRoom)}`,
                ['gcl.v1', GCL.auth.getToken()]
            );
        } catch (e) { console.error('[gcl] presence connect failed', e); scheduleReconnect(); return; }
        ws = sock;
        wsRoom = wantRoom;

        sock.onopen = () => {
            if (sock !== ws) return;
            lastRx = Date.now();
            clearInterval(pingTimer);
            pingTimer = setInterval(() => {
                if (sock !== ws) return;
                if (Date.now() - lastRx > DEAD_MS) { try { sock.close(); } catch (e) { /* noop */ } return; }
                if (sock.readyState === 1) sock.send('ping');
            }, PING_MS);
        };

        sock.onmessage = (ev) => {
            if (sock !== ws) return;
            lastRx = Date.now();
            if (ev.data === 'pong') return;
            let m;
            try { m = JSON.parse(ev.data); } catch (e) { return; }
            onPresenceMessage(m);
        };

        sock.onclose = (ev) => {
            if (sock !== ws) return;
            clearInterval(pingTimer); pingTimer = null;
            wsReady = false;
            ws = null;
            if (ev.code === 4401) { GCL.auth.sessionRejected('Your session ended. Please log in again.'); return; }
            if (ev.code === 4403) { GCL.auth.sessionRejected('This account has been banned.'); return; }
            if (ev.code === 4000) { replaced = true; return; }
            scheduleReconnect();
        };

        sock.onerror = () => { /* onclose follows */ };
    }

    function onPresenceMessage(m) {
        switch (m.t) {
            case 'hello':
                wsReady = true;
                backoff = 1000;
                // fresh socket: re-claim ourselves and re-resolve everyone we can see
                asked.clear();
                for (const id of Object.keys(ghosts)) if (!LAZY_IDS[id]) pending.add(id);
                if (selfId) sendJson({ t: 'claim', gid: selfId });
                flushLookups();
                break;
            case 'names':
                if (m.names && typeof m.names === 'object') {
                    for (const id of Object.keys(m.names)) setName(id, m.names[id]);
                }
                break;
            case 'join':
            case 'rename':
                if (typeof m.gid === 'string') setName(m.gid, m.name);
                break;
            case 'leave':
                if (typeof m.gid === 'string') forgetName(m.gid);
                break;
            case 'claim_err':
                console.warn('[gcl] could not claim in-game id', m.gid, m.reason);
                break;
            case 'revoked':
                GCL.auth.sessionRejected('Your session ended. Please log in again.');
                closePresence();
                break;
            case 'replaced':
                replaced = true; // another tab/window took over presence for this account
                closePresence();
                break;
            default: break;
        }
    }

    function queueLookup(id) {
        if (!id || id === selfId || LAZY_IDS[id] || asked.has(id)) return;
        pending.add(id);
    }

    function flushLookups() {
        if (!wsReady || pending.size === 0) return;
        const ids = [...pending].slice(0, MAX_LOOKUP);
        for (const id of ids) { pending.delete(id); asked.add(id); }
        sendJson({ t: 'lookup', gids: ids });
    }

    // ---- wire into the ws_hook ------------------------------------------------------

    // frame observer: keep ghosts up to date, queue lookups, retry deferred rebuilds
    GCL.wsHook.onEveryFrame((frame) => {
        const f = decodeRelevant(frame);
        if (!f) return;
        switch (f.code) {
            case 'a': { // self init: new game session, reset everything
                resetState();
                selfId = f.id;
                wantRoom = roomFromUrl(GCL.wsHook.getCurrentServerUrl());
                if (GCL.auth.isLoggedIn()) {
                    if (ws && wsRoom === wantRoom && wsReady) sendJson({ t: 'claim', gid: selfId });
                    else connectPresence(); // claim is sent on 'hello'
                }
                break;
            }
            case 'b': {
                const g = ghosts[f.id];
                if (g) mergeFields(g, f, B_FIELDS);
                break;
            }
            case 'c': {
                const g = ghosts[f.id];
                if (!g) break;
                mergeFields(g, f, C_FIELDS);
                if (isFilled(g.radius) && isFilled(g.colorCode)) g.hasStatus = true;
                if (g.hasStatus && !g.rebuilt && LAZY_IDS[f.id]) rebuildPlayer(f.id, g);
                break;
            }
            case 'd': {
                const g = { id: f.id, hasStatus: false, rebuilt: false };
                mergeFields(g, f, D_FIELDS);
                ghosts[f.id] = g;
                queueLookup(f.id);
                break;
            }
            case 'e':
                delete ghosts[f.id];
                forgetName(f.id);
                break;
            default: break; // 's' and everything else: nothing to do
        }
    });

    // frame transformer: swap in names, then append queued rebuild frames
    GCL.wsHook.addFrameTransformer((frame, meta) => {
        let out = frame;
        if (GCL.auth.isLoggedIn()) {
            if (frame.startsWith('a,')) {
                // our own name: field 18 of the self-init frame
                const parts = frame.split(',');
                const me = GCL.auth.getUser();
                if (parts.length > 18 && me && isSafeName(me.username)) {
                    parts[18] = me.username;
                    out = parts.join(',');
                }
            } else if (frame.startsWith('d,')) {
                // someone we already know: rewrite their name before the game sees it
                const parts = frame.split(',');
                const name = LAZY_IDS[parts[1]];
                if (name && parts.length > 11) {
                    parts[11] = name;
                    out = parts.join(',');
                }
            }
        }
        if (meta.frame_id === 0 && INJECT_MESSAGES.length) {
            out = out + '|' + INJECT_MESSAGES.join('|');
            INJECT_MESSAGES = [];
        }
        return out;
    });

    // once per incoming packet: send any unresolved ids in one lookup
    GCL.wsHook.onBatchComplete(flushLookups);

    // game socket closed: leave the room, forget everything about this session
    GCL.wsHook.onSocketClose(() => {
        if (ws) sendJson({ t: 'unclaim' });
        wantRoom = null;
        closePresence();
        resetState();
    });

    // login / logout / tab close
    GCL.auth.on('login', () => {
        replaced = false;
        backoff = 1000;
        wantRoom = wantRoom || roomFromUrl(GCL.wsHook.getCurrentServerUrl());
        connectPresence();
    });
    GCL.auth.on('logout', () => {
        closePresence();
        LAZY_IDS = {};
        asked.clear();
        pending.clear();
    });
    PAGE.addEventListener('pagehide', () => { closePresence(); });

    // already logged in from a stored token (auto-login ran before we registered)
    if (GCL.auth.isLoggedIn()) wantRoom = wantRoom || null;

    GCL.presence = { getRoom: () => wsRoom };
})();
