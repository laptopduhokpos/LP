/**
 * iPhone / iPad — cleanup stale PWA cache + load Supabase UMD (stable on Safari).
 */
(function () {
    var ua = navigator.userAgent || "";
    var ios = /iPad|iPhone|iPod/.test(ua) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    window.__MM_IS_IOS = ios;

    if (ios && "serviceWorker" in navigator) {
        navigator.serviceWorker.getRegistrations().then(function (regs) {
            regs.forEach(function (r) { r.unregister().catch(function () {}); });
        });
        if (window.caches && caches.keys) {
            caches.keys().then(function (keys) {
                keys.forEach(function (k) {
                    if (k.indexOf("ld-manager") >= 0) caches.delete(k);
                });
            });
        }
    }

    function umdReady() {
        return !!(window.supabase && typeof window.supabase.createClient === "function");
    }

    window.mmSupabaseUmdReady = function () {
        if (umdReady()) return Promise.resolve();
        if (window.__mmSbUmdPromise) return window.__mmSbUmdPromise;
        var base = "assets/vendor/";
        var urls = [
            base + "supabase.umd.js",
            "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/dist/umd/supabase.js",
            "https://unpkg.com/@supabase/supabase-js@2.49.1/dist/umd/supabase.js"
        ];
        var i = 0;
        window.__mmSbUmdPromise = new Promise(function (resolve, reject) {
            function tryNext() {
                if (umdReady()) { resolve(); return; }
                if (i >= urls.length) { reject(new Error("supabase_umd_failed")); return; }
                var s = document.createElement("script");
                s.src = urls[i++];
                s.crossOrigin = "anonymous";
                s.onload = function () { umdReady() ? resolve() : tryNext(); };
                s.onerror = tryNext;
                document.head.appendChild(s);
            }
            tryNext();
        });
        return window.__mmSbUmdPromise;
    };

    if (!umdReady()) {
        window.mmSupabaseUmdReady().catch(function () {});
    }
})();
