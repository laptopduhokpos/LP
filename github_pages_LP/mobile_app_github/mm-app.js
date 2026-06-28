import { initializeApp, getApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
        import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
        import {
            initializeFirestore,
            persistentLocalCache,
            persistentMultipleTabManager,
            getFirestore,
            doc,
            onSnapshot,
            getDoc,
            getDocFromServer
        } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
        import { mmPrintTodaySummary } from "./mm-pdf-report.js?v=2.17.40";
        import {
            mmSnapSave,
            mmSnapSaveDebounced,
            mmSnapLoad,
            mmSnapLoadBundle,
            mmSnapLoadHubBundle,
            mmSnapDetailType
        } from "./mm-snapshot-store.js?v=2.17.40";

        const firebaseConfig = window.POS_FIREBASE_CONFIG || {};
        if (!firebaseConfig.apiKey) {
            const m = document.getElementById("authMsg");
            if (m) m.textContent = "Firebase apiKey نییە.";
            throw new Error("Missing Firebase apiKey");
        }

        const app = initializeApp(firebaseConfig);
        const auth = getAuth(app);
        let db;
        try {
            db = initializeFirestore(app, {
                localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
            });
        } catch (e) {
            db = getFirestore(app);
        }

        function mmInitFirestore(fbApp) {
            try {
                return initializeFirestore(fbApp, {
                    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
                });
            } catch (err) {
                return getFirestore(fbApp);
            }
        }

        let mmLastCacheSavedAt = null;
        let mmHasLocalCache = false;
        let mmLiveConnected = true;

        const MM_MAX_SHOPS = 2;
        const MM_ACCOUNTS_KEY = "mm_saved_accounts_v1";
        const MM_ACTIVE_ACCOUNT_KEY = "mm_active_account";
        const MM_SHOP_COLORS = ["#3b82f6", "#8b5cf6"];
        let mmAccounts = [];
        const mmShopHub = {};
        let mmHubBooting = false;
        let mmSwitchingShop = false;

        function mmEncodeSecret(s) {
            try { return btoa(unescape(encodeURIComponent(String(s || "")))); } catch (e) { return String(s || ""); }
        }
        function mmDecodeSecret(s) {
            try { return decodeURIComponent(escape(atob(String(s || "")))); } catch (e) { return String(s || ""); }
        }
        function mmLoadAccounts() {
            try {
                const raw = localStorage.getItem(MM_ACCOUNTS_KEY);
                mmAccounts = raw ? JSON.parse(raw) : [];
                if (!Array.isArray(mmAccounts)) mmAccounts = [];
            } catch (e) { mmAccounts = []; }
            mmAccounts = mmAccounts.slice(0, MM_MAX_SHOPS).map(function (a, i) {
                return {
                    id: String(a.id || ("acc_" + i)),
                    email: String(a.email || "").trim().toLowerCase(),
                    passEnc: String(a.passEnc || ""),
                    label: String(a.label || "").trim(),
                    colorIdx: Number(a.colorIdx) >= 0 ? Number(a.colorIdx) % MM_SHOP_COLORS.length : i % MM_SHOP_COLORS.length
                };
            }).filter(function (a) { return a.email && a.passEnc; });
            return mmAccounts;
        }
        function mmSaveAccounts() {
            try { localStorage.setItem(MM_ACCOUNTS_KEY, JSON.stringify(mmAccounts)); } catch (e) {}
        }
        function mmGetActiveEmail() {
            try {
                const v = String(localStorage.getItem(MM_ACTIVE_ACCOUNT_KEY) || "").trim().toLowerCase();
                if (v) return v;
            } catch (e) {}
            return mmAccounts.length ? mmAccounts[0].email : "";
        }
        function mmSetActiveEmail(email) {
            const e = String(email || "").trim().toLowerCase();
            try { localStorage.setItem(MM_ACTIVE_ACCOUNT_KEY, e); } catch (err) {}
            mmRenderShopSwitcher();
            mmRenderShopsHub();
        }
        function mmAccountByEmail(email) {
            const e = String(email || "").trim().toLowerCase();
            return mmAccounts.find(function (a) { return a.email === e; }) || null;
        }
        function mmShopLabel(acc) {
            if (!acc) return "—";
            if (acc.label) return acc.label;
            const local = String(acc.email || "").split("@")[0] || acc.email;
            return local.replace(/[._-]/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
        }
        function mmShopColor(acc) {
            const idx = acc && Number.isFinite(Number(acc.colorIdx)) ? Number(acc.colorIdx) : 0;
            return MM_SHOP_COLORS[((idx % MM_SHOP_COLORS.length) + MM_SHOP_COLORS.length) % MM_SHOP_COLORS.length];
        }
        function mmHubKey(email) { return String(email || "").trim().toLowerCase(); }
        function mmEnsureHubState(email) {
            const key = mmHubKey(email);
            if (!mmShopHub[key]) {
                mmShopHub[key] = {
                    email: key, dash: null, inv: null, status: "loading",
                    displayCurrency: "IQD", usdRate: 0, unsubDash: null, unsubInv: null, appName: ""
                };
            }
            return mmShopHub[key];
        }
        function mmFormatHubMoney(state, iqdVal) {
            const n = Math.round(Number(iqdVal) || 0);
            const cur = String((state && state.displayCurrency) || "IQD").toUpperCase();
            const rate = Number(state && state.usdRate) || 0;
            if (cur === "USD" && rate > 0) {
                const usd = Math.round((n / rate) * 100) / 100;
                return "$" + new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(usd);
            }
            return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n) + " د.ع";
        }
        function mmApplyHubDash(state, data) {
            if (!state) return;
            if (!data) {
                state.dash = null;
                state.status = "warn";
                return;
            }
            const meta = data.meta || data;
            state.dash = data;
            state.displayCurrency = String(data.posDisplayCurrency || meta.posDisplayCurrency || data.amountCurrency || meta.amountCurrency || "IQD").toUpperCase();
            let rate = Number(data.usdRatePerOne || meta.usdRatePerOne || 0);
            if (rate >= 10000) rate = rate / 100;
            state.usdRate = rate > 0 ? rate : 0;
            state.status = "ok";
            if (state.email) mmSnapSaveDebounced(state.email, "dashboard", data);
        }
        function mmApplyHubInv(state, data) {
            if (!state) return;
            state.inv = data && data.summary ? data.summary : null;
            if (state.email && data) mmSnapSaveDebounced(state.email, "inventory", data);
        }
        function mmTeardownHub(email) {
            const key = mmHubKey(email);
            const st = mmShopHub[key];
            if (!st) return;
            if (st.unsubDash) { try { st.unsubDash(); } catch (e) {} st.unsubDash = null; }
            if (st.unsubInv) { try { st.unsubInv(); } catch (e) {} st.unsubInv = null; }
            delete mmShopHub[key];
        }
        function mmGetSecondaryApp(appName) {
            try { return getApp(appName); } catch (e) { return initializeApp(firebaseConfig, appName); }
        }
        async function mmStartHubForAccount(acc) {
            if (!acc || !acc.email) return;
            const key = mmHubKey(acc.email);
            const state = mmEnsureHubState(key);
            try {
                const hubSnap = await mmSnapLoadHubBundle(key);
                if (hubSnap.dashboard && hubSnap.dashboard.data) {
                    mmApplyHubDash(state, hubSnap.dashboard.data);
                }
                if (hubSnap.inventory && hubSnap.inventory.data) {
                    mmApplyHubInv(state, hubSnap.inventory.data);
                }
                if (hubSnap.latestSavedAt) {
                    mmLastCacheSavedAt = Math.max(mmLastCacheSavedAt || 0, hubSnap.latestSavedAt);
                    mmHasLocalCache = true;
                }
                if (state.dash || state.inv) mmRenderShopsHub();
            } catch (e) {}
            state.status = state.status === "ok" ? "ok" : "loading";
            const appName = "mm-shop-" + acc.id;
            state.appName = appName;
            const fbApp = mmGetSecondaryApp(appName);
            const fbAuth = getAuth(fbApp);
            const fbDb = mmInitFirestore(fbApp);
            try {
                if (!fbAuth.currentUser || String(fbAuth.currentUser.email || "").toLowerCase() !== key) {
                    await signInWithEmailAndPassword(fbAuth, acc.email, mmDecodeSecret(acc.passEnc));
                }
            } catch (e) {
                state.status = state.dash || state.inv ? "ok" : "err";
                mmRenderShopsHub();
                return;
            }
            if (state.unsubDash) { try { state.unsubDash(); } catch (e2) {} }
            if (state.unsubInv) { try { state.unsubInv(); } catch (e3) {} }
            const dashRef = doc(fbDb, "pos_mobile_dashboard", key);
            const invRef = doc(fbDb, "pos_mobile_inventory", key);
            state.unsubDash = onSnapshot(dashRef, function (snap) {
                mmApplyHubDash(state, snap.exists() ? snap.data() : null);
                mmRenderShopsHub();
                if (key === mmHubKey(activeChannelId) && snap.exists()) {
                    applyDashboardData(snap.data(), { silent: snap.metadata.fromCache, fromCache: snap.metadata.fromCache });
                }
            }, function () {
                state.status = state.dash || state.inv ? "ok" : "err";
                mmRenderShopsHub();
            });
            state.unsubInv = onSnapshot(invRef, function (snap) {
                mmApplyHubInv(state, snap.exists() ? snap.data() : null);
                mmRenderShopsHub();
                if (key === mmHubKey(activeChannelId) && snap.exists()) {
                    applyInventoryData(snap.data(), { silent: snap.metadata.fromCache, fromCache: snap.metadata.fromCache });
                }
            }, function () {});
        }
        async function mmStartAllHubs() {
            if (mmHubBooting) return;
            mmHubBooting = true;
            mmLoadAccounts();
            const jobs = mmAccounts.map(function (acc) { return mmStartHubForAccount(acc); });
            try { await Promise.all(jobs); } catch (e) {}
            mmHubBooting = false;
            mmRenderShopsHub();
            mmRenderShopSwitcher();
            mmRenderSavedAuthList();
        }
        function mmUpsertAccount(email, password, label) {
            const em = String(email || "").trim().toLowerCase();
            const pass = String(password || "");
            if (!em || !pass) return { ok: false, msg: "ئیمێیل و تێپەڕەوشە پێویستە." };
            let acc = mmAccountByEmail(em);
            if (!acc) {
                if (mmAccounts.length >= MM_MAX_SHOPS) {
                    return { ok: false, msg: "زۆرترین " + MM_MAX_SHOPS + " دووکان — یەکێک بسڕەوە." };
                }
                acc = {
                    id: "acc_" + Date.now().toString(36),
                    email: em,
                    passEnc: mmEncodeSecret(pass),
                    label: String(label || "").trim(),
                    colorIdx: mmAccounts.length % MM_SHOP_COLORS.length
                };
                mmAccounts.push(acc);
            } else {
                acc.passEnc = mmEncodeSecret(pass);
                if (label) acc.label = String(label).trim();
            }
            mmSaveAccounts();
            return { ok: true, acc: acc };
        }
        function mmRemoveAccount(email) {
            const em = mmHubKey(email);
            const idx = mmAccounts.findIndex(function (a) { return a.email === em; });
            if (idx < 0) return;
            mmTeardownHub(em);
            mmAccounts.splice(idx, 1);
            mmSaveAccounts();
            if (mmGetActiveEmail() === em && mmAccounts.length) {
                mmSetActiveEmail(mmAccounts[0].email);
            }
            mmRenderSavedAuthList();
            mmRenderShopsHub();
            mmRenderShopSwitcher();
        }
        async function mmSwitchActiveShop(email) {
            const em = mmHubKey(email);
            const acc = mmAccountByEmail(em);
            if (!acc) return;
            if (mmSwitchingShop) return;

            const prevActive = mmGetActiveEmail();
            const cur = auth.currentUser ? String(auth.currentUser.email || "").toLowerCase() : "";

            if (cur === em) {
                mmSetActiveEmail(em);
                mmRenderShopsHub();
                mmRenderShopSwitcher();
                return;
            }

            const pass = mmDecodeSecret(acc.passEnc);
            if (!pass) {
                showRefreshToast("گۆڕینی دووکان سەرنەکەوت — تێپەڕەوشە نەما، دووبارە زیاد بکە", true);
                return;
            }

            mmSwitchingShop = true;
            try {
                if (cur && cur !== em) {
                    await signOut(auth);
                }
                await signInWithEmailAndPassword(auth, acc.email, pass);
                mmSetActiveEmail(em);
                showRefreshToast("دووکان گۆڕدرا ✓", false);
            } catch (e) {
                mmSetActiveEmail(prevActive || cur);
                mmRenderShopsHub();
                mmRenderShopSwitcher();
                let hint = "گۆڕینی دووکان سەرنەکەوت";
                const code = e && e.code ? String(e.code) : "";
                if (/wrong-password|invalid-credential|invalid-login/i.test(code)) {
                    hint += " — تێپەڕەوشە نوێ بکە (سڕینەوە + زیادکردن)";
                }
                showRefreshToast(hint, true);
                if (prevActive && prevActive !== em) {
                    const prevAcc = mmAccountByEmail(prevActive);
                    if (prevAcc) {
                        try {
                            const prevPass = mmDecodeSecret(prevAcc.passEnc);
                            if (prevPass) {
                                await signInWithEmailAndPassword(auth, prevAcc.email, prevPass);
                                mmSetActiveEmail(prevActive);
                            }
                        } catch (e2) {}
                    }
                }
            } finally {
                mmSwitchingShop = false;
            }
        }
        function mmRenderShopsHub() {
            const grid = document.getElementById("mmShopsGrid");
            const countEl = document.getElementById("mmShopsCount");
            if (!grid) return;
            mmLoadAccounts();
            if (countEl) countEl.textContent = mmAccounts.length + "/" + MM_MAX_SHOPS;
            const active = mmHubKey(activeChannelId || mmGetActiveEmail());
            let html = "";
            mmAccounts.forEach(function (acc) {
                const key = acc.email;
                const st = mmShopHub[key] || mmEnsureHubState(key);
                const dash = st.dash || {};
                const inv = st.inv || {};
                const priv = mmPrivacyFromDoc(dash);
                const net = priv.hideProfit ? null : dash.netProfitToday;
                const sales = dash.salesToday;
                const out = Number(inv.outOfStock || 0);
                const low = Number(inv.lowStock || 0);
                const isActive = key === active;
                const statusCls = st.status === "ok" ? "ok" : st.status === "err" ? "err" : st.status === "warn" ? "warn" : "";
                let badges = "";
                if (out > 0) badges += '<span class="mm-shop-badge alert">' + out + ' نەما</span>';
                if (low > 0) badges += '<span class="mm-shop-badge low">' + low + ' کەم</span>';
                html += '<button type="button" class="mm-shop-card' + (isActive ? " active" : "") + '" data-mm-shop="' + esc(key) + '" style="--shop-accent:' + mmShopColor(acc) + '">' +
                    '<div class="mm-shop-card-top"><div class="mm-shop-name">' + esc(mmShopLabel(acc)) + '</div>' +
                    '<span class="mm-shop-status ' + statusCls + '" title="sync"></span></div>' +
                    '<div class="mm-shop-net">' + (st.dash ? (priv.hideProfit ? MM_PRIVACY_HIDDEN : mmFormatHubMoney(st, net)) : "—") + '</div>' +
                    '<div class="mm-shop-meta">فرۆشتن: ' + (st.dash ? mmFormatHubMoney(st, sales) : "—") + '</div>' +
                    (badges ? '<div class="mm-shop-badges">' + badges + '</div>' : '') +
                    '</button>';
            });
            if (mmAccounts.length < MM_MAX_SHOPS) {
                html += '<button type="button" class="mm-shop-card mm-shop-card-add" id="mmShopCardAdd"><i class="fas fa-plus"></i><span>دووکان زیاد بکە</span></button>';
            }
            grid.innerHTML = html;
            grid.querySelectorAll("[data-mm-shop]").forEach(function (btn) {
                btn.addEventListener("click", function () {
                    mmSwitchActiveShop(btn.getAttribute("data-mm-shop"));
                    switchMobileTab("dash");
                });
            });
            const addCard = document.getElementById("mmShopCardAdd");
            if (addCard) addCard.addEventListener("click", function () { mmOpenAddShopModal(); });
        }
        function mmRenderShopSwitcher() {
            const bar = document.getElementById("mmShopSwitcher");
            if (!bar) return;
            mmLoadAccounts();
            if (!mmAccounts.length || mmAccounts.length < 2) {
                bar.classList.add("hidden");
                bar.innerHTML = "";
                return;
            }
            bar.classList.remove("hidden");
            const active = mmHubKey(activeChannelId || mmGetActiveEmail());
            bar.innerHTML = mmAccounts.map(function (acc) {
                const isActive = acc.email === active;
                return '<button type="button" class="mm-shop-chip' + (isActive ? " active" : "") + '" data-mm-chip="' + esc(acc.email) + '" style="--shop-accent:' + mmShopColor(acc) + '">' +
                    '<span class="mm-shop-chip-dot"></span><span>' + esc(mmShopLabel(acc)) + '</span></button>';
            }).join("");
            bar.querySelectorAll("[data-mm-chip]").forEach(function (btn) {
                btn.addEventListener("click", function () { mmSwitchActiveShop(btn.getAttribute("data-mm-chip")); });
            });
        }
        function mmRenderSavedAuthList() {
            const box = document.getElementById("mmSavedAccountsAuth");
            if (!box) return;
            mmLoadAccounts();
            if (!mmAccounts.length) {
                box.classList.add("hidden");
                box.innerHTML = "";
                return;
            }
            box.classList.remove("hidden");
            box.innerHTML = '<p style="margin:0 0 6px;font-size:0.75rem;color:var(--muted);font-weight:700;"><i class="fas fa-clock-rotate-left"></i> دووکانە پاشەکەوتکراوەکان</p>' +
                mmAccounts.map(function (acc) {
                    return '<button type="button" class="mm-saved-auth-item" data-mm-quick="' + esc(acc.email) + '">' +
                        '<strong>' + esc(acc.email) + '</strong>' +
                        '<span style="font-size:0.72rem;color:#93c5fd;">چوونەژوورەوە <i class="fas fa-arrow-left"></i></span></button>';
                }).join("");
            box.querySelectorAll("[data-mm-quick]").forEach(function (btn) {
                btn.addEventListener("click", async function () {
                    const acc = mmAccountByEmail(btn.getAttribute("data-mm-quick"));
                    if (!acc) return;
                    authMsg.textContent = "چاوەڕێ بکە…";
                    try {
                        await signInWithEmailAndPassword(auth, acc.email, mmDecodeSecret(acc.passEnc));
                        authMsg.textContent = "";
                    } catch (e) {
                        authMsg.textContent = "چوونەژوورەوە سەرنەکەوت — تێپەڕەوشە نوێ بکەرەوە.";
                    }
                });
            });
        }
        function mmCloseShopModal() {
            const m = document.getElementById("mmShopModal");
            if (m) { m.classList.add("hidden"); m.setAttribute("aria-hidden", "true"); }
        }
        function mmOpenAddShopModal() {
            const body = document.getElementById("mmShopModalBody");
            const title = document.getElementById("mmShopModalTitle");
            const m = document.getElementById("mmShopModal");
            if (!body || !m) return;
            if (title) title.innerHTML = '<i class="fas fa-plus"></i> دووکانێکی تر';
            if (mmAccounts.length >= MM_MAX_SHOPS) {
                body.innerHTML = '<p style="color:#fca5a5;margin:0;">زۆرترین ' + MM_MAX_SHOPS + ' دووکان — لە بەڕێوەبردن یەکێک بسڕەوە.</p>';
            } else {
                body.innerHTML =
                    '<label class="field-label" for="mmAddLabel">ناوی دووکان (ئیختیاری)</label>' +
                    '<input id="mmAddLabel" type="text" placeholder="دووکانی ١ · Duhok Center" style="width:100%;padding:10px;border-radius:12px;border:1px solid var(--line);background:var(--input-bg);color:var(--text);margin-bottom:10px;">' +
                    '<label class="field-label" for="mmAddEmail">ئیمێیل</label>' +
                    '<input id="mmAddEmail" type="email" placeholder="shop02@pos.laptopduhok.com" dir="ltr" autocomplete="username" style="width:100%;padding:10px;border-radius:12px;border:1px solid var(--line);background:var(--input-bg);color:var(--text);margin-bottom:10px;">' +
                    '<label class="field-label" for="mmAddPass">تێپەڕەوشە</label>' +
                    '<input id="mmAddPass" type="password" dir="ltr" autocomplete="new-password" style="width:100%;padding:10px;border-radius:12px;border:1px solid var(--line);background:var(--input-bg);color:var(--text);margin-bottom:12px;">' +
                    '<p style="font-size:0.68rem;color:var(--muted);line-height:1.5;margin:0 0 12px;"><i class="fas fa-lock"></i> تێپەڕەوشە لە ئامێرەکەتدا پاشەکەوت دەکرێت بۆ خێرا چوونەژوورەوە.</p>' +
                    '<button type="button" id="mmAddShopSubmit" class="btn-primary" style="width:100%;"><i class="fas fa-check"></i> زیادکردن و جاودێری</button>';
                const submit = document.getElementById("mmAddShopSubmit");
                if (submit) submit.addEventListener("click", mmSubmitAddShop);
            }
            m.classList.remove("hidden");
            m.setAttribute("aria-hidden", "false");
        }
        function mmOpenManageShopsModal() {
            const body = document.getElementById("mmShopModalBody");
            const title = document.getElementById("mmShopModalTitle");
            const m = document.getElementById("mmShopModal");
            if (!body || !m) return;
            if (title) title.innerHTML = '<i class="fas fa-sliders"></i> بەڕێوەبردنی دووکان';
            mmLoadAccounts();
            const active = mmHubKey(activeChannelId || mmGetActiveEmail());
            let html = mmAccounts.map(function (acc) {
                const isActive = acc.email === active;
                return '<div class="mm-manage-row' + (isActive ? " active" : "") + '">' +
                    '<div class="mm-manage-row-meta"><strong>' + esc(acc.email) + '</strong>' +
                    '<small>' + esc(mmShopLabel(acc)) + (isActive ? " · چالاک" : "") + '</small></div>' +
                    '<div class="mm-manage-actions">' +
                    (isActive ? '' : '<button type="button" class="mm-btn-switch" data-mm-sw="' + esc(acc.email) + '">چالاک</button>') +
                    '<button type="button" class="mm-btn-remove" data-mm-rm="' + esc(acc.email) + '"><i class="fas fa-trash"></i></button>' +
                    '</div></div>';
            }).join("");
            html += '<button type="button" id="mmLogoutAllBtn" class="btn-danger" style="width:100%;margin-top:12px;"><i class="fas fa-power-off"></i> سڕینەوەی هەموو دووکانەکان</button>';
            body.innerHTML = html || '<p class="detail-empty">هیچ دووکانێک نییە.</p>';
            body.querySelectorAll("[data-mm-sw]").forEach(function (btn) {
                btn.addEventListener("click", function () {
                    mmCloseShopModal();
                    mmSwitchActiveShop(btn.getAttribute("data-mm-sw"));
                });
            });
            body.querySelectorAll("[data-mm-rm]").forEach(function (btn) {
                btn.addEventListener("click", function () {
                    const em = btn.getAttribute("data-mm-rm");
                    if (!confirm("ئەم دووکانە لە لیست بسڕدرێتەوە؟")) return;
                    const wasActive = mmHubKey(em) === mmHubKey(activeChannelId);
                    mmRemoveAccount(em);
                    if (wasActive && mmAccounts.length) {
                        mmSwitchActiveShop(mmAccounts[0].email);
                    } else if (!mmAccounts.length) {
                        signOut(auth);
                    }
                    mmOpenManageShopsModal();
                });
            });
            const logoutAll = document.getElementById("mmLogoutAllBtn");
            if (logoutAll) logoutAll.addEventListener("click", function () {
                if (!confirm("هەموو دووکانەکان دەسڕدرێنەوە لە ئامێرەکە. دڵنیایت؟")) return;
                mmAccounts.slice().forEach(function (a) { mmTeardownHub(a.email); });
                mmAccounts = [];
                mmSaveAccounts();
                try { localStorage.removeItem(MM_ACTIVE_ACCOUNT_KEY); } catch (e) {}
                mmCloseShopModal();
                signOut(auth);
            });
            m.classList.remove("hidden");
            m.setAttribute("aria-hidden", "false");
        }
        async function mmSubmitAddShop() {
            const email = (document.getElementById("mmAddEmail") && document.getElementById("mmAddEmail").value || "").trim().toLowerCase();
            const password = document.getElementById("mmAddPass") ? document.getElementById("mmAddPass").value : "";
            const label = document.getElementById("mmAddLabel") ? document.getElementById("mmAddLabel").value : "";
            const submit = document.getElementById("mmAddShopSubmit");
            if (submit) { submit.disabled = true; submit.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
            const testApp = mmGetSecondaryApp("mm-test-" + Date.now());
            const testAuth = getAuth(testApp);
            try {
                await signInWithEmailAndPassword(testAuth, email, password);
                await signOut(testAuth);
            } catch (e) {
                alert("چوونەژوورەوە سەرنەکەوت — ئیمێیل/تێپەڕەوشە بپشکنە.");
                if (submit) { submit.disabled = false; submit.innerHTML = '<i class="fas fa-check"></i> زیادکردن و جاودێری'; }
                return;
            }
            const res = mmUpsertAccount(email, password, label);
            if (!res.ok) {
                alert(res.msg);
                if (submit) { submit.disabled = false; submit.innerHTML = '<i class="fas fa-check"></i> زیادکردن و جاودێری'; }
                return;
            }
            await mmStartHubForAccount(res.acc);
            mmCloseShopModal();
            mmRenderShopsHub();
            mmRenderShopSwitcher();
            mmRenderSavedAuthList();
            if (submit) { submit.disabled = false; submit.innerHTML = '<i class="fas fa-check"></i> زیادکردن و جاودێری'; }
            if (!auth.currentUser) {
                await mmSwitchActiveShop(email);
            } else {
                showRefreshToast("دووکان زیادکرا ✓", false);
            }
        }
        async function mmRefreshAllHubs() {
            if (!navigator.onLine) {
                await mmHydrateHubsFromLocalStore();
                return;
            }
            const jobs = mmAccounts.map(async function (acc) {
                const key = acc.email;
                const st = mmShopHub[key];
                if (!st || !st.appName) return;
                try {
                    const fbDb = mmInitFirestore(mmGetSecondaryApp(st.appName));
                    const snaps = await Promise.all([
                        getDocFromServer(doc(fbDb, "pos_mobile_dashboard", key)),
                        getDocFromServer(doc(fbDb, "pos_mobile_inventory", key))
                    ]);
                    mmApplyHubDash(st, snaps[0].exists() ? snaps[0].data() : null);
                    mmApplyHubInv(st, snaps[1].exists() ? snaps[1].data() : null);
                } catch (e) { st.status = st.dash || st.inv ? "ok" : "err"; }
            });
            await Promise.all(jobs);
            mmRenderShopsHub();
        }

        function mmFormatCacheTime(savedAt) {
            if (!savedAt) return "";
            return mmFormatShopTime(new Date(savedAt));
        }

        function mmNoteCacheSavedAt(savedAt) {
            if (!savedAt) return;
            mmLastCacheSavedAt = Math.max(mmLastCacheSavedAt || 0, savedAt);
            mmHasLocalCache = true;
        }

        function mmUpdateConnectionStatus(opts) {
            opts = opts || {};
            const online = navigator.onLine;
            const fromCache = !!opts.fromCache;
            if (!online) {
                mmLiveConnected = false;
                const ts = mmFormatCacheTime(opts.savedAt || mmLastCacheSavedAt);
                if (mmHasLocalCache || ts) {
                    setStatus(ts ? ("ئۆفلاین · " + ts) : "ئۆفلاین · cache", false, "offline-cache");
                } else {
                    setStatus("ئۆفلاین", false, "offline");
                }
                return;
            }
            if (fromCache && !opts.live) {
                mmLiveConnected = false;
                const ts = mmFormatCacheTime(opts.savedAt || mmLastCacheSavedAt);
                setStatus(ts ? ("cache · " + ts) : "cache", true, "cache");
                return;
            }
            mmLiveConnected = true;
            setStatus("پەیوەست · live", true, "live");
        }

        async function mmHydrateFromLocalStore(channelId, dayKey) {
            if (!channelId) return false;
            try {
                const bundle = await mmSnapLoadBundle(channelId, dayKey);
                let any = false;
                if (bundle.dashboard && bundle.dashboard.data) {
                    applyDashboardData(bundle.dashboard.data, {
                        silent: true,
                        fromCache: true,
                        savedAt: bundle.dashboard.savedAt
                    });
                    any = true;
                }
                if (bundle.inventory && bundle.inventory.data) {
                    applyInventoryData(bundle.inventory.data, {
                        silent: true,
                        fromCache: true,
                        savedAt: bundle.inventory.savedAt
                    });
                    any = true;
                }
                if (bundle.debt && bundle.debt.data) {
                    applyDebtData(bundle.debt.data, {
                        silent: true,
                        fromCache: true,
                        savedAt: bundle.debt.savedAt
                    });
                    any = true;
                }
                if (bundle.detail && bundle.detail.data) {
                    applyDetailData(bundle.detail.data, dayKey, {
                        silent: true,
                        fromCache: true,
                        savedAt: bundle.detail.savedAt
                    });
                    any = true;
                }
                if (bundle.latestSavedAt) mmNoteCacheSavedAt(bundle.latestSavedAt);
                if (any) mmUpdateConnectionStatus({ fromCache: true, savedAt: bundle.latestSavedAt });
                return any;
            } catch (e) {
                return false;
            }
        }

        async function mmHydrateHubsFromLocalStore() {
            mmLoadAccounts();
            let any = false;
            for (let i = 0; i < mmAccounts.length; i++) {
                const acc = mmAccounts[i];
                const key = mmHubKey(acc.email);
                const state = mmEnsureHubState(key);
                try {
                    const hubSnap = await mmSnapLoadHubBundle(key);
                    if (hubSnap.dashboard && hubSnap.dashboard.data) {
                        mmApplyHubDash(state, hubSnap.dashboard.data);
                        any = true;
                    }
                    if (hubSnap.inventory && hubSnap.inventory.data) {
                        mmApplyHubInv(state, hubSnap.inventory.data);
                        any = true;
                    }
                    if (hubSnap.latestSavedAt) mmNoteCacheSavedAt(hubSnap.latestSavedAt);
                } catch (e) {}
            }
            if (any) mmRenderShopsHub();
            return any;
        }

        const authCard = document.getElementById("authCard");
        const dashboard = document.getElementById("dashboard");
        const emailEl = document.getElementById("email");
        const passEl = document.getElementById("password");
        const authMsg = document.getElementById("authMsg");
        const statusEl = document.getElementById("status");
        const metaEl = document.getElementById("meta");
        const kpiSales = document.getElementById("kpiSales");
        const kpiExpenses = document.getElementById("kpiExpenses");
        const kpiNet = document.getElementById("kpiNet");
        const kpiInvoices = document.getElementById("kpiInvoices");
        let unsub = null;
        let unsubDetail = null;
        let unsubInventory = null;
        let unsubDebt = null;
        let mmBackupItems = [];
        let activeChannelId = "";
        let refreshBusy = false;
        let mmSnapDashboard = null;
        let mmSnapDetail = null;
        let mmSnapInvSummary = null;
        let mmSnapDebtSummary = null;
        let mmSnapDetailDayKey = "";
        const refreshBtn = document.getElementById("refreshBtn");
        const refreshToast = document.getElementById("refreshToast");
        const ptrIndicator = document.getElementById("ptrIndicator");
        let refreshToastTimer = null;
        const panelHome = document.getElementById("panelHome");
        const panelDash = document.getElementById("panelDash");
        const panelInv = document.getElementById("panelInv");
        const panelDebt = document.getElementById("panelDebt");
        const panelBackup = document.getElementById("panelBackup");
        const bottomNav = document.getElementById("bottomNav");
        const tabHomeBtn = document.getElementById("tabHome");
        const tabDashBtn = document.getElementById("tabDash");
        const tabInvBtn = document.getElementById("tabInv");
        const tabDebtBtn = document.getElementById("tabDebt");

        function setTabActive(btn, on) {
            if (!btn) return;
            btn.classList.toggle("active", on);
            btn.setAttribute("aria-pressed", on ? "true" : "false");
        }

        function switchMobileTab(tab) {
            const t = tab === "backup" ? "backup" : tab === "debt" ? "debt" : tab === "inv" ? "inv" : tab === "dash" ? "dash" : "home";
            if (panelHome) panelHome.classList.toggle("hidden", t !== "home");
            if (panelDash) panelDash.classList.toggle("hidden", t !== "dash");
            if (panelInv) panelInv.classList.toggle("hidden", t !== "inv");
            if (panelDebt) panelDebt.classList.toggle("hidden", t !== "debt");
            if (panelBackup) panelBackup.classList.toggle("hidden", t !== "backup");
            setTabActive(tabHomeBtn, t === "home");
            setTabActive(tabDashBtn, t === "dash");
            setTabActive(tabInvBtn, t === "inv");
            setTabActive(tabDebtBtn, t === "debt");
            try { localStorage.setItem("pos_mobile_tab", t); } catch (e) {}
            window.scrollTo({ top: 0, behavior: "smooth" });
        }

        function formatBackupBytes(n) {
            n = Number(n) || 0;
            if (n < 1024) return n + " B";
            if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
            return (n / 1048576).toFixed(1) + " MB";
        }

        function formatBackupDate(ms) {
            if (!ms) return "—";
            try {
                return new Date(ms).toLocaleString("ar-IQ", {
                    year: "numeric", month: "short", day: "numeric",
                    hour: "2-digit", minute: "2-digit", hour12: false
                });
            } catch (e) { return "—"; }
        }

        function mmIsGithubPages() {
            return /\.github\.io$/i.test(location.hostname || "");
        }

        function guessPosApiBase() {
            if (mmIsGithubPages()) return "";
            try {
                const p = location.pathname || "";
                const idx = p.toLowerCase().indexOf("/public/mobile_manager");
                if (idx >= 0) return (location.origin + p.substring(0, idx)).replace(/\/$/, "");
                const idx2 = p.toLowerCase().indexOf("/mobile_app_github");
                if (idx2 >= 0) return "";
            } catch (e) {}
            return (location.origin + "/pos").replace(/\/$/, "");
        }

        function getMmPosBase() {
            const el = document.getElementById("mmPosUrl");
            let v = el && el.value ? String(el.value).trim() : "";
            if (!v) { try { v = localStorage.getItem("mm_pos_url") || ""; } catch (e) {} }
            if (!v) v = guessPosApiBase();
            return v.replace(/\/$/, "");
        }

        function getMmBackupPin() {
            const el = document.getElementById("mmBackupPin");
            let v = el && el.value ? String(el.value).trim() : "";
            if (!v) { try { v = localStorage.getItem("mm_backup_pin") || ""; } catch (e) {} }
            return v.replace(/\D/g, "");
        }

        let mmPosBaseCached = "";
        let mmPinCached = "";

        function mmIsMixedLanBlocked(posBase) {
            try {
                const pos = new URL(posBase);
                if (pos.protocol === "http:" && location.protocol === "https:") return true;
            } catch (e) {}
            return false;
        }

        function mmIsIos() {
            return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        }

        function mmIsIosStandalone() {
            return window.navigator.standalone === true ||
                (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
        }

        function mmBackupFetchList(posBase, pin) {
            const fd = new FormData();
            fd.append("action", "mobile_list_backups");
            fd.append("pin", pin);
            return fetch(posBase + "/", { method: "POST", body: fd, credentials: "omit" });
        }
        function mmBackupFetchDownload(posBase, pin, name) {
            const fd = new FormData();
            fd.append("action", "mobile_download_backup");
            fd.append("pin", pin);
            fd.append("name", name);
            return fetch(posBase + "/", { method: "POST", body: fd, credentials: "omit" });
        }

        function mmBackupDlLabel() {
            return mmIsIosStandalone() ? '<i class="fas fa-share-square"></i> Save' : '<i class="fas fa-download"></i> داونلۆد';
        }

        function mmDownloadBackupFile(posBase, pin, fileName, btn) {
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            }
            const resetBtn = function () {
                if (!btn) return;
                btn.disabled = false;
                btn.innerHTML = mmBackupDlLabel();
            };
            mmBackupFetchDownload(posBase, pin, fileName)
                .then(function (res) {
                    if (!res.ok) throw new Error("HTTP " + res.status);
                    return res.blob();
                })
                .then(function (blob) {
                    const file = new File([blob], fileName, { type: blob.type || "application/zip" });
                    if (navigator.canShare && navigator.canShare({ files: [file] })) {
                        return navigator.share({ files: [file], title: fileName });
                    }
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = fileName;
                    a.click();
                    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
                })
                .then(function () { resetBtn(); })
                .catch(function (err) {
                    resetBtn();
                    if (err && err.name === "AbortError") return;
                    alert("داونلۆد سەرنەکەوت: " + String(err.message || err));
                });
        }

        function mmBindBackupDownload(btn, posBase, pin, fileName) {
            btn.addEventListener("click", function (e) {
                e.preventDefault();
                mmDownloadBackupFile(posBase, pin, fileName, btn);
            });
        }

        function buildMmBackupPageUrl(posBase, auto) {
            const u = new URL("backup.html", window.location.href);
            u.searchParams.set("pos", String(posBase || "").replace(/\/$/, ""));
            if (auto) u.searchParams.set("auto", "1");
            return u.toString();
        }

        function openPosBackupPage(auto) {
            const posBase = getMmPosBase();
            const pin = getMmBackupPin();
            if (!pin || pin.length < 4) {
                alert("PIN بنووسە (2026 یان لە POS)");
                return;
            }
            if (/localhost|127\.0\.0\.1/i.test(posBase)) {
                alert("IPـی WiFiـی لاپتۆپ بنووسە — localhost لە موبایل کار ناکات");
                return;
            }
            try {
                localStorage.setItem("mm_pos_url", posBase);
                localStorage.setItem("mm_backup_pin", pin);
            } catch (e) {}
            window.location.href = buildMmBackupPageUrl(posBase, auto);
        }

        function renderBackupList(items) {
            const box = document.getElementById("backupContent");
            if (!box) return;
            if (!items || !items.length) {
                box.innerHTML = '<div class="detail-empty">پاشەکەوت نییە.<br><small>لە POS: بەڕێوەبردنی داتابەیس → پاشەکەوتکردن</small></div>';
                return;
            }
            mmBackupItems = items;
            box.innerHTML = items.map(function (it, idx) {
                const name = esc(it.name || "backup.zip");
                const sub = (it.mtime_iso || formatBackupDate(it.mtime)) + " · " + formatBackupBytes(it.bytes);
                return '<div class="backup-row">' +
                    '<div class="backup-row-meta"><div class="backup-row-name">' + name + '</div><div class="backup-row-sub">' + sub + '</div></div>' +
                    '<button type="button" class="backup-dl-btn" data-backup-idx="' + idx + '">' + mmBackupDlLabel() + '</button>' +
                    '</div>';
            }).join("");
            box.querySelectorAll(".backup-dl-btn").forEach(function (btn) {
                const i = parseInt(btn.getAttribute("data-backup-idx"), 10);
                const it = mmBackupItems[i];
                if (!it || !it.name) return;
                mmBindBackupDownload(btn, mmPosBaseCached, mmPinCached, it.name || "backup.zip");
            });
        }

        function loadLanBackups() {
            const posBase = getMmPosBase();
            const pin = getMmBackupPin();
            const box = document.getElementById("backupContent");
            if (!pin || pin.length < 4) {
                alert("PIN لە POS بنووسە: ڕێکخستن → پێشکەوتوو → بەڕێوەبردنی داتابەیس");
                return;
            }
            if (/localhost|127\.0\.0\.1/i.test(posBase)) {
                if (box) box.innerHTML = '<div class="detail-empty" style="color:#fca5a5;">localhost لە موبایل کار ناکات.<br><small>IPـی WiFiـی لاپتۆپ بنووسە، وەک: http://192.168.1.5/pos</small></div>';
                return;
            }
            if (mmIsMixedLanBlocked(posBase)) {
                if (box) box.innerHTML = '<div class="detail-empty" style="color:#fcd34d;">github.io (HTTPS) ناتوانێت بە POS (HTTP) پەیوەند بکات.<br><small>«کردنەوە لە Safari» بگرە ↓</small></div>';
                return;
            }
            mmPosBaseCached = posBase;
            mmPinCached = pin;
            try {
                localStorage.setItem("mm_pos_url", posBase);
                localStorage.setItem("mm_backup_pin", pin);
            } catch (e) {}
            if (box) box.innerHTML = '<div class="detail-empty"><i class="fas fa-spinner fa-spin"></i></div>';
            mmBackupFetchList(posBase, pin)
                .then(function (res) {
                    return res.json().then(function (data) {
                        if (!res.ok || data.status !== "success") {
                            throw new Error(data.message || ("HTTP " + res.status));
                        }
                        return data;
                    });
                })
                .then(function (data) {
                    renderBackupList(data.backups || []);
                })
                .catch(function (err) {
                    let msg = String(err.message || err);
                    if (/failed to fetch|network|load/i.test(msg)) {
                        msg = "پەیوەندی بە POS نەکرا — WiFi، IP، XAMPP بپشکنە";
                    } else if (/PIN|403|نادروست/i.test(msg)) {
                        msg = "PIN نادروستە — لە POS: بەڕێوەبردنی داتابەیس (یان settingsPin: 2026)";
                    }
                    if (box) box.innerHTML = '<div class="detail-empty" style="color:#fca5a5;">' + esc(msg) + '</div>';
                });
        }

        function initMobileBackupUi() {
            const urlEl = document.getElementById("mmPosUrl");
            const pinEl = document.getElementById("mmBackupPin");
            const btn = document.getElementById("mmLoadBackupsBtn");
            const safariBtn = document.getElementById("mmOpenSafariBackupBtn");
            const qs = new URLSearchParams(location.search);
            if (urlEl && !urlEl.value) {
                const fromQs = qs.get("mm_pos") || qs.get("pos") || "";
                try { urlEl.value = fromQs || localStorage.getItem("mm_pos_url") || guessPosApiBase(); } catch (e) { urlEl.value = fromQs || guessPosApiBase(); }
            }
            if (pinEl && !pinEl.value) {
                const fromQs = qs.get("mm_pin") || qs.get("pin") || "";
                try { pinEl.value = fromQs || localStorage.getItem("mm_backup_pin") || ""; } catch (e) { pinEl.value = fromQs || ""; }
            }
            if (btn && !btn.__mmBound) {
                btn.__mmBound = true;
                btn.addEventListener("click", loadLanBackups);
            }
            if (safariBtn && !safariBtn.__mmBound) {
                safariBtn.__mmBound = true;
                safariBtn.addEventListener("click", function () { openPosBackupPage(true); });
            }
            if (qs.get("mm_auto") === "1" || location.hash === "#backup") {
                setTimeout(function () {
                    if (getMmBackupPin().length >= 4) loadLanBackups();
                }, 400);
            }
        }

        function bindBackups(channelId) {
            initMobileBackupUi();
        }

        function updateHomeSyncText(text) {
            const el = document.getElementById("homeLastSync");
            if (el) el.innerHTML = '<i class="fas fa-clock"></i> ' + text;
        }

        const MM_SHOP_TZ = "Asia/Baghdad";
        let mmShopBusinessDate = "";
        let mmBusinessDayStartHour = 0;
        let mmDetailBindDayKey = "";

        function mmFormatShopTime(dateInput, opts) {
            opts = opts || {};
            const d = dateInput instanceof Date ? dateInput : new Date(dateInput || Date.now());
            if (isNaN(d.getTime())) return "";
            try {
                return d.toLocaleString("ar-IQ", {
                    timeZone: MM_SHOP_TZ,
                    hour: "2-digit",
                    minute: "2-digit",
                    second: opts.withSeconds ? "2-digit" : undefined,
                    hour12: false
                });
            } catch (e) {
                return d.toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" });
            }
        }

        function mmGetPosDateKey(d) {
            const x = d instanceof Date ? d : new Date(d);
            if (isNaN(x.getTime())) return "";
            try {
                return x.toLocaleDateString("en-CA", { timeZone: MM_SHOP_TZ });
            } catch (e) {
                const y = x.getFullYear();
                const mo = String(x.getMonth() + 1).padStart(2, "0");
                const day = String(x.getDate()).padStart(2, "0");
                return y + "-" + mo + "-" + day;
            }
        }

        function mmGetPosTimezoneHour(d) {
            const x = d instanceof Date ? d : new Date(d);
            if (isNaN(x.getTime())) return 0;
            try {
                return parseInt(x.toLocaleString("en-GB", { timeZone: MM_SHOP_TZ, hour: "numeric", hour12: false }), 10) || 0;
            } catch (e) {
                return x.getHours();
            }
        }

        function mmShiftDateKey(dateKey, deltaDays) {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
            if (!m) return String(dateKey || "");
            const y = parseInt(m[1], 10);
            const mo = parseInt(m[2], 10);
            const da = parseInt(m[3], 10);
            const utcMs = Date.UTC(y, mo - 1, da, 12, 0, 0) + (deltaDays * 86400000);
            try {
                return new Date(utcMs).toLocaleDateString("en-CA", { timeZone: MM_SHOP_TZ });
            } catch (e) {
                const d2 = new Date(utcMs);
                return d2.getFullYear() + "-" + String(d2.getMonth() + 1).padStart(2, "0") + "-" + String(d2.getDate()).padStart(2, "0");
            }
        }

        function mmLoadCachedBusinessMeta(channelId) {
            if (!channelId) return;
            try {
                const bd = localStorage.getItem("mm_business_date_" + channelId);
                if (bd && /^\d{4}-\d{2}-\d{2}$/.test(bd)) mmShopBusinessDate = bd;
                const sh = parseInt(localStorage.getItem("mm_business_start_hour_" + channelId) || "", 10);
                if (Number.isFinite(sh) && sh >= 0 && sh <= 23) mmBusinessDayStartHour = sh;
            } catch (e) {}
        }

        function mmPersistBusinessMeta(channelId) {
            if (!channelId) return;
            try {
                if (mmShopBusinessDate) localStorage.setItem("mm_business_date_" + channelId, mmShopBusinessDate);
                localStorage.setItem("mm_business_start_hour_" + channelId, String(mmBusinessDayStartHour || 0));
            } catch (e) {}
        }

        function mmUpdateShopBusinessMeta(src, opts) {
            opts = opts || {};
            if (!src) return false;
            const meta = src.meta || {};
            let bd = String(src.businessDate || meta.businessDate || "").slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(bd)) return false;
            const prev = mmShopBusinessDate;
            mmShopBusinessDate = bd;
            const shRaw = src.businessDayStartHour != null ? src.businessDayStartHour : meta.businessDayStartHour;
            const sh = parseInt(shRaw, 10);
            if (Number.isFinite(sh) && sh >= 0 && sh <= 23) mmBusinessDayStartHour = sh;
            if (activeChannelId) mmPersistBusinessMeta(activeChannelId);
            if (!opts.silent && prev && prev !== bd && activeChannelId) {
                bindDetail(activeChannelId);
            }
            return prev !== bd;
        }

        function getBusinessDateKey(d) {
            const x = d instanceof Date ? d : new Date(d);
            if (isNaN(x.getTime())) return mmShopBusinessDate || "";
            let dateKey = mmGetPosDateKey(x);
            if (!dateKey) return mmShopBusinessDate || "";
            const sh = Number.isFinite(mmBusinessDayStartHour) ? mmBusinessDayStartHour : 0;
            if (mmGetPosTimezoneHour(x) < sh) dateKey = mmShiftDateKey(dateKey, -1);
            return dateKey;
        }

        function getMobileBusinessDayKey() {
            if (mmShopBusinessDate && /^\d{4}-\d{2}-\d{2}$/.test(mmShopBusinessDate)) {
                return mmShopBusinessDate;
            }
            return getBusinessDateKey(new Date());
        }

        function esc(s) {
            return String(s || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
        }

        function formatMoney(v) {
            const n = Math.round(Number(v || 0));
            return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number.isFinite(n) ? n : 0);
        }

        let mobileAmountMeta = { amountCurrency: "IQD", posDisplayCurrency: "IQD", syncVersion: 3, usdRatePerOne: 0 };
        const MM_PRIVACY_HIDDEN = "— · شاردراوە";

        function mmPrivacyFromDoc(d) {
            const doc = d || {};
            const p = doc.privacy || {};
            const m = doc.meta || {};
            return {
                hideProfit: !!(p.hideProfit || m.hideProfit),
                hideSalesDetail: !!(p.hideSalesDetail || m.hideSalesDetail)
            };
        }

        function mmApplyProfitPrivacyUi(hideProfit) {
            const kpiFeatured = document.querySelector(".kpi-featured");
            const homeNetTile = document.querySelector(".home-mini.net");
            if (kpiFeatured) kpiFeatured.classList.toggle("mm-privacy-off", !!hideProfit);
            if (homeNetTile) homeNetTile.classList.toggle("mm-privacy-off", !!hideProfit);
        }

        function getMobileDisplayCurrency() {
            var m = String(mobileAmountMeta.posDisplayCurrency || mobileAmountMeta.amountCurrency || "").toUpperCase();
            if (m === "USD" || m === "IQD") return m;
            try {
                var ls = localStorage.getItem("pos_currency_mode");
                if (ls === "USD" || ls === "IQD") return ls;
            } catch (e) {}
            return "IQD";
        }

        function getMobileUsdRatePerOne() {
            var r = Number(mobileAmountMeta.usdRatePerOne || 0);
            if (r > 0 && r < 10000) return r;
            if (r >= 10000) return r / 100;
            try {
                var bundle = parseInt(localStorage.getItem("pos_usd_rate") || "", 10);
                if (bundle >= 10000) return bundle / 100;
            } catch (e) {}
            return 1500;
        }

        function normalizeMobileIqd(val) {
            return Math.round(Number(val) || 0);
        }

        function iqdToMobileDisplay(iqd) {
            var n = normalizeMobileIqd(iqd);
            if (getMobileDisplayCurrency() !== "USD") return n;
            var rate = getMobileUsdRatePerOne();
            if (!rate || rate <= 0) return n;
            return Math.round((n / rate) * 100) / 100;
        }

        function formatMobileMoney(iqdStored) {
            if (getMobileDisplayCurrency() === "USD") {
                var usd = iqdToMobileDisplay(iqdStored);
                var fmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(usd);
                return "$" + fmt;
            }
            return formatMoney(normalizeMobileIqd(iqdStored)) + " د.ع";
        }

        function formatMoneyIqd(v) {
            return formatMobileMoney(v);
        }

        function updateMobileCurrencyHint() {
            var el = document.getElementById("dashCurrencyHint");
            if (!el) return;
            if (getMobileDisplayCurrency() === "USD") {
                el.innerHTML = '<i class="fas fa-coins"></i> هەموو بڕەکان بە <strong>دۆلار ($)</strong> — هەمان دراوێ POS';
            } else {
                el.innerHTML = '<i class="fas fa-coins"></i> هەموو بڕەکان بە <strong>دینار (د.ع)</strong> — هەمان دراوێ POS';
            }
        }

        function setMobileAmountMeta(src) {
            if (!src) return;
            var meta = src.meta || src;
            var prevCur = getMobileDisplayCurrency();
            mobileAmountMeta = {
                amountCurrency: src.amountCurrency || meta.amountCurrency || "IQD",
                posDisplayCurrency: src.posDisplayCurrency || meta.posDisplayCurrency || meta.amountCurrency || "IQD",
                syncVersion: Number(src.syncVersion != null ? src.syncVersion : (meta.v != null ? meta.v : 3)),
                usdRatePerOne: Number(src.usdRatePerOne || meta.usdRatePerOne || 0)
            };
            updateMobileCurrencyHint();
            if (getMobileDisplayCurrency() !== prevCur) {
                if (debtDocSynced && typeof refreshDebtView === "function") refreshDebtView();
                if (invDocSynced && typeof refreshInventoryView === "function") refreshInventoryView();
            }
        }

        function groupSaleLineItems(items) {
            const grouped = {};
            (items || []).forEach((it) => {
                const qty =
                    Number(it.qty) > 0
                        ? Number(it.qty)
                        : Number(it.count) > 0
                          ? Number(it.count)
                          : 1;
                const price = Number(it.price) || 0;
                const saleUnit = it.saleUnit || "piece";
                const note = String(it.note || "");
                const key =
                    String(it.id || it.name || "") +
                    "_" +
                    note +
                    "_" +
                    price +
                    "_" +
                    saleUnit;
                if (!grouped[key]) {
                    grouped[key] = {
                        name: String(it.name || ""),
                        qty: 0,
                        price,
                        saleUnit
                    };
                }
                grouped[key].qty += qty;
            });
            return Object.values(grouped);
        }

        function setStatus(text, ok, mode) {
            let icon = ok ? "fa-circle-check" : "fa-triangle-exclamation";
            let bg = ok ? "rgba(34,197,94,0.14)" : "rgba(239,68,68,0.12)";
            let border = ok ? "rgba(34,197,94,0.28)" : "rgba(239,68,68,0.3)";
            let color = ok ? "#4ade80" : "#fca5a5";
            if (mode === "cache") {
                icon = "fa-cloud";
                bg = "rgba(59,130,246,0.14)";
                border = "rgba(59,130,246,0.28)";
                color = "#93c5fd";
            } else if (mode === "offline-cache") {
                icon = "fa-wifi-slash";
                bg = "rgba(245,158,11,0.14)";
                border = "rgba(245,158,11,0.28)";
                color = "#fcd34d";
            } else if (mode === "offline") {
                icon = "fa-wifi-slash";
            } else if (mode === "live") {
                icon = "fa-circle-check";
            }
            statusEl.innerHTML = '<i class="fas ' + icon + '"></i> ' + text;
            statusEl.style.background = bg;
            statusEl.style.borderColor = border;
            statusEl.style.color = color;
        }

        function formatQty(v) {
            const n = Number(v || 0);
            if (!Number.isFinite(n)) return "0";
            if (Math.abs(n - Math.round(n)) < 0.001) return String(Math.round(n));
            return n.toFixed(2).replace(/\.?0+$/, "");
        }

        let invProductsCache = [];
        let invCategoriesCache = [];
        let invSessionsCache = [];
        let invRecentCache = [];
        let invSearchText = "";
        let invCatFilter = "";
        let invActiveTab = "products";
        let invSubTabsBound = false;
        let invChannelId = "";
        let invFiltersBound = false;
        let invScannerActive = false;
        let invHtml5Scanner = null;
        let invDetectorStream = null;
        let invDetectorLoop = null;
        let invScanBannerText = "";
        let invStDayMode = "today";
        let invDateFiltersBound = false;

        let debtCustomersCache = [];
        let debtCompaniesCache = [];
        let debtCustLedgerCache = [];
        let debtCompLedgerCache = [];
        let debtCustLedgerById = {};
        let debtCompLedgerById = {};
        let debtExpandedId = null;
        let debtDocSynced = false;
        let invDocSynced = false;
        let debtActiveTab = "customers";
        let debtSearchText = "";
        let debtFiltersBound = false;

        function debtLedgerTypeLabel(type) {
            const map = {
                sale: "فرۆشتن",
                payment: "پارەدان",
                return: "گەڕانەوە",
                credit_purchase: "کڕین بە قەرز",
                purchase: "کڕین",
                receive: "وەرگرتن",
                return_to_supplier: "زڤڕاندن",
                debt_payment: "پارەدان"
            };
            return map[String(type || "")] || String(type || "—");
        }

        function filterDebtRows(rows, q) {
            const term = String(q || "").trim().toLowerCase();
            if (!term) return rows.slice();
            return rows.filter(function (r) {
                return String(r.name || "").toLowerCase().indexOf(term) >= 0 ||
                    String(r.phone || "").toLowerCase().indexOf(term) >= 0;
            });
        }

        function renderDebtLedgerMini(entries, emptyLabel) {
            if (!entries || !entries.length) {
                return '<div class="detail-empty" style="padding:6px 0;font-size:0.72rem;">' + esc(emptyLabel || "هیچ جووڵەیەک نییە.") + "</div>";
            }
            let html = '<div class="debt-ledger-mini">';
            entries.forEach(function (e) {
                const amt = Number(e.amount) || 0;
                const who = e.name || e.targetName || e.companyName || "";
                html += '<div class="line-row"><span>' +
                    (who ? '<strong style="color:var(--text);">' + esc(who) + "</strong><br>" : "") +
                    esc(debtLedgerTypeLabel(e.type)) +
                    (e.note ? " · " + esc(e.note) : "") +
                    '<br><small style="color:var(--muted)">' + esc(e.date || "") + "</small></span>" +
                    '<span class="amt">' + formatMobileMoney(amt) + "</span></div>";
            });
            html += "</div>";
            return html;
        }

        function renderDebtRowDetail(r, isCust) {
            const idKey = String(r.id);
            const byId = isCust ? debtCustLedgerById : debtCompLedgerById;
            const entries = (byId && byId[idKey]) ? byId[idKey] : [];
            const limit = Number(r.debtLimit) || 0;
            const opening = Number(r.openingBalance) || 0;
            let html = '<div class="debt-detail-grid">' +
                '<div><span>قەرزی ئێستا</span><strong>' + formatMobileMoney(Number(r.balance) || 0) + "</strong></div>" +
                '<div><span>سنووری قەرز</span><strong>' + (limit > 0 ? formatMobileMoney(limit) : "—") + "</strong></div>" +
                '<div><span>قەرزی سەرەتایی</span><strong>' + formatMobileMoney(opening) + "</strong></div>" +
                '<div><span>ژمارە</span><strong>#' + esc(idKey) + "</strong></div>" +
                "</div>";
            html += '<div class="detail-h expenses" style="margin:6px 0 4px;font-size:0.72rem;"><i class="fas fa-list"></i> مێژووی قەرز</div>';
            html += renderDebtLedgerMini(entries, "هیچ تۆمارێک نییە بۆ ئەم " + (isCust ? "کڕیارە" : "کڕین کۆمپانیایە") + ".");
            return html;
        }

        function renderDebtListHtml() {
            const isCust = debtActiveTab === "customers";
            const rows = filterDebtRows(isCust ? debtCustomersCache : debtCompaniesCache, debtSearchText);
            let html = '<div class="inv-toolbar" style="margin-bottom:8px;">' +
                '<input type="search" id="debtSearchIn" class="inv-search" placeholder="گەڕان: ناو، تەلەفۆن…" value="' + esc(debtSearchText) + '" inputmode="search" autocomplete="off" style="width:100%;">' +
                "</div>";
            if (!rows.length) {
                html += '<div class="detail-empty">' + (isCust ? "هیچ قەرزی کڕیار نییە." : "هیچ قەرزی کڕین کۆمپانیا نییە.") + "</div>";
                const ledger = isCust ? debtCustLedgerCache : debtCompLedgerCache;
                if (ledger.length) {
                    html += '<div class="inv-section"><div class="detail-h expenses"><i class="fas fa-clock-rotate-left"></i> دوایین جووڵەکان (گشتی)</div>';
                    html += renderDebtLedgerMini(ledger.slice(0, 20));
                    html += "</div>";
                }
                return html;
            }
            rows.forEach(function (r) {
                const bal = Number(r.balance) || 0;
                const amtCls = bal > 0 ? "positive" : "credit";
                const phone = r.phone ? ('<div class="debt-row-meta"><i class="fas fa-phone"></i> ' + esc(r.phone) + "</div>") : "";
                const warn = r.overLimit ? '<span class="debt-badge-warn"><i class="fas fa-triangle-exclamation"></i> سنوور تێپەڕی</span>' : "";
                const idKey = String(r.id);
                const expanded = debtExpandedId === idKey;
                const limit = Number(r.debtLimit) || 0;
                const metaExtra = (limit > 0 ? ('<div class="debt-row-meta">سنوور: ' + formatMobileMoney(limit) + "</div>") : "");
                const entityLabel = isCust ? "ناوی کڕیار" : "ناوی کڕین کۆمپانیا";
                html += '<div class="debt-row' + (expanded ? " expanded" : "") + '" data-debt-id="' + esc(idKey) + '">' +
                    '<div class="debt-row-head">' +
                    '<div class="debt-row-name-block">' +
                    '<span class="debt-entity-label">' + entityLabel + "</span>" +
                    '<div class="debt-row-name">' + esc(r.name || "—") + "</div>" + phone + metaExtra + warn +
                    '<div class="debt-chevron"><i class="fas fa-chevron-' + (expanded ? "up" : "down") + '"></i> ' +
                    (expanded ? "شاردنەوە" : "وردەکاری") + "</div></div>" +
                    '<div class="debt-row-amt-block">' +
                    '<span class="debt-entity-label">قەرز</span>' +
                    '<div class="debt-row-amt ' + amtCls + '">' + formatMobileMoney(Math.abs(bal)) + "</div></div></div>";
                if (expanded) {
                    html += '<div class="debt-row-detail">' + renderDebtRowDetail(r, isCust) + "</div>";
                }
                html += "</div>";
            });
            return html;
        }

        function refreshDebtView() {
            const el = document.getElementById("debtContent");
            if (!el) return;
            el.innerHTML = renderDebtListHtml();
        }

        function setDebtSubTab(which) {
            debtActiveTab = which === "companies" ? "companies" : "customers";
            debtExpandedId = null;
            const tc = document.getElementById("debtTabCustomers");
            const ts = document.getElementById("debtTabCompanies");
            if (tc) tc.classList.toggle("active", debtActiveTab === "customers");
            if (ts) ts.classList.toggle("active", debtActiveTab === "companies");
            refreshDebtView();
        }

        function bindDebtFilters() {
            const el = document.getElementById("debtContent");
            if (!el || debtFiltersBound) return;
            debtFiltersBound = true;
            let tmr = null;
            el.addEventListener("input", function (e) {
                if (!e.target || e.target.id !== "debtSearchIn") return;
                clearTimeout(tmr);
                const inp = e.target;
                tmr = setTimeout(function () {
                    debtSearchText = inp.value || "";
                    refreshDebtView();
                    const again = document.getElementById("debtSearchIn");
                    if (again) {
                        again.focus();
                        again.setSelectionRange(debtSearchText.length, debtSearchText.length);
                    }
                }, 180);
            });
            const tc = document.getElementById("debtTabCustomers");
            const ts = document.getElementById("debtTabCompanies");
            if (tc) tc.addEventListener("click", function () { setDebtSubTab("customers"); });
            if (ts) ts.addEventListener("click", function () { setDebtSubTab("companies"); });
            el.addEventListener("click", function (e) {
                const row = e.target && e.target.closest ? e.target.closest(".debt-row[data-debt-id]") : null;
                if (!row || (e.target && e.target.id === "debtSearchIn")) return;
                const id = row.getAttribute("data-debt-id");
                debtExpandedId = debtExpandedId === id ? null : id;
                refreshDebtView();
            });
        }

        function applyDebtData(data, opts) {
            opts = opts || {};
            const debtContent = document.getElementById("debtContent");
            const debtMeta = document.getElementById("debtMeta");
            const debtCustTotal = document.getElementById("debtCustTotal");
            const debtSupTotal = document.getElementById("debtSupTotal");
            const debtCustCount = document.getElementById("debtCustCount");
            const debtSupCount = document.getElementById("debtSupCount");
            if (!debtContent) return;
            if (!data) {
                if (!opts.fromCache && !opts._cacheRetried && activeChannelId) {
                    mmSnapLoad(activeChannelId, "debt").then(function (snap) {
                        if (snap && snap.data) {
                            applyDebtData(snap.data, {
                                silent: opts.silent,
                                fromCache: true,
                                savedAt: snap.savedAt
                            });
                        } else {
                            applyDebtData(null, Object.assign({}, opts, { _cacheRetried: true }));
                        }
                    });
                    return;
                }
                debtDocSynced = false;
                let hint = 'لە POS: ڕێکخستن → Firebase sync → <strong>پەیوەست بکە</strong> (هەمان ئیمەیڵ)<br>' +
                    'پاشان <strong>«ئێستا هاوکات بکە»</strong> بگرە و ≈١٣ چرکە چاوەڕێ بکە.';
                if (invDocSynced) {
                    hint = 'کۆگە هاتە موبایل بەڵام <strong>قەرز</strong> هێشتا نەنێردراوە.<br>' +
                        'لە POS: تابی <strong>کۆمپانیا</strong> بکەرەوە، پاشان <strong>«ئێستا هاوکات بکە»</strong> (Ctrl+F5 سەرەتا).';
                }
                if (activeChannelId) {
                    hint += '<br><small style="color:var(--muted)">کەناڵ: ' + esc(activeChannelId) + '</small>';
                }
                debtContent.innerHTML = '<div class="detail-empty">هێشتا داتای قەرز لە Firebase نییە.<br><br>' + hint +
                    '<br><br><button type="button" class="btn-ghost" onclick="document.getElementById(\'refreshBtn\')&&document.getElementById(\'refreshBtn\').click()" style="margin-top:8px;width:100%;"><i class="fas fa-arrows-rotate"></i> Refresh</button></div>';
                if (debtMeta) debtMeta.textContent = "کڕیار · کڕین کۆمپانیا";
                if (debtCustTotal) debtCustTotal.textContent = "0";
                if (debtSupTotal) debtSupTotal.textContent = "0";
                if (debtCustCount) debtCustCount.textContent = "0 کڕیار";
                if (debtSupCount) debtSupCount.textContent = "0 کڕین کۆمپانیا";
                mmSnapDebtSummary = null;
                return;
            }
            debtDocSynced = true;
            if (opts.fromCache) mmNoteCacheSavedAt(opts.savedAt);
            const summary = data.summary || {};
            mmSnapDebtSummary = Object.assign({}, summary);
            const meta = data.meta || {};
            setMobileAmountMeta(data);
            if (debtCustTotal) debtCustTotal.textContent = formatMoneyIqd(normalizeMobileIqd(summary.customerReceivables || 0));
            if (debtSupTotal) debtSupTotal.textContent = formatMoneyIqd(normalizeMobileIqd(summary.supplierPayables || 0));
            if (debtCustCount) debtCustCount.textContent = String(Number(summary.customerDebtorCount || 0)) + " کڕیار";
            if (debtSupCount) debtSupCount.textContent = String(Number(summary.supplierDebtCount || 0)) + " کڕین کۆمپانیا";
            if (debtMeta) {
                debtMeta.textContent = (opts.fromCache ? "cache · " : "") + "کۆی قەرزی کڕیار · کڕین کۆمپانیا" +
                    (meta.truncatedCustomers || meta.truncatedCompanies ? " · بەشێک لە لیست" : "");
            }
            debtCustomersCache = Array.isArray(data.customers) ? data.customers.slice() : [];
            debtCompaniesCache = Array.isArray(data.companies) ? data.companies.slice() : [];
            debtCustLedgerCache = Array.isArray(data.customerLedgerRecent) ? data.customerLedgerRecent : [];
            debtCompLedgerCache = Array.isArray(data.companyLedgerRecent) ? data.companyLedgerRecent : [];
            debtCustLedgerById = (data.customerLedgerById && typeof data.customerLedgerById === "object") ? data.customerLedgerById : {};
            debtCompLedgerById = (data.companyLedgerById && typeof data.companyLedgerById === "object") ? data.companyLedgerById : {};
            if (debtExpandedId) {
                const still = (debtActiveTab === "customers" ? debtCustomersCache : debtCompaniesCache)
                    .some(function (r) { return String(r.id) === debtExpandedId; });
                if (!still) debtExpandedId = null;
            }
            refreshDebtView();
            bindDebtFilters();
            if (activeChannelId && !opts.fromCache) {
                mmSnapSaveDebounced(activeChannelId, "debt", data);
            }
        }

        function bindDebt(channelId) {
            if (unsubDebt) { unsubDebt(); unsubDebt = null; }
            const debtContent = document.getElementById("debtContent");
            if (!debtContent) return;
            const dref = doc(db, "pos_mobile_debt", channelId);
            unsubDebt = onSnapshot(dref, function (snap) {
                applyDebtData(snap.exists() ? snap.data() : null, {
                    silent: snap.metadata.fromCache,
                    fromCache: snap.metadata.fromCache
                });
                if (snap.metadata.fromCache) {
                    mmUpdateConnectionStatus({ fromCache: true, savedAt: mmLastCacheSavedAt });
                } else if (snap.exists()) {
                    mmUpdateConnectionStatus({ live: true });
                }
            }, function () {
                debtContent.innerHTML = '<div class="detail-empty" style="color:#fca5a5;">نەتوانرا قەرز بخوێنرێتەوە — Firestore Rules.<br><br>' +
                    '<strong>چارەسەر:</strong> Firebase Console → Firestore → Rules<br>' +
                    '<code style="display:block;font-size:0.68rem;word-break:break-all;margin:8px 0;padding:8px;background:rgba(0,0,0,.2);border-radius:8px;">match /pos_mobile_debt/{channelId} {<br>&nbsp;&nbsp;allow read, write: if request.auth != null &amp;&amp; request.auth.token.email.lower() == channelId;<br>}</code>' +
                    "پاشان Publish → لە POS sync بکە.</div>";
            });
        }

        function getInvStocktakeFilterDate() {
            if (invStDayMode === "all") return "";
            if (invStDayMode === "today") return getMobileBusinessDayKey();
            if (invStDayMode === "yesterday") {
                const d = new Date();
                d.setDate(d.getDate() - 1);
                return getBusinessDateKey(d);
            }
            if (invStDayMode === "pick") {
                const el = document.getElementById("invStDatePick");
                return (el && el.value) ? el.value : getMobileBusinessDayKey();
            }
            return "";
        }

        function stocktakeMatchesDay(item, dayKey) {
            if (!dayKey || !item) return true;
            const bd = String(item.businessDate || "").slice(0, 10);
            const dt = String(item.date || "").slice(0, 10);
            return bd === dayKey || dt.indexOf(dayKey) === 0;
        }

        function normalizeBarcodeSearchInput(raw) {
            if (raw == null) return "";
            let t = String(raw).trim();
            if (!t) return "";
            t = t.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
            t = t.replace(/[\u06F0-\u06F9]/g, (ch) => String(ch.charCodeAt(0) - 0x06f0));
            t = t.replace(/[\u0660-\u0669]/g, (ch) => String(ch.charCodeAt(0) - 0x0660));
            return t.replace(/\s/g, "").toLowerCase();
        }

        function barcodeHaystackMatch(raw, term) {
            const t = normalizeBarcodeSearchInput(term);
            if (!t) return false;
            const str = String(raw || "");
            if (!str.trim()) return false;
            if (normalizeBarcodeSearchInput(str) === t) return true;
            if (normalizeBarcodeSearchInput(str).indexOf(t) >= 0) return true;
            const parts = str.split(",");
            for (let i = 0; i < parts.length; i++) {
                const seg = normalizeBarcodeSearchInput(parts[i]);
                if (seg && (seg === t || seg.indexOf(t) >= 0 || t.indexOf(seg) >= 0)) return true;
            }
            return false;
        }

        function productMatchesInvSearch(p, term) {
            const raw = String(term || "").trim();
            if (!raw) return true;
            const tl = raw.toLowerCase();
            if (String(p.name || "").toLowerCase().indexOf(tl) >= 0) return true;
            if (String(p.category || "").toLowerCase().indexOf(tl) >= 0) return true;
            if (String(p.manufacturer || "").toLowerCase().indexOf(tl) >= 0) return true;
            if (barcodeHaystackMatch(p.barcode, raw)) return true;
            if (normalizeBarcodeSearchInput(String(p.id)) === normalizeBarcodeSearchInput(raw)) return true;
            return false;
        }

        function invCatStorageKey() {
            return "pos_mobile_inv_cat_" + (invChannelId || "default");
        }

        function loadInvCatFilter() {
            try {
                invCatFilter = localStorage.getItem(invCatStorageKey()) || "";
            } catch (e) {
                invCatFilter = "";
            }
        }

        function saveInvCatFilter(val) {
            invCatFilter = val || "";
            try {
                localStorage.setItem(invCatStorageKey(), invCatFilter);
            } catch (e) {}
        }

        function buildCategoryOptions(categories, selected) {
            const cats = Array.isArray(categories) ? categories.slice() : [];
            const seen = Object.create(null);
            const out = [];
            cats.forEach((c) => {
                const s = String(c || "").trim();
                if (s && !seen[s]) {
                    seen[s] = 1;
                    out.push(s);
                }
            });
            invProductsCache.forEach((p) => {
                const s = String(p.category || "").trim();
                if (s && !seen[s]) {
                    seen[s] = 1;
                    out.push(s);
                }
            });
            out.sort((a, b) => a.localeCompare(b, "ku", { sensitivity: "base" }));
            let html = '<option value="">هەموو پۆلەکان</option>';
            out.forEach((c) => {
                const sel = selected === c ? " selected" : "";
                html += '<option value="' + esc(c) + '"' + sel + ">" + esc(c) + "</option>";
            });
            return html;
        }

        function filterInventoryProducts(products, filterText, category) {
            let list = products.slice();
            const cat = String(category || "").trim();
            if (cat) {
                list = list.filter((p) => String(p.category || "").trim() === cat);
            }
            const q = String(filterText || "").trim();
            if (q) {
                list = list.filter((p) => productMatchesInvSearch(p, q));
            }
            list.sort((a, b) => {
                if ((a.qty || 0) <= 0 && (b.qty || 0) > 0) return -1;
                if ((a.qty || 0) > 0 && (b.qty || 0) <= 0) return 1;
                return String(a.name || "").localeCompare(String(b.name || ""), "ku", { sensitivity: "base" });
            });
            return list;
        }

        function renderInventoryTable(products, filterText, category) {
            const list = filterInventoryProducts(products, filterText, category);
            const titleCat = category ? (" · " + category) : "";

            let html = '<div class="inv-list-title"><i class="fas fa-list-alt"></i> ئایتم · ' + list.length + titleCat + "</div>";
            if (invScanBannerText) {
                html += '<div class="inv-scan-banner"><i class="fas fa-check-circle"></i> ' + esc(invScanBannerText) + "</div>";
            }
            html += '<div class="inv-toolbar">' +
                '<select id="invCatFilter" class="inv-cat-select" aria-label="پۆل">' +
                buildCategoryOptions(invCategoriesCache, category || "") +
                "</select>" +
                '<input type="search" id="invSearchIn" class="inv-search" placeholder="گەڕان: ناو، بارکۆد…" value="' + esc(filterText || "") + '" inputmode="search" autocomplete="off">' +
                '<button type="button" id="invScanMini" class="inv-scan-mini" aria-label="سکان"><i class="fas fa-barcode"></i></button>' +
                "</div>";

            if (!list.length) {
                html += '<div class="detail-empty">هیچ ئایتمێک نەدۆزرایەوە.</div>';
                return html;
            }

            html += '<div class="inv-table-wrap"><table class="inv-table"><thead><tr>' +
                "<th>بارکۆد</th><th>ناو</th><th>پۆل</th><th>کۆمپانیا دروستکەر</th>" +
                "<th>تێچوو</th><th>نرخ</th><th>ژمارە</th><th>کەمترین</th><th>بەسەرچوون</th><th>دۆخ</th>" +
                "</tr></thead><tbody>";

            list.forEach((p) => {
                const st = p.status || "ok";
                let rowCls = "";
                if (p.lossPrice) rowCls = "inv-tr-loss";
                else if (st === "out") rowCls = "inv-tr-out";
                else if (st === "low") rowCls = "inv-tr-low";
                const lossHint = p.lossPrice
                    ? '<small><i class="fas fa-exclamation-circle"></i> بهای کڕین > فرۆشتن</small>'
                    : "";
                let badges = '<span class="inv-badge ' + st + '">' + esc(p.statusLabel || st) + "</span>";
                if (p.lossPrice) {
                    badges += '<span class="inv-badge loss"><i class="fas fa-triangle-exclamation"></i> زیان</span>';
                }
                html += '<tr class="' + rowCls + '">' +
                    "<td dir=\"ltr\">" + esc(p.barcode || "—") + "</td>" +
                    '<td class="inv-td-name">' + esc(p.name || "—") + lossHint + "</td>" +
                    "<td>" + esc(p.category || "—") + "</td>" +
                    "<td>" + esc(p.manufacturer || "—") + "</td>" +
                    '<td class="inv-td-money">' + formatMoneyIqd(normalizeMobileIqd(p.cost)) + "</td>" +
                    '<td class="inv-td-money">' + formatMoneyIqd(normalizeMobileIqd(p.price)) + "</td>" +
                    '<td class="inv-td-qty ' + st + '">' + formatQty(p.qty) + "</td>" +
                    "<td>" + esc(p.minStock != null ? p.minStock : "—") + "</td>" +
                    "<td>" + esc(p.expiry || "—") + "</td>" +
                    "<td>" + badges + "</td></tr>";
            });
            html += "</tbody></table></div>";
            return html;
        }

        function renderStocktakeSections(sessions, recent) {
            const dayKey = getInvStocktakeFilterDate();
            const sess = (Array.isArray(sessions) ? sessions : []).filter(function (s) { return stocktakeMatchesDay(s, dayKey); });
            const rec = (Array.isArray(recent) ? recent : []).filter(function (m) { return stocktakeMatchesDay(m, dayKey); });
            const dayLabel = dayKey ? (" · " + dayKey) : "";
            let html = '<div class="inv-section">';
            html += '<div class="detail-h stocktake"><i class="fas fa-clipboard-list"></i> مێژووی جەرد (' + sess.length + dayLabel + ")</div>";
            if (!sess.length) {
                html += '<div class="detail-empty">بۆ ئەم ڕۆژە جەرد نییە.</div>';
            } else {
                sess.slice(0, 20).forEach((s) => {
                    const net = Number(s.netVariance || 0);
                    const netTxt = (net > 0 ? "+" : "") + formatQty(net);
                    html += '<div class="st-session"><div><div class="date">' + esc(s.businessDate || "—") + '</div><div class="meta">' +
                        esc(s.warehouseName || "") + " · " + String(Number(s.itemCount || 0)) + " ئایتم · جیاوازی " + netTxt +
                        "</div></div><i class=\"fas fa-calendar-check\" style=\"color:#34d399\"></i></div>";
                });
            }
            if (rec.length) {
                html += '<div class="detail-h stocktake"><i class="fas fa-clock-rotate-left"></i> گوهۆڕین (' + Math.min(rec.length, 15) + dayLabel + ")</div>";
                rec.slice(0, 15).forEach((m) => {
                    const q = Number(m.qty || 0);
                    const qTxt = (q > 0 ? "+" : "") + formatQty(q);
                    html += '<div class="line-row"><span>' + esc(m.productName || "#" + m.productId) + '<br><small style="color:var(--muted)">' + esc(m.date || "") + "</small></span><span class=\"amt\">" + qTxt + "</span></div>";
                });
            }
            html += "</div>";
            return html;
        }

        function buildManufacturerSummary(products) {
            const map = Object.create(null);
            (products || []).forEach(function (p) {
                const raw = String(p.manufacturer || "").trim();
                const key = raw || "__none__";
                if (!map[key]) {
                    map[key] = {
                        name: raw || "بێ کۆمپانیا دروستکەر",
                        products: 0,
                        qty: 0,
                        low: 0,
                        out: 0
                    };
                }
                map[key].products += 1;
                map[key].qty += Number(p.qty) || 0;
                if (p.status === "out") map[key].out += 1;
                else if (p.status === "low") map[key].low += 1;
            });
            return Object.values(map).sort(function (a, b) {
                return String(a.name).localeCompare(String(b.name), "ku", { sensitivity: "base" });
            });
        }

        function manufacturerMatchesSearch(row, term) {
            const raw = String(term || "").trim();
            if (!raw) return true;
            return String(row.name || "").toLowerCase().indexOf(raw.toLowerCase()) >= 0;
        }

        function renderManufacturersSection(products, filterText) {
            const rows = buildManufacturerSummary(products).filter(function (r) {
                return manufacturerMatchesSearch(r, filterText);
            });
            let html = '<div class="inv-list-title"><i class="fas fa-industry"></i> کۆمپانیا دروستکەر · ' + rows.length + "</div>";
            html += '<p class="sub" style="margin:0 0 8px;font-size:0.74rem;color:var(--muted);">جیا لە <strong>کڕین کۆمپانیا</strong> (قەرزی دابینکەر) — ئەمە ناوی دروستکەری کاڵایە.</p>';
            html += '<div class="inv-toolbar">' +
                '<input type="search" id="invSearchIn" class="inv-search" placeholder="گەڕان: کۆمپانیا دروستکەر…" value="' + esc(filterText || "") + '" inputmode="search" autocomplete="off" style="min-width:100%;">' +
                "</div>";
            if (!rows.length) {
                html += '<div class="detail-empty">هیچ کۆمپانیایەکی دروستکەر نەدۆزرایەوە.</div>';
                return html;
            }
            html += '<div class="inv-section">';
            rows.forEach(function (r) {
                html += '<div class="mfr-row"><div><div class="mfr-row-name">' + esc(r.name) + '</div><div class="mfr-row-meta">' +
                    String(r.products) + " ئایتم · لە کۆگەدا " + formatQty(r.qty) +
                    (r.low ? (" · <span style=\"color:#fbbf24\">" + r.low + " کەم</span>") : "") +
                    (r.out ? (" · <span style=\"color:#f87171\">" + r.out + " نەما</span>") : "") +
                    "</div></div><div class=\"mfr-row-stats\"><strong>" + String(r.products) + "</strong>ئایتم</div></div>";
            });
            html += "</div>";
            return html;
        }

        function setInvSubTab(which) {
            invActiveTab = which === "manufacturers" ? "manufacturers" : "products";
            const tp = document.getElementById("invTabProducts");
            const tm = document.getElementById("invTabManufacturers");
            const dateRow = document.getElementById("invDateRow");
            if (tp) tp.classList.toggle("active", invActiveTab === "products");
            if (tm) tm.classList.toggle("active", invActiveTab === "manufacturers");
            if (dateRow) dateRow.style.display = invActiveTab === "products" ? "" : "none";
            refreshInventoryView();
        }

        function bindInvSubTabs() {
            if (invSubTabsBound) return;
            invSubTabsBound = true;
            const tp = document.getElementById("invTabProducts");
            const tm = document.getElementById("invTabManufacturers");
            if (tp) tp.addEventListener("click", function () { setInvSubTab("products"); });
            if (tm) tm.addEventListener("click", function () { setInvSubTab("manufacturers"); });
        }

        function refreshInventoryView() {
            const invContent = document.getElementById("inventoryContent");
            if (!invContent) return;
            if (invActiveTab === "manufacturers") {
                invContent.innerHTML = renderManufacturersSection(invProductsCache, invSearchText);
                return;
            }
            invContent.innerHTML =
                renderInventoryTable(invProductsCache, invSearchText, invCatFilter) +
                renderStocktakeSections(invSessionsCache, invRecentCache);
        }

        function bindInvDateFilters() {
            if (invDateFiltersBound) return;
            invDateFiltersBound = true;
            const row = document.getElementById("invDateRow");
            const pick = document.getElementById("invStDatePick");
            if (pick) pick.value = getMobileBusinessDayKey();
            if (!row) return;
            row.addEventListener("click", function (e) {
                const chip = e.target && e.target.closest ? e.target.closest(".inv-date-chip") : null;
                if (!chip) return;
                invStDayMode = chip.getAttribute("data-inv-day") || "today";
                row.querySelectorAll(".inv-date-chip").forEach(function (c) {
                    c.classList.toggle("active", c === chip);
                });
                refreshInventoryView();
            });
            if (pick) {
                pick.addEventListener("change", function () {
                    invStDayMode = "pick";
                    row.querySelectorAll(".inv-date-chip").forEach(function (c) { c.classList.remove("active"); });
                    refreshInventoryView();
                });
            }
        }

        function bindInventoryFilters() {
            const invContent = document.getElementById("inventoryContent");
            if (!invContent || invFiltersBound) return;
            invFiltersBound = true;
            let tmr = null;
            invContent.addEventListener("input", (e) => {
                if (!e.target || e.target.id !== "invSearchIn") return;
                clearTimeout(tmr);
                const inp = e.target;
                tmr = setTimeout(() => {
                    invSearchText = inp.value || "";
                    invScanBannerText = "";
                    refreshInventoryView();
                    const again = document.getElementById("invSearchIn");
                    if (again) {
                        again.focus();
                        again.setSelectionRange(invSearchText.length, invSearchText.length);
                    }
                }, 180);
            });
            invContent.addEventListener("change", (e) => {
                if (!e.target || e.target.id !== "invCatFilter") return;
                saveInvCatFilter(e.target.value || "");
                invScanBannerText = "";
                refreshInventoryView();
            });
            invContent.addEventListener("click", (e) => {
                const t = e.target && e.target.closest ? e.target.closest("#invScanMini") : null;
                if (t) openInvScanner();
            });
        }

        function loadHtml5QrcodeLib() {
            if (window.Html5Qrcode) return Promise.resolve(window.Html5Qrcode);
            return new Promise((resolve, reject) => {
                const s = document.createElement("script");
                s.src = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
                s.async = true;
                s.onload = () => resolve(window.Html5Qrcode);
                s.onerror = () => reject(new Error("library"));
                document.head.appendChild(s);
            });
        }

        async function stopInvScanner() {
            invScannerActive = false;
            if (invDetectorLoop) {
                cancelAnimationFrame(invDetectorLoop);
                invDetectorLoop = null;
            }
            if (invDetectorStream) {
                invDetectorStream.getTracks().forEach((tr) => { try { tr.stop(); } catch (e) {} });
                invDetectorStream = null;
            }
            const video = document.getElementById("invScannerVideo");
            if (video) video.srcObject = null;
            const videoWrap = document.getElementById("invScannerVideoWrap");
            if (videoWrap) videoWrap.classList.add("hidden");
            if (invHtml5Scanner) {
                try { await invHtml5Scanner.stop(); } catch (e) {}
                try { await invHtml5Scanner.clear(); } catch (e) {}
            }
            const region = document.getElementById("invScannerRegion");
            if (region) region.innerHTML = "";
        }

        function applyInvScanResult(code) {
            const val = normalizeBarcodeSearchInput(code) || String(code || "").trim();
            if (!val) return;
            invSearchText = val;
            const list = filterInventoryProducts(invProductsCache, invSearchText, invCatFilter);
            if (list.length === 1) {
                invScanBannerText = list[0].name + " · ژمارە: " + formatQty(list[0].qty);
            } else if (list.length > 1) {
                invScanBannerText = list.length + " ئایتم دۆزرایەوە بۆ «" + val + "»";
            } else {
                invScanBannerText = "هیچ ئایتمێک نەدۆزرایەوە بۆ «" + val + "»";
            }
            closeInvScanner();
            refreshInventoryView();
        }

        async function startBarcodeDetectorScan() {
            if (!("BarcodeDetector" in window)) return false;
            const videoWrap = document.getElementById("invScannerVideoWrap");
            const video = document.getElementById("invScannerVideo");
            const msg = document.getElementById("invScannerMsg");
            const region = document.getElementById("invScannerRegion");
            if (!video || !videoWrap) return false;
            if (region) region.innerHTML = "";
            videoWrap.classList.remove("hidden");
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: "environment" } }, audio: false
            });
            invDetectorStream = stream;
            video.srcObject = stream;
            await video.play();
            const detector = new BarcodeDetector({
                formats: ["ean_13", "ean_8", "code_128", "code_39", "upc_a", "upc_e", "qr_code", "codabar", "itf"]
            });
            if (msg) msg.textContent = "بارکۆد لە ناو چوارگۆشەکەدا بگرە";
            invScannerActive = true;
            const tick = async () => {
                if (!invScannerActive) return;
                try {
                    const codes = await detector.detect(video);
                    if (codes && codes.length && codes[0].rawValue) {
                        applyInvScanResult(codes[0].rawValue);
                        return;
                    }
                } catch (e) {}
                invDetectorLoop = requestAnimationFrame(() => { tick(); });
            };
            tick();
            return true;
        }

        async function startHtml5QrcodeScan() {
            const Html5Qrcode = await loadHtml5QrcodeLib();
            const region = document.getElementById("invScannerRegion");
            const msg = document.getElementById("invScannerMsg");
            if (!region) return;
            region.innerHTML = "";
            invHtml5Scanner = new Html5Qrcode("invScannerRegion");
            let cameras = [];
            try { cameras = await Html5Qrcode.getCameras(); } catch (e) {}
            let cam = { facingMode: "environment" };
            if (cameras && cameras.length) {
                const back = cameras.find((c) => /back|rear|environment|پشت/i.test(c.label || ""));
                cam = (back || cameras[cameras.length - 1]).id;
            }
            const formats = window.Html5QrcodeSupportedFormats
                ? [
                    Html5QrcodeSupportedFormats.EAN_13,
                    Html5QrcodeSupportedFormats.EAN_8,
                    Html5QrcodeSupportedFormats.CODE_128,
                    Html5QrcodeSupportedFormats.CODE_39,
                    Html5QrcodeSupportedFormats.UPC_A,
                    Html5QrcodeSupportedFormats.UPC_E,
                    Html5QrcodeSupportedFormats.QR_CODE
                ]
                : undefined;
            const config = {
                fps: 10,
                qrbox: (w, h) => ({ width: Math.min(280, w * 0.85), height: Math.min(140, h * 0.35) }),
                aspectRatio: 1.777
            };
            if (formats) config.formatsToSupport = formats;
            await invHtml5Scanner.start(
                cam,
                config,
                (decoded) => applyInvScanResult(decoded),
                () => {}
            );
            invScannerActive = true;
            if (msg) msg.textContent = "بارکۆد لە ناو چوارگۆشەکەدا بگرە";
        }

        async function openInvScanner() {
            switchMobileTab("inv");
            const modal = document.getElementById("invScannerModal");
            const msg = document.getElementById("invScannerMsg");
            if (!modal) return;
            await stopInvScanner();
            modal.classList.remove("hidden");
            modal.setAttribute("aria-hidden", "false");
            if (msg) msg.textContent = "چاوەڕێی کەمرا…";
            try {
                const ok = await startBarcodeDetectorScan();
                if (!ok) await startHtml5QrcodeScan();
            } catch (e) {
                if (msg) msg.textContent = "کەمرا نەکرایەوە — ڕێگەی کەمرا بدە یان بارکۆد بنووسە.";
            }
        }

        async function closeInvScanner() {
            await stopInvScanner();
            const modal = document.getElementById("invScannerModal");
            if (modal) {
                modal.classList.add("hidden");
                modal.setAttribute("aria-hidden", "true");
            }
        }

        function showRefreshToast(msg, isErr) {
            if (!refreshToast) return;
            refreshToast.textContent = msg || "";
            refreshToast.classList.toggle("err", !!isErr);
            refreshToast.classList.add("show");
            clearTimeout(refreshToastTimer);
            refreshToastTimer = setTimeout(function () { refreshToast.classList.remove("show"); }, 2200);
        }

        function applyDashboardData(d, opts) {
            opts = opts || {};
            setMobileAmountMeta(d);
            if (!d) {
                if (!opts.fromCache && !opts._cacheRetried && activeChannelId) {
                    mmSnapLoad(activeChannelId, "dashboard").then(function (snap) {
                        if (snap && snap.data) {
                            applyDashboardData(snap.data, {
                                silent: opts.silent,
                                fromCache: true,
                                savedAt: snap.savedAt
                            });
                        } else {
                            applyDashboardData(null, Object.assign({}, opts, { _cacheRetried: true }));
                        }
                    });
                    return;
                }
                kpiSales.textContent = formatMobileMoney(0);
                kpiExpenses.textContent = formatMobileMoney(0);
                kpiNet.textContent = formatMobileMoney(0);
                kpiInvoices.textContent = "0";
                mmApplyProfitPrivacyUi(false);
                metaEl.innerHTML = '<i class="fas fa-clock"></i> دوایین نوێکردنەوە: هێشتا داتا نییە';
                updateHomeSyncText("دوایین sync: هێشتا داتا نییە");
                const hNet0 = document.getElementById("homeNet");
                const hSales0 = document.getElementById("homeSales");
                if (hNet0) hNet0.textContent = formatMobileMoney(0);
                if (hSales0) hSales0.textContent = formatMobileMoney(0);
                if (!opts.silent) setStatus("چاوەڕێی یەکەم sync", false);
                mmSnapDashboard = null;
                return;
            }
            const priv = mmPrivacyFromDoc(d);
            mmUpdateShopBusinessMeta(d, { silent: opts.silent || opts.fromCache });
            mmApplyProfitPrivacyUi(priv.hideProfit);
            kpiSales.textContent = formatMoneyIqd(normalizeMobileIqd(d.salesToday));
            kpiExpenses.textContent = formatMoneyIqd(normalizeMobileIqd(d.expensesToday));
            kpiNet.textContent = priv.hideProfit ? MM_PRIVACY_HIDDEN : formatMoneyIqd(normalizeMobileIqd(d.netProfitToday));
            kpiInvoices.textContent = String(Number(d.invoicesCountToday || 0));
            let ts;
            if (opts.fromCache && opts.savedAt) {
                ts = new Date(opts.savedAt);
            } else {
                ts = d.updatedAt && d.updatedAt.toDate ? d.updatedAt.toDate() : new Date();
            }
            const syncPrefix = opts.fromCache && !navigator.onLine ? "cache · " : opts.fromCache ? "cache · " : "";
            const timeStr = mmFormatShopTime(ts, { withSeconds: true });
            const syncTxt = syncPrefix + "دوایین نوێکردنەوە: " + timeStr + " (دهۆک)";
            metaEl.innerHTML = '<i class="fas fa-clock"></i> ' + syncTxt;
            updateHomeSyncText((opts.fromCache ? "cache · " : "") + "دوایین sync: " + mmFormatShopTime(ts) + " (دهۆک)");
            const hNet = document.getElementById("homeNet");
            const hSales = document.getElementById("homeSales");
            if (hNet) hNet.textContent = priv.hideProfit ? MM_PRIVACY_HIDDEN : formatMoneyIqd(normalizeMobileIqd(d.netProfitToday));
            if (hSales) hSales.textContent = formatMoneyIqd(normalizeMobileIqd(d.salesToday));
            if (opts.fromCache) {
                mmNoteCacheSavedAt(opts.savedAt);
                mmUpdateConnectionStatus({ fromCache: true, savedAt: opts.savedAt });
            } else if (!opts.silent) {
                mmUpdateConnectionStatus({ live: true });
            }
            mmSnapDashboard = Object.assign({}, d);
            if (activeChannelId && !opts.fromCache) {
                mmSnapSaveDebounced(activeChannelId, "dashboard", d);
            }
        }

        function applyInventoryData(data, opts) {
            opts = opts || {};
            const invContent = document.getElementById("inventoryContent");
            const invMeta = document.getElementById("invMeta");
            const invWhBadge = document.getElementById("invWhBadge");
            const invWhName = document.getElementById("invWhName");
            const invInStock = document.getElementById("invInStock");
            const invLow = document.getElementById("invLow");
            const invOut = document.getElementById("invOut");
            const invStocktakeToday = document.getElementById("invStocktakeToday");
            const invStocktakeHint = document.getElementById("invStocktakeHint");
            if (!invContent) return;
            if (!data) {
                if (!opts.fromCache && !opts._cacheRetried && activeChannelId) {
                    mmSnapLoad(activeChannelId, "inventory").then(function (snap) {
                        if (snap && snap.data) {
                            applyInventoryData(snap.data, {
                                silent: opts.silent,
                                fromCache: true,
                                savedAt: snap.savedAt
                            });
                        } else {
                            applyInventoryData(null, Object.assign({}, opts, { _cacheRetried: true }));
                        }
                    });
                    return;
                }
                invDocSynced = false;
                invContent.innerHTML = '<div class="detail-empty">هێشتا داتای کۆگە نییە.<br><br>لە POS: ڕێکخستن → Firebase sync چالاک بکە، پاشان Ctrl+F5.<br>دوای ≈١٢ چرکە یان دوای جەرد/فرۆشتن داتا دێت.<br><br><button type="button" class="btn-ghost" onclick="document.getElementById(\'refreshBtn\')&&document.getElementById(\'refreshBtn\').click()" style="margin-top:8px;width:100%;"><i class="fas fa-arrows-rotate"></i> Refresh</button></div>';
                if (invMeta) invMeta.textContent = "کۆگە · جەرد";
                if (invWhBadge) invWhBadge.classList.add("hidden");
                mmSnapInvSummary = null;
                return;
            }
            invDocSynced = true;
            if (opts.fromCache) mmNoteCacheSavedAt(opts.savedAt);
            mmUpdateShopBusinessMeta(data, { silent: true });
            setMobileAmountMeta(data);
            const summary = data.summary || {};
            const meta = data.meta || {};
            const products = Array.isArray(data.products) ? data.products : [];
            const categories = Array.isArray(data.categories) ? data.categories : [];
            const sessions = Array.isArray(data.stocktakeSessions) ? data.stocktakeSessions : [];
            const recent = Array.isArray(data.recentStocktakes) ? data.recentStocktakes : [];
            if (invInStock) invInStock.textContent = String(Number(summary.inStock || 0));
            if (invLow) invLow.textContent = String(Number(summary.lowStock || 0));
            if (invOut) invOut.textContent = String(Number(summary.outOfStock || 0));
            const homeInvStock = document.getElementById("homeInvStock");
            const homeInvOut = document.getElementById("homeInvOut");
            if (homeInvStock) homeInvStock.textContent = String(Number(summary.inStock || 0));
            if (homeInvOut) homeInvOut.textContent = String(Number(summary.outOfStock || 0));
            if (invStocktakeToday) invStocktakeToday.textContent = String(Number(summary.stocktakeCountToday || 0));
            if (invStocktakeHint) invStocktakeHint.textContent = "کۆی گشتی: " + String(Number(summary.stocktakeCountTotal || 0));
            if (invWhName) invWhName.textContent = summary.warehouseName || "کۆگە";
            if (invWhBadge) invWhBadge.classList.remove("hidden");
            if (invMeta) {
                invMeta.textContent = (opts.fromCache ? "cache · " : "") + "هەموو ئایتم · " + String(Number(summary.totalTracked || products.length || 0)) +
                    (meta.truncatedProducts ? " · بەشێک لە لیست" : "");
            }
            invProductsCache = products.slice();
            invCategoriesCache = categories.slice();
            invSessionsCache = sessions;
            invRecentCache = recent;
            mmSnapInvSummary = Object.assign({}, summary);
            refreshInventoryView();
            bindInventoryFilters();
            bindInvSubTabs();
            if (data.debtSnapshot && (data.debtSnapshot.summary || data.debtSnapshot.companies || data.debtSnapshot.customers)) {
                applyDebtData(data.debtSnapshot, { silent: true, fromCache: opts.fromCache, savedAt: opts.savedAt });
            }
            if (activeChannelId && !opts.fromCache) {
                mmSnapSaveDebounced(activeChannelId, "inventory", data);
            }
        }

        function applyDetailData(data, dayKey, opts) {
            opts = opts || {};
            const detailCard = document.getElementById("detailCard");
            const detailContent = document.getElementById("detailContent");
            const detailMeta = document.getElementById("detailMeta");
            if (!detailCard || !detailContent) return;
            detailCard.classList.remove("hidden");
            if (!data) {
                if (!opts.fromCache && !opts._cacheRetried && activeChannelId && dayKey) {
                    mmSnapLoad(activeChannelId, mmSnapDetailType(dayKey)).then(function (snap) {
                        if (snap && snap.data) {
                            applyDetailData(snap.data, dayKey, {
                                silent: opts.silent,
                                fromCache: true,
                                savedAt: snap.savedAt
                            });
                        } else {
                            applyDetailData(null, dayKey, Object.assign({}, opts, { _cacheRetried: true }));
                        }
                    });
                    return;
                }
                detailContent.innerHTML = '<div class="detail-empty">هێشتا وردەکاری نییە. لە لاپتۆپ «ئێستا هاوکات بکە» بکە.</div>';
                if (detailMeta) detailMeta.textContent = "ڕۆژ: " + dayKey;
                mmSnapDetail = null;
                mmSnapDetailDayKey = dayKey;
                return;
            }
            if (opts.fromCache) mmNoteCacheSavedAt(opts.savedAt);
            mmUpdateShopBusinessMeta(data, { silent: true });
            const meta = data.meta || {};
            const priv = mmPrivacyFromDoc(data);
            setMobileAmountMeta(data);
            const sales = priv.hideSalesDetail ? [] : (Array.isArray(data.sales) ? data.sales : []);
            const ret = Array.isArray(data.returns) ? data.returns : [];
            const exp = Array.isArray(data.expenses) ? data.expenses : [];
            const purchases = Array.isArray(data.purchases) ? data.purchases : [];
            if (detailMeta) {
                detailMeta.textContent = (opts.fromCache ? "cache · " : "") + "ڕۆژ: " + (meta.businessDate || dayKey) + (meta.truncatedSales ? " · بەشێک لە پسوولەکان" : "");
            }
            let html = "";
            html += '<div class="detail-h purchases"><i class="fas fa-truck"></i> کڕین (' + purchases.length + ")</div>";
            if (!purchases.length) html += '<div class="detail-empty">—</div>';
            else purchases.slice(0, 100).forEach((p) => {
                html += '<div class="line-row purchase-row"><span><strong>' + esc(p.invoiceNo || "—") + '</strong><span class="purchase-co"> · ' + esc(p.company || "—") + "</span></span><span class=\"amt purchase\">" + formatMoneyIqd(normalizeMobileIqd(p.total)) + "</span></div>";
            });
            html += '<div class="detail-h sales"><i class="fas fa-receipt"></i> فرۆشتن (' + (priv.hideSalesDetail ? "—" : sales.length) + ")</div>";
            if (priv.hideSalesDetail) {
                html += '<div class="detail-empty mm-privacy-note"><i class="fas fa-eye-slash"></i> وردەکاری فرۆشتن شاردراوە لە ڕێکخستنەکانی POS</div>';
            } else if (!sales.length) html += '<div class="detail-empty">—</div>';
            else {
                sales.forEach((s) => {
                    const itemsArr = groupSaleLineItems(Array.isArray(s.items) ? s.items : []);
                    let itemsHtml = "";
                    if (itemsArr.length) {
                        itemsHtml = '<div class="sale-items">';
                        itemsArr.forEach((it) => {
                            itemsHtml += '<div class="sale-item"><span>' + esc(formatQty(it.qty)) + "× " + esc(it.name) + '</span><span class="price">' + formatMoneyIqd(normalizeMobileIqd(it.price)) + "</span></div>";
                        });
                        itemsHtml += "</div>";
                    }
                    html += '<div class="sale-card"><div class="sale-card-top"><span class="sale-id">#' + esc(s.id) + '</span><span class="sale-total">' + formatMoneyIqd(normalizeMobileIqd(s.total)) + "</span></div>" +
                        '<div class="sale-meta"><span><i class="fas fa-user"></i> ' + esc(s.cashier || "کاشێر") + '</span><span><i class="fas fa-money-bill"></i> ' + esc(s.payment_method || "نەقد") + "</span></div>" +
                        itemsHtml + "</div>";
                });
            }
            html += '<div class="detail-h returns"><i class="fas fa-rotate-left"></i> گەڕانەوە (' + ret.length + ")</div>";
            if (!ret.length) html += '<div class="detail-empty">—</div>';
            else ret.slice(0, 100).forEach((r) => {
                html += '<div class="line-row"><span><strong>#' + esc(r.id) + "</strong></span><span class=\"amt\">" + formatMoneyIqd(normalizeMobileIqd(r.total)) + "</span></div>";
            });
            html += '<div class="detail-h expenses"><i class="fas fa-coins"></i> مەسرەف (' + exp.length + ")</div>";
            if (!exp.length) html += '<div class="detail-empty">—</div>';
            else exp.slice(0, 100).forEach((e) => {
                html += '<div class="line-row"><span>' + esc(e.type || "") + " " + esc(e.note || "") + '</span><span class="amt">' + formatMoneyIqd(normalizeMobileIqd(e.amount)) + "</span></div>";
            });
            detailContent.innerHTML = html;
            mmSnapDetail = {
                sales: priv.hideSalesDetail ? [] : sales.slice(),
                returns: ret.slice(),
                expenses: exp.slice(),
                purchases: purchases.slice(),
                privacy: Object.assign({}, priv),
                meta: Object.assign({}, meta)
            };
            mmSnapDetailDayKey = dayKey;
            if (activeChannelId && !opts.fromCache) {
                mmSnapSaveDebounced(activeChannelId, mmSnapDetailType(dayKey), data);
            }
        }

        async function mmExportTodayPdfReport() {
            if (!activeChannelId) {
                showRefreshToast("سەرەتا چوونەژوورەوە بکە", true);
                return;
            }
            const pdfBtn = document.getElementById("mmPdfTodayBtn");
            const homePdfBtn = document.getElementById("homeGoPdf");
            if (pdfBtn) { pdfBtn.disabled = true; pdfBtn.classList.add("spinning"); }
            if (homePdfBtn) homePdfBtn.disabled = true;
            try {
                if (navigator.onLine && !refreshBusy) {
                    await manualRefreshAll({ silent: true });
                }
                if (!mmSnapDashboard) {
                    showRefreshToast("هێشتا داتا نییە — Refresh بکە", true);
                    return;
                }
                const acc = mmAccountByEmail(activeChannelId);
                mmPrintTodaySummary({
                    shopLabel: mmShopLabel(acc || { email: activeChannelId }),
                    shopEmail: activeChannelId,
                    dayKey: mmSnapDetailDayKey || getMobileBusinessDayKey(),
                    dashboard: mmSnapDashboard,
                    detail: mmSnapDetail || {},
                    privacy: mmPrivacyFromDoc(Object.assign({}, mmSnapDashboard || {}, mmSnapDetail || {})),
                    inv: mmSnapInvSummary || {},
                    debt: mmSnapDebtSummary || {},
                    currency: getMobileDisplayCurrency(),
                    version: window.MM_APP_VERSION || "",
                    formatMoney: formatMoneyIqd,
                    esc: esc
                });
                showRefreshToast("PDF ئامادەیە — Print / Save as PDF", false);
            } catch (e) {
                showRefreshToast("PDF سەرنەکەوت", true);
            } finally {
                if (pdfBtn) { pdfBtn.disabled = false; pdfBtn.classList.remove("spinning"); }
                if (homePdfBtn) homePdfBtn.disabled = false;
            }
        }

        async function manualRefreshAll(opts) {
            opts = opts || {};
            if (!activeChannelId || refreshBusy) return;
            refreshBusy = true;
            if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.classList.add("spinning"); }
            const dayKey = getMobileBusinessDayKey();
            if (!navigator.onLine) {
                try {
                    const hydrated = await mmHydrateFromLocalStore(activeChannelId, dayKey);
                    await mmHydrateHubsFromLocalStore();
                    mmUpdateConnectionStatus({ fromCache: true, savedAt: mmLastCacheSavedAt });
                    if (!opts.silent) {
                        showRefreshToast(hydrated ? "ئۆفلاین — دوایین داتا ✓" : "ئۆفلاین — هیچ cache نییە", !hydrated);
                    }
                } catch (e) {
                    if (!opts.silent) showRefreshToast("ئۆفلاین — cache سەرنەکەوت", true);
                } finally {
                    refreshBusy = false;
                    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.classList.remove("spinning"); }
                }
                return;
            }
            try {
                const readDoc = opts.forceServer ? getDocFromServer : getDoc;
                const snaps = await Promise.all([
                    readDoc(doc(db, "pos_mobile_dashboard", activeChannelId)),
                    readDoc(doc(db, "pos_mobile_inventory", activeChannelId)),
                    readDoc(doc(db, "pos_mobile_debt", activeChannelId)),
                    readDoc(doc(db, "pos_mobile_daily_detail", activeChannelId, "days", dayKey))
                ]);
                applyDashboardData(snaps[0].exists() ? snaps[0].data() : null, { silent: true });
                applyInventoryData(snaps[1].exists() ? snaps[1].data() : null, { silent: true });
                applyDebtData(snaps[2].exists() ? snaps[2].data() : null, { silent: true });
                applyDetailData(snaps[3].exists() ? snaps[3].data() : null, dayKey, { silent: true });
                if (opts.forceServer) await mmRefreshAllHubs();
                mmUpdateConnectionStatus({ live: true });
                if (!opts.silent) showRefreshToast("داتا نوێکرایەوە ✓", false);
            } catch (e) {
                const hydrated = await mmHydrateFromLocalStore(activeChannelId, dayKey);
                if (hydrated) {
                    mmUpdateConnectionStatus({ fromCache: true, savedAt: mmLastCacheSavedAt });
                    if (!opts.silent) showRefreshToast("cache — server نەگەیشت", true);
                } else {
                    setStatus("هەڵەی Firebase", false);
                    if (!opts.silent) showRefreshToast("Refresh سەرنەکەوت", true);
                }
            } finally {
                refreshBusy = false;
                if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.classList.remove("spinning"); }
            }
        }

        function setupPullToRefresh() {
            const shell = document.querySelector(".app-shell");
            if (!shell || !ptrIndicator) return;
            let startY = 0;
            let pulling = false;
            shell.addEventListener("touchstart", function (e) {
                if (!activeChannelId || window.scrollY > 8) return;
                if (e.touches && e.touches[0]) { startY = e.touches[0].clientY; pulling = true; }
            }, { passive: true });
            shell.addEventListener("touchmove", function (e) {
                if (!pulling || !e.touches || !e.touches[0]) return;
                const dy = e.touches[0].clientY - startY;
                ptrIndicator.classList.toggle("visible", dy > 70 && window.scrollY <= 8);
            }, { passive: true });
            shell.addEventListener("touchend", function () {
                if (ptrIndicator.classList.contains("visible")) {
                    ptrIndicator.classList.remove("visible");
                    manualRefreshAll({ silent: false, forceServer: navigator.onLine });
                }
                pulling = false;
            }, { passive: true });
        }

        function bindInventory(channelId) {
            if (unsubInventory) { unsubInventory(); unsubInventory = null; }
            invChannelId = channelId || "";
            loadInvCatFilter();
            const invCard = document.getElementById("inventoryCard");
            const invContent = document.getElementById("inventoryContent");
            if (!invCard || !invContent) return;

            const iref = doc(db, "pos_mobile_inventory", channelId);
            unsubInventory = onSnapshot(iref, (snap) => {
                applyInventoryData(snap.exists() ? snap.data() : null, {
                    silent: snap.metadata.fromCache,
                    fromCache: snap.metadata.fromCache
                });
                if (snap.metadata.fromCache) {
                    mmUpdateConnectionStatus({ fromCache: true, savedAt: mmLastCacheSavedAt });
                } else if (snap.exists()) {
                    mmUpdateConnectionStatus({ live: true });
                }
            }, () => {
                invContent.innerHTML = '<div class="detail-empty" style="color:#fca5a5;">نەتوانرا کۆگە بخوێنرێتەوە — Firestore Rules.<br><br>' +
                    '<strong>چارەسەر:</strong> Firebase Console → Firestore → Rules<br>' +
                    'ئەم blockـە زیاد بکە (وەک dashboard):<br>' +
                    '<code style="display:block;font-size:0.68rem;word-break:break-all;margin:8px 0;padding:8px;background:rgba(0,0,0,.2);border-radius:8px;">match /pos_mobile_inventory/{channelId} {<br>&nbsp;&nbsp;allow read, write: if request.auth != null &amp;&amp; request.auth.token.email.lower() == channelId;<br>}</code>' +
                    'پاشان <strong>Publish</strong> → لە POS «ئێستا هاوکات بکە».</div>';
            });
        }

        function bindDetail(channelId) {
            if (unsubDetail) { unsubDetail(); unsubDetail = null; }
            const dayKey = getMobileBusinessDayKey();
            mmDetailBindDayKey = dayKey;
            const dref = doc(db, "pos_mobile_daily_detail", channelId, "days", dayKey);
            const detailCard = document.getElementById("detailCard");
            const detailContent = document.getElementById("detailContent");
            const detailMeta = document.getElementById("detailMeta");
            if (!detailCard || !detailContent) return;

            unsubDetail = onSnapshot(dref, (snap) => {
                applyDetailData(snap.exists() ? snap.data() : null, dayKey, {
                    silent: snap.metadata.fromCache,
                    fromCache: snap.metadata.fromCache
                });
                if (snap.metadata.fromCache) {
                    mmUpdateConnectionStatus({ fromCache: true, savedAt: mmLastCacheSavedAt });
                } else if (snap.exists()) {
                    mmUpdateConnectionStatus({ live: true });
                }
            }, () => {
                detailContent.innerHTML = '<div class="detail-empty" style="color:#fca5a5;">نەتوانرا وردەکاری بخوێنرێتەوە (Firestore rules).</div>';
            });
        }

        function bindDashboard(channelId) {
            if (unsub) unsub();
            const ref = doc(db, "pos_mobile_dashboard", channelId);
            unsub = onSnapshot(ref, (snap) => {
                applyDashboardData(snap.exists() ? snap.data() : null, {
                    silent: snap.metadata.fromCache,
                    fromCache: snap.metadata.fromCache
                });
                if (snap.metadata.fromCache) {
                    mmUpdateConnectionStatus({ fromCache: true, savedAt: mmLastCacheSavedAt });
                } else if (snap.exists()) {
                    mmUpdateConnectionStatus({ live: true });
                }
            }, () => setStatus("هەڵەی Firebase", false));
        }

        async function doLogin() {
            const email = (emailEl.value || "").trim().toLowerCase();
            const password = passEl.value || "";
            if (!email || !password) {
                authMsg.textContent = "ئیمێیل و تێپەڕەوشە بنووسە.";
                return;
            }
            const domain = email.split("@")[1] || "";
            if (!domain.includes(".") || domain === "0") {
                authMsg.textContent = "ئیمێیل هەڵەیە («" + email + "»). دەبێت وەک hakar01@pos.laptopduhok.com بێت — لە کارتێکی دروستکراو بەکاربهێنە.";
                return;
            }
            authMsg.textContent = "چاوەڕێ بکە…";
            try {
                await signInWithEmailAndPassword(auth, email, password);
                const upsert = mmUpsertAccount(email, password, "");
                if (upsert.ok) {
                    mmSetActiveEmail(email);
                    await mmStartHubForAccount(upsert.acc);
                }
                authMsg.textContent = "";
            } catch (e) {
                let msg = e && e.message ? e.message : "Unknown error";
                if (/auth\/unauthorized-domain/i.test(msg) || /unauthorized-domain/i.test(msg)) {
                    msg = "دۆمەین ڕێگەپێدراو نییە — لە Firebase → Authorized domains زیاد بکە: laptopduhokpos.github.io";
                }
                authMsg.textContent = "چوونەژوورەوە سەرنەکەوت: " + msg;
            }
        }

        const themeBtn = document.getElementById("themeToggleBtn");
        const themeIcon = document.getElementById("themeIcon");
        function updateThemeIcon() {
            const isLight = document.documentElement.getAttribute("data-theme") === "light";
            themeIcon.className = isLight ? "fas fa-moon" : "fas fa-sun";
            themeIcon.style.color = isLight ? "#2563eb" : "#fbbf24";
        }
        updateThemeIcon();
        themeBtn.addEventListener("click", () => {
            const newTheme = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
            if (newTheme === "light") document.documentElement.setAttribute("data-theme", "light");
            else document.documentElement.removeAttribute("data-theme");
            localStorage.setItem("pos_mobile_theme", newTheme);
            updateThemeIcon();
        });

        document.getElementById("authForm").addEventListener("submit", (ev) => { ev.preventDefault(); doLogin(); });
        if (tabHomeBtn) tabHomeBtn.addEventListener("click", () => switchMobileTab("home"));
        if (tabDashBtn) tabDashBtn.addEventListener("click", () => switchMobileTab("dash"));
        if (tabInvBtn) tabInvBtn.addEventListener("click", () => switchMobileTab("inv"));
        if (tabDebtBtn) tabDebtBtn.addEventListener("click", () => switchMobileTab("debt"));
        const homeGoDash = document.getElementById("homeGoDash");
        const homeGoInv = document.getElementById("homeGoInv");
        const homeGoDebt = document.getElementById("homeGoDebt");
        if (homeGoDash) homeGoDash.addEventListener("click", () => switchMobileTab("dash"));
        if (homeGoInv) homeGoInv.addEventListener("click", () => switchMobileTab("inv"));
        if (homeGoDebt) homeGoDebt.addEventListener("click", () => switchMobileTab("debt"));
        const homeGoBackup = document.getElementById("homeGoBackup");
        if (homeGoBackup) homeGoBackup.addEventListener("click", () => switchMobileTab("backup"));
        const homeGoPdf = document.getElementById("homeGoPdf");
        if (homeGoPdf) homeGoPdf.addEventListener("click", () => mmExportTodayPdfReport());
        const mmPdfTodayBtn = document.getElementById("mmPdfTodayBtn");
        if (mmPdfTodayBtn) mmPdfTodayBtn.addEventListener("click", () => mmExportTodayPdfReport());
        document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth));
        const logoutBtnHome = document.getElementById("logoutBtnHome");
        if (logoutBtnHome) logoutBtnHome.addEventListener("click", () => signOut(auth));
        const mmAddShopBtn = document.getElementById("mmAddShopBtn");
        const mmManageShopsBtn = document.getElementById("mmManageShopsBtn");
        const mmShopModalClose = document.getElementById("mmShopModalClose");
        const mmShopModal = document.getElementById("mmShopModal");
        if (mmAddShopBtn) mmAddShopBtn.addEventListener("click", mmOpenAddShopModal);
        if (mmManageShopsBtn) mmManageShopsBtn.addEventListener("click", mmOpenManageShopsModal);
        if (mmShopModalClose) mmShopModalClose.addEventListener("click", mmCloseShopModal);
        if (mmShopModal) {
            mmShopModal.addEventListener("click", function (e) {
                if (e.target === mmShopModal) mmCloseShopModal();
            });
        }
        mmLoadAccounts();
        mmRenderSavedAuthList();
        async function copyUserEmail() {
            const txt = auth.currentUser && auth.currentUser.email ? auth.currentUser.email : "";
            try { await navigator.clipboard.writeText(txt); }
            catch (_) { window.prompt("ئیمێیل کۆپی بکە:", txt); }
        }
        document.getElementById("copyEmailBtn").addEventListener("click", copyUserEmail);
        const copyEmailBtnHome = document.getElementById("copyEmailBtnHome");
        if (copyEmailBtnHome) copyEmailBtnHome.addEventListener("click", copyUserEmail);

        const invScanBtn = document.getElementById("invScanBtn");
        if (invScanBtn) invScanBtn.addEventListener("click", () => openInvScanner());
        const invScannerClose = document.getElementById("invScannerClose");
        if (invScannerClose) invScannerClose.addEventListener("click", () => closeInvScanner());
        const invScannerModal = document.getElementById("invScannerModal");
        if (invScannerModal) {
            invScannerModal.addEventListener("click", (e) => {
                if (e.target === invScannerModal) closeInvScanner();
            });
        }

        let deferredInstallPrompt = null;
        const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent || "");
        const isAndroid = /android/i.test(navigator.userAgent || "");
        const isMobileUa = isIos || isAndroid || /mobile/i.test(navigator.userAgent || "");
        const isStandalone =
            window.matchMedia("(display-mode: standalone)").matches ||
            window.navigator.standalone === true;

        function mmOpenInstallHelp() {
            const cardAuth = document.getElementById("installCardAuth");
            const cardHome = document.getElementById("installCardHome");
            if (cardAuth && authCard && !authCard.classList.contains("hidden")) {
                cardAuth.scrollIntoView({ behavior: "smooth", block: "center" });
                return;
            }
            if (cardHome) {
                cardHome.classList.remove("hidden");
                cardHome.scrollIntoView({ behavior: "smooth", block: "center" });
            }
        }

        function mmRefreshInstallBar() {
            const bar = document.getElementById("mmInstallBar");
            if (!bar) return;
            if (isStandalone || !isMobileUa) {
                bar.classList.add("hidden");
                return;
            }
            bar.classList.remove("hidden");
        }

        function setupInstallUi() {
            const cardAuth = document.getElementById("installCardAuth");
            const cardHome = document.getElementById("installCardHome");
            const iosAuth = document.getElementById("installStepsIosAuth");
            const androidAuth = document.getElementById("installStepsAndroidAuth");
            const btnAuth = document.getElementById("installBtnAuth");
            const btnHome = document.getElementById("installBtnHome");
            const barBtn = document.getElementById("mmInstallBarBtn");

            if (isStandalone) {
                if (cardAuth) cardAuth.classList.add("hidden");
                if (cardHome) cardHome.classList.add("hidden");
                mmRefreshInstallBar();
                return;
            }
            if (cardAuth) cardAuth.classList.remove("hidden");
            if (cardHome) cardHome.classList.remove("hidden");
            if (isIos) {
                if (iosAuth) iosAuth.classList.remove("hidden");
                if (androidAuth) androidAuth.classList.add("hidden");
            } else {
                if (androidAuth) androidAuth.classList.remove("hidden");
                if (iosAuth) iosAuth.classList.add("hidden");
            }

            async function runInstall() {
                if (deferredInstallPrompt) {
                    deferredInstallPrompt.prompt();
                    try { await deferredInstallPrompt.userChoice; } catch (e) {}
                    deferredInstallPrompt = null;
                    if (btnAuth) btnAuth.classList.add("hidden");
                    if (btnHome) btnHome.classList.add("hidden");
                    mmRefreshInstallBar();
                    return;
                }
                mmOpenInstallHelp();
            }
            if (btnAuth) btnAuth.addEventListener("click", runInstall);
            if (btnHome) btnHome.addEventListener("click", runInstall);
            if (barBtn) barBtn.addEventListener("click", runInstall);
            mmRefreshInstallBar();
        }

        window.addEventListener("beforeinstallprompt", (e) => {
            e.preventDefault();
            deferredInstallPrompt = e;
            const btnAuth = document.getElementById("installBtnAuth");
            const btnHome = document.getElementById("installBtnHome");
            const androidAuth = document.getElementById("installStepsAndroidAuth");
            if (btnAuth) btnAuth.classList.remove("hidden");
            if (btnHome) btnHome.classList.remove("hidden");
            if (androidAuth) androidAuth.classList.add("hidden");
            mmRefreshInstallBar();
        });

        window.addEventListener("appinstalled", function () {
            deferredInstallPrompt = null;
            mmRefreshInstallBar();
            const cardAuth = document.getElementById("installCardAuth");
            const cardHome = document.getElementById("installCardHome");
            if (cardAuth) cardAuth.classList.add("hidden");
            if (cardHome) cardHome.classList.add("hidden");
        });

        bindInvDateFilters();
        setupInstallUi();
        setupPullToRefresh();
        setInterval(function () {
            if (!activeChannelId) return;
            const nextDay = getMobileBusinessDayKey();
            if (mmDetailBindDayKey && nextDay !== mmDetailBindDayKey) {
                bindDetail(activeChannelId);
            }
        }, 60000);

        if (refreshBtn) {
            refreshBtn.addEventListener("click", function () { manualRefreshAll({ silent: false, forceServer: true }); });
        }
        const dashRefreshBtn = document.getElementById("dashRefreshBtn");
        if (dashRefreshBtn) {
            dashRefreshBtn.addEventListener("click", function () { manualRefreshAll({ silent: false, forceServer: true }); });
        }
        window.addEventListener("online", function () {
            if (activeChannelId) {
                mmUpdateConnectionStatus({ live: true });
                manualRefreshAll({ silent: true });
            }
        });
        window.addEventListener("offline", function () {
            if (activeChannelId) mmUpdateConnectionStatus({ fromCache: true, savedAt: mmLastCacheSavedAt });
        });
        document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "visible" && activeChannelId && !refreshBusy) {
                if (!navigator.onLine) {
                    mmHydrateFromLocalStore(activeChannelId, getMobileBusinessDayKey());
                    mmHydrateHubsFromLocalStore();
                } else {
                    manualRefreshAll({ silent: true });
                }
            }
        });

        function mmRegisterServiceWorker() {
            if (!("serviceWorker" in navigator)) return;
            var ver = String(window.MM_APP_VERSION || "1");
            var swUrl = "./sw.js?v=" + encodeURIComponent(ver);
            navigator.serviceWorker.register(swUrl, { scope: "./", updateViaCache: "none" })
                .then(function (reg) {
                    function tryActivateUpdate() {
                        if (!reg.waiting) return;
                        reg.waiting.postMessage({ type: "SKIP_WAITING" });
                        showRefreshToast("وەشانی نوێ دامەزرا — refresh…", false);
                        setTimeout(function () { location.reload(); }, 400);
                    }
                    reg.addEventListener("updatefound", function () {
                        var nw = reg.installing;
                        if (!nw) return;
                        nw.addEventListener("statechange", function () {
                            if (nw.state === "installed" && navigator.serviceWorker.controller) {
                                tryActivateUpdate();
                            }
                        });
                    });
                    tryActivateUpdate();
                    setInterval(function () { reg.update().catch(function () {}); }, 5 * 60 * 1000);
                })
                .catch(function () {});
            navigator.serviceWorker.addEventListener("controllerchange", function () {
                if (window._mmSwReloading) return;
                window._mmSwReloading = true;
                location.reload();
            });
        }
        mmRegisterServiceWorker();

        const appShell = document.getElementById("appShell");

        onAuthStateChanged(auth, async (user) => {
            if (mmSwitchingShop && !user) return;
            if (!user || !user.email) {
                activeChannelId = "";
                mmHasLocalCache = false;
                mmLastCacheSavedAt = null;
                if (appShell) appShell.classList.remove("is-logged-in");
                if (refreshBtn) refreshBtn.classList.add("hidden");
                if (unsub) { unsub(); unsub = null; }
                if (unsubDetail) { unsubDetail(); unsubDetail = null; }
                if (unsubInventory) { unsubInventory(); unsubInventory = null; }
                if (unsubDebt) { unsubDebt(); unsubDebt = null; }
                if (panelBackup) panelBackup.classList.add("hidden");
                const detailCard = document.getElementById("detailCard");
                if (detailCard) detailCard.classList.add("hidden");
                if (panelInv) panelInv.classList.add("hidden");
                if (panelDebt) panelDebt.classList.add("hidden");
                if (panelHome) panelHome.classList.add("hidden");
                if (bottomNav) bottomNav.classList.add("hidden");
                authCard.classList.remove("hidden");
                dashboard.classList.add("hidden");
                setStatus("پەیوەست نییە", false);
                return;
            }
            authCard.classList.add("hidden");
            dashboard.classList.remove("hidden");
            mmRefreshInstallBar();
            if (appShell) appShell.classList.add("is-logged-in");
            if (bottomNav) bottomNav.classList.remove("hidden");
            const homeEmail = document.getElementById("homeEmail");
            if (homeEmail) homeEmail.textContent = user.email;
            const savedTab = (function () { try { return localStorage.getItem("pos_mobile_tab") || "home"; } catch (e) { return "home"; } })();
            switchMobileTab(savedTab === "backup" ? "backup" : savedTab === "debt" ? "debt" : savedTab === "inv" ? "inv" : savedTab === "dash" ? "dash" : "home");
            const channelId = user.email.toLowerCase();
            activeChannelId = channelId;
            mmLoadCachedBusinessMeta(channelId);
            const dayKey = getMobileBusinessDayKey();
            await mmHydrateFromLocalStore(channelId, dayKey);
            await mmHydrateHubsFromLocalStore();
            mmSetActiveEmail(channelId);
            if (passEl && passEl.value) {
                const upsertLive = mmUpsertAccount(channelId, passEl.value, "");
                if (upsertLive.ok) mmStartHubForAccount(upsertLive.acc);
            }
            mmStartAllHubs();
            if (refreshBtn) refreshBtn.classList.remove("hidden");
            bindDashboard(channelId);
            bindDetail(channelId);
            bindInventory(channelId);
            bindDebt(channelId);
            bindBackups(channelId);
        });

        (function mmTryAutoLogin() {
            mmLoadAccounts();
            if (!mmAccounts.length || auth.currentUser) return;
            const target = mmAccountByEmail(mmGetActiveEmail()) || mmAccounts[0];
            if (!target) return;
            signInWithEmailAndPassword(auth, target.email, mmDecodeSecret(target.passEnc)).catch(function () {});
        })();
