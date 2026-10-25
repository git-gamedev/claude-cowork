// ==UserScript==
// @name         gats.io Community Login + Presence
// @namespace    https://gats.io/
// @version      1.8
// @description  Community login layer + self rename for gats.io
// @match        https://gats.io/*
// @connect      login-info-handler.gitgames.workers.dev
// @license     MIT
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function auth_ui() {
    'use strict';

    const WORKER_URL = 'https://login-info-handler.gitgames.workers.dev';
    const STORAGE_KEY = 'gcl_session_token'; // "gats community login"
    const STORAGE_EXPIRES_KEY = 'gcl_session_expires';

    // --------------------------------------------------------------------
    // Token storage helpers
    // --------------------------------------------------------------------

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

    // --------------------------------------------------------------------
    // Worker API calls
    // --------------------------------------------------------------------

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

    async function apiLogin(username, password) {
        return apiCall('/auth/login', { body: { username, password } });
    }

    async function apiSignup(username, password) {
        return apiCall('/auth/signup', { body: { username, password } });
    }

    async function apiVerify(token) {
        return apiCall('/session/verify', { token });
    }

    async function apiLogout(token) {
        return apiCall('/session/logout', { token });
    }

    async function apiUnregister(token, password) {
        return apiCall('/auth/unregister', { token, body: { password } });
    }

    // --------------------------------------------------------------------
    // UI state
    // --------------------------------------------------------------------

    let currentUser = null; // { username } once logged in
    let currentToken = null;

    function isLoggedIn() {
        return !!currentToken;
    }

    // --------------------------------------------------------------------
    // Modal markup + styles (scoped, won't collide with gats.io's own CSS)
    // --------------------------------------------------------------------

    const STYLE = `
    #gcl-modal-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.55);
      z-index: 999999; display: flex; align-items: center; justify-content: center;
      font-family: system-ui, -apple-system, sans-serif;
    }
    #gcl-modal {
      background: #1b1f27; color: #eee; width: 320px; border-radius: 10px;
      padding: 20px; box-shadow: 0 8px 30px rgba(0,0,0,0.5);
      position: relative;
    }
    #gcl-modal h2 { margin: 0 0 14px; font-size: 18px; }
    #gcl-modal .gcl-field { margin-bottom: 10px; }
    #gcl-modal label { display: block; font-size: 12px; color: #aaa; margin-bottom: 4px; }
    #gcl-modal input {
      width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px;
      border: 1px solid #3a3f4b; background: #12151b; color: #eee; font-size: 14px;
    }
    #gcl-modal .gcl-hint {
      font-size: 11px; color: #888; margin-top: -4px; margin-bottom: 10px;
    }
    #gcl-modal .gcl-error {
      color: #ff6b6b; font-size: 12px; min-height: 16px; margin-bottom: 8px;
    }
    #gcl-modal button {
      width: 100%; padding: 9px; border-radius: 6px; border: none;
      font-size: 14px; cursor: pointer; margin-top: 4px;
    }
    #gcl-modal .gcl-primary { background: #4a7dfc; color: #fff; }
    #gcl-modal .gcl-primary:disabled { background: #3a4a7c; cursor: default; }
    #gcl-modal .gcl-link {
      background: none; color: #8ab4ff; text-decoration: underline;
      margin-top: 10px; font-size: 12px; padding: 0;
    }
    #gcl-modal .gcl-close {
      position: absolute; top: 10px; right: 12px; background: none;
      border: none; color: #888; font-size: 18px; width: auto; padding: 0;
      margin: 0; cursor: pointer;
    }
    #gcl-status-badge {
      position: fixed; top: 10px; right: 10px; z-index: 999998;
      background: #1b1f27; color: #eee; font-family: system-ui, sans-serif;
      font-size: 12px; padding: 6px 10px; border-radius: 6px;
      border: 1px solid #3a3f4b; cursor: pointer;
    }
    #gcl-modal .gcl-danger-zone {
      margin-top: 18px; padding-top: 14px; border-top: 1px solid #3a3f4b;
    }
    #gcl-modal .gcl-danger-label {
      font-size: 12px; color: #ff8a8a; margin-bottom: 8px;
    }
    #gcl-modal .gcl-danger-btn {
      background: #3a1f22; color: #ff8a8a; border: 1px solid #5c2b30;
    }
    #gcl-modal .gcl-swipe-track {
      position: relative; height: 40px; border-radius: 20px;
      background: #12151b; border: 1px solid #3a3f4b; margin-top: 4px;
      overflow: hidden; user-select: none;
    }
    #gcl-modal .gcl-swipe-label {
      position: absolute; inset: 0; display: flex; align-items: center;
      justify-content: center; font-size: 12px; color: #888; pointer-events: none;
    }
    #gcl-modal .gcl-swipe-thumb {
      position: absolute; top: 3px; left: 3px; width: 34px; height: 34px;
      border-radius: 50%; background: #5c2b30; cursor: grab;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; color: #ff8a8a; touch-action: none;
    }
    #gcl-modal .gcl-swipe-track.gcl-confirmed .gcl-swipe-thumb {
      background: #ff4d4d; color: #fff; cursor: default;
    }
    #gcl-modal .gcl-swipe-track.gcl-confirmed .gcl-swipe-label {
      color: #ff8a8a;
    }
  `;

    function injectStyle() {
        const style = document.createElement('style');
        style.textContent = STYLE;
        document.head.appendChild(style);
    }

    // --------------------------------------------------------------------
    // Status badge — shows logged-in/out state, click to open modal
    // --------------------------------------------------------------------

    function ensureBadge() {
        let badge = document.getElementById('gcl-status-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.id = 'gcl-status-badge';
            badge.addEventListener('click', () => {
                if (isLoggedIn()) {
                    showAccountModal();
                } else {
                    showLoginModal();
                }
            });
            document.body.appendChild(badge);
        }
        updateBadge();
    }

    function updateBadge() {
        const badge = document.getElementById('gcl-status-badge');
        if (!badge) return;
        badge.textContent = isLoggedIn()
            ? `\u25CF ${currentUser.username}`
            : '\u25CB Log in';
    }

    // --------------------------------------------------------------------
    // Modal helpers
    // --------------------------------------------------------------------

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

    // --------------------------------------------------------------------
    // Login modal
    // --------------------------------------------------------------------

    function showLoginModal() {
        const modal = openModal(`
      <h2>Community Log In</h2>
      <div class="gcl-error" id="gcl-login-error"></div>
      <div class="gcl-field">
        <label>Username</label>
        <input type="text" id="gcl-login-username" autocomplete="off" />
      </div>
      <div class="gcl-field">
        <label>Password</label>
        <input type="password" id="gcl-login-password" autocomplete="off" />
      </div>
      <button class="gcl-primary" id="gcl-login-submit">Log In</button>
      <button class="gcl-link" id="gcl-goto-register">Need an account? Register</button>
    `);

        modal.querySelector('#gcl-goto-register').addEventListener('click', showRegisterModal);

        const submit = modal.querySelector('#gcl-login-submit');
        const errorEl = modal.querySelector('#gcl-login-error');

        async function doLogin() {
            const username = modal.querySelector('#gcl-login-username').value.trim();
            const password = modal.querySelector('#gcl-login-password').value;
            errorEl.textContent = '';

            if (!username || !password) {
                errorEl.textContent = 'Enter a username and password.';
                return;
            }

            submit.disabled = true;
            submit.textContent = 'Logging in...';

            const { status, data } = await apiLogin(username, password);

            submit.disabled = false;
            submit.textContent = 'Log In';

            if (status === 200 && data.token) {
                onLoginSuccess(username, data.token, data.expiresAt);
                closeModal();
            } else if (status === 429) {
                errorEl.textContent = 'Too many attempts. Wait a bit and try again.';
            } else {
                errorEl.textContent = 'Incorrect username or password.';
            }
        }

        submit.addEventListener('click', doLogin);
        modal.querySelector('#gcl-login-password').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doLogin();
        });
    }

    // --------------------------------------------------------------------
    // Register modal
    // --------------------------------------------------------------------

    function showRegisterModal() {
        const modal = openModal(`
      <h2>Community Register</h2>
      <div class="gcl-error" id="gcl-register-error"></div>
      <div class="gcl-field">
        <label>Username (3-32 chars, letters/numbers/_)</label>
        <input type="text" id="gcl-register-username" autocomplete="off" />
      </div>
      <div class="gcl-field">
        <label>Password (8+ chars)</label>
        <input type="password" id="gcl-register-password" autocomplete="off" />
      </div>
      <div class="gcl-hint">
        Tip: use a different password than your gats.io account, if you have one.
        This is a separate community login, not affiliated with the game.
      </div>
      <button class="gcl-primary" id="gcl-register-submit">Register</button>
      <button class="gcl-link" id="gcl-goto-login">Already have an account? Log in</button>
    `);

        modal.querySelector('#gcl-goto-login').addEventListener('click', showLoginModal);

        const submit = modal.querySelector('#gcl-register-submit');
        const errorEl = modal.querySelector('#gcl-register-error');

        async function doRegister() {
            const username = modal.querySelector('#gcl-register-username').value.trim();
            const password = modal.querySelector('#gcl-register-password').value;
            errorEl.textContent = '';

            if (!username || !password) {
                errorEl.textContent = 'Enter a username and password.';
                return;
            }

            submit.disabled = true;
            submit.textContent = 'Creating account...';

            const { status, data } = await apiSignup(username, password);

            submit.disabled = false;
            submit.textContent = 'Register';

            if (status === 201 && data.token) {
                onLoginSuccess(username, data.token, data.expiresAt);
                closeModal();
            } else if (status === 409) {
                errorEl.textContent = 'That username is already taken.';
            } else if (status === 429) {
                errorEl.textContent = 'Too many attempts. Wait a bit and try again.';
            } else {
                errorEl.textContent = 'Invalid username or password (check the requirements above).';
            }
        }

        submit.addEventListener('click', doRegister);
        modal.querySelector('#gcl-register-password').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doRegister();
        });
    }

    // --------------------------------------------------------------------
    // Account modal (shown when already logged in — logout + delete account)
    // --------------------------------------------------------------------

    function showAccountModal() {
        const modal = openModal(`
      <h2>Community Account</h2>
      <div class="gcl-field">
        <label>Logged in as</label>
        <input type="text" value="${escapeHtml(currentUser.username)}" disabled />
      </div>
      <button class="gcl-primary" id="gcl-logout-submit">Log Out</button>

      <div class="gcl-danger-zone">
        <div class="gcl-danger-label">Delete account permanently</div>
        <div class="gcl-swipe-track" id="gcl-swipe-track">
          <div class="gcl-swipe-label" id="gcl-swipe-label">Swipe to confirm</div>
          <div class="gcl-swipe-thumb" id="gcl-swipe-thumb">&rarr;</div>
        </div>
        <div id="gcl-unregister-step2" style="display:none; margin-top:10px;">
          <div class="gcl-field">
            <label>Re-enter your password to permanently delete this account</label>
            <input type="password" id="gcl-unregister-password" autocomplete="off" />
          </div>
          <div class="gcl-error" id="gcl-unregister-error"></div>
          <button class="gcl-primary gcl-danger-btn" id="gcl-unregister-submit">
            Permanently Delete Account
          </button>
        </div>
      </div>
    `);

        modal.querySelector('#gcl-logout-submit').addEventListener('click', async () => {
            await performLogout();
            closeModal();
        });

        setupSwipeConfirm(modal);
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // Simple drag-to-confirm swipe. Once the thumb reaches the end of the
    // track, reveal the password re-entry step. This is a deliberate-action
    // gate, not itself a security boundary — the password check server-side
    // is what actually protects against accidental/unattended deletion.
    function setupSwipeConfirm(modal) {
        const track = modal.querySelector('#gcl-swipe-track');
        const thumb = modal.querySelector('#gcl-swipe-thumb');
        const label = modal.querySelector('#gcl-swipe-label');
        const step2 = modal.querySelector('#gcl-unregister-step2');

        let dragging = false;
        let confirmed = false;
        const trackWidth = 260;
        const thumbWidth = 34;
        const maxX = trackWidth - thumbWidth - 6;

        function setThumbX(x) {
            thumb.style.left = `${3 + Math.max(0, Math.min(maxX, x))}px`;
        }

        function onDown() {
            if (confirmed) return;
            dragging = true;
            thumb.style.cursor = 'grabbing';
        }

        function onMove(e) {
            if (!dragging || confirmed) return;
            const rect = track.getBoundingClientRect();
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const x = clientX - rect.left - thumbWidth / 2;
            setThumbX(x);
            if (x >= maxX - 4) {
                confirmed = true;
                dragging = false;
                setThumbX(maxX);
                track.classList.add('gcl-confirmed');
                label.textContent = 'Confirmed';
                thumb.textContent = '\u2713';
                step2.style.display = 'block';
            }
        }

        function onUp() {
            if (!dragging) return;
            dragging = false;
            thumb.style.cursor = 'grab';
            if (!confirmed) setThumbX(0);
        }

        thumb.addEventListener('mousedown', onDown);
        thumb.addEventListener('touchstart', onDown, { passive: true });
        window.addEventListener('mousemove', onMove);
        window.addEventListener('touchmove', onMove, { passive: true });
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchend', onUp);

        const submit = modal.querySelector('#gcl-unregister-submit');
        const errorEl = modal.querySelector('#gcl-unregister-error');

        submit.addEventListener('click', async () => {
            const password = modal.querySelector('#gcl-unregister-password').value;
            errorEl.textContent = '';

            if (!password) {
                errorEl.textContent = 'Enter your password to confirm.';
                return;
            }

            submit.disabled = true;
            submit.textContent = 'Deleting...';

            const { status } = await apiUnregister(currentToken, password);

            if (status === 200) {
                currentUser = null;
                currentToken = null;
                clearSession();
                updateBadge();
                window.dispatchEvent(new CustomEvent('gcl:logout'));
                window.dispatchEvent(new CustomEvent('gcl:unregistered'));
                closeModal();
                return;
            }

            submit.disabled = false;
            submit.textContent = 'Permanently Delete Account';

            if (status === 401) {
                errorEl.textContent = 'Incorrect password. Account was not deleted.';
            } else {
                errorEl.textContent = 'Something went wrong. Account was not deleted.';
            }
        });
    }

    // --------------------------------------------------------------------
    // Session lifecycle
    // --------------------------------------------------------------------

    function onLoginSuccess(username, token, expiresAt) {
        currentUser = { username };
        currentToken = token;
        saveSession(token, expiresAt);
        updateBadge();
        window.dispatchEvent(new CustomEvent('gcl:login', {
            detail: { username, token }
        }));
    }

    async function performLogout() {
        const token = currentToken;
        currentUser = null;
        currentToken = null;
        clearSession();
        updateBadge();
        window.dispatchEvent(new CustomEvent('gcl:logout'));

        if (token) {
            await apiLogout(token);
        }
    }

    async function tryAutoLogin() {
        const token = getStoredToken();
        if (!token) return;

        const { status, data } = await apiVerify(token);
        if (status === 200) {
            const expiresAt = Number(localStorage.getItem(STORAGE_EXPIRES_KEY));
            currentToken = token;
            currentUser = { username: data.username || '(unknown)' };
            saveSession(token, expiresAt);
            updateBadge();
            window.dispatchEvent(new CustomEvent('gcl:login', {
                detail: {
                    username: currentUser.username,
                    token
                }
            }));
        } else {
            clearSession();
        }
    }

    // --------------------------------------------------------------------
    // Init
    // --------------------------------------------------------------------

    function init() {
        injectStyle();
        ensureBadge();
        tryAutoLogin();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Expose a small API for other parts of the userscript.
    window.gclAuth = {
        isLoggedIn,
        getUser: () => currentUser,
        getToken: () => currentToken,
        logout: performLogout,
    };
})();

