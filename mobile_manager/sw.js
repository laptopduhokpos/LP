/**
 * PWA service worker — Mobile Manager (_PRIVATE/mobile_manager/)
 */
const CACHE_NAME = "ld-manager-pwa-v26";
const SHELL = [
    "./index.html",
    "./mm-app.css",
    "./mm-app.js",
    "./backup.html",
    "./manifest.json",
    "./assets/brand/laptop-duhok-logo.png",
    "./assets/icons/icon-192.png",
    "./assets/icons/icon-512.png",
    "./assets/icons/apple-touch-icon.png",
    "./assets/icons/favicon-32.png"
];

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

self.addEventListener("fetch", function (event) {
    var req = event.request;
    if (req.method !== "GET") return;
    var url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    var path = url.pathname;
    var isShell =
        (path.indexOf("mobile_manager") !== -1 || path.indexOf("mobile_app_github") !== -1 || /\/LP\/?$/i.test(path) || /\/LP\//i.test(path)) &&
        (path.endsWith("index.html") ||
            path.endsWith("/mobile_manager/") ||
            path.endsWith("/mobile_app_github/") ||
            path.endsWith("/LP/") ||
            /\/LP\/backup\.html$/i.test(path) ||
            path.indexOf("manifest.json") !== -1 ||
            path.indexOf("laptop-duhok-logo") !== -1);

    if (!isShell) return;

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
