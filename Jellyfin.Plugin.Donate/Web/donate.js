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
    var PROMPT_RETRY_MS = 30000;
    var PROMPT_RETRY_WINDOW_MS = 5 * 60 * 1000;

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

    /*
     * Brand marks from Simple Icons (https://simpleicons.org), CC0-1.0. Inlined rather
     * than fetched so the donate page works offline and pulls nothing third-party into
     * a user's browser. Trademarks belong to their owners; they are used here only to
     * label the payment method they point at.
     */
    var BRAND_ICONS = {
        paypal: { color: '#002991', path: 'M15.607 4.653H8.941L6.645 19.251H1.82L4.862 0h7.995c3.754 0 6.375 2.294 6.473 5.513-.648-.478-2.105-.86-3.722-.86m6.57 5.546c0 3.41-3.01 6.853-6.958 6.853h-2.493L11.595 24H6.74l1.845-11.538h3.592c4.208 0 7.346-3.634 7.153-6.949a5.24 5.24 0 0 1 2.848 4.686M9.653 5.546h6.408c.907 0 1.942.222 2.363.541-.195 2.741-2.655 5.483-6.441 5.483H8.714Z' },
        venmo: { color: '#008CFF', path: 'M21.772 13.119c-.267 0-.381-.251-.38-.655 0-.533.121-1.575.712-1.575.267 0 .357.243.357.598 0 .533-.13 1.632-.689 1.632Zm.502-3.377c-1.677 0-2.405 1.285-2.405 2.658 0 1.042.421 1.874 1.693 1.874 1.717 0 2.438-1.406 2.438-2.763 0-1.025-.462-1.769-1.726-1.769Zm-3.833 0c-.558 0-.964.17-1.393.477-.154-.275-.462-.477-.932-.477-.542 0-.947.219-1.247.437l-.04-.364H13.54l-.688 4.354h1.506l.479-3.053c.129-.065.323-.154.518-.154.145 0 .267.049.267.267 0 .056-.016.145-.024.218l-.429 2.722h1.498l.478-3.053c.138-.073.324-.154.51-.154.146 0 .268.049.268.267 0 .056-.017.145-.025.218l-.429 2.722h1.499l.461-2.908c.025-.153.049-.388.049-.549 0-.582-.267-.97-1.037-.97Zm-6.871 0c-.575 0-.98.219-1.287.421l-.017-.348H8.962l-.689 4.354H9.78l.478-3.053c.13-.065.324-.154.518-.154.147 0 .268.049.268.242 0 .081-.024.227-.032.299l-.422 2.666h1.499l.462-2.908c.024-.153.049-.388.049-.549 0-.582-.268-.97-1.03-.97Zm-5.631 1.834c.041-.485.413-.824.697-.824.162 0 .299.097.299.291 0 .404-.713.533-.996.533Zm.843-1.834c-1.604 0-2.382 1.39-2.382 2.698 0 1.01.478 1.817 1.814 1.817.527 0 1.07-.113 1.418-.282l.186-1.26c-.494.25-.874.347-1.271.347-.365 0-.64-.194-.64-.687.826-.008 2.252-.347 2.252-1.453 0-.687-.494-1.18-1.377-1.18Zm-4.239.267c.089.186.146.412.146.743 0 .606-.429 1.494-.777 2.06l-.373-2.989L0 9.969l.705 4.2h1.757c.77-1.01 1.718-2.448 1.718-3.554 0-.347-.073-.622-.235-.889l-1.402.283Z' },
        cashapp: { color: '#00C244', path: 'M23.59 3.475a5.1 5.1 0 00-3.05-3.05c-1.31-.42-2.5-.42-4.92-.42H8.36c-2.4 0-3.61 0-4.9.4a5.1 5.1 0 00-3.05 3.06C0 4.765 0 5.965 0 8.365v7.27c0 2.41 0 3.6.4 4.9a5.1 5.1 0 003.05 3.05c1.3.41 2.5.41 4.9.41h7.28c2.41 0 3.61 0 4.9-.4a5.1 5.1 0 003.06-3.06c.41-1.3.41-2.5.41-4.9v-7.25c0-2.41 0-3.61-.41-4.91zm-6.17 4.63l-.93.93a.5.5 0 01-.67.01 5 5 0 00-3.22-1.18c-.97 0-1.94.32-1.94 1.21 0 .9 1.04 1.2 2.24 1.65 2.1.7 3.84 1.58 3.84 3.64 0 2.24-1.74 3.78-4.58 3.95l-.26 1.2a.49.49 0 01-.48.39H9.63l-.09-.01a.5.5 0 01-.38-.59l.28-1.27a6.54 6.54 0 01-2.88-1.57v-.01a.48.48 0 010-.68l1-.97a.49.49 0 01.67 0c.91.86 2.13 1.34 3.39 1.32 1.3 0 2.17-.55 2.17-1.42 0-.87-.88-1.1-2.54-1.72-1.76-.63-3.43-1.52-3.43-3.6 0-2.42 2.01-3.6 4.39-3.71l.25-1.23a.48.48 0 01.48-.38h1.78l.1.01c.26.06.43.31.37.57l-.27 1.37c.9.3 1.75.77 2.48 1.39l.02.02c.19.2.19.5 0 .68z' },
        kofi: { color: '#FF6433', path: 'M11.351 2.715c-2.7 0-4.986.025-6.83.26C2.078 3.285 0 5.154 0 8.61c0 3.506.182 6.13 1.585 8.493 1.584 2.701 4.233 4.182 7.662 4.182h.83c4.209 0 6.494-2.234 7.637-4a9.5 9.5 0 0 0 1.091-2.338C21.792 14.688 24 12.22 24 9.208v-.415c0-3.247-2.13-5.507-5.792-5.87-1.558-.156-2.65-.208-6.857-.208m0 1.947c4.208 0 5.09.052 6.571.182 2.624.311 4.13 1.584 4.13 4v.39c0 2.156-1.792 3.844-3.87 3.844h-.935l-.156.649c-.208 1.013-.597 1.818-1.039 2.546-.909 1.428-2.545 3.064-5.922 3.064h-.805c-2.571 0-4.831-.883-6.078-3.195-1.09-2-1.298-4.155-1.298-7.506 0-2.181.857-3.402 3.012-3.714 1.533-.233 3.559-.26 6.39-.26m6.547 2.287c-.416 0-.65.234-.65.546v2.935c0 .311.234.545.65.545 1.324 0 2.051-.754 2.051-2s-.727-2.026-2.052-2.026m-10.39.182c-1.818 0-3.013 1.48-3.013 3.142 0 1.533.858 2.857 1.949 3.897.727.701 1.87 1.429 2.649 1.896a1.47 1.47 0 0 0 1.507 0c.78-.467 1.922-1.195 2.623-1.896 1.117-1.039 1.974-2.364 1.974-3.897 0-1.662-1.247-3.142-3.039-3.142-1.065 0-1.792.545-2.338 1.298-.493-.753-1.246-1.298-2.312-1.298' },
        buymeacoffee: { color: '#FFDD00', path: 'M20.216 6.415l-.132-.666c-.119-.598-.388-1.163-1.001-1.379-.197-.069-.42-.098-.57-.241-.152-.143-.196-.366-.231-.572-.065-.378-.125-.756-.192-1.133-.057-.325-.102-.69-.25-.987-.195-.4-.597-.634-.996-.788a5.723 5.723 0 00-.626-.194c-1-.263-2.05-.36-3.077-.416a25.834 25.834 0 00-3.7.062c-.915.083-1.88.184-2.75.5-.318.116-.646.256-.888.501-.297.302-.393.77-.177 1.146.154.267.415.456.692.58.36.162.737.284 1.123.366 1.075.238 2.189.331 3.287.37 1.218.05 2.437.01 3.65-.118.299-.033.598-.073.896-.119.352-.054.578-.513.474-.834-.124-.383-.457-.531-.834-.473-.466.074-.96.108-1.382.146-1.177.08-2.358.082-3.536.006a22.228 22.228 0 01-1.157-.107c-.086-.01-.18-.025-.258-.036-.243-.036-.484-.08-.724-.13-.111-.027-.111-.185 0-.212h.005c.277-.06.557-.108.838-.147h.002c.131-.009.263-.032.394-.048a25.076 25.076 0 013.426-.12c.674.019 1.347.067 2.017.144l.228.031c.267.04.533.088.798.145.392.085.895.113 1.07.542.055.137.08.288.111.431l.319 1.484a.237.237 0 01-.199.284h-.003c-.037.006-.075.01-.112.015a36.704 36.704 0 01-4.743.295 37.059 37.059 0 01-4.699-.304c-.14-.017-.293-.042-.417-.06-.326-.048-.649-.108-.973-.161-.393-.065-.768-.032-1.123.161-.29.16-.527.404-.675.701-.154.316-.199.66-.267 1-.069.34-.176.707-.135 1.056.087.753.613 1.365 1.37 1.502a39.69 39.69 0 0011.343.376.483.483 0 01.535.53l-.071.697-1.018 9.907c-.041.41-.047.832-.125 1.237-.122.637-.553 1.028-1.182 1.171-.577.131-1.165.2-1.756.205-.656.004-1.31-.025-1.966-.022-.699.004-1.556-.06-2.095-.58-.475-.458-.54-1.174-.605-1.793l-.731-7.013-.322-3.094c-.037-.351-.286-.695-.678-.678-.336.015-.718.3-.678.679l.228 2.185.949 9.112c.147 1.344 1.174 2.068 2.446 2.272.742.12 1.503.144 2.257.156.966.016 1.942.053 2.892-.122 1.408-.258 2.465-1.198 2.616-2.657.34-3.332.683-6.663 1.024-9.995l.215-2.087a.484.484 0 01.39-.426c.402-.078.787-.212 1.074-.518.455-.488.546-1.124.385-1.766zm-1.478.772c-.145.137-.363.201-.578.233-2.416.359-4.866.54-7.308.46-1.748-.06-3.477-.254-5.207-.498-.17-.024-.353-.055-.47-.18-.22-.236-.111-.71-.054-.995.052-.26.152-.609.463-.646.484-.057 1.046.148 1.526.22.577.088 1.156.159 1.737.212 2.48.226 5.002.19 7.472-.14.45-.06.899-.13 1.345-.21.399-.072.84-.206 1.08.206.166.281.188.657.162.974a.544.544 0 01-.169.364zm-6.159 3.9c-.862.37-1.84.788-3.109.788a5.884 5.884 0 01-1.569-.217l.877 9.004c.065.78.717 1.38 1.5 1.38 0 0 1.243.065 1.658.065.447 0 1.786-.065 1.786-.065.783 0 1.434-.6 1.499-1.38l.94-9.95a3.996 3.996 0 00-1.322-.238c-.826 0-1.491.284-2.26.613z' },
        githubsponsors: { color: '#EA4AAA', path: 'M17.625 1.499c-2.32 0-4.354 1.203-5.625 3.03-1.271-1.827-3.305-3.03-5.625-3.03C3.129 1.499 0 4.253 0 8.249c0 4.275 3.068 7.847 5.828 10.227a33.14 33.14 0 0 0 5.616 3.876l.028.017.008.003-.001.003c.163.085.342.126.521.125.179.001.358-.041.521-.125l-.001-.003.008-.003.028-.017a33.14 33.14 0 0 0 5.616-3.876C20.932 16.096 24 12.524 24 8.249c0-3.996-3.129-6.75-6.375-6.75zm-.919 15.275a30.766 30.766 0 0 1-4.703 3.316l-.004-.002-.004.002a30.955 30.955 0 0 1-4.703-3.316c-2.677-2.307-5.047-5.298-5.047-8.523 0-2.754 2.121-4.5 4.125-4.5 2.06 0 3.914 1.479 4.544 3.684.143.495.596.797 1.086.796.49.001.943-.302 1.085-.796.63-2.205 2.484-3.684 4.544-3.684 2.004 0 4.125 1.746 4.125 4.5 0 3.225-2.37 6.216-5.048 8.523z' },
        patreon: { color: '#000000', path: 'M22.957 7.21c-.004-3.064-2.391-5.576-5.191-6.482-3.478-1.125-8.064-.962-11.384.604C2.357 3.231 1.093 7.391 1.046 11.54c-.039 3.411.302 12.396 5.369 12.46 3.765.047 4.326-4.804 6.068-7.141 1.24-1.662 2.836-2.132 4.801-2.618 3.376-.836 5.678-3.501 5.673-7.031Z' },
        revolut: { color: '#191C1F', path: 'M20.9133 6.9566C20.9133 3.1208 17.7898 0 13.9503 0H2.424v3.8605h10.9782c1.7376 0 3.177 1.3651 3.2087 3.043.016.84-.2994 1.633-.8878 2.2324-.5886.5998-1.375.9303-2.2144.9303H9.2322a.2756.2756 0 0 0-.2755.2752v3.431c0 .0585.018.1142.052.1612L16.2646 24h5.3114l-7.2727-10.094c3.6625-.1838 6.61-3.2612 6.61-6.9494zM6.8943 5.9229H2.424V24h4.4704z' },
        wise: { color: '#9FE870', path: 'M6.488 7.469 0 15.05h11.585l1.301-3.576H7.922l3.033-3.507.01-.092L8.993 4.48h8.873l-6.878 18.925h4.706L24 .595H2.543l3.945 6.874Z' },
        bitcoin: { color: '#F7931A', path: 'M23.638 14.904c-1.602 6.43-8.113 10.34-14.542 8.736C2.67 22.05-1.244 15.525.362 9.105 1.962 2.67 8.475-1.243 14.9.358c6.43 1.605 10.342 8.115 8.738 14.548v-.002zm-6.35-4.613c.24-1.59-.974-2.45-2.64-3.03l.54-2.153-1.315-.33-.525 2.107c-.345-.087-.705-.167-1.064-.25l.526-2.127-1.32-.33-.54 2.165c-.285-.067-.565-.132-.84-.2l-1.815-.45-.35 1.407s.975.225.955.236c.535.136.63.486.615.766l-1.477 5.92c-.075.166-.24.406-.614.314.015.02-.96-.24-.96-.24l-.66 1.51 1.71.426.93.242-.54 2.19 1.32.327.54-2.17c.36.1.705.19 1.05.273l-.51 2.154 1.32.33.545-2.19c2.24.427 3.93.257 4.64-1.774.57-1.637-.03-2.58-1.217-3.196.854-.193 1.5-.76 1.68-1.93h.01zm-3.01 4.22c-.404 1.64-3.157.75-4.05.53l.72-2.9c.896.23 3.757.67 3.33 2.37zm.41-4.24c-.37 1.49-2.662.735-3.405.55l.654-2.64c.744.18 3.137.524 2.75 2.084v.006z' },
        stripe: { color: '#635BFF', path: 'M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z' },
        zelle: { color: '#6D1ED4', path: 'M13.559 24h-2.841a.483.483 0 0 1-.483-.483v-2.765H5.638a.667.667 0 0 1-.666-.666v-2.234a.67.67 0 0 1 .142-.412l8.139-10.382h-7.25a.667.667 0 0 1-.667-.667V3.914c0-.367.299-.666.666-.666h4.23V.483c0-.266.217-.483.483-.483h2.841c.266 0 .483.217.483.483v2.765h4.323c.367 0 .666.299.666.666v2.137a.67.67 0 0 1-.141.41l-8.19 10.481h7.665c.367 0 .666.299.666.666v2.477a.667.667 0 0 1-.666.667h-4.32v2.765a.483.483 0 0 1-.483.483Z' },
        liberapay: { color: '#F6C915', path: 'M2.32 0A2.321 2.321 0 0 0 0 2.32v19.36A2.321 2.321 0 0 0 2.32 24h19.36A2.32 2.32 0 0 0 24 21.68V2.32A2.32 2.32 0 0 0 21.68 0zm9.208 3.98l-2.27 9.405a2.953 2.953 0 0 0-.073.539.853.853 0 0 0 .09.432.7.7 0 0 0 .334.302c.157.077.378.126.661.147l-.49 2.008c-.772 0-1.38-.1-1.82-.3-.441-.203-.757-.477-.947-.826a2.391 2.391 0 0 1-.278-1.2c.005-.452.068-.933.188-1.445l2.074-8.67zm3.9 3.888c.61 0 1.135.092 1.576.277.44.185.802.438 1.085.76.283.32.493.696.629 1.126.136.43.204.89.204 1.379v.001c0 .794-.13 1.52-.392 2.179a5.16 5.16 0 0 1-1.086 1.706 4.84 4.84 0 0 1-1.665 1.118c-.648.267-1.353.4-2.114.4-.37 0-.74-.033-1.11-.098l-.735 2.956H9.403l2.71-11.298c.435-.13.934-.248 1.494-.351a10.045 10.045 0 0 1 1.821-.155zm-.31 2.041a4.67 4.67 0 0 0-.98.098l-1.143 4.752c.185.044.413.065.685.065.425 0 .812-.079 1.16-.237a2.556 2.556 0 0 0 .89-.661c.244-.283.435-.623.571-1.02a4.03 4.03 0 0 0 .204-1.315c0-.468-.104-.865-.31-1.192-.207-.326-.566-.49-1.077-.49z' },
    };

    /*
     * Maps a method name onto a brand mark. "Cash App", "cash-app" and "cashapp" all
     * land on the same icon, and a few common aliases are spelled out.
     */
    var BRAND_ALIASES = {
        cash: 'cashapp',
        squarecash: 'cashapp',
        kofi: 'kofi',
        coffee: 'buymeacoffee',
        buymeacoffe: 'buymeacoffee',
        github: 'githubsponsors',
        githubsponsor: 'githubsponsors',
        sponsors: 'githubsponsors',
        btc: 'bitcoin',
        transferwise: 'wise',
        paypalme: 'paypal'
    };

    function brandFor(name) {
        if (!name) {
            return null;
        }
        var key = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
        if (BRAND_ICONS[key]) {
            return BRAND_ICONS[key];
        }
        if (BRAND_ALIASES[key] && BRAND_ICONS[BRAND_ALIASES[key]]) {
            return BRAND_ICONS[BRAND_ALIASES[key]];
        }
        // "PayPal (friends and family)" should still find PayPal.
        for (var slug in BRAND_ICONS) {
            if (Object.prototype.hasOwnProperty.call(BRAND_ICONS, slug) && key.indexOf(slug) === 0) {
                return BRAND_ICONS[slug];
            }
        }
        return null;
    }

    // ---- colour helpers -----------------------------------------------------

    function parseHex(colour) {
        if (!colour) {
            return null;
        }
        var hex = String(colour).trim().replace(/^#/, '');
        if (hex.length === 3) {
            hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        if (!/^[0-9a-f]{6}$/i.test(hex)) {
            return null;   // named colours, rgb() etc - leave them alone
        }
        return {
            r: parseInt(hex.substring(0, 2), 16),
            g: parseInt(hex.substring(2, 4), 16),
            b: parseInt(hex.substring(4, 6), 16)
        };
    }

    function toHex(rgb) {
        function part(v) {
            var s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
            return s.length === 1 ? '0' + s : s;
        }
        return '#' + part(rgb.r) + part(rgb.g) + part(rgb.b);
    }

    /** WCAG relative luminance, 0 (black) to 1 (white). */
    function luminance(rgb) {
        function channel(v) {
            v = v / 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        }
        return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
    }

    /**
     * Black or white, whichever is legible on the given background. Brand colours run
     * from #000000 (Patreon) to #FFDD00 (Buy Me a Coffee), so a fixed white would be
     * unreadable on the pale ones.
     */
    function readableOn(colour) {
        var rgb = parseHex(colour);
        if (!rgb) {
            return '#fff';
        }
        return luminance(rgb) > 0.45 ? '#111418' : '#fff';
    }

    function mix(rgb, towards, amount) {
        return {
            r: rgb.r + (towards - rgb.r) * amount,
            g: rgb.g + (towards - rgb.g) * amount,
            b: rgb.b + (towards - rgb.b) * amount
        };
    }

    /**
     * Keeps a brand colour distinguishable from the surface behind it. Patreon's black
     * and Revolut's near-black otherwise disappear into a dark card.
     */
    function separateFromBackground(colour, lightTheme) {
        var rgb = parseHex(colour);
        if (!rgb) {
            return colour;
        }
        var l = luminance(rgb);
        if (!lightTheme && l < 0.02) {
            return toHex(mix(rgb, 255, 0.22));
        }
        if (lightTheme && l > 0.9) {
            return toHex(mix(rgb, 0, 0.12));
        }
        return colour;
    }

    function brandSvg(brand) {
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '19');
        svg.setAttribute('height', '19');
        svg.setAttribute('fill', 'currentColor');
        svg.setAttribute('aria-hidden', 'true');
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', brand.path);
        svg.appendChild(path);
        return svg;
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
            'box-shadow:inset 0 0 0 1px rgba(128,128,128,.35);',
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
        var icon = el('div', 'jfd-icon');

        // Brand mark when we recognise the method, otherwise the text badge.
        var brand = brandFor(method.Name);
        if (brand) {
            icon.appendChild(brandSvg(brand));
            if (!method.Color) {
                accent = brand.color;
            }
        } else {
            icon.textContent = (method.Icon || method.Name || '?').substring(0, 2);
        }

        accent = separateFromBackground(accent, isLightTheme());
        icon.style.background = accent;
        icon.style.color = readableOn(accent);
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
            go.style.color = readableOn(accent);
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

    // ------------------------------------------------------------ playback state

    /*
     * True while the user is watching something. Nothing of ours should be on screen
     * then - not the floating button, and certainly not a popup over a film. Checks
     * several signals because the web client has changed shape between versions:
     * an actually-playing <video>, the player route, and fullscreen.
     */
    function isPlaying() {
        try {
            if (document.fullscreenElement
                || document.webkitFullscreenElement
                || document.mozFullScreenElement) {
                return true;
            }

            var hash = (window.location.hash || '').toLowerCase();
            if (hash.indexOf('/video') !== -1) {
                return true;
            }

            var videos = document.getElementsByTagName('video');
            for (var i = 0; i < videos.length; i++) {
                var video = videos[i];
                if (!video.paused && !video.ended && video.readyState > 2) {
                    return true;
                }
            }
        } catch (err) {
            log('playback check failed', err);
        }
        return false;
    }

    // -------------------------------------------------------- persistent link

    function updatePersistentButton() {
        var wanted = !!(config && config.Enabled && config.ShowPersistentButton
            && loggedInUserId() && !isPlaying());

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
            var giveUpAt = Date.now() + PROMPT_RETRY_WINDOW_MS;

            function tryShow() {
                if (loggedInUserId() !== userId || overlay) {
                    return;
                }
                if (isPlaying()) {
                    // Wait for the film to finish rather than talking over it, but give
                    // up after a while so nobody gets ambushed hours later.
                    if (Date.now() < giveUpAt) {
                        promptTimer = setTimeout(tryShow, PROMPT_RETRY_MS);
                    }
                    return;
                }
                showPopup();
            }

            promptTimer = setTimeout(tryShow, Math.max(0, (config.DelaySeconds || 0) * 1000));
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
        if (userId !== lastUserId) {
            lastUserId = userId;
            if (userId) {
                onUserSignedIn(userId);
            } else {
                onUserSignedOut();
            }
        }

        // Playback starts and stops without a sign-in change, so the floating button
        // has to be re-evaluated on every tick. Both branches exit early once the
        // button already matches the wanted state.
        updatePersistentButton();
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

    /*
     * The one-second poll would leave the button on screen for up to a tick after
     * playback starts, which is exactly when it is most annoying. React to the events
     * directly as well; play/pause/ended are captured because they do not bubble.
     */
    window.addEventListener('hashchange', updatePersistentButton);
    document.addEventListener('fullscreenchange', updatePersistentButton);
    document.addEventListener('webkitfullscreenchange', updatePersistentButton);
    document.addEventListener('play', updatePersistentButton, true);
    document.addEventListener('playing', updatePersistentButton, true);
    document.addEventListener('pause', updatePersistentButton, true);
    document.addEventListener('ended', updatePersistentButton, true);

    watchDrawer();
    setInterval(poll, POLL_MS);
    poll();
})();