// ============================================================================
// ws-hook.js — WebSocket tap ONLY. UNCHANGED.
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
// hook-handler.js — SELF username injection && OTHERS username checks
//
// CHANGES in v1.5:
//   1. rebuildPlayer is applied as soon as a name is found (not only on 's').
//   2. rebuildPlayer waits until the ghost has received a REAL 'c' status
//      frame — the old version injected blank colour/radius/hp, which made
//      the player's body circle disappear.
//   3. The rebuilt 'c' message now has all 17 fields (chatMessage added).
//   4. Self presence is also reported when you log in AFTER the game's 'a'
//      frame already arrived (login race), and /presence/set is traced.
//   5. console.clear() is now opt-in (CLEAR_CONSOLE) so traces survive.
// ============================================================================

(function hook_handler() {
    'use strict';

    const WORKER_URL = 'https://login-info-handler.gitgames.workers.dev';
    const BATCH_MAX_IDS = 25;

    //persistant variables
    let lastReportedServer = null;
    let lastReportedId = null;
    let mySelfId = null; // our own in-game id, from the 'a' frame

    const ghosts = {};

    let UNKNOWN_IDS = [];
    let LAZY_IDS = {};

    // Lookup throttling. The game re-sends 'd' every time a player re-enters
    // view range, and guests can never be resolved, so without this the same
    // ids were re-queried endlessly, several 60s streams at a time.
    const IN_FLIGHT = new Set();   // ids with a lookup-batch currently open
    const RETRY_AT = {};           // id -> earliest time we may ask again
    const ATTEMPTS = {};           // id -> consecutive unresolved lookups
    const RETRY_BASE_MS = 5000;
    const RETRY_MAX_MS = 30000;

    let RETURN_MESSAGE = undefined;
    let INJECT_MESSAGES = [];

    //Websocket Hooks
    window.gclWsHook.onEveryFrame((frame) => {
        const decoded = decodeRelevant(frame);
        if (!decoded) return;

        const A_USERNAME_INDEX = 18;

        switch (decoded.code) {
            case 'a': //self player init
                mySelfId = decoded.msg[1];
                console.log('[gcl-trace] A arrived — self id:', mySelfId, 'logged in:', window.gclAuth.isLoggedIn());

                decoded.msg[A_USERNAME_INDEX] = window.gclAuth.isLoggedIn() ? window.gclAuth.getUser().username : decoded.msg[A_USERNAME_INDEX];
                RETURN_MESSAGE = decoded.msg.join(',');

                if (window.gclAuth.isLoggedIn()) {
                    reportSelfPresence(decoded.msg[1]); // fire-and-forget, don't block the frame
                }
                break;
            case 'b': //position update
                if (!(decoded.id in ghosts)) break;
                if (decoded.id === lastReportedId) break;

                mergeFields(ghosts[decoded.id], decoded, ['x', 'y', 'spdX', 'spdY', 'playerAngle']);

                break;

            case 'c': { //status update
                if (!(decoded.id in ghosts)) break;
                if (decoded.id === lastReportedId) break;

                const g = ghosts[decoded.id];

                if (!g.loggedFirstC) {
                    g.loggedFirstC = true;
                    console.log('[gcl-trace] FIRST C raw for id', decoded.id, ':', frame);
                }

                // The game delta-encodes frames: a BLANK field means "unchanged",
                // not "empty". Only overwrite with non-blank values, otherwise a
                // later sparse 'c' wipes radius/colorCode and the body vanishes.
                mergeFields(g, decoded, [
                    'currentBullets', 'shooting', 'reloading', 'hp', 'beingHit',
                    'armorAmount', 'radius', 'ghillie', 'maxBullets', 'invincible',
                    'dashing', 'chatBoxOpen', 'isLeader', 'colorCode'
                ]);
                g.chatMessage = decoded.chatMessage; // blank = no message, don't merge

                // Only treat the ghost as "ready" once it has the fields that
                // make the body draw.
                if (isFilled(g.radius) && isFilled(g.colorCode)) g.hasStatus = true;

                // If we already know this player's community name but couldn't
                // apply it yet (no status data back then), apply it now.
                if (decoded.id in LAZY_IDS && !g.rebuilt) {
                    console.log('[gcl-trace] C arrived for known id', decoded.id, '— applying deferred rebuild');
                    rebuildPlayer(decoded.id, g);
                }

                break;
            }
            case 'd': //new player join
                console.log('[gcl-trace] D arrived — id:', decoded.id, 'username:', decoded.username, 'raw:', frame);
                ghosts[decoded.id] = {
                    classCode: decoded.classCode, colorCode: decoded.colorCode,
                    x: decoded.x, y: decoded.y, radius: decoded.radius,
                    playerAngle: decoded.playerAngle, armorAmount: decoded.armorAmount,
                    hp: decoded.hp, maxBullets: decoded.maxBullets,
                    username: decoded.username, ghillie: decoded.ghillie,
                    invincible: decoded.invincible, isLeader: decoded.isLeader,
                    isPremiumMember: decoded.isPremiumMember, teamCode: decoded.teamCode,
                    chatBoxOpen: decoded.chatBoxOpen,
                    hasStatus: false, // set true once a real 'c' frame arrives
                    rebuilt: false
                };
                if (decoded.id in LAZY_IDS) {
                    // Name already known: the first real 'c' frame applies it.
                    console.log('[gcl-trace] D — id', decoded.id, 'already resolved, skipping lookup');
                } else {
                    UNKNOWN_IDS.push(decoded.id);
                    console.log('[gcl-trace] D — pushed to UNKNOWN_IDS, now:', JSON.stringify(UNKNOWN_IDS));
                }

                break;
            case 'e':
                if (decoded.id in ghosts) delete ghosts[decoded.id];

                UNKNOWN_IDS = UNKNOWN_IDS.filter(ID => ID !== decoded.id);

                if (decoded.id in LAZY_IDS) delete LAZY_IDS[decoded.id];

                break;
            case 's':
                console.log('[gcl-trace] S arrived — calling checkLazyIDs. Current LAZY_IDS:', JSON.stringify(LAZY_IDS), 'ghosts keys:', JSON.stringify(Object.keys(ghosts)));
                checkLazyIDs();

                break;
        }
    });

    window.gclWsHook.addFrameTransformer((frame) => {
        if (RETURN_MESSAGE) {
            frame = RETURN_MESSAGE;
            RETURN_MESSAGE = null;
        }


        for (const message of INJECT_MESSAGES) {
            frame += '|';
            frame += message;
        }
        INJECT_MESSAGES = [];
        return frame;
    });

    window.gclWsHook.onBatchComplete(() => {
        if (UNKNOWN_IDS.length === 0) return;

        const now = Date.now();
        const ready = [];
        const waiting = [];
        for (const id of UNKNOWN_IDS) {
            if (!(id in ghosts)) continue;                              // player already gone
            if (IN_FLIGHT.has(id)) continue;                            // lookup already open for this id
            if (ready.includes(id) || waiting.includes(id)) continue;   // duplicate in the queue
            if ((RETRY_AT[id] || 0) > now) waiting.push(id);            // backing off
            else ready.push(id);
        }
        UNKNOWN_IDS = waiting;
        if (ready.length === 0) return;

        for (const id of ready) IN_FLIGHT.add(id);
        console.log('[gcl-trace] batch complete — kicking off startIdChecks for:', JSON.stringify(ready));
        startIdChecks(ready);
    });

    window.gclWsHook.onSocketClose(() => {
        if (window.gclAuth.isLoggedIn()) {
            // fire-and-forget; pass the exact (server, id) we reported so the
            // worker only clears OUR record, not a newer session's.
            clearSelfPresence(lastReportedServer, lastReportedId);
        }

        for (const id of Object.keys(ghosts)) delete ghosts[id];
        UNKNOWN_IDS = [];
        LAZY_IDS = {};
        RETURN_MESSAGE = null;
        INJECT_MESSAGES.length = 0;
        lastReportedServer = null;
        lastReportedId = null;
        mySelfId = null;
        IN_FLIGHT.clear();
        for (const k of Object.keys(RETRY_AT)) delete RETRY_AT[k];
        for (const k of Object.keys(ATTEMPTS)) delete ATTEMPTS[k];
    });

    // Login race fix: if the user logs in (or auto-login finishes) AFTER the
    // game's 'a' frame already arrived, report presence now. The username
    // itself can't be injected retroactively, but others will at least be
    // able to look this player up.
    window.addEventListener('gcl:login', () => {
        if (mySelfId !== null && window.gclWsHook.getCurrentServerUrl()) {
            console.log('[gcl-trace] gcl:login after A frame — reporting presence late for id:', mySelfId);
            reportSelfPresence(mySelfId);
        }
    });

    // Tab closing/reloading: the socket 'close' event isn't reliable then, so
    // also clear presence on pagehide (best effort; the worker's ownership
    // checks make a missed clear harmless anyway).
    window.addEventListener('pagehide', () => {
        if (window.gclAuth.isLoggedIn()) {
            clearSelfPresence(lastReportedServer, lastReportedId);
        }
    });

    //helper functions
    function isFilled(v) {
        return v !== undefined && v !== '';
    }

    // Copy only non-blank fields from a decoded frame onto a ghost.
    function mergeFields(target, source, fields) {
        for (const f of fields) {
            if (isFilled(source[f])) target[f] = source[f];
        }
    }

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

    //async functions
    async function reportSelfPresence(selfId) {
        const server = window.gclWsHook.getCurrentServerUrl();
        if (lastReportedServer === server && lastReportedId === String(selfId)) return;

        const token = window.gclAuth.getToken();
        console.log('[gcl-trace] presence/set — sending. server:', server, 'id:', selfId);
        try {
            const res = await fetch(WORKER_URL + '/presence/set', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ server, id: String(selfId) }),
            });
            console.log('[gcl-trace] presence/set — response status:', res.status);
            if (res.ok) {
                lastReportedServer = server;
                lastReportedId = String(selfId);
            }
        } catch (e) {
            console.error('[gcl] presence/set failed:', e);
        }
    }

    async function startIdChecksChunk(IDS) {
        const server = window.gclWsHook.getCurrentServerUrl();
        console.log('[gcl-trace] startIdChecksChunk — requesting lookup-batch for:', JSON.stringify(IDS), 'server:', server);

        let res;
        try {
            res = await fetch(WORKER_URL + '/presence/lookup-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ server, ids: IDS }),
            });
        } catch (e) {
            console.error('[gcl] presence/lookup-batch fetch failed:', e);
            return IDS; // treat as unresolved; backoff below decides when to retry
        }

        console.log('[gcl-trace] startIdChecksChunk — response status:', res.status, 'ok:', res.ok);

        if (!res.ok) {
            console.error('[gcl] presence/lookup-batch request failed:', res.status);
            return IDS;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        let REMAINING_IDS = IDS;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    console.log('[gcl-trace] startIdChecksChunk — stream reader done (no more data)');
                    break;
                }

                buffer += decoder.decode(value, { stream: true });

                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newlineIndex);
                    buffer = buffer.slice(newlineIndex + 1);
                    if (!line) continue;

                    console.log('[gcl-trace] startIdChecksChunk — stream line received:', line);
                    const msg = JSON.parse(line);

                    if (msg.found) {
                        console.log('[gcl-trace] startIdChecksChunk — FOUND matches in this line:', JSON.stringify(msg.found));
                        for (const { id, username } of msg.found) {
                            LAZY_IDS[id] = username;
                            console.log('[gcl-trace] LAZY_IDS SET — id:', id, 'username:', username);
                            REMAINING_IDS = REMAINING_IDS.filter(ID => ID !== id);

                            // Apply the name now (deferred internally if the
                            // ghost has no real status data yet).
                            if (id in ghosts) rebuildPlayer(id, ghosts[id]);
                        }
                    }

                    if (msg.done) {
                        console.log('[gcl-trace] startIdChecksChunk — stream signaled done. unresolved:', JSON.stringify(msg.unresolved));
                        const sortedRemaining = [...REMAINING_IDS].sort();
                        const sortedUnresolved = [...msg.unresolved].sort();
                        if (sortedRemaining.join(',') !== sortedUnresolved.join(',')) {
                            console.log("[gcl] ID_Check timeout Id's remaining discrepancy found. Reverting to client authoritative");
                        }
                        return REMAINING_IDS;
                    }
                }
            }
        } catch (e) {
            console.error('[gcl] presence/lookup-batch stream error:', e);
        }

        return REMAINING_IDS;
    }

    async function startIdChecks(IDS) {
        const chunks = [];
        for (let i = 0; i < IDS.length; i += BATCH_MAX_IDS) {
            chunks.push(IDS.slice(i, i + BATCH_MAX_IDS));
        }

        let stillUnresolved;
        try {
            const results = await Promise.all(chunks.map((chunk) => startIdChecksChunk(chunk)));
            stillUnresolved = results.flat();
        } catch (e) {
            console.error('[gcl] startIdChecks failed:', e);
            stillUnresolved = IDS;
        }

        console.log('[gcl-trace] startIdChecks — all chunks settled. stillUnresolved:', JSON.stringify(stillUnresolved));

        for (const id of IDS) IN_FLIGHT.delete(id);

        const now = Date.now();
        for (const id of IDS) {
            if (stillUnresolved.includes(id)) {
                if (!(id in ghosts)) continue; // left while we were asking
                const attempts = (ATTEMPTS[id] = (ATTEMPTS[id] || 0) + 1);
                RETRY_AT[id] = now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
                UNKNOWN_IDS.push(id);
            } else {
                delete ATTEMPTS[id];
                delete RETRY_AT[id];
            }
        }
    }

    async function checkLazyIDs() {
        const server = window.gclWsHook.getCurrentServerUrl();
        for (const ID of Object.keys(LAZY_IDS)) {
            if (!(ID in ghosts)) {
                console.log('[gcl-trace] checkLazyIDs — dropping LAZY_IDS entry for', ID, '(no longer in ghosts)');
                delete LAZY_IDS[ID];
            }
        }
        for (const ID of Object.keys(LAZY_IDS)) {
            console.log('[gcl-trace] checkLazyIDs — re-verifying', ID, 'via idRegistered');
            const UPDATED_USERNAME = await idRegistered(server, ID);
            console.log('[gcl-trace] checkLazyIDs — idRegistered(', ID, ') returned:', UPDATED_USERNAME);
            if (!(ID in ghosts)) continue;
            if (!UPDATED_USERNAME) {
                const wasTracked = LAZY_IDS[ID] !== undefined;
                delete LAZY_IDS[ID];
                if (wasTracked) rebuildPlayer(ID, ghosts[ID]);
                continue;
            }

            if (UPDATED_USERNAME === LAZY_IDS[ID]) {
                console.log('[gcl-trace] checkLazyIDs —', ID, 'username unchanged, skipping rebuild');
                continue;
            }

            LAZY_IDS[ID] = UPDATED_USERNAME;
            rebuildPlayer(ID, ghosts[ID]);
        }
    }

    async function clearSelfPresence(server, id) {
        if (!server || !id) return; // never reported presence, nothing to clear
        const token = window.gclAuth.getToken();
        if (!token) return;
        try {
            await fetch(WORKER_URL + '/presence/clear', {
                method: 'POST',
                keepalive: true, // lets the request outlive a closing tab
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ server, id: String(id) }),
            });
        } catch (e) {
            console.error('[gcl] presence/clear failed:', e);
        }
    }

    async function idRegistered(server, id, attempt = 0) {
        const MAX_ATTEMPTS = 5;

        const res = await fetch(WORKER_URL + '/presence/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server, id: String(id) }),
        });
        let data = {};
        try { data = await res.json(); } catch (e) {}

        if (res.ok && data.code === 'PRESENCE_FOUND') return data.username;
        if (res.ok) return null; // genuinely not found — don't retry, this is expected/permanent
        if (attempt >= MAX_ATTEMPTS) return null; // network/server error, give up after a few tries
        await new Promise(r => setTimeout(r, 500));
        return idRegistered(server, id, attempt + 1);
    }
})();

