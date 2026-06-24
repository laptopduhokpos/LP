/**
 * PWA service worker — Mobile Manager (_PRIVATE/mobile_manager/)
 * CACHE_NAME must change on every release so installed PWAs fetch fresh shell.
 */
const MM_SW_VERSION = "2.16.0";
const CACHE_NAME = "ld-manager-pwa-" + MM_SW_VERSION.replace(/\./g, "-");
const SHELL = [
    "./index.html",
    "./mm-app.css?v=" + MM_SW_VERSION,
    "./mm-app.js?v=" + MM_SW_VERSION,
    "./mm-pdf-report.js",
    "./backup.html",
    "./manifest.json?v=" + MM_SW_VERSION,
    "./assets/brand/laptop-duhok-logo.png",
    "./assets/icons/icon-192.png",
    "./assets/icons/icon-512.png",
    "./assets/icons/apple-touch-icon.png",
    "./assets/icons/favicon-32.png"
];

function mmIsAppPath(path) {
    return (
        path.indexOf("mobile_manager") !== -1 ||
        path.indexOf("mobile_app_github") !== -1 ||
        path.indexOf("github_pages_LP") !== -1 ||
        /\/LP\/?$/i.test(path) ||
        /\/LP\//i.test(path)
    );
}

function mmIsMutableAsset(path) {
    return (
        path.indexOf("mm-app.") !== -1 ||
        path.endsWith("index.html") ||
        path.indexOf("sw.js") !== -1 ||
        path.indexOf("manifest.json") !== -1
    );
}

self.addEventListener("install", function (event) {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            return Promise.all(
                SHELL.map(function (url) {
                    return cache.add(new Request(url, { cache: "reload" })).catch(function () {
                        return null;
                    });
                })
            );
        })
    );
});

self.addEventListener("activate", function (event) {
    event.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(
                keys
                    .filter(function (k) {
                        return k.indexOf("ld-manager-pwa-") === 0 && k !== CACHE_NAME;
                    })
                    .map(function (k) {
                        return caches.delete(k);
                    })
            );
        }).then(function () {
            return self.clients.claim();
        })
    );
});

self.addEventListener("message", function (event) {
    if (event.data && event.data.type === "SKIP_WAITING") {
        self.skipWaiting();
    }
});

self.addEventListener("fetch", function (event) {
    var req = event.request;
    if (req.method !== "GET") return;
    var url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (!mmIsAppPath(url.pathname)) return;

    var path = url.pathname + url.search;

    if (mmIsMutableAsset(path)) {
        event.respondWith(
            fetch(req, { cache: "no-store" })
                .then(function (res) {
                    if (res && res.ok) {
                        var copy = res.clone();
                        caches.open(CACHE_NAME).then(function (c) {
                            c.put(req, copy);
                        });
                    }
                    return res;
                })
                .catch(function () {
                    return caches.match(req).then(function (cached) {
                        return cached || caches.match("./index.html");
                    });
                })
        );
        return;
    }

    event.respondWith(
        fetch(req)
            .then(function (res) {
                if (res && res.ok) {
                    var copy = res.clone();
                    caches.open(CACHE_NAME).then(function (c) {
                        c.put(req, copy);
                    });
                }
                return res;
            })
            .catch(function () {
                return caches.match(req).then(function (cached) {
                    if (cached) return cached;
                    return caches.match("./index.html");
                });
            })
    );
});
