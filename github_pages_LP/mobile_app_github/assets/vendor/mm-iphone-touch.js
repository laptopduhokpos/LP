/**
 * iPhone / iPad — boot overlay + pre-module login/tabs (before mm-app.js loads).
 * Post-boot taps are handled by mmBindTap() inside mm-app.js.
 */
(function () {
    var ua = navigator.userAgent || "";
    var isIos = window.__MM_IS_IOS ||
        /iPad|iPhone|iPod/.test(ua) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    var touch = { x: 0, y: 0, moved: false, el: null };
    var TAP_SLOP = 14;

    function hideBoot() {
        var o = document.getElementById("mmBootOverlay");
        if (o) {
            o.style.pointerEvents = "none";
            o.style.display = "none";
            o.classList.add("hidden");
        }
    }

    function msg(text) {
        var el = document.getElementById("authMsg");
        if (el) el.textContent = text || "";
    }

    function cfg() {
        return window.POS_SUPABASE_MOBILE || {};
    }

    function sbReady() {
        return typeof window.mmSupabaseUmdReady === "function"
            ? window.mmSupabaseUmdReady()
            : Promise.resolve();
    }

    function getSb() {
        var c = cfg();
        if (!c.url || !c.anonKey || !window.supabase) return null;
        if (!window.__mmIphoneSb) {
            window.__mmIphoneSb = window.supabase.createClient(c.url, c.anonKey, {
                auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
            });
        }
        return window.__mmIphoneSb;
    }

    var loginBusy = false;
    function iphoneLogin() {
        if (typeof window.mmDoLogin === "function") {
            window.mmDoLogin();
            return;
        }
        if (loginBusy) return;
        var emailEl = document.getElementById("email");
        var passEl = document.getElementById("password");
        var email = emailEl ? String(emailEl.value || "").trim().toLowerCase() : "";
        var password = passEl ? String(passEl.value || "") : "";
        if (!email || !password) {
            msg("ئیمێیل و تێپەڕەوشە بنووسە.");
            return;
        }
        loginBusy = true;
        msg("چاوەڕێ بکە…");
        sbReady().then(function () {
            var sb = getSb();
            if (!sb) throw new Error("Supabase بارنەبوو — refresh بکە");
            return sb.auth.signInWithPassword({ email: email, password: password });
        }).then(function (res) {
            if (res.error) throw res.error;
            msg("");
            if (typeof window.mmDoLogin === "function") {
                window.mmDoLogin();
            } else {
                location.reload();
            }
        }).catch(function (e) {
            var m = e && e.message ? e.message : "هەڵە";
            msg("چوونەژوورەوە سەرنەکەوت: " + m);
        }).finally(function () {
            loginBusy = false;
        });
    }

    function themeToggle() {
        if (typeof window.mmThemeToggle === "function") {
            window.mmThemeToggle();
            return;
        }
        var isLight = document.documentElement.getAttribute("data-theme") === "light";
        if (isLight) document.documentElement.removeAttribute("data-theme");
        else document.documentElement.setAttribute("data-theme", "light");
        try { localStorage.setItem("pos_mobile_theme", isLight ? "dark" : "light"); } catch (e) {}
        var icon = document.getElementById("themeIcon");
        if (icon) {
            icon.className = isLight ? "fas fa-sun" : "fas fa-moon";
            icon.style.color = isLight ? "#fbbf24" : "#2563eb";
        }
    }

    function switchTab(tab) {
        if (typeof window.mmSwitchMobileTab === "function") {
            window.mmSwitchMobileTab(tab);
        }
    }

    var ACTION_MAP = {
        loginBtn: iphoneLogin,
        themeToggleBtn: themeToggle,
        tabHome: function () { switchTab("home"); },
        tabDash: function () { switchTab("dash"); },
        tabInv: function () { switchTab("inv"); },
        tabDebt: function () { switchTab("debt"); },
        homeGoDash: function () { switchTab("dash"); },
        homeGoInv: function () { switchTab("inv"); },
        homeGoDebt: function () { switchTab("debt"); },
        homeGoBackup: function () { switchTab("backup"); },
        logoutBtn: function () { if (window.mmLogoutUi) window.mmLogoutUi(); },
        logoutBtnHome: function () { if (window.mmLogoutUi) window.mmLogoutUi(); }
    };

    function tapTarget(el) {
        if (!el || !el.closest) return null;
        return el.closest(
            "button, a[href], .mm-shop-card, .mm-saved-auth-item, .nav-tab, " +
            ".btn-primary, .btn-install, .btn-ghost, .btn-danger, .refresh-btn, " +
            ".theme-toggle, .home-tile, .backup-dl-btn, .inv-scan-btn, .btn-pdf-featured, " +
            ".mm-install-bar-btn, .inv-date-chip, .debt-sub-tab, .mm-modal-close, .inv-scanner-close"
        );
    }

    function resolveTapTarget(e) {
        var ct = e.changedTouches && e.changedTouches[0];
        if (ct) {
            var hit = document.elementFromPoint(ct.clientX, ct.clientY);
            var fromPoint = tapTarget(hit);
            if (fromPoint) return fromPoint;
        }
        return tapTarget(e.target) || touch.el;
    }

    function runPreBootAction(t, e) {
        if (t.id === "authForm" || (t.closest && t.closest("#authForm") && t.type === "submit")) {
            e.preventDefault();
            iphoneLogin();
            return true;
        }
        var fn = t.id && ACTION_MAP[t.id];
        if (fn) {
            e.preventDefault();
            e.stopPropagation();
            fn();
            return true;
        }
        if (t.classList && t.classList.contains("nav-tab") && t.id) {
            e.preventDefault();
            e.stopPropagation();
            var tab = t.id.replace(/^tab/, "").toLowerCase();
            if (tab === "home") switchTab("home");
            else if (tab === "dash") switchTab("dash");
            else if (tab === "inv") switchTab("inv");
            else if (tab === "debt") switchTab("debt");
            return true;
        }
        return false;
    }

    function onTouchStart(e) {
        if (window.__mmAppReady) return;
        touch.moved = false;
        var t0 = e.targetTouches && e.targetTouches[0];
        if (!t0) return;
        touch.x = t0.clientX;
        touch.y = t0.clientY;
        touch.el = tapTarget(e.target);
    }

    function onTouchMove(e) {
        if (window.__mmAppReady) return;
        var t0 = e.targetTouches && e.targetTouches[0];
        if (!t0) return;
        if (Math.abs(t0.clientX - touch.x) > TAP_SLOP || Math.abs(t0.clientY - touch.y) > TAP_SLOP) {
            touch.moved = true;
        }
    }

    function onTouchEnd(e) {
        if (window.__mmAppReady) return;
        if (touch.moved) return;
        var t = resolveTapTarget(e);
        if (!t || t.disabled) return;
        if (t.closest && t.closest("input, textarea, select, label")) return;
        runPreBootAction(t, e);
    }

    function bind() {
        hideBoot();
        if (isIos) {
            document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
            document.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
            document.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
            document.addEventListener("touchcancel", function () { touch.moved = true; }, { capture: true, passive: true });
        } else {
            document.addEventListener("click", function (e) {
                if (window.__mmAppReady) return;
                var t = tapTarget(e.target);
                if (t) runPreBootAction(t, e);
            }, true);
        }
        var form = document.getElementById("authForm");
        if (form && !form.__mmIphoneBound) {
            form.__mmIphoneBound = true;
            form.addEventListener("submit", function (e) {
                e.preventDefault();
                iphoneLogin();
            });
        }
        var loginBtn = document.getElementById("loginBtn");
        if (loginBtn && loginBtn.type === "submit") {
            loginBtn.type = "button";
        }
    }

    window.mmIphoneLogin = iphoneLogin;

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", bind);
    } else {
        bind();
    }
    setTimeout(hideBoot, isIos ? 800 : 3000);
    setTimeout(hideBoot, 6000);
})();