// Console clearing is now opt-in so the [gcl-trace] lines stay visible.
// Set CLEAR_CONSOLE to true to get the old behaviour back.
(async function cleanup_console() {
    const CLEAR_CONSOLE = false;
    if (!CLEAR_CONSOLE) return;
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.clear();
})();// ==UserScript==
// @name         gats.io Community Login + Presence
// @namespace    https://gats.io/
// @version      1.8
// @description  Community login layer + self rename for gats.io
// @match        https://gats.io/*
// @connect      login-info-handler.gitgames.workers.dev
// @license     MIT
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function auth_ui() {
    'use strict';

    const WORKER_URL = 'https://login-info-handler.gitgames.workers.dev';
    const STORAGE_KEY = 'gcl_session_token'; // "gats community login"
    const STORAGE_EXPIRES_KEY = 'gcl_session_expires';

    // --------------------------------------------------------------------
    // Token storage helpers
    // --------------------------------------------------------------------

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

    // --------------------------------------------------------------------
    // Worker API calls
    // --------------------------------------------------------------------

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

    async function apiLogin(username, password) {
        return apiCall('/auth/login', { body: { username, password } });
    }

    async function apiSignup(username, password) {
        return apiCall('/auth/signup', { body: { username, password } });
    }

    async function apiVerify(token) {
        return apiCall('/session/verify', { token });
    }

    async function apiLogout(token) {
        return apiCall('/session/logout', { token });
    }

    async function apiUnregister(token, password) {
        return apiCall('/auth/unregister', { token, body: { password } });
    }

    // --------------------------------------------------------------------
    // UI state
    // --------------------------------------------------------------------

    let currentUser = null; // { username } once logged in
    let currentToken = null;

    function isLoggedIn() {
        return !!currentToken;
    }

    // --------------------------------------------------------------------
    // Modal markup + styles (scoped, won't collide with gats.io's own CSS)
    // --------------------------------------------------------------------

    const STYLE = `
    #gcl-modal-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.55);
      z-index: 999999; display: flex; align-items: center; justify-content: center;
      font-family: system-ui, -apple-system, sans-serif;
    }
    #gcl-modal {
      background: #1b1f27; color: #eee; width: 320px; border-radius: 10px;
      padding: 20px; box-shadow: 0 8px 30px rgba(0,0,0,0.5);
      position: relative;
    }
    #gcl-modal h2 { margin: 0 0 14px; font-size: 18px; }
    #gcl-modal .gcl-field { margin-bottom: 10px; }
    #gcl-modal label { display: block; font-size: 12px; color: #aaa; margin-bottom: 4px; }
    #gcl-modal input {
      width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px;
      border: 1px solid #3a3f4b; background: #12151b; color: #eee; font-size: 14px;
    }
    #gcl-modal .gcl-hint {
      font-size: 11px; color: #888; margin-top: -4px; margin-bottom: 10px;
    }
    #gcl-modal .gcl-error {
      color: #ff6b6b; font-size: 12px; min-height: 16px; margin-bottom: 8px;
    }
    #gcl-modal button {
      width: 100%; padding: 9px; border-radius: 6px; border: none;
      font-size: 14px; cursor: pointer; margin-top: 4px;
    }
    #gcl-modal .gcl-primary { background: #4a7dfc; color: #fff; }
    #gcl-modal .gcl-primary:disabled { background: #3a4a7c; cursor: default; }
    #gcl-modal .gcl-link {
      background: none; color: #8ab4ff; text-decoration: underline;
      margin-top: 10px; font-size: 12px; padding: 0;
    }
    #gcl-modal .gcl-close {
      position: absolute; top: 10px; right: 12px; background: none;
      border: none; color: #888; font-size: 18px; width: auto; padding: 0;
      margin: 0; cursor: pointer;
    }
    #gcl-status-badge {
      position: fixed; top: 10px; right: 10px; z-index: 999998;
      background: #1b1f27; color: #eee; font-family: system-ui, sans-serif;
      font-size: 12px; padding: 6px 10px; border-radius: 6px;
      border: 1px solid #3a3f4b; cursor: pointer;
    }
    #gcl-modal .gcl-danger-zone {
      margin-top: 18px; padding-top: 14px; border-top: 1px solid #3a3f4b;
    }
    #gcl-modal .gcl-danger-label {
      font-size: 12px; color: #ff8a8a; margin-bottom: 8px;
    }
    #gcl-modal .gcl-danger-btn {
      background: #3a1f22; color: #ff8a8a; border: 1px solid #5c2b30;
    }
    #gcl-modal .gcl-swipe-track {
      position: relative; height: 40px; border-radius: 20px;
      background: #12151b; border: 1px solid #3a3f4b; margin-top: 4px;
      overflow: hidden; user-select: none;
    }
    #gcl-modal .gcl-swipe-label {
      position: absolute; inset: 0; display: flex; align-items: center;
      justify-content: center; font-size: 12px; color: #888; pointer-events: none;
    }
    #gcl-modal .gcl-swipe-thumb {
      position: absolute; top: 3px; left: 3px; width: 34px; height: 34px;
      border-radius: 50%; background: #5c2b30; cursor: grab;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; color: #ff8a8a; touch-action: none;
    }
    #gcl-modal .gcl-swipe-track.gcl-confirmed .gcl-swipe-thumb {
      background: #ff4d4d; color: #fff; cursor: default;
    }
    #gcl-modal .gcl-swipe-track.gcl-confirmed .gcl-swipe-label {
      color: #ff8a8a;
    }
  `;

    function injectStyle() {
        const style = document.createElement('style');
        style.textContent = STYLE;
        document.head.appendChild(style);
    }

    // --------------------------------------------------------------------
    // Status badge — shows logged-in/out state, click to open modal
    // --------------------------------------------------------------------

    function ensureBadge() {
        let badge = document.getElementById('gcl-status-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.id = 'gcl-status-badge';
            badge.addEventListener('click', () => {
                if (isLoggedIn()) {
                    showAccountModal();
                } else {
                    showLoginModal();
                }
            });
            document.body.appendChild(badge);
        }
        updateBadge();
    }

    function updateBadge() {
        const badge = document.getElementById('gcl-status-badge');
        if (!badge) return;
        badge.textContent = isLoggedIn()
            ? `\u25CF ${currentUser.username}`
            : '\u25CB Log in';
    }

    // --------------------------------------------------------------------
    // Modal helpers
    // --------------------------------------------------------------------

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

    // --------------------------------------------------------------------
    // Login modal
    // --------------------------------------------------------------------

    function showLoginModal() {
        const modal = openModal(`
      <h2>Community Log In</h2>
      <div class="gcl-error" id="gcl-login-error"></div>
      <div class="gcl-field">
        <label>Username</label>
        <input type="text" id="gcl-login-username" autocomplete="off" />
      </div>
      <div class="gcl-field">
        <label>Password</label>
        <input type="password" id="gcl-login-password" autocomplete="off" />
      </div>
      <button class="gcl-primary" id="gcl-login-submit">Log In</button>
      <button class="gcl-link" id="gcl-goto-register">Need an account? Register</button>
    `);

        modal.querySelector('#gcl-goto-register').addEventListener('click', showRegisterModal);

        const submit = modal.querySelector('#gcl-login-submit');
        const errorEl = modal.querySelector('#gcl-login-error');

        async function doLogin() {
            const username = modal.querySelector('#gcl-login-username').value.trim();
            const password = modal.querySelector('#gcl-login-password').value;
            errorEl.textContent = '';

            if (!username || !password) {
                errorEl.textContent = 'Enter a username and password.';
                return;
            }

            submit.disabled = true;
            submit.textContent = 'Logging in...';

            const { status, data } = await apiLogin(username, password);

            submit.disabled = false;
            submit.textContent = 'Log In';

            if (status === 200 && data.token) {
                onLoginSuccess(username, data.token, data.expiresAt);
                closeModal();
            } else if (status === 429) {
                errorEl.textContent = 'Too many attempts. Wait a bit and try again.';
            } else {
                errorEl.textContent = 'Incorrect username or password.';
            }
        }

        submit.addEventListener('click', doLogin);
        modal.querySelector('#gcl-login-password').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doLogin();
        });
    }

    // --------------------------------------------------------------------
    // Register modal
    // --------------------------------------------------------------------

    function showRegisterModal() {
        const modal = openModal(`
      <h2>Community Register</h2>
      <div class="gcl-error" id="gcl-register-error"></div>
      <div class="gcl-field">
        <label>Username (3-32 chars, letters/numbers/_)</label>
        <input type="text" id="gcl-register-username" autocomplete="off" />
      </div>
      <div class="gcl-field">
        <label>Password (8+ chars)</label>
        <input type="password" id="gcl-register-password" autocomplete="off" />
      </div>
      <div class="gcl-hint">
        Tip: use a different password than your gats.io account, if you have one.
        This is a separate community login, not affiliated with the game.
      </div>
      <button class="gcl-primary" id="gcl-register-submit">Register</button>
      <button class="gcl-link" id="gcl-goto-login">Already have an account? Log in</button>
    `);

        modal.querySelector('#gcl-goto-login').addEventListener('click', showLoginModal);

        const submit = modal.querySelector('#gcl-register-submit');
        const errorEl = modal.querySelector('#gcl-register-error');

        async function doRegister() {
            const username = modal.querySelector('#gcl-register-username').value.trim();
            const password = modal.querySelector('#gcl-register-password').value;
            errorEl.textContent = '';

            if (!username || !password) {
                errorEl.textContent = 'Enter a username and password.';
                return;
            }

            submit.disabled = true;
            submit.textContent = 'Creating account...';

            const { status, data } = await apiSignup(username, password);

            submit.disabled = false;
            submit.textContent = 'Register';

            if (status === 201 && data.token) {
                onLoginSuccess(username, data.token, data.expiresAt);
                closeModal();
            } else if (status === 409) {
                errorEl.textContent = 'That username is already taken.';
            } else if (status === 429) {
                errorEl.textContent = 'Too many attempts. Wait a bit and try again.';
            } else {
                errorEl.textContent = 'Invalid username or password (check the requirements above).';
            }
        }

        submit.addEventListener('click', doRegister);
        modal.querySelector('#gcl-register-password').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doRegister();
        });
    }

    // --------------------------------------------------------------------
    // Account modal (shown when already logged in — logout + delete account)
    // --------------------------------------------------------------------

    function showAccountModal() {
        const modal = openModal(`
      <h2>Community Account</h2>
      <div class="gcl-field">
        <label>Logged in as</label>
        <input type="text" value="${escapeHtml(currentUser.username)}" disabled />
      </div>
      <button class="gcl-primary" id="gcl-logout-submit">Log Out</button>

      <div class="gcl-danger-zone">
        <div class="gcl-danger-label">Delete account permanently</div>
        <div class="gcl-swipe-track" id="gcl-swipe-track">
          <div class="gcl-swipe-label" id="gcl-swipe-label">Swipe to confirm</div>
          <div class="gcl-swipe-thumb" id="gcl-swipe-thumb">&rarr;</div>
        </div>
        <div id="gcl-unregister-step2" style="display:none; margin-top:10px;">
          <div class="gcl-field">
            <label>Re-enter your password to permanently delete this account</label>
            <input type="password" id="gcl-unregister-password" autocomplete="off" />
          </div>
          <div class="gcl-error" id="gcl-unregister-error"></div>
          <button class="gcl-primary gcl-danger-btn" id="gcl-unregister-submit">
            Permanently Delete Account
          </button>
        </div>
      </div>
    `);

        modal.querySelector('#gcl-logout-submit').addEventListener('click', async () => {
            await performLogout();
            closeModal();
        });

        setupSwipeConfirm(modal);
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // Simple drag-to-confirm swipe. Once the thumb reaches the end of the
    // track, reveal the password re-entry step. This is a deliberate-action
    // gate, not itself a security boundary — the password check server-side
    // is what actually protects against accidental/unattended deletion.
    function setupSwipeConfirm(modal) {
        const track = modal.querySelector('#gcl-swipe-track');
        const thumb = modal.querySelector('#gcl-swipe-thumb');
        const label = modal.querySelector('#gcl-swipe-label');
        const step2 = modal.querySelector('#gcl-unregister-step2');

        let dragging = false;
        let confirmed = false;
        const trackWidth = 260;
        const thumbWidth = 34;
        const maxX = trackWidth - thumbWidth - 6;

        function setThumbX(x) {
            thumb.style.left = `${3 + Math.max(0, Math.min(maxX, x))}px`;
        }

        function onDown() {
            if (confirmed) return;
            dragging = true;
            thumb.style.cursor = 'grabbing';
        }

        function onMove(e) {
            if (!dragging || confirmed) return;
            const rect = track.getBoundingClientRect();
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const x = clientX - rect.left - thumbWidth / 2;
            setThumbX(x);
            if (x >= maxX - 4) {
                confirmed = true;
                dragging = false;
                setThumbX(maxX);
                track.classList.add('gcl-confirmed');
                label.textContent = 'Confirmed';
                thumb.textContent = '\u2713';
                step2.style.display = 'block';
            }
        }

        function onUp() {
            if (!dragging) return;
            dragging = false;
            thumb.style.cursor = 'grab';
            if (!confirmed) setThumbX(0);
        }

        thumb.addEventListener('mousedown', onDown);
        thumb.addEventListener('touchstart', onDown, { passive: true });
        window.addEventListener('mousemove', onMove);
        window.addEventListener('touchmove', onMove, { passive: true });
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchend', onUp);

        const submit = modal.querySelector('#gcl-unregister-submit');
        const errorEl = modal.querySelector('#gcl-unregister-error');

        submit.addEventListener('click', async () => {
            const password = modal.querySelector('#gcl-unregister-password').value;
            errorEl.textContent = '';

            if (!password) {
                errorEl.textContent = 'Enter your password to confirm.';
                return;
            }

            submit.disabled = true;
            submit.textContent = 'Deleting...';

            const { status } = await apiUnregister(currentToken, password);

            if (status === 200) {
                currentUser = null;
                currentToken = null;
                clearSession();
                updateBadge();
                window.dispatchEvent(new CustomEvent('gcl:logout'));
                window.dispatchEvent(new CustomEvent('gcl:unregistered'));
                closeModal();
                return;
            }

            submit.disabled = false;
            submit.textContent = 'Permanently Delete Account';

            if (status === 401) {
                errorEl.textContent = 'Incorrect password. Account was not deleted.';
            } else {
                errorEl.textContent = 'Something went wrong. Account was not deleted.';
            }
        });
    }

    // --------------------------------------------------------------------
    // Session lifecycle
    // --------------------------------------------------------------------

    function onLoginSuccess(username, token, expiresAt) {
        currentUser = { username };
        currentToken = token;
        saveSession(token, expiresAt);
        updateBadge();
        window.dispatchEvent(new CustomEvent('gcl:login', {
            detail: { username, token }
        }));
    }

    async function performLogout() {
        const token = currentToken;
        currentUser = null;
        currentToken = null;
        clearSession();
        updateBadge();
        window.dispatchEvent(new CustomEvent('gcl:logout'));

        if (token) {
            await apiLogout(token);
        }
    }

    async function tryAutoLogin() {
        const token = getStoredToken();
        if (!token) return;

        const { status, data } = await apiVerify(token);
        if (status === 200) {
            const expiresAt = Number(localStorage.getItem(STORAGE_EXPIRES_KEY));
            currentToken = token;
            currentUser = { username: data.username || '(unknown)' };
            saveSession(token, expiresAt);
            updateBadge();
            window.dispatchEvent(new CustomEvent('gcl:login', {
                detail: {
                    username: currentUser.username,
                    token
                }
            }));
        } else {
            clearSession();
        }
    }

    // --------------------------------------------------------------------
    // Init
    // --------------------------------------------------------------------

    function init() {
        injectStyle();
        ensureBadge();
        tryAutoLogin();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Expose a small API for other parts of the userscript.
    window.gclAuth = {
        isLoggedIn,
        getUser: () => currentUser,
        getToken: () => currentToken,
        logout: performLogout,
    };
})();

