/*
 * Jellyfin "Donations" plugin - web client script.
 *
 * Injected into index.html by the server plugin. Written in ES5 on purpose: the
 * Jellyfin web client also runs inside old smart-TV webviews.
 *
 * Public API: window.JellyfinDonate.open()  -> opens the donate page on demand.
 */
(function () {
    'use strict';

    if (window.JellyfinDonate) {
        return;
    }

    var STYLE_ID = 'jfd-styles';
    var POLL_MS = 1000;

    var config = null;
    var configUserId = null;
    var lastUserId = null;
    var overlay = null;
    var previousFocus = null;
    var promptTimer = null;
    var persistentButton = null;

    // ---------------------------------------------------------------- helpers

    function log() {
        if (window.JFD_DEBUG && window.console) {
            console.log.apply(console, ['[Donations]'].concat([].slice.call(arguments)));
        }
    }

    function apiReady() {
        return !!(window.ApiClient && typeof window.ApiClient.getUrl === 'function');
    }

    function loggedInUserId() {
        try {
            if (!apiReady() || !ApiClient.isLoggedIn || !ApiClient.isLoggedIn()) {
                return null;
            }
            var id = ApiClient.getCurrentUserId();
            return id || null;
        } catch (err) {
            return null;
        }
    }

    function request(method, path, body) {
        var options = { type: method, url: ApiClient.getUrl(path), dataType: 'json' };
        if (body !== undefined) {
            options.data = JSON.stringify(body);
            options.contentType = 'application/json';
        }
        return ApiClient.ajax(options);
    }

    function storage(kind) {
        try {
            return kind === 'session' ? window.sessionStorage : window.localStorage;
        } catch (err) {
            return null;
        }
    }

    function storageGet(kind, key) {
        var store = storage(kind);
        try {
            return store ? store.getItem(key) : null;
        } catch (err) {
            return null;
        }
    }

    function storageSet(kind, key, value) {
        var store = storage(kind);
        try {
            if (store) {
                store.setItem(key, value);
            }
        } catch (err) {
            /* private mode, quota, whatever - the server copy is authoritative anyway */
        }
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined && text !== null) {
            node.textContent = text;
        }
        return node;
    }

    /*
     * Admin-authored copy. Plain text by default (newlines become paragraphs);
     * raw HTML only when the admin explicitly enabled it in the settings.
     */
    function setText(node, value) {
        node.innerHTML = '';
        if (!value) {
            return;
        }
        if (config && config.AllowHtml) {
            node.innerHTML = value;
            return;
        }
        var paragraphs = String(value).split(/\n\s*\n/);
        for (var i = 0; i < paragraphs.length; i++) {
            var lines = paragraphs[i].split('\n');
            var p = document.createElement('p');
            for (var j = 0; j < lines.length; j++) {
                if (j > 0) {
                    p.appendChild(document.createElement('br'));
                }
                p.appendChild(document.createTextNode(lines[j]));
            }
            node.appendChild(p);
        }
    }

    /*
     * Jellyfin serialises API responses in PascalCase today. Normalising the keys
     * keeps the script working if that ever changes to camelCase.
     */
    function pascalKeys(obj) {
        if (!obj || typeof obj !== 'object') {
            return obj;
        }
        var out = {};
        for (var key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                out[key.charAt(0).toUpperCase() + key.slice(1)] = obj[key];
            }
        }
        return out;
    }

    function normalizeConfig(raw) {
        var result = pascalKeys(raw);
        var methods = result.Methods || [];
        result.Methods = [];
        for (var i = 0; i < methods.length; i++) {
            result.Methods.push(pascalKeys(methods[i]));
        }
        return result;
    }

    function safeImageUrl(url) {
        if (!url) {
            return '';
        }
        var trimmed = String(url).trim();
        return /^(https?:\/\/|data:image\/)/i.test(trimmed) ? trimmed : '';
    }

    /*
     * Admins type "paypal.me/name" far more often than "https://paypal.me/name", and
     * silently dropping the link left an empty card. Fill in the obvious scheme rather
     * than rejecting it, while still refusing anything that is not a web/payment link
     * (javascript: and friends).
     */
    function safeUrl(url) {
        if (!url) {
            return '';
        }

        var trimmed = String(url).trim();
        if (/^(https?:|mailto:|bitcoin:|lightning:|upi:)/i.test(trimmed)) {
            return trimmed;
        }
        if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(trimmed)) {
            return 'mailto:' + trimmed;
        }
        // A bare host, optionally with a path: "paypal.me/x", "www.example.com".
        if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/|\?|#|$)/i.test(trimmed)) {
            return 'https://' + trimmed;
        }
        return '';
    }

    function copyText(value, onDone) {
        function fallback() {
            var box = document.createElement('textarea');
            box.value = value;
            box.setAttribute('readonly', '');
            box.style.position = 'fixed';
            box.style.opacity = '0';
            document.body.appendChild(box);
            box.select();
            var ok = false;
            try {
                ok = document.execCommand('copy');
            } catch (err) {
                ok = false;
            }
            document.body.removeChild(box);
            onDone(ok);
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(value).then(function () {
                onDone(true);
            }, fallback);
        } else {
            fallback();
        }
    }

    // ----------------------------------------------------------------- styles

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }
        var css = [
            '.jfd-root{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;',
            'justify-content:center;padding:20px;box-sizing:border-box;',
            'font-family:inherit;--jfd-accent:#00a4dc;--jfd-bg:#1c1c1f;--jfd-fg:#f2f2f4;',
            '--jfd-muted:#a9adb6;--jfd-line:rgba(255,255,255,.12);--jfd-card:rgba(255,255,255,.05);',
            '--jfd-card-hover:rgba(255,255,255,.1);}',
            '.jfd-root.jfd-light{--jfd-bg:#ffffff;--jfd-fg:#16181d;--jfd-muted:#5b6270;',
            '--jfd-line:rgba(0,0,0,.12);--jfd-card:rgba(0,0,0,.035);--jfd-card-hover:rgba(0,0,0,.07);}',
            '.jfd-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.72);',
            '-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);animation:jfd-fade .18s ease-out;}',
            '.jfd-dialog{position:relative;width:100%;max-width:480px;max-height:100%;overflow-y:auto;',
            '-webkit-overflow-scrolling:touch;background:var(--jfd-bg);color:var(--jfd-fg);',
            'border:1px solid var(--jfd-line);border-radius:14px;padding:28px;box-sizing:border-box;',
            'box-shadow:0 24px 64px rgba(0,0,0,.5);animation:jfd-pop .2s cubic-bezier(.2,.8,.3,1);}',
            '.jfd-dialog.jfd-wide{max-width:660px;}',
            '@keyframes jfd-fade{from{opacity:0}to{opacity:1}}',
            '@keyframes jfd-pop{from{opacity:0;transform:translateY(12px) scale(.98)}',
            'to{opacity:1;transform:none}}',
            '.jfd-title{margin:0 0 12px;font-size:1.4em;font-weight:600;line-height:1.25;}',
            '.jfd-body{color:var(--jfd-muted);font-size:.95em;line-height:1.55;}',
            '.jfd-body p{margin:0 0 10px;}.jfd-body p:last-child{margin-bottom:0;}',
            '.jfd-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px;}',
            '.jfd-btn{flex:1 1 auto;min-width:130px;padding:11px 18px;border-radius:8px;border:1px solid transparent;',
            'font-size:.95em;font-weight:600;cursor:pointer;font-family:inherit;line-height:1.3;',
            'transition:filter .15s ease,background .15s ease;}',
            '.jfd-btn:focus-visible{outline:2px solid var(--jfd-accent);outline-offset:2px;}',
            '.jfd-btn-primary{background:var(--jfd-accent);color:#fff;}',
            '.jfd-btn-primary:hover{filter:brightness(1.12);}',
            '.jfd-btn-secondary{background:transparent;color:var(--jfd-fg);border-color:var(--jfd-line);}',
            '.jfd-btn-secondary:hover{background:var(--jfd-card-hover);}',
            '.jfd-check{display:flex;align-items:center;gap:9px;margin-top:18px;color:var(--jfd-muted);',
            'font-size:.88em;cursor:pointer;user-select:none;}',
            '.jfd-check input{width:16px;height:16px;accent-color:var(--jfd-accent);cursor:pointer;margin:0;flex:0 0 auto;}',
            '.jfd-close{position:absolute;top:12px;right:12px;width:32px;height:32px;border:0;border-radius:50%;',
            'background:transparent;color:var(--jfd-muted);font-size:20px;line-height:1;cursor:pointer;}',
            '.jfd-close:hover{background:var(--jfd-card-hover);color:var(--jfd-fg);}',
            '.jfd-methods{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;margin-top:20px;}',
            '.jfd-method{display:flex;flex-direction:column;gap:8px;padding:14px;border-radius:10px;',
            'background:var(--jfd-card);border:1px solid var(--jfd-line);text-align:left;}',
            '.jfd-method-head{display:flex;align-items:center;gap:10px;}',
            '.jfd-icon{flex:0 0 auto;width:34px;height:34px;border-radius:8px;display:flex;align-items:center;',
            'justify-content:center;font-size:15px;font-weight:700;color:#fff;background:var(--jfd-accent);',
            'text-transform:uppercase;}',
            '.jfd-method-name{font-weight:600;font-size:1em;}',
            '.jfd-handle{display:flex;align-items:center;gap:6px;}',
            '.jfd-handle code{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
            'background:var(--jfd-card-hover);border-radius:6px;padding:5px 8px;font-size:.85em;',
            'font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--jfd-fg);}',
            '.jfd-copy{flex:0 0 auto;padding:5px 10px;border-radius:6px;border:1px solid var(--jfd-line);',
            'background:transparent;color:var(--jfd-muted);font-size:.78em;cursor:pointer;font-family:inherit;}',
            '.jfd-copy:hover{background:var(--jfd-card-hover);color:var(--jfd-fg);}',
            '.jfd-note{font-size:.82em;color:var(--jfd-muted);line-height:1.45;}',
            '.jfd-qr{max-width:140px;border-radius:8px;align-self:center;background:#fff;padding:6px;}',
            '.jfd-go{margin-top:auto;padding:9px 14px;border-radius:7px;border:0;background:var(--jfd-accent);',
            'color:#fff;font-weight:600;font-size:.88em;cursor:pointer;font-family:inherit;}',
            '.jfd-go:hover{filter:brightness(1.12);}',
            '.jfd-thanks{margin-top:20px;padding:16px;border-radius:10px;border:1px solid var(--jfd-accent);',
            'background:var(--jfd-card);}',
            '.jfd-thanks .jfd-title{font-size:1.1em;margin-bottom:8px;}',
            '.jfd-thanks .jfd-body{color:var(--jfd-fg);}',
            '.jfd-empty{margin-top:20px;padding:16px;border:1px dashed var(--jfd-line);border-radius:10px;',
            'color:var(--jfd-muted);font-size:.9em;}',
            '.jfd-fab{position:fixed;right:18px;bottom:18px;z-index:99998;padding:10px 16px;border:0;',
            'border-radius:999px;background:#00a4dc;color:#fff;font-weight:600;font-size:.9em;cursor:pointer;',
            'font-family:inherit;box-shadow:0 6px 20px rgba(0,0,0,.35);}',
            '.jfd-fab:hover{filter:brightness(1.12);}',
            '@media (max-width:600px){.jfd-dialog{padding:22px;}',
            '.jfd-methods{grid-template-columns:1fr;}.jfd-btn{flex:1 1 100%;}}'
        ].join('');

        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = css;
        document.head.appendChild(style);
    }

    // ---------------------------------------------------------------- overlay

    function isLightTheme() {
        var mode = (config && config.Appearance) || 'auto';
        if (mode === 'light') {
            return true;
        }
        if (mode === 'dark') {
            return false;
        }
        try {
            return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
        } catch (err) {
            return false;
        }
    }

    function closeOverlay() {
        if (!overlay) {
            return;
        }
        document.removeEventListener('keydown', onKeyDown, true);
        if (overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
        overlay = null;
        if (previousFocus && previousFocus.focus) {
            try {
                previousFocus.focus();
            } catch (err) { /* element may be gone */ }
        }
        previousFocus = null;
    }

    function onKeyDown(event) {
        if (!overlay) {
            return;
        }
        if (event.key === 'Escape' || event.keyCode === 27) {
            event.preventDefault();
            event.stopPropagation();
            closeOverlay();
            return;
        }
        if (event.key === 'Tab' || event.keyCode === 9) {
            var focusable = overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
            if (!focusable.length) {
                return;
            }
            var first = focusable[0];
            var last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    }

    function buildOverlay(wide) {
        closeOverlay();
        injectStyles();
        previousFocus = document.activeElement;

        var root = el('div', 'jfd-root' + (isLightTheme() ? ' jfd-light' : ''));
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        if (config && config.AccentColor) {
            root.style.setProperty('--jfd-accent', config.AccentColor);
        }

        var backdrop = el('div', 'jfd-backdrop');
        backdrop.addEventListener('click', closeOverlay);
        root.appendChild(backdrop);

        var dialog = el('div', 'jfd-dialog' + (wide ? ' jfd-wide' : ''));
        root.appendChild(dialog);

        var close = el('button', 'jfd-close', '×');
        close.type = 'button';
        close.setAttribute('aria-label', 'Close');
        close.addEventListener('click', closeOverlay);
        dialog.appendChild(close);

        document.body.appendChild(root);
        document.addEventListener('keydown', onKeyDown, true);

        overlay = root;
        return dialog;
    }

    // ------------------------------------------------------------------ popup

    function showPopup() {
        var dialog = buildOverlay(false);

        var title = el('h2', 'jfd-title', config.PopupTitle || 'Support this server');
        dialog.appendChild(title);
        labelDialog(title);

        var body = el('div', 'jfd-body');
        setText(body, config.PopupMessage);
        dialog.appendChild(body);

        var dontRemind = null;
        if (config.ShowDontRemindOption) {
            var label = el('label', 'jfd-check');
            dontRemind = document.createElement('input');
            dontRemind.type = 'checkbox';
            label.appendChild(dontRemind);
            label.appendChild(document.createTextNode(config.DontRemindText || "Don't remind me again"));
            dialog.appendChild(label);
        }

        function applyDontRemind() {
            if (dontRemind && dontRemind.checked) {
                setOptOut(true);
            }
        }

        var actions = el('div', 'jfd-actions');

        var yes = el('button', 'jfd-btn jfd-btn-primary', config.DonateButtonText || 'Donate');
        yes.type = 'button';
        yes.addEventListener('click', function () {
            applyDontRemind();
            var external = safeUrl(config.ExternalDonatePageUrl);
            if (external) {
                closeOverlay();
                window.open(external, '_blank', 'noopener,noreferrer');
            } else {
                showDonatePage();
            }
        });
        actions.appendChild(yes);

        var no = el('button', 'jfd-btn jfd-btn-secondary', config.CloseButtonText || 'Close');
        no.type = 'button';
        no.addEventListener('click', function () {
            applyDontRemind();
            closeOverlay();
        });
        actions.appendChild(no);

        dialog.appendChild(actions);
        yes.focus();

        markPrompted();
    }

    function labelDialog(titleNode) {
        if (!overlay) {
            return;
        }
        var id = 'jfd-title-' + Date.now();
        titleNode.id = id;
        overlay.setAttribute('aria-labelledby', id);
    }

    // ------------------------------------------------------------ donate page

    function showDonatePage() {
        var dialog = buildOverlay(true);

        var title = el('h2', 'jfd-title', config.DonatePageTitle || 'Support the server');
        dialog.appendChild(title);
        labelDialog(title);

        var body = el('div', 'jfd-body');
        setText(body, config.DonatePageMessage);
        dialog.appendChild(body);

        var thanks = buildThanksPanel();

        var methods = config.Methods || [];
        if (!methods.length) {
            var empty = el('div', 'jfd-empty',
                'No payment methods have been set up yet. Ask the server administrator to add one under '
                + 'Dashboard > Plugins > Donations.');
            dialog.appendChild(empty);
        } else {
            var grid = el('div', 'jfd-methods');
            var shown = 0;
            for (var i = 0; i < methods.length; i++) {
                var card = buildMethodCard(methods[i], thanks);
                // A method whose link could not be understood and that has no handle
                // would render as an empty box - leave it out entirely.
                if (card.getAttribute('data-usable') === '1') {
                    grid.appendChild(card);
                    shown++;
                }
            }
            if (shown) {
                dialog.appendChild(grid);
            } else {
                dialog.appendChild(el('div', 'jfd-empty',
                    'The payment methods are not set up correctly yet - ask the server administrator '
                    + 'to check the links under Dashboard > Plugins > Donations.'));
            }
        }

        dialog.appendChild(thanks.node);
        if (config.HasDonated) {
            thanks.reveal(false);
        }

        var actions = el('div', 'jfd-actions');
        var done = el('button', 'jfd-btn jfd-btn-secondary', config.CloseButtonText || 'Close');
        done.type = 'button';
        done.addEventListener('click', closeOverlay);
        actions.appendChild(done);
        dialog.appendChild(actions);

        dialog.scrollTop = 0;
        done.focus();
    }

    function buildThanksPanel() {
        var node = el('div', 'jfd-thanks');
        node.style.display = 'none';

        var heading = el('h3', 'jfd-title', 'Thank you!');
        node.appendChild(heading);

        var body = el('div', 'jfd-body');
        setText(body, config.ThankYouMessage);
        node.appendChild(body);

        var confirm = el('button', 'jfd-go', config.DonatedButtonText || "I've made a donation");
        confirm.type = 'button';
        confirm.style.marginTop = '12px';
        confirm.addEventListener('click', function () {
            confirm.disabled = true;
            confirm.textContent = 'Thanks - noted!';
            markDonated();
        });
        node.appendChild(confirm);

        return {
            node: node,
            reveal: function (scroll) {
                node.style.display = '';
                if (scroll !== false && node.scrollIntoView) {
                    node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
        };
    }

    function buildMethodCard(method, thanks) {
        var card = el('div', 'jfd-method');
        card.setAttribute('data-usable', (safeUrl(method.Url) || method.Handle) ? '1' : '0');
        var accent = method.Color || (config && config.AccentColor) || '#00a4dc';

        var head = el('div', 'jfd-method-head');
        var icon = el('div', 'jfd-icon', (method.Icon || method.Name || '?').substring(0, 2));
        icon.style.background = accent;
        head.appendChild(icon);
        head.appendChild(el('div', 'jfd-method-name', method.Name));
        card.appendChild(head);

        if (method.Handle) {
            var row = el('div', 'jfd-handle');
            row.appendChild(el('code', null, method.Handle));
            var copy = el('button', 'jfd-copy', 'Copy');
            copy.type = 'button';
            copy.addEventListener('click', function () {
                copyText(method.Handle, function (ok) {
                    copy.textContent = ok ? 'Copied' : 'Select it';
                    setTimeout(function () {
                        copy.textContent = 'Copy';
                    }, 2000);
                });
                thanks.reveal();
            });
            row.appendChild(copy);
            card.appendChild(row);
        }

        if (method.Instructions) {
            card.appendChild(el('div', 'jfd-note', method.Instructions));
        }

        var image = safeImageUrl(method.ImageUrl);
        if (image) {
            var qr = document.createElement('img');
            qr.className = 'jfd-qr';
            qr.src = image;
            qr.alt = method.Name + ' payment code';
            card.appendChild(qr);
        }

        var url = safeUrl(method.Url);
        if (url) {
            var go = el('button', 'jfd-go', 'Open ' + method.Name);
            go.type = 'button';
            go.style.background = accent;
            go.addEventListener('click', function () {
                window.open(url, '_blank', 'noopener,noreferrer');
                thanks.reveal();
            });
            card.appendChild(go);
        }

        return card;
    }

    // ------------------------------------------------------------ server sync

    function markPrompted() {
        if (configUserId) {
            storageSet('session', 'jfd.shown.' + configUserId, '1');
        }
        request('POST', 'Donate/Prompted').catch(function (err) {
            log('could not record prompt', err);
        });
    }

    function setOptOut(value) {
        if (configUserId) {
            storageSet('local', 'jfd.optout.' + configUserId, value ? '1' : '0');
        }
        request('POST', 'Donate/OptOut', { OptOut: !!value }).catch(function (err) {
            log('could not save opt-out', err);
        });
    }

    function markDonated() {
        if (config) {
            config.HasDonated = true;
        }
        request('POST', 'Donate/Donated').catch(function (err) {
            log('could not record donation', err);
        });
    }

    // -------------------------------------------------------- persistent link

    function updatePersistentButton() {
        var wanted = !!(config && config.Enabled && config.ShowPersistentButton && loggedInUserId());

        if (!wanted) {
            if (persistentButton && persistentButton.parentNode) {
                persistentButton.parentNode.removeChild(persistentButton);
            }
            persistentButton = null;
            return;
        }

        if (persistentButton) {
            return;
        }

        injectStyles();
        persistentButton = el('button', 'jfd-fab', config.PersistentButtonText || 'Donate');
        persistentButton.type = 'button';
        if (config.AccentColor) {
            persistentButton.style.background = config.AccentColor;
        }
        persistentButton.addEventListener('click', function () {
            showDonatePage();
        });
        document.body.appendChild(persistentButton);
    }

    // ------------------------------------------------------------ sidebar link

    /*
     * Adds a "Donate" row to the web client's navigation drawer. The drawer is
     * rebuilt on navigation, so this re-runs on a MutationObserver. It copies the
     * classes off an existing row so it inherits whatever theme is in use; if the
     * markup ever changes shape we simply do nothing and the floating button and
     * popup still work.
     */
    /*
     * Finds a real navigation link in the sidebar. Jellyfin 10.11 rebuilt the web client
     * on React/MUI, so the old .navMenuOption markup is gone and hardcoding class names
     * produces an unstyled inline link. Cloning a link that is already there means we
     * inherit whatever structure and styling the current client uses.
     */
    // Material Design "favorite" heart, 24x24 - drawn into whatever <svg> the cloned
    // nav link carries, so the entry does not keep the icon of the link we copied.
    var HEART_PATH = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3'
        + 'c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5'
        + 'c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';

    function setDonateIcon(svg) {
        try {
            while (svg.firstChild) {
                svg.removeChild(svg.firstChild);
            }
            var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', HEART_PATH);
            svg.appendChild(path);
            if (!svg.getAttribute('viewBox')) {
                svg.setAttribute('viewBox', '0 0 24 24');
            }
        } catch (err) {
            log('could not swap the sidebar icon', err);
        }
    }

    function findNavTemplate() {
        var selectors = [
            '.mainDrawer a[href*="#/home"]',
            '.mainDrawer a[href*="#!/home"]',
            'nav a[href*="#/home"]',
            '[class*="drawer" i] a[href*="#/home"]',
            '[class*="nav" i] a[href*="#/home"]',
            'a.navMenuOption'
        ];

        for (var i = 0; i < selectors.length; i++) {
            var found;
            try {
                found = document.querySelector(selectors[i]);
            } catch (err) {
                found = null;
            }
            if (found && found.parentNode) {
                return found;
            }
        }
        return null;
    }

    function addMenuItem() {
        if (!config || !config.Enabled || !config.ShowMenuItem || !loggedInUserId()) {
            return;
        }

        try {
            var template = findNavTemplate();
            if (!template) {
                // Nothing safe to copy - the floating button is the fallback.
                return;
            }

            // The repeating unit may be the link itself, or a wrapper around it
            // (MUI puts each link in its own list item). Climb while we are an only
            // child so the clone is inserted as a sibling of the other entries.
            var unit = template;
            while (unit.parentNode
                && unit.parentNode !== document.body
                && unit.parentNode.children.length === 1) {
                unit = unit.parentNode;
            }

            var container = unit.parentNode;
            if (!container || container.querySelector('.jfd-menu-item')) {
                return;
            }

            var item = unit.cloneNode(true);

            // Drop active/selected styling copied from the link we cloned - on the clone
            // and everything inside it, or the entry looks permanently highlighted
            // (MUI puts Mui-selected on the inner button, not the list item).
            var styled = [item];
            var inner = item.querySelectorAll('*');
            for (var c = 0; c < inner.length; c++) {
                styled.push(inner[c]);
            }
            for (var d = 0; d < styled.length; d++) {
                if (typeof styled[d].className === 'string' && styled[d].className) {
                    styled[d].className = styled[d].className
                        .replace(/[\w-]*(active|selected|current)[\w-]*/gi, '')
                        .replace(/\s+/g, ' ')
                        .trim();
                }
                styled[d].removeAttribute('aria-current');
            }
            item.classList.add('jfd-menu-item');
            item.setAttribute('data-jf-donate', '');
            item.style.cursor = 'pointer';
            item.removeAttribute('href');

            // The clone may be a wrapper; neutralise the anchor inside it too.
            var innerLinks = item.querySelectorAll('a[href]');
            for (var k = 0; k < innerLinks.length; k++) {
                innerLinks[k].removeAttribute('href');
                innerLinks[k].setAttribute('data-jf-donate', '');
                innerLinks[k].style.cursor = 'pointer';
            }

            // Swap the label, and the icon ligature when the client uses one. Leaf
            // elements holding text are the icon (first) and the label (last); an SVG
            // icon has no text, so only the label gets replaced and the cloned icon stays.
            var leaves = [];
            var nodes = item.querySelectorAll('*');
            for (var i = 0; i < nodes.length; i++) {
                if (!nodes[i].children.length && nodes[i].textContent.trim()) {
                    leaves.push(nodes[i]);
                }
            }

            var label = config.PersistentButtonText || 'Donate';
            if (leaves.length >= 2) {
                if (/material-icons|icon/i.test(leaves[0].className || '')) {
                    leaves[0].textContent = 'volunteer_activism';
                }
                leaves[leaves.length - 1].textContent = label;
            } else if (leaves.length === 1) {
                leaves[0].textContent = label;
            } else {
                item.textContent = label;
            }

            // SVG-icon clients (10.11 uses MUI) keep the icon of the link we cloned,
            // so redraw it as a heart.
            var icons = item.querySelectorAll('svg');
            for (var v = 0; v < icons.length; v++) {
                setDonateIcon(icons[v]);
            }

            container.appendChild(item);
        } catch (err) {
            log('could not add the sidebar item', err);
        }
    }

    function watchDrawer() {
        if (!window.MutationObserver) {
            return;
        }
        var observer = new MutationObserver(function () {
            addMenuItem();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ------------------------------------------------------------- login flow

    function onUserSignedIn(userId) {
        log('signed in', userId);

        request('GET', 'Donate/Config').then(function (result) {
            config = normalizeConfig(result);
            configUserId = userId;

            if (!config || !config.Enabled) {
                updatePersistentButton();
                return;
            }

            addMenuItem();

            updatePersistentButton();
            addMenuItem();

            if (!config.ShouldPrompt) {
                return;
            }

            // With no reminder interval set, "every time they open Jellyfin" means
            // once per browser session rather than on every route change.
            if (!config.ReminderIntervalDays && storageGet('session', 'jfd.shown.' + userId) === '1') {
                return;
            }

            if (storageGet('local', 'jfd.optout.' + userId) === '1') {
                return;
            }

            clearTimeout(promptTimer);
            promptTimer = setTimeout(function () {
                if (loggedInUserId() === userId && !overlay) {
                    showPopup();
                }
            }, Math.max(0, (config.DelaySeconds || 0) * 1000));
        }, function (err) {
            log('config request failed', err);
        });
    }

    function onUserSignedOut() {
        clearTimeout(promptTimer);
        closeOverlay();
        config = null;
        configUserId = null;
        updatePersistentButton();

        var existing = document.querySelector('.jfd-menu-item');
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }
    }

    function poll() {
        if (!apiReady()) {
            return;
        }
        var userId = loggedInUserId();
        if (userId === lastUserId) {
            return;
        }
        lastUserId = userId;
        if (userId) {
            onUserSignedIn(userId);
        } else {
            onUserSignedOut();
        }
    }

    // ------------------------------------------------------------------ boot

    function withConfig(callback) {
        if (config) {
            callback();
            return;
        }
        if (!loggedInUserId()) {
            return;
        }
        request('GET', 'Donate/Config').then(function (result) {
            config = normalizeConfig(result);
            configUserId = loggedInUserId();
            callback();
        });
    }

    window.JellyfinDonate = {
        open: function () {
            if (config) {
                showDonatePage();
                return;
            }
            if (!loggedInUserId()) {
                return;
            }
            request('GET', 'Donate/Config').then(function (result) {
                config = normalizeConfig(result);
                configUserId = loggedInUserId();
                showDonatePage();
            });
        },
        close: closeOverlay,

        // Used by the admin settings page to preview the popup, ignoring the
        // "don't show to administrators" and reminder-interval rules.
        preview: function () {
            withConfig(function () {
                showPopup();
            });
        },

        reload: function () {
            lastUserId = undefined;
            poll();
        }
    };

    document.addEventListener('click', function (event) {
        var target = event.target;
        while (target && target !== document.body) {
            if (target.hasAttribute && (target.hasAttribute('data-jf-donate')
                || (target.tagName === 'A' && target.getAttribute('href') === '#donate'))) {
                event.preventDefault();
                window.JellyfinDonate.open();
                return;
            }
            target = target.parentNode;
        }
    }, true);

    watchDrawer();
    setInterval(poll, POLL_MS);
    poll();
})();