// ============================================================================
// ws-hook.js — WebSocket tap ONLY. UNCHANGED.
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
// hook-handler.js — SELF username injection && OTHERS username checks
//
// CHANGES in v1.5:
//   1. rebuildPlayer is applied as soon as a name is found (not only on 's').
//   2. rebuildPlayer waits until the ghost has received a REAL 'c' status
//      frame — the old version injected blank colour/radius/hp, which made
//      the player's body circle disappear.
//   3. The rebuilt 'c' message now has all 17 fields (chatMessage added).
//   4. Self presence is also reported when you log in AFTER the game's 'a'
//      frame already arrived (login race), and /presence/set is traced.
//   5. console.clear() is now opt-in (CLEAR_CONSOLE) so traces survive.
// ============================================================================

(function hook_handler() {
    'use strict';

    const WORKER_URL = 'https://login-info-handler.gitgames.workers.dev';
    const BATCH_MAX_IDS = 25;

    //persistant variables
    let lastReportedServer = null;
    let lastReportedId = null;
    let mySelfId = null; // our own in-game id, from the 'a' frame

    const ghosts = {};

    let UNKNOWN_IDS = [];
    let LAZY_IDS = {};

    // Lookup throttling. The game re-sends 'd' every time a player re-enters
    // view range, and guests can never be resolved, so without this the same
    // ids were re-queried endlessly, several 60s streams at a time.
    const IN_FLIGHT = new Set();   // ids with a lookup-batch currently open
    const RETRY_AT = {};           // id -> earliest time we may ask again
    const ATTEMPTS = {};           // id -> consecutive unresolved lookups
    const RETRY_BASE_MS = 5000;
    const RETRY_MAX_MS = 30000;

    let RETURN_MESSAGE = undefined;
    let INJECT_MESSAGES = [];

    //Websocket Hooks
    window.gclWsHook.onEveryFrame((frame) => {
        const decoded = decodeRelevant(frame);
        if (!decoded) return;

        const A_USERNAME_INDEX = 18;

        switch (decoded.code) {
            case 'a': //self player init
                mySelfId = decoded.msg[1];
                console.log('[gcl-trace] A arrived — self id:', mySelfId, 'logged in:', window.gclAuth.isLoggedIn());

                decoded.msg[A_USERNAME_INDEX] = window.gclAuth.isLoggedIn() ? window.gclAuth.getUser().username : decoded.msg[A_USERNAME_INDEX];
                RETURN_MESSAGE = decoded.msg.join(',');

                if (window.gclAuth.isLoggedIn()) {
                    reportSelfPresence(decoded.msg[1]); // fire-and-forget, don't block the frame
                }
                break;
            case 'b': //position update
                if (!(decoded.id in ghosts)) break;
                if (decoded.id === lastReportedId) break;

                mergeFields(ghosts[decoded.id], decoded, ['x', 'y', 'spdX', 'spdY', 'playerAngle']);

                break;

            case 'c': { //status update
                if (!(decoded.id in ghosts)) break;
                if (decoded.id === lastReportedId) break;

                const g = ghosts[decoded.id];

                if (!g.loggedFirstC) {
                    g.loggedFirstC = true;
                    console.log('[gcl-trace] FIRST C raw for id', decoded.id, ':', frame);
                }

                // The game delta-encodes frames: a BLANK field means "unchanged",
                // not "empty". Only overwrite with non-blank values, otherwise a
                // later sparse 'c' wipes radius/colorCode and the body vanishes.
                mergeFields(g, decoded, [
                    'currentBullets', 'shooting', 'reloading', 'hp', 'beingHit',
                    'armorAmount', 'radius', 'ghillie', 'maxBullets', 'invincible',
                    'dashing', 'chatBoxOpen', 'isLeader', 'colorCode'
                ]);
                g.chatMessage = decoded.chatMessage; // blank = no message, don't merge

                // Only treat the ghost as "ready" once it has the fields that
                // make the body draw.
                if (isFilled(g.radius) && isFilled(g.colorCode)) g.hasStatus = true;

                // If we already know this player's community name but couldn't
                // apply it yet (no status data back then), apply it now.
                if (decoded.id in LAZY_IDS && !g.rebuilt) {
                    console.log('[gcl-trace] C arrived for known id', decoded.id, '— applying deferred rebuild');
                    rebuildPlayer(decoded.id, g);
                }

                break;
            }
            case 'd': //new player join
                console.log('[gcl-trace] D arrived — id:', decoded.id, 'username:', decoded.username, 'raw:', frame);
                ghosts[decoded.id] = {
                    classCode: decoded.classCode, colorCode: decoded.colorCode,
                    x: decoded.x, y: decoded.y, radius: decoded.radius,
                    playerAngle: decoded.playerAngle, armorAmount: decoded.armorAmount,
                    hp: decoded.hp, maxBullets: decoded.maxBullets,
                    username: decoded.username, ghillie: decoded.ghillie,
                    invincible: decoded.invincible, isLeader: decoded.isLeader,
                    isPremiumMember: decoded.isPremiumMember, teamCode: decoded.teamCode,
                    chatBoxOpen: decoded.chatBoxOpen,
                    hasStatus: false, // set true once a real 'c' frame arrives
                    rebuilt: false
                };
                if (decoded.id in LAZY_IDS) {
                    // Name already known: the first real 'c' frame applies it.
                    console.log('[gcl-trace] D — id', decoded.id, 'already resolved, skipping lookup');
                } else {
                    UNKNOWN_IDS.push(decoded.id);
                    console.log('[gcl-trace] D — pushed to UNKNOWN_IDS, now:', JSON.stringify(UNKNOWN_IDS));
                }

                break;
            case 'e':
                if (decoded.id in ghosts) delete ghosts[decoded.id];

                UNKNOWN_IDS = UNKNOWN_IDS.filter(ID => ID !== decoded.id);

                if (decoded.id in LAZY_IDS) delete LAZY_IDS[decoded.id];

                break;
            case 's':
                console.log('[gcl-trace] S arrived — calling checkLazyIDs. Current LAZY_IDS:', JSON.stringify(LAZY_IDS), 'ghosts keys:', JSON.stringify(Object.keys(ghosts)));
                checkLazyIDs();

                break;
        }
    });

    window.gclWsHook.addFrameTransformer((frame) => {
        if (RETURN_MESSAGE) {
            frame = RETURN_MESSAGE;
            RETURN_MESSAGE = null;
        }


        for (const message of INJECT_MESSAGES) {
            frame += '|';
            frame += message;
        }
        INJECT_MESSAGES = [];
        return frame;
    });

    window.gclWsHook.onBatchComplete(() => {
        if (UNKNOWN_IDS.length === 0) return;

        const now = Date.now();
        const ready = [];
        const waiting = [];
        for (const id of UNKNOWN_IDS) {
            if (!(id in ghosts)) continue;                              // player already gone
            if (IN_FLIGHT.has(id)) continue;                            // lookup already open for this id
            if (ready.includes(id) || waiting.includes(id)) continue;   // duplicate in the queue
            if ((RETRY_AT[id] || 0) > now) waiting.push(id);            // backing off
            else ready.push(id);
        }
        UNKNOWN_IDS = waiting;
        if (ready.length === 0) return;

        for (const id of ready) IN_FLIGHT.add(id);
        console.log('[gcl-trace] batch complete — kicking off startIdChecks for:', JSON.stringify(ready));
        startIdChecks(ready);
    });

    window.gclWsHook.onSocketClose(() => {
        if (window.gclAuth.isLoggedIn()) {
            // fire-and-forget; pass the exact (server, id) we reported so the
            // worker only clears OUR record, not a newer session's.
            clearSelfPresence(lastReportedServer, lastReportedId);
        }

        for (const id of Object.keys(ghosts)) delete ghosts[id];
        UNKNOWN_IDS = [];
        LAZY_IDS = {};
        RETURN_MESSAGE = null;
        INJECT_MESSAGES.length = 0;
        lastReportedServer = null;
        lastReportedId = null;
        mySelfId = null;
        IN_FLIGHT.clear();
        for (const k of Object.keys(RETRY_AT)) delete RETRY_AT[k];
        for (const k of Object.keys(ATTEMPTS)) delete ATTEMPTS[k];
    });

    // Login race fix: if the user logs in (or auto-login finishes) AFTER the
    // game's 'a' frame already arrived, report presence now. The username
    // itself can't be injected retroactively, but others will at least be
    // able to look this player up.
    window.addEventListener('gcl:login', () => {
        if (mySelfId !== null && window.gclWsHook.getCurrentServerUrl()) {
            console.log('[gcl-trace] gcl:login after A frame — reporting presence late for id:', mySelfId);
            reportSelfPresence(mySelfId);
        }
    });

    // Tab closing/reloading: the socket 'close' event isn't reliable then, so
    // also clear presence on pagehide (best effort; the worker's ownership
    // checks make a missed clear harmless anyway).
    window.addEventListener('pagehide', () => {
        if (window.gclAuth.isLoggedIn()) {
            clearSelfPresence(lastReportedServer, lastReportedId);
        }
    });

    //helper functions
    function isFilled(v) {
        return v !== undefined && v !== '';
    }

    // Copy only non-blank fields from a decoded frame onto a ghost.
    function mergeFields(target, source, fields) {
        for (const f of fields) {
            if (isFilled(source[f])) target[f] = source[f];
        }
    }

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

    //async functions
    async function reportSelfPresence(selfId) {
        const server = window.gclWsHook.getCurrentServerUrl();
        if (lastReportedServer === server && lastReportedId === String(selfId)) return;

        const token = window.gclAuth.getToken();
        console.log('[gcl-trace] presence/set — sending. server:', server, 'id:', selfId);
        try {
            const res = await fetch(WORKER_URL + '/presence/set', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ server, id: String(selfId) }),
            });
            console.log('[gcl-trace] presence/set — response status:', res.status);
            if (res.ok) {
                lastReportedServer = server;
                lastReportedId = String(selfId);
            }
        } catch (e) {
            console.error('[gcl] presence/set failed:', e);
        }
    }

    async function startIdChecksChunk(IDS) {
        const server = window.gclWsHook.getCurrentServerUrl();
        console.log('[gcl-trace] startIdChecksChunk — requesting lookup-batch for:', JSON.stringify(IDS), 'server:', server);

        let res;
        try {
            res = await fetch(WORKER_URL + '/presence/lookup-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ server, ids: IDS }),
            });
        } catch (e) {
            console.error('[gcl] presence/lookup-batch fetch failed:', e);
            return IDS; // treat as unresolved; backoff below decides when to retry
        }

        console.log('[gcl-trace] startIdChecksChunk — response status:', res.status, 'ok:', res.ok);

        if (!res.ok) {
            console.error('[gcl] presence/lookup-batch request failed:', res.status);
            return IDS;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        let REMAINING_IDS = IDS;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    console.log('[gcl-trace] startIdChecksChunk — stream reader done (no more data)');
                    break;
                }

                buffer += decoder.decode(value, { stream: true });

                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newlineIndex);
                    buffer = buffer.slice(newlineIndex + 1);
                    if (!line) continue;

                    console.log('[gcl-trace] startIdChecksChunk — stream line received:', line);
                    const msg = JSON.parse(line);

                    if (msg.found) {
                        console.log('[gcl-trace] startIdChecksChunk — FOUND matches in this line:', JSON.stringify(msg.found));
                        for (const { id, username } of msg.found) {
                            LAZY_IDS[id] = username;
                            console.log('[gcl-trace] LAZY_IDS SET — id:', id, 'username:', username);
                            REMAINING_IDS = REMAINING_IDS.filter(ID => ID !== id);

                            // Apply the name now (deferred internally if the
                            // ghost has no real status data yet).
                            if (id in ghosts) rebuildPlayer(id, ghosts[id]);
                        }
                    }

                    if (msg.done) {
                        console.log('[gcl-trace] startIdChecksChunk — stream signaled done. unresolved:', JSON.stringify(msg.unresolved));
                        const sortedRemaining = [...REMAINING_IDS].sort();
                        const sortedUnresolved = [...msg.unresolved].sort();
                        if (sortedRemaining.join(',') !== sortedUnresolved.join(',')) {
                            console.log("[gcl] ID_Check timeout Id's remaining discrepancy found. Reverting to client authoritative");
                        }
                        return REMAINING_IDS;
                    }
                }
            }
        } catch (e) {
            console.error('[gcl] presence/lookup-batch stream error:', e);
        }

        return REMAINING_IDS;
    }

    async function startIdChecks(IDS) {
        const chunks = [];
        for (let i = 0; i < IDS.length; i += BATCH_MAX_IDS) {
            chunks.push(IDS.slice(i, i + BATCH_MAX_IDS));
        }

        let stillUnresolved;
        try {
            const results = await Promise.all(chunks.map((chunk) => startIdChecksChunk(chunk)));
            stillUnresolved = results.flat();
        } catch (e) {
            console.error('[gcl] startIdChecks failed:', e);
            stillUnresolved = IDS;
        }

        console.log('[gcl-trace] startIdChecks — all chunks settled. stillUnresolved:', JSON.stringify(stillUnresolved));

        for (const id of IDS) IN_FLIGHT.delete(id);

        const now = Date.now();
        for (const id of IDS) {
            if (stillUnresolved.includes(id)) {
                if (!(id in ghosts)) continue; // left while we were asking
                const attempts = (ATTEMPTS[id] = (ATTEMPTS[id] || 0) + 1);
                RETRY_AT[id] = now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
                UNKNOWN_IDS.push(id);
            } else {
                delete ATTEMPTS[id];
                delete RETRY_AT[id];
            }
        }
    }

    async function checkLazyIDs() {
        const server = window.gclWsHook.getCurrentServerUrl();
        for (const ID of Object.keys(LAZY_IDS)) {
            if (!(ID in ghosts)) {
                console.log('[gcl-trace] checkLazyIDs — dropping LAZY_IDS entry for', ID, '(no longer in ghosts)');
                delete LAZY_IDS[ID];
            }
        }
        for (const ID of Object.keys(LAZY_IDS)) {
            console.log('[gcl-trace] checkLazyIDs — re-verifying', ID, 'via idRegistered');
            const UPDATED_USERNAME = await idRegistered(server, ID);
            console.log('[gcl-trace] checkLazyIDs — idRegistered(', ID, ') returned:', UPDATED_USERNAME);
            if (!(ID in ghosts)) continue;
            if (!UPDATED_USERNAME) {
                const wasTracked = LAZY_IDS[ID] !== undefined;
                delete LAZY_IDS[ID];
                if (wasTracked) rebuildPlayer(ID, ghosts[ID]);
                continue;
            }

            if (UPDATED_USERNAME === LAZY_IDS[ID]) {
                console.log('[gcl-trace] checkLazyIDs —', ID, 'username unchanged, skipping rebuild');
                continue;
            }

            LAZY_IDS[ID] = UPDATED_USERNAME;
            rebuildPlayer(ID, ghosts[ID]);
        }
    }

    async function clearSelfPresence(server, id) {
        if (!server || !id) return; // never reported presence, nothing to clear
        const token = window.gclAuth.getToken();
        if (!token) return;
        try {
            await fetch(WORKER_URL + '/presence/clear', {
                method: 'POST',
                keepalive: true, // lets the request outlive a closing tab
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ server, id: String(id) }),
            });
        } catch (e) {
            console.error('[gcl] presence/clear failed:', e);
        }
    }

    async function idRegistered(server, id, attempt = 0) {
        const MAX_ATTEMPTS = 5;

        const res = await fetch(WORKER_URL + '/presence/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server, id: String(id) }),
        });
        let data = {};
        try { data = await res.json(); } catch (e) {}

        if (res.ok && data.code === 'PRESENCE_FOUND') return data.username;
        if (res.ok) return null; // genuinely not found — don't retry, this is expected/permanent
        if (attempt >= MAX_ATTEMPTS) return null; // network/server error, give up after a few tries
        await new Promise(r => setTimeout(r, 500));
        return idRegistered(server, id, attempt + 1);
    }
})();

// Console clearing is now opt-in so the [gcl-trace] lines stay visible.
// Set CLEAR_CONSOLE to true to get the old behaviour back.
(async function cleanup_console() {
    const CLEAR_CONSOLE = false;
    if (!CLEAR_CONSOLE) return;
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.clear();
})();
