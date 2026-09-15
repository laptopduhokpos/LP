import { initializeApp, getApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
        import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
        import {
            initializeFirestore,
            persistentLocalCache,
            persistentMultipleTabManager,
            getFirestore,
            doc,
            onSnapshot,
            getDoc,
            getDocFromServer,
            setDoc,
            updateDoc
        } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
        import { getStorage, ref as storageRef, getBlob, getStream, deleteObject } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
        import { mmPrintTodaySummary } from "./mm-pdf-report.js?v=2.18.13";
        import {
            mmSnapSave,
            mmSnapSaveDebounced,
            mmSnapLoad,
            mmSnapLoadBundle,
            mmSnapLoadHubBundle,
            mmSnapDetailType
        } from "./mm-snapshot-store.js?v=2.18.13";

        const firebaseConfig = window.POS_FIREBASE_CONFIG || {};
        if (!firebaseConfig.apiKey) {
            const m = document.getElementById("authMsg");
            if (m) m.textContent = "Firebase apiKey نییە.";
            throw new Error("Missing Firebase apiKey");
        }

        const app = initializeApp(firebaseConfig);
        const auth = getAuth(app);
        setPersistence(auth, browserLocalPersistence).catch(function () {});
        const storage = getStorage(app);
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
                state.status = state.dash || state.inv ? "ok" : "warn";
                mmRenderShopsHub();
                setTimeout(function () {
                    if (!navigator.onLine) return;
                    Promise.all([
                        getDocFromServer(dashRef).catch(function () { return null; }),
                        getDocFromServer(invRef).catch(function () { return null; })
                    ]).then(function (pair) {
                        if (pair[0]) mmApplyHubDash(state, pair[0].exists() ? pair[0].data() : null);
                        if (pair[1]) mmApplyHubInv(state, pair[1].exists() ? pair[1].data() : null);
                        mmRenderShopsHub();
                    });
                }, 2500);
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
        let mmBackupCleaning = false;
        let mmBackupBlobCache = null;
        let mmBackupBlobCacheKey = "";
        let mmBackupPrefetchPromise = null;
        const mmBackupCleanedChannels = Object.create(null);

        function mmSortBackupItems(items) {
            return (items || []).slice().sort(function (a, b) {
                return (Number(b.uploadedAt) || 0) - (Number(a.uploadedAt) || 0);
            });
        }

        function mmCleanupOldCloudBackups(channelId, items) {
            const sorted = mmSortBackupItems(items);
            if (sorted.length <= 1) return Promise.resolve(sorted.slice(0, 1));
            if (mmBackupCleaning) return Promise.resolve(sorted.slice(0, 1));
            mmBackupCleaning = true;
            const latest = sorted[0];
            const old = sorted.slice(1);
            const metaRef = doc(db, "pos_mobile_backups", channelId);
            const jobs = old.map(function (x) {
                if (!x || !x.name) return Promise.resolve();
                const p = x.path || ("pos_mobile_backups/" + channelId + "/" + x.name);
                return deleteObject(storageRef(storage, p)).catch(function () {});
            });
            return Promise.all(jobs)
                .then(function () {
                    return setDoc(
                        metaRef,
                        { items: [latest], latest: latest, updatedAt: Date.now() },
                        { merge: true }
                    );
                })
                .then(function () { return [latest]; })
                .catch(function () { return [latest]; })
                .finally(function () { mmBackupCleaning = false; });
        }

        function mmApplyBackupList(channelId, items) {
            const sorted = mmSortBackupItems(items);
            const one = sorted.slice(0, 1);
            renderCloudBackupList(one);
            if (sorted.length > 1 && !mmBackupCleanedChannels[channelId] && !mmBackupCleaning) {
                mmBackupCleanedChannels[channelId] = true;
                mmCleanupOldCloudBackups(channelId, sorted).then(function (cleaned) {
                    renderCloudBackupList(cleaned);
                });
            }
        }
        let unsubBackup = null;
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
        const panelEntry = document.getElementById("panelEntry");
        const panelInv = document.getElementById("panelInv");
        const panelDebt = document.getElementById("panelDebt");
        const panelBackup = document.getElementById("panelBackup");
        const panelFollowup = document.getElementById("panelFollowup");
        const bottomNav = document.getElementById("bottomNav");
        const tabHomeBtn = document.getElementById("tabHome");
        const tabDashBtn = document.getElementById("tabDash");
        const tabEntryBtn = document.getElementById("tabEntry");
        const tabInvBtn = document.getElementById("tabInv");
        const tabDebtBtn = document.getElementById("tabDebt");

        function setTabActive(btn, on) {
            if (!btn) return;
            btn.classList.toggle("active", on);
            btn.setAttribute("aria-pressed", on ? "true" : "false");
        }

        function switchMobileTab(tab) {
            let t = tab === "backup" ? "backup" : tab === "followup" ? "followup" : tab === "debt" ? "debt" : tab === "inv" ? "inv" : tab === "dash" ? "dash" : tab === "entry" ? "entry" : "home";
            if (panelHome) panelHome.classList.toggle("hidden", t !== "home");
            if (panelDash) panelDash.classList.toggle("hidden", t !== "dash");
            if (panelEntry) panelEntry.classList.toggle("hidden", t !== "entry");
            if (panelInv) panelInv.classList.toggle("hidden", t !== "inv");
            if (panelDebt) panelDebt.classList.toggle("hidden", t !== "debt");
            if (panelBackup) panelBackup.classList.toggle("hidden", t !== "backup");
            if (panelFollowup) panelFollowup.classList.toggle("hidden", t !== "followup");
            if (t === "backup" && activeChannelId) {
                bindBackups(activeChannelId);
            }
            if (t === "entry") {
                if (typeof populateEntryCategories === "function") populateEntryCategories();
                if (typeof populateEntryManufacturers === "function") populateEntryManufacturers();
                if (typeof calcEntryTotalStock === "function") calcEntryTotalStock();
                setTimeout(() => {
                    const b = document.getElementById("mmEntryBarcode");
                    if (b) b.focus();
                }, 150);
            }
            setTabActive(tabHomeBtn, t === "home" || t === "followup");
            setTabActive(tabDashBtn, t === "dash");
            setTabActive(tabEntryBtn, t === "entry");
            setTabActive(tabInvBtn, t === "inv");
            setTabActive(tabDebtBtn, t === "debt");
            try { localStorage.setItem("pos_mobile_tab", t === "followup" ? "home" : t); } catch (e) {}
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

        function mmIsIos() {
            return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        }

        function mmIsIosStandalone() {
            return window.navigator.standalone === true ||
                (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
        }

        function mmBackupDlLabel() {
            return mmIsIosStandalone() ? '<i class="fas fa-share-square"></i> Save' : '<i class="fas fa-download"></i> داونلۆد';
        }

        function mmFormatBackupUploadedAt(item) {
            const ms = item && (item.uploadedAt || item.mtime);
            if (!ms) return "—";
            try {
                return new Date(Number(ms)).toLocaleString("ar-IQ", {
                    year: "numeric", month: "short", day: "numeric",
                    hour: "2-digit", minute: "2-digit", hour12: false
                });
            } catch (e) { return "—"; }
        }

        function mmIsMobileDownload() {
            return mmIsIos() || /Android/i.test(navigator.userAgent || "");
        }

        function mmBackupCacheKey(channelId, item) {
            if (!item) return "";
            const p = item.path || ("pos_mobile_backups/" + channelId + "/" + item.name);
            return String(channelId || "") + "|" + p + "|" + (item.uploadedAt || 0);
        }

        function mmBackupIdbGet(key) {
            if (!key || !("indexedDB" in window)) return Promise.resolve(null);
            return new Promise(function (resolve) {
                const req = indexedDB.open("ld-mobile-manager", 1);
                req.onerror = function () { resolve(null); };
                req.onsuccess = function () {
                    const db = req.result;
                    if (!db.objectStoreNames.contains("snapshots")) {
                        db.close();
                        resolve(null);
                        return;
                    }
                    const tx = db.transaction("snapshots", "readonly");
                    const getReq = tx.objectStore("snapshots").get("backup_blob|" + key);
                    getReq.onsuccess = function () {
                        const row = getReq.result;
                        resolve(row && row.blob instanceof Blob ? row.blob : null);
                    };
                    getReq.onerror = function () { resolve(null); };
                    tx.oncomplete = function () { db.close(); };
                };
            });
        }

        function mmBackupIdbPut(key, blob) {
            if (!key || !blob || !("indexedDB" in window)) return Promise.resolve();
            return new Promise(function (resolve) {
                const req = indexedDB.open("ld-mobile-manager", 1);
                req.onerror = function () { resolve(); };
                req.onupgradeneeded = function (e) {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains("snapshots")) {
                        db.createObjectStore("snapshots");
                    }
                };
                req.onsuccess = function () {
                    const db = req.result;
                    const tx = db.transaction("snapshots", "readwrite");
                    tx.objectStore("snapshots").put({ blob: blob, savedAt: Date.now() }, "backup_blob|" + key);
                    tx.oncomplete = function () { db.close(); resolve(); };
                    tx.onerror = function () { db.close(); resolve(); };
                };
            });
        }

        function mmFetchBackupBlob(path, totalBytes, onProgress) {
            const maxSize = 80 * 1024 * 1024;
            return getStream(storageRef(storage, path), maxSize).then(function (stream) {
                const reader = stream.getReader();
                const chunks = [];
                let received = 0;
                function pump() {
                    return reader.read().then(function (result) {
                        if (result.done) {
                            return new Blob(chunks, { type: "application/zip" });
                        }
                        chunks.push(result.value);
                        received += result.value.length;
                        if (onProgress) onProgress(received, totalBytes || received);
                        return pump();
                    });
                }
                return pump();
            }).catch(function () {
                return getBlob(storageRef(storage, path));
            });
        }

        function mmUpdateBackupDlBtn(btn, html, disabled) {
            if (!btn) return;
            btn.innerHTML = html;
            btn.disabled = !!disabled;
        }

        function mmPrefetchBackupBlob(item, btn) {
            if (!item || !item.name || !activeChannelId) return Promise.resolve(null);
            const cacheKey = mmBackupCacheKey(activeChannelId, item);
            if (mmBackupBlobCache && mmBackupBlobCacheKey === cacheKey) {
                mmUpdateBackupDlBtn(btn, mmBackupDlLabel(), false);
                return Promise.resolve(mmBackupBlobCache);
            }
            if (mmBackupPrefetchPromise && mmBackupBlobCacheKey === cacheKey) {
                return mmBackupPrefetchPromise;
            }
            const path = item.path || ("pos_mobile_backups/" + activeChannelId + "/" + item.name);
            const totalBytes = Number(item.bytes) || 0;
            mmBackupBlobCacheKey = cacheKey;
            mmUpdateBackupDlBtn(btn, '<i class="fas fa-spinner fa-spin"></i> 0%', true);
            mmBackupPrefetchPromise = mmBackupIdbGet(cacheKey).then(function (cached) {
                if (cached) {
                    mmBackupBlobCache = cached;
                    mmUpdateBackupDlBtn(btn, mmBackupDlLabel() + " ✓", false);
                    return cached;
                }
                return mmFetchBackupBlob(path, totalBytes, function (got, total) {
                    const pct = total > 0 ? Math.min(99, Math.round((got / total) * 100)) : 0;
                    mmUpdateBackupDlBtn(btn, '<i class="fas fa-spinner fa-spin"></i> ' + pct + "%", true);
                }).then(function (blob) {
                    mmBackupBlobCache = blob;
                    mmBackupIdbPut(cacheKey, blob);
                    mmUpdateBackupDlBtn(btn, mmBackupDlLabel() + " ✓", false);
                    return blob;
                });
            }).catch(function () {
                mmUpdateBackupDlBtn(btn, mmBackupDlLabel(), false);
                return null;
            }).finally(function () {
                mmBackupPrefetchPromise = null;
            });
            return mmBackupPrefetchPromise;
        }

        function mmSaveBackupBlob(blob, fileName) {
            const fileNameSafe = fileName || "backup.zip";
            const file = new File([blob], fileNameSafe, { type: blob.type || "application/zip" });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                return navigator.share({ files: [file], title: fileNameSafe });
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = fileNameSafe;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
            return Promise.resolve();
        }

        function mmDownloadCloudBackup(item, btn) {
            if (!item || !item.name || !activeChannelId) return;
            const fileName = item.name || "backup.zip";
            const cacheKey = mmBackupCacheKey(activeChannelId, item);
            const path = item.path || ("pos_mobile_backups/" + activeChannelId + "/" + item.name);
            const totalBytes = Number(item.bytes) || 0;
            mmUpdateBackupDlBtn(btn, '<i class="fas fa-spinner fa-spin"></i>', true);
            const blobPromise = (mmBackupBlobCache && mmBackupBlobCacheKey === cacheKey)
                ? Promise.resolve(mmBackupBlobCache)
                : (mmBackupPrefetchPromise && mmBackupBlobCacheKey === cacheKey)
                    ? mmBackupPrefetchPromise
                    : mmFetchBackupBlob(path, totalBytes, function (got, total) {
                        const pct = total > 0 ? Math.min(99, Math.round((got / total) * 100)) : 0;
                        mmUpdateBackupDlBtn(btn, '<i class="fas fa-spinner fa-spin"></i> ' + pct + "%", true);
                    }).then(function (blob) {
                        mmBackupBlobCache = blob;
                        mmBackupBlobCacheKey = cacheKey;
                        mmBackupIdbPut(cacheKey, blob);
                        return blob;
                    });
            blobPromise
                .then(function (blob) {
                    if (!blob) throw new Error("backup blob empty");
                    return mmSaveBackupBlob(blob, fileName);
                })
                .catch(function (err) {
                    alert("داونلۆد سەرنەکەوت: " + String(err.message || err));
                })
                .finally(function () {
                    mmUpdateBackupDlBtn(btn, mmBackupDlLabel() + (mmBackupBlobCache ? " ✓" : ""), false);
                });
        }

        function renderCloudBackupList(items, opts) {
            opts = opts || {};
            const box = document.getElementById("backupContent");
            if (!box) return;
            mmBackupItems = mmSortBackupItems(items || []).slice(0, 1);
            if (!mmBackupItems.length) {
                const em = esc(activeChannelId || "");
                let msg = 'پاشەکەوت لە Cloud نییە';
                if (opts.error) {
                    msg += '<br><small style="color:#f87171;">' + esc(String(opts.error)) + '</small>';
                }
                msg += '<br><small dir="ltr">' + em + '</small>';
                msg += '<br><small>① POS → Settings → Firebase login<br>② بەڕێوەبردنی داتابەیس → پاشەکەوت (ZIP)<br>③ یان «نێردن بۆ Mobile Manager»<br>Firebase Console: Storage Rules + Firestore Rules → Publish</small>';
                box.innerHTML = '<div class="detail-empty">' + msg + '</div>';
                return;
            }
            box.innerHTML = mmBackupItems.map(function (it, idx) {
                const name = esc(it.name || "backup.zip");
                const label = name.indexOf("Latest") !== -1 ? "دوایین پاشەکەوت" : name;
                const sub = mmFormatBackupUploadedAt(it) + " · " + formatBackupBytes(it.bytes);
                return '<div class="backup-row backup-row--latest">' +
                    '<div class="backup-row-meta"><div class="backup-row-name">' + esc(label) + '</div><div class="backup-row-sub">' + sub + '</div></div>' +
                    '<button type="button" class="backup-dl-btn" data-cloud-backup-idx="' + idx + '">' + mmBackupDlLabel() + '</button>' +
                    '</div>';
            }).join("");
            box.querySelectorAll("[data-cloud-backup-idx]").forEach(function (btn) {
                const i = parseInt(btn.getAttribute("data-cloud-backup-idx"), 10);
                const it = mmBackupItems[i];
                if (!it) return;
                btn.addEventListener("click", function (e) {
                    e.preventDefault();
                    mmDownloadCloudBackup(it, btn);
                });
                mmPrefetchBackupBlob(it, btn);
            });
        }

        function bindBackups(channelId) {
            if (unsubBackup) {
                unsubBackup();
                unsubBackup = null;
            }
            if (!channelId) return;
            const metaRef = doc(db, "pos_mobile_backups", channelId);
            unsubBackup = onSnapshot(metaRef, function (snap) {
                const data = snap.exists() ? snap.data() : null;
                mmApplyBackupList(channelId, data && data.items ? data.items : []);
            }, function (err) {
                const code = err && err.code ? String(err.code) : "";
                let hint = "Firebase Rules پێویستە Publish بکرێت (Firestore + Storage)";
                if (/permission|unauthenticated/i.test(code)) hint = "دەسەڵات نییە — Firestore Rules → pos_mobile_backups";
                renderCloudBackupList([], { error: hint });
            });
            const refreshBtn = document.getElementById("mmRefreshCloudBackupsBtn");
            if (refreshBtn && !refreshBtn.__mmBound) {
                refreshBtn.__mmBound = true;
                refreshBtn.addEventListener("click", function () {
                    const box = document.getElementById("backupContent");
                    if (box) box.innerHTML = '<div class="detail-empty"><i class="fas fa-spinner fa-spin"></i></div>';
                    getDocFromServer(metaRef).then(function (snap) {
                        const data = snap.exists() ? snap.data() : null;
                        mmApplyBackupList(channelId, data && data.items ? data.items : []);
                    }).catch(function () {
                        renderCloudBackupList(mmBackupItems);
                    });
                });
            }
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
            // Viewing debt is 100% free - zero token deduction
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

        let invScannerTarget = "search"; // "search" or "entry"

        function applyInvScanResult(code) {
            const val = normalizeBarcodeSearchInput(code) || String(code || "").trim();
            if (!val) return;
            closeInvScanner();
            if (invScannerTarget && invScannerTarget.indexOf("entry") === 0) {
                if (typeof applyEntryScanResult === "function") {
                    applyEntryScanResult(val, invScannerTarget);
                }
                return;
            }
            invSearchText = val;
            const list = filterInventoryProducts(invProductsCache, invSearchText, invCatFilter);
            if (list.length === 1) {
                invScanBannerText = list[0].name + " · ژمارە: " + formatQty(list[0].qty);
            } else if (list.length > 1) {
                invScanBannerText = list.length + " ئایتم دۆزرایەوە بۆ «" + val + "»";
            } else {
                invScanBannerText = "هیچ ئایتمێک نەدۆزرایەوە بۆ «" + val + "»";
            }
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

        async function openInvScanner(target) {
            invScannerTarget = target === "entry" ? "entry" : "search";
            if (invScannerTarget === "search") {
                switchMobileTab("inv");
            }
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

        /* --- Mobile Item Entry (ئیدخالا کاڵایان ب مۆبایلێ) --- */
        let mmEntryLookupTimer = null;
        let mmEntryMode = "add"; // "add" or "set"
        let mmEntryRecent = [];

        function playChime(success) {
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                if (success) {
                    osc.frequency.setValueAtTime(784, ctx.currentTime);
                    osc.frequency.setValueAtTime(1046.5, ctx.currentTime + 0.08);
                    gain.gain.setValueAtTime(0.12, ctx.currentTime);
                    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
                    osc.start();
                    osc.stop(ctx.currentTime + 0.25);
                } else {
                    osc.type = "sawtooth";
                    osc.frequency.setValueAtTime(220, ctx.currentTime);
                    gain.gain.setValueAtTime(0.12, ctx.currentTime);
                    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
                    osc.start();
                    osc.stop(ctx.currentTime + 0.2);
                }
            } catch(e) {}
        }

        function guessPosBase() {
            try {
                const stored = localStorage.getItem("pos_wifi_base_url");
                if (stored) return stored.replace(/\/+$/, "");
            } catch(e) {}
            if (window.location.protocol === "http:" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
                return window.location.origin + "/pos";
            }
            if (window.location.pathname.indexOf("/pos") !== -1) {
                return window.location.origin + "/pos";
            }
            return "";
        }

        let mmEntryShowPack = false;
        let mmEntryShowCarton = false;
        let mmEntryTrackStock = true;

        async function populateEntryCategories() {
            const datalist = document.getElementById("mmEntryCatList");
            const selectEl = document.getElementById("mmEntryCatSelect");
            if (!datalist && !selectEl) return;
            const seen = {};
            const cats = [];

            // 1. From invCategoriesCache
            if (Array.isArray(invCategoriesCache)) {
                invCategoriesCache.forEach(c => {
                    const s = String(c || "").trim();
                    if (s && !seen[s]) {
                        seen[s] = true;
                        cats.push(s);
                    }
                });
            }

            // 2. From invProductsCache
            if (Array.isArray(invProductsCache)) {
                invProductsCache.forEach(p => {
                    const c = String(p.category || "").trim();
                    if (c && !seen[c]) {
                        seen[c] = true;
                        cats.push(c);
                    }
                });
            }

            // 3. From POS server via mobile_entry.php if available
            const posBase = guessPosBase();
            if (posBase) {
                try {
                    const res = await fetch(posBase + "/mobile_entry.php?ajax=1&action=get_meta");
                    const json = await res.json();
                    if (json && json.status === "success" && Array.isArray(json.categories)) {
                        json.categories.forEach(c => {
                            const s = String(c || "").trim();
                            if (s && !seen[s]) {
                                seen[s] = true;
                                cats.push(s);
                            }
                        });
                    }
                } catch(e) {}
            }

            cats.sort((a, b) => a.localeCompare(b, "ku", { sensitivity: "base" }));
            if (datalist) {
                datalist.innerHTML = cats.map(c => `<option value="${esc(c)}">`).join("");
            }
            if (selectEl) {
                selectEl.innerHTML = `<option value="">▼</option>` + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
            }
        }

        async function populateEntryManufacturers() {
            const datalist = document.getElementById("mmEntryMfrList");
            const selectEl = document.getElementById("mmEntryMfrSelect");
            if (!datalist && !selectEl) return;
            const seen = {};
            const mfrs = [];

            if (Array.isArray(invProductsCache)) {
                invProductsCache.forEach(p => {
                    const m = String(p.manufacturer || "").trim();
                    if (m && !seen[m]) {
                        seen[m] = true;
                        mfrs.push(m);
                    }
                });
            }

            const posBase = guessPosBase();
            if (posBase) {
                try {
                    const res = await fetch(posBase + "/mobile_entry.php?ajax=1&action=get_meta");
                    const json = await res.json();
                    if (json && json.status === "success" && Array.isArray(json.manufacturers)) {
                        json.manufacturers.forEach(m => {
                            const s = String(m || "").trim();
                            if (s && !seen[s]) {
                                seen[s] = true;
                                mfrs.push(s);
                            }
                        });
                    }
                } catch(e) {}
            }

            mfrs.sort((a, b) => a.localeCompare(b, "ku", { sensitivity: "base" }));
            if (datalist) {
                datalist.innerHTML = mfrs.map(m => `<option value="${esc(m)}">`).join("");
            }
            if (selectEl) {
                selectEl.innerHTML = `<option value="">▼</option>` + mfrs.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
            }
        }

        function toggleEntryPack(forcedState) {
            mmEntryShowPack = (forcedState !== undefined) ? !!forcedState : !mmEntryShowPack;
            const btn = document.getElementById("mmTogglePackBtn");
            const card = document.getElementById("mmCardPack");
            const convRow = document.getElementById("mmEntryConvRow");
            const pppWrap = document.getElementById("mmConvPppWrap");

            if (btn) {
                btn.classList.toggle("active", mmEntryShowPack);
                btn.setAttribute("aria-checked", mmEntryShowPack ? "true" : "false");
                const stateSpan = btn.querySelector(".toggle-state");
                if (stateSpan) stateSpan.textContent = mmEntryShowPack ? "هەیە" : "نینە";
            }
            if (card) {
                card.classList.remove("hidden");
                card.style.display = mmEntryShowPack ? "block" : "none";
            }
            if (convRow) {
                const showConv = (mmEntryShowPack || mmEntryShowCarton);
                convRow.classList.remove("hidden");
                convRow.style.display = showConv ? "grid" : "none";
            }
            if (pppWrap) {
                pppWrap.classList.remove("hidden");
                pppWrap.style.display = mmEntryShowPack ? "block" : "none";
            }
            calcEntryTotalStock();
        }

        function toggleEntryCarton(forcedState) {
            mmEntryShowCarton = (forcedState !== undefined) ? !!forcedState : !mmEntryShowCarton;
            const btn = document.getElementById("mmToggleCartonBtn");
            const card = document.getElementById("mmCardCarton");
            const convRow = document.getElementById("mmEntryConvRow");
            const ppcWrap = document.getElementById("mmConvPpcWrap");

            if (btn) {
                btn.classList.toggle("active", mmEntryShowCarton);
                btn.setAttribute("aria-checked", mmEntryShowCarton ? "true" : "false");
                const stateSpan = btn.querySelector(".toggle-state");
                if (stateSpan) stateSpan.textContent = mmEntryShowCarton ? "هەیە" : "نینە";
            }
            if (card) {
                card.classList.remove("hidden");
                card.style.display = mmEntryShowCarton ? "block" : "none";
            }
            if (convRow) {
                const showConv = (mmEntryShowPack || mmEntryShowCarton);
                convRow.classList.remove("hidden");
                convRow.style.display = showConv ? "grid" : "none";
            }
            if (ppcWrap) {
                ppcWrap.classList.remove("hidden");
                ppcWrap.style.display = mmEntryShowCarton ? "block" : "none";
            }
            calcEntryTotalStock();
        }

        function toggleEntryTrack(forcedState) {
            mmEntryTrackStock = (forcedState !== undefined) ? !!forcedState : !mmEntryTrackStock;
            const btn = document.getElementById("mmToggleTrackBtn");
            if (btn) {
                btn.classList.toggle("active", mmEntryTrackStock);
                btn.setAttribute("aria-checked", mmEntryTrackStock ? "true" : "false");
                const stateSpan = btn.querySelector(".toggle-state");
                if (stateSpan) stateSpan.textContent = mmEntryTrackStock ? "هەیە" : "نینە";
            }
        }

        function calcEntryTotalStock() {
            const ppp = Math.max(1, parseInt(document.getElementById("mmEntryPiecesPerPack")?.value, 10) || 1);
            const ppc = Math.max(1, parseInt(document.getElementById("mmEntryPacksPerCarton")?.value, 10) || 1);
            const itemsPerPack = mmEntryShowPack ? ppp : 1;
            const itemsPerCarton = mmEntryShowCarton ? (itemsPerPack * ppc) : 1;

            const stockPiece = parseFloat(document.getElementById("mmEntryStockPiece")?.value) || 0;
            const stockPack = mmEntryShowPack ? (parseFloat(document.getElementById("mmEntryStockPack")?.value) || 0) : 0;
            const stockCarton = mmEntryShowCarton ? (parseFloat(document.getElementById("mmEntryStockCarton")?.value) || 0) : 0;

            const total = (stockCarton * itemsPerCarton) + (stockPack * itemsPerPack) + stockPiece;

            const badge = document.getElementById("mmEntryTotalStockBadge");
            if (badge) badge.textContent = formatQty(total) + " دانە";

            const preview = document.getElementById("mmConvTotalPreview");
            if (preview) {
                if (mmEntryShowCarton) {
                    preview.textContent = "کۆی دانە ل کارتۆنێ دا: " + itemsPerCarton + " دانە";
                } else if (mmEntryShowPack) {
                    preview.textContent = "کۆی دانە ل پاکێتێ دا: " + itemsPerPack + " دانە";
                } else {
                    preview.textContent = "";
                }
            }

            return { totalQty: total, ppp, ppc, itemsPerCarton, stockPiece, stockPack, stockCarton };
        }

        function autoGenerateBarcode() {
            const code = "99" + Math.floor(1000000000 + Math.random() * 9000000000);
            const barcodeInp = document.getElementById("mmEntryBarcode");
            if (barcodeInp) {
                barcodeInp.value = code;
                lookupEntryBarcode(code);
            }
        }

        function syncAllowNoName() {
            const chk = document.getElementById("mmEntryAllowNoName");
            const nameInp = document.getElementById("mmEntryName");
            if (!nameInp) return;
            if (chk && chk.checked) {
                nameInp.required = false;
                nameInp.placeholder = "خۆکار ژ بارکۆد و نرخ (بێ ناو)";
            } else {
                nameInp.required = true;
                nameInp.placeholder = "ناڤێ بەرهەم بنڤیسە...";
            }
        }

        function applyEntryScanResult(code, target) {
            playChime(true);
            if (navigator.vibrate) navigator.vibrate(80);
            if (target === "entry_pack") {
                const pInp = document.getElementById("mmEntryBarcodePack");
                if (pInp) pInp.value = code;
            } else if (target === "entry_carton") {
                const cInp = document.getElementById("mmEntryBarcodeCarton");
                if (cInp) cInp.value = code;
            } else {
                const barcodeInput = document.getElementById("mmEntryBarcode");
                if (barcodeInput) {
                    barcodeInput.value = code;
                    lookupEntryBarcode(code);
                }
            }
        }

        function fillEntryFormFromProduct(found) {
            if (!found) return;
            const foundIdEl = document.getElementById("mmEntryFoundId");
            const nameEl = document.getElementById("mmEntryName");
            const catEl = document.getElementById("mmEntryCat");
            const mfrEl = document.getElementById("mmEntryMfr");
            const priceEl = document.getElementById("mmEntryPrice");
            const costEl = document.getElementById("mmEntryCost");
            const stockPieceEl = document.getElementById("mmEntryStockPiece");
            const statusEl = document.getElementById("mmEntryBarcodeStatus");
            const modeWrap = document.getElementById("mmEntryQtyModeWrap");

            if (foundIdEl) foundIdEl.value = found.id || "0";
            const costBadge = document.getElementById("entryTokenCostBadge");
            if (costBadge) costBadge.innerHTML = '<i class="fas fa-coins"></i> ١ خاڵ (دەستکاری)';
            if (nameEl) nameEl.value = found.name || "";
            if (catEl) catEl.value = found.category || "";
            if (mfrEl) mfrEl.value = found.manufacturer || "";
            if (priceEl) priceEl.value = (found.price !== undefined && found.price !== null) ? found.price : "";
            if (costEl) costEl.value = (found.cost !== undefined && found.cost !== null) ? found.cost : "";
            if (stockPieceEl) stockPieceEl.value = "1";

            // Piece wholesale price
            const wpPieceEl = document.getElementById("mmEntryWholesalePricePiece");
            const twPiece = (found.takeawayPrice !== undefined && found.takeawayPrice !== null && Number(found.takeawayPrice) > 0)
                ? found.takeawayPrice
                : ((found.wholesalePrice !== undefined && found.wholesalePrice !== null && Number(found.wholesalePrice) > 0) ? found.wholesalePrice : "");
            if (wpPieceEl) wpPieceEl.value = twPiece;

            // Pack fields
            const hasPack = !!(found.unit_show_pack || found.barcode_pack || (found.price_pack && found.price_pack > 0));
            toggleEntryPack(hasPack);
            const bPackEl = document.getElementById("mmEntryBarcodePack");
            const pPackEl = document.getElementById("mmEntryPricePack");
            const wpPackEl = document.getElementById("mmEntryWholesalePricePack");
            const cPackEl = document.getElementById("mmEntryCostPack");
            const sPackEl = document.getElementById("mmEntryStockPack");
            const pppEl = document.getElementById("mmEntryPiecesPerPack");
            if (bPackEl) bPackEl.value = found.barcode_pack || "";
            if (pPackEl) pPackEl.value = (found.price_pack !== undefined && found.price_pack !== null) ? found.price_pack : "";
            if (wpPackEl) {
                const twPack = (found.takeawayPrice_pack !== undefined && found.takeawayPrice_pack !== null && Number(found.takeawayPrice_pack) > 0) ? found.takeawayPrice_pack : "";
                wpPackEl.value = twPack;
            }
            if (cPackEl) cPackEl.value = (found.cost_pack !== undefined && found.cost_pack !== null) ? found.cost_pack : "";
            if (sPackEl) sPackEl.value = "0";
            if (pppEl) pppEl.value = found.pieces_per_pack || 1;

            // Carton fields
            const hasCarton = !!(found.unit_show_carton || found.barcode_carton || (found.price_carton && found.price_carton > 0));
            toggleEntryCarton(hasCarton);
            const bCartonEl = document.getElementById("mmEntryBarcodeCarton");
            const pCartonEl = document.getElementById("mmEntryPriceCarton");
            const wpCartonEl = document.getElementById("mmEntryWholesalePriceCarton");
            const cCartonEl = document.getElementById("mmEntryCostCarton");
            const sCartonEl = document.getElementById("mmEntryStockCarton");
            const ppcEl = document.getElementById("mmEntryPacksPerCarton");
            if (bCartonEl) bCartonEl.value = found.barcode_carton || "";
            if (pCartonEl) pCartonEl.value = (found.price_carton !== undefined && found.price_carton !== null) ? found.price_carton : "";
            if (wpCartonEl) {
                const twCarton = (found.takeawayPrice_carton !== undefined && found.takeawayPrice_carton !== null && Number(found.takeawayPrice_carton) > 0) ? found.takeawayPrice_carton : "";
                wpCartonEl.value = twCarton;
            }
            if (cCartonEl) cCartonEl.value = (found.cost_carton !== undefined && found.cost_carton !== null) ? found.cost_carton : "";
            if (sCartonEl) sCartonEl.value = "0";
            if (ppcEl) ppcEl.value = found.packs_per_carton || 1;

            // Advanced fields
            const wqEl = document.getElementById("mmEntryWholesaleQty");
            const wpEl = document.getElementById("mmEntryWholesalePrice");
            const expEl = document.getElementById("mmEntryExpiry");
            const minEl = document.getElementById("mmEntryMinStock");
            const noteEl = document.getElementById("mmEntryNote");
            const saleEl = document.getElementById("mmEntryForSale");
            if (wqEl) wqEl.value = found.wholesaleQty || "";
            if (wpEl) wpEl.value = twPiece;
            if (expEl) expEl.value = found.expiry || "";
            if (minEl) minEl.value = found.minStock || 5;
            if (noteEl) noteEl.value = found.note || "";
            if (saleEl) saleEl.checked = (found.forSale !== 0);

            if (modeWrap) modeWrap.classList.remove("hidden");
            setEntryQtyMode("add");

            calcEntryTotalStock();

            if (statusEl) {
                statusEl.className = "barcode-status-box found";
                statusEl.innerHTML = `<i class="fas fa-check-circle"></i> ئەم کاڵایە هەیە: <strong>${esc(found.name)}</strong> · عەدەدێ مەخزەنی: <strong>${formatQty(found.qty)}</strong>`;
                statusEl.classList.remove("hidden");
            }
            playChime(true);
        }

        async function lookupEntryBarcode(code) {
            const raw = String(code || "").trim();
            if (!raw) {
                resetEntryStatus();
                return;
            }
            populateEntryCategories();
            populateEntryManufacturers();

            let found = null;
            if (Array.isArray(invProductsCache)) {
                found = invProductsCache.find(p => {
                    return (p.barcode && String(p.barcode).trim() === raw) ||
                           (p.barcode_pack && String(p.barcode_pack).trim() === raw) ||
                           (p.barcode_carton && String(p.barcode_carton).trim() === raw) ||
                           barcodeHaystackMatch(p.barcode, raw) ||
                           normalizeBarcodeSearchInput(String(p.id)) === normalizeBarcodeSearchInput(raw);
                });
            }

            if (found) {
                fillEntryFormFromProduct(found);
                return;
            }

            // If not found in cache, check server via mobile_entry.php if available
            const posBase = guessPosBase();
            if (posBase) {
                try {
                    const res = await fetch(posBase + "/mobile_entry.php?ajax=1&action=lookup_barcode&barcode=" + encodeURIComponent(raw));
                    const json = await res.json();
                    if (json && json.status === "success" && json.found && json.product) {
                        fillEntryFormFromProduct(json.product);
                        return;
                    }
                } catch(e) {}
            }

            // Not found anywhere -> new product
            const foundIdEl = document.getElementById("mmEntryFoundId");
            const statusEl = document.getElementById("mmEntryBarcodeStatus");
            const modeWrap = document.getElementById("mmEntryQtyModeWrap");

            if (foundIdEl) foundIdEl.value = "0";
            if (modeWrap) modeWrap.classList.add("hidden");
            setEntryQtyMode("add");

            if (statusEl) {
                statusEl.className = "barcode-status-box new";
                statusEl.innerHTML = `<i class="fas fa-sparkles"></i> ✨ کاڵایەکی نوێیە — تکایە ناڤ و نرخ بنڤیسە`;
                statusEl.classList.remove("hidden");
            }
            calcEntryTotalStock();
        }

        function resetEntryStatus() {
            const statusEl = document.getElementById("mmEntryBarcodeStatus");
            if (statusEl) {
                statusEl.classList.add("hidden");
                statusEl.innerHTML = "";
            }
            const modeWrap = document.getElementById("mmEntryQtyModeWrap");
            if (modeWrap) modeWrap.classList.add("hidden");
        }

        function setEntryQtyMode(mode) {
            mmEntryMode = mode === "set" ? "set" : "add";
            const btnAdd = document.getElementById("mmBtnModeAdd");
            const btnSet = document.getElementById("mmBtnModeSet");
            if (btnAdd) btnAdd.classList.toggle("active", mmEntryMode === "add");
            if (btnSet) btnSet.classList.toggle("active", mmEntryMode === "set");
        }

        function clearEntryForm() {
            const bInp = document.getElementById("mmEntryBarcode");
            const nInp = document.getElementById("mmEntryName");
            const pInp = document.getElementById("mmEntryPrice");
            const cInp = document.getElementById("mmEntryCost");
            const sPiece = document.getElementById("mmEntryStockPiece");
            const wpPiece = document.getElementById("mmEntryWholesalePricePiece");
            const catInp = document.getElementById("mmEntryCat");
            const mfrInp = document.getElementById("mmEntryMfr");
            const fId = document.getElementById("mmEntryFoundId");

            if (bInp) { bInp.value = ""; bInp.focus(); }
            if (nInp) nInp.value = "";
            if (pInp) pInp.value = "";
            if (cInp) cInp.value = "";
            if (sPiece) sPiece.value = "1";
            if (wpPiece) wpPiece.value = "";
            if (catInp) catInp.value = "";
            if (mfrInp) mfrInp.value = "";
            if (fId) fId.value = "0";
            const costBadge = document.getElementById("entryTokenCostBadge");
            if (costBadge) costBadge.innerHTML = '<i class="fas fa-coins"></i> ٢ خاڵ (ئیدخال)';

            // Pack
            const bPack = document.getElementById("mmEntryBarcodePack");
            const pPack = document.getElementById("mmEntryPricePack");
            const wpPack = document.getElementById("mmEntryWholesalePricePack");
            const cPack = document.getElementById("mmEntryCostPack");
            const sPack = document.getElementById("mmEntryStockPack");
            const ppp = document.getElementById("mmEntryPiecesPerPack");
            if (bPack) bPack.value = "";
            if (pPack) pPack.value = "";
            if (wpPack) wpPack.value = "";
            if (cPack) cPack.value = "";
            if (sPack) sPack.value = "0";
            if (ppp) ppp.value = "1";

            // Carton
            const bCarton = document.getElementById("mmEntryBarcodeCarton");
            const pCarton = document.getElementById("mmEntryPriceCarton");
            const wpCarton = document.getElementById("mmEntryWholesalePriceCarton");
            const cCarton = document.getElementById("mmEntryCostCarton");
            const sCarton = document.getElementById("mmEntryStockCarton");
            const ppc = document.getElementById("mmEntryPacksPerCarton");
            if (bCarton) bCarton.value = "";
            if (pCarton) pCarton.value = "";
            if (wpCarton) wpCarton.value = "";
            if (cCarton) cCarton.value = "";
            if (sCarton) sCarton.value = "0";
            if (ppc) ppc.value = "1";

            // Advanced
            const wq = document.getElementById("mmEntryWholesaleQty");
            const wp = document.getElementById("mmEntryWholesalePrice");
            const exp = document.getElementById("mmEntryExpiry");
            const note = document.getElementById("mmEntryNote");
            if (wq) wq.value = "";
            if (wp) wp.value = "";
            if (exp) exp.value = "";
            if (note) note.value = "";

            const noNameChk = document.getElementById("mmEntryAllowNoName");
            if (noNameChk) { noNameChk.checked = false; syncAllowNoName(); }

            toggleEntryPack(false);
            toggleEntryCarton(false);
            toggleEntryTrack(true);
            resetEntryStatus();
            calcEntryTotalStock();
        }

        function updateLocalCacheAfterEntry(item) {
            if (!Array.isArray(invProductsCache)) invProductsCache = [];
            const idx = invProductsCache.findIndex(p => {
                if (item.id && p.id === item.id) return true;
                if (item.barcode && p.barcode && String(p.barcode).trim() === String(item.barcode).trim()) return true;
                return false;
            });

            if (idx >= 0) {
                const p = invProductsCache[idx];
                if (item.name) p.name = item.name;
                if (item.barcode) p.barcode = item.barcode;
                if (item.category) p.category = item.category;
                if (item.manufacturer) p.manufacturer = item.manufacturer;
                if (item.price !== undefined) p.price = item.price;
                if (item.cost !== undefined) p.cost = item.cost;
                if (item.unit_show_pack !== undefined) p.unit_show_pack = item.unit_show_pack;
                if (item.unit_show_carton !== undefined) p.unit_show_carton = item.unit_show_carton;
                if (item.barcode_pack) p.barcode_pack = item.barcode_pack;
                if (item.barcode_carton) p.barcode_carton = item.barcode_carton;
                if (item.price_pack !== undefined) p.price_pack = item.price_pack;
                if (item.price_carton !== undefined) p.price_carton = item.price_carton;
                if (item.cost_pack !== undefined) p.cost_pack = item.cost_pack;
                if (item.cost_carton !== undefined) p.cost_carton = item.cost_carton;
                if (item.takeawayPrice !== undefined) p.takeawayPrice = item.takeawayPrice;
                if (item.takeawayPrice_pack !== undefined) p.takeawayPrice_pack = item.takeawayPrice_pack;
                if (item.takeawayPrice_carton !== undefined) p.takeawayPrice_carton = item.takeawayPrice_carton;
                if (item.wholesalePrice !== undefined) p.wholesalePrice = item.wholesalePrice;
                if (item.pieces_per_pack) p.pieces_per_pack = item.pieces_per_pack;
                if (item.packs_per_carton) p.packs_per_carton = item.packs_per_carton;
                if (item.finalQty !== undefined) {
                    p.qty = item.finalQty;
                } else if (item.qty_mode === "set") {
                    p.qty = item.qty;
                } else {
                    p.qty = (p.qty || 0) + item.qty;
                }
            } else {
                invProductsCache.unshift({
                    id: item.id || Date.now(),
                    name: item.name,
                    barcode: item.barcode,
                    category: item.category,
                    manufacturer: item.manufacturer,
                    price: item.price,
                    cost: item.cost,
                    qty: item.qty,
                    trackStock: item.trackStock !== undefined ? item.trackStock : 1,
                    unit_show_pack: item.unit_show_pack,
                    unit_show_carton: item.unit_show_carton,
                    pieces_per_pack: item.pieces_per_pack,
                    packs_per_carton: item.packs_per_carton,
                    barcode_pack: item.barcode_pack,
                    barcode_carton: item.barcode_carton,
                    price_pack: item.price_pack,
                    price_carton: item.price_carton,
                    cost_pack: item.cost_pack,
                    cost_carton: item.cost_carton,
                    takeawayPrice: item.takeawayPrice || item.wholesalePrice || 0,
                    takeawayPrice_pack: item.takeawayPrice_pack || 0,
                    takeawayPrice_carton: item.takeawayPrice_carton || 0,
                    wholesalePrice: item.wholesalePrice || 0
                });
            }
            refreshInventoryView();
        }

        function addRecentEntryItem(item) {
            mmEntryRecent.unshift(item);
            if (mmEntryRecent.length > 30) mmEntryRecent.pop();

            const cntEl = document.getElementById("mmEntryRecentCount");
            if (cntEl) cntEl.textContent = mmEntryRecent.length + " کاڵا";

            const listEl = document.getElementById("mmEntryRecentList");
            if (!listEl) return;
            listEl.innerHTML = mmEntryRecent.map(it => {
                const qtyTxt = it.qty_mode === "set" ? ("عەدەد: " + it.qty) : ("+" + it.qty);
                let extraUnits = "";
                if (it.unit_show_pack && it.stock_pack) extraUnits += ` · ${it.stock_pack} پاکێت`;
                if (it.unit_show_carton && it.stock_carton) extraUnits += ` · ${it.stock_carton} کارتۆن`;
                let wsText = "";
                if (it.takeawayPrice) wsText += ` · جوملە: ${formatMoney(it.takeawayPrice)}`;
                return `
                    <div class="entry-recent-item">
                        <div class="entry-recent-info">
                            <div class="entry-recent-name">${esc(it.name)}</div>
                            <div class="entry-recent-meta">
                                ${it.barcode ? `<span dir="ltr">#${esc(it.barcode)}</span> · ` : ""}
                                ${it.category ? `<span>${esc(it.category)}</span> · ` : ""}
                                <span>نرخ: ${formatMoney(it.price)}</span>
                                ${wsText ? `<span style="color:#f59e0b">${wsText}</span>` : ""}
                                ${extraUnits ? `<span style="color:#38bdf8">${extraUnits}</span>` : ""}
                            </div>
                        </div>
                        <div class="entry-recent-badge">${qtyTxt}</div>
                    </div>
                `;
            }).join("");
        }

        async function saveEntryProduct() {
            const btn = document.getElementById("mmEntrySubmitBtn");
            const barcode = (document.getElementById("mmEntryBarcode")?.value || "").trim();
            const allowNoName = !!(document.getElementById("mmEntryAllowNoName")?.checked);
            let name = (document.getElementById("mmEntryName")?.value || "").trim();
            const cat = (document.getElementById("mmEntryCat")?.value || "").trim();
            const mfr = (document.getElementById("mmEntryMfr")?.value || "").trim();

            const price = parseFloat(document.getElementById("mmEntryPrice")?.value) || 0;
            const cost = parseFloat(document.getElementById("mmEntryCost")?.value) || 0;

            const stockCalc = calcEntryTotalStock();
            const totalQty = stockCalc.totalQty;
            const ppp = stockCalc.ppp;
            const ppc = stockCalc.ppc;

            const foundId = parseInt(document.getElementById("mmEntryFoundId")?.value, 10) || 0;

            if (!name && allowNoName && barcode) {
                name = barcode + (price > 0 ? (" · " + formatMoney(price)) : "");
            } else if (!name && barcode) {
                name = "کاڵا " + barcode;
            }

            if (!name) {
                showRefreshToast("تکایە ناڤێ کاڵای بنڤیسە", true);
                if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
                return;
            }

            // Pack & Carton specific data
            const barcodePack = mmEntryShowPack ? (document.getElementById("mmEntryBarcodePack")?.value || "").trim() : "";
            const pricePack = mmEntryShowPack ? (document.getElementById("mmEntryPricePack")?.value || "") : "";
            const costPack = mmEntryShowPack ? (document.getElementById("mmEntryCostPack")?.value || "") : "";
            const wpPack = mmEntryShowPack ? (document.getElementById("mmEntryWholesalePricePack")?.value || "") : "";

            const barcodeCarton = mmEntryShowCarton ? (document.getElementById("mmEntryBarcodeCarton")?.value || "").trim() : "";
            const priceCarton = mmEntryShowCarton ? (document.getElementById("mmEntryPriceCarton")?.value || "") : "";
            const costCarton = mmEntryShowCarton ? (document.getElementById("mmEntryCostCarton")?.value || "") : "";
            const wpCarton = mmEntryShowCarton ? (document.getElementById("mmEntryWholesalePriceCarton")?.value || "") : "";

            // Wholesale prices (Piece, Pack, Carton)
            const wholesalePricePiece = parseFloat(document.getElementById("mmEntryWholesalePricePiece")?.value) || parseFloat(document.getElementById("mmEntryWholesalePrice")?.value) || 0;
            const wholesalePricePack = wpPack !== "" ? parseFloat(wpPack) : 0;
            const wholesalePriceCarton = wpCarton !== "" ? parseFloat(wpCarton) : 0;

            // Advanced data
            const wholesaleQty = parseInt(document.getElementById("mmEntryWholesaleQty")?.value, 10) || 0;
            const wholesalePrice = wholesalePricePiece;
            const expiry = (document.getElementById("mmEntryExpiry")?.value || "").trim();
            const minStock = parseInt(document.getElementById("mmEntryMinStock")?.value, 10) || 5;
            const note = (document.getElementById("mmEntryNote")?.value || "").trim();
            const forSale = document.getElementById("mmEntryForSale") ? (document.getElementById("mmEntryForSale").checked ? 1 : 0) : 1;

            const isEdit = foundId > 0;
            const tokenCost = isEdit ? 1 : 2;
            const tokenCategory = isEdit ? "entry_edit" : "entry_add";
            const actionLabel = isEdit ? "دەستکاری (Edit)" : "ئیدخالکرنا کاڵایێ نوێ (Add)";

            if (!mmCanSpendTokens(tokenCost, actionLabel)) {
                return;
            }

            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> چاوەڕێبە...';
            }

            const itemPayload = {
                id: foundId,
                barcode: barcode,
                name: name,
                category: cat,
                manufacturer: mfr,
                supplier: "Direct Store",
                price: price,
                cost: cost,
                qty: totalQty,
                stock_piece: stockCalc.stockPiece,
                stock_pack: stockCalc.stockPack,
                stock_carton: stockCalc.stockCarton,
                qty_mode: mmEntryMode,
                trackStock: mmEntryTrackStock ? 1 : 0,
                unit_show_pack: mmEntryShowPack ? 1 : 0,
                unit_show_carton: mmEntryShowCarton ? 1 : 0,
                pieces_per_pack: ppp,
                packs_per_carton: ppc,
                barcode_pack: barcodePack,
                barcode_carton: barcodeCarton,
                price_pack: pricePack !== "" ? parseFloat(pricePack) : null,
                cost_pack: costPack !== "" ? parseFloat(costPack) : null,
                price_carton: priceCarton !== "" ? parseFloat(priceCarton) : null,
                cost_carton: costCarton !== "" ? parseFloat(costCarton) : null,
                takeawayPrice: wholesalePricePiece,
                takeawayPrice_pack: wholesalePricePack,
                takeawayPrice_carton: wholesalePriceCarton,
                wholesaleQty: wholesaleQty,
                wholesalePrice: wholesalePrice,
                expiry: expiry,
                minStock: minStock,
                note: note,
                forSale: forSale,
                added_at: Date.now()
            };

            let savedLocally = false;
            let savedCloud = false;

            const posBase = guessPosBase();
            if (posBase && window.location.protocol !== "https:") {
                try {
                    const fd = new FormData();
                    fd.append("action", "save_product");
                    fd.append("product_id", itemPayload.id);
                    fd.append("barcode", itemPayload.barcode);
                    fd.append("name", itemPayload.name);
                    fd.append("price", itemPayload.price);
                    fd.append("cost", itemPayload.cost);
                    fd.append("qty", itemPayload.qty);
                    fd.append("qty_mode", itemPayload.qty_mode);
                    fd.append("category", itemPayload.category);
                    fd.append("manufacturer", itemPayload.manufacturer);
                    fd.append("supplier", itemPayload.supplier);
                    fd.append("trackStock", itemPayload.trackStock);
                    fd.append("unit_show_pack", itemPayload.unit_show_pack);
                    fd.append("unit_show_carton", itemPayload.unit_show_carton);
                    fd.append("pieces_per_pack", itemPayload.pieces_per_pack);
                    fd.append("packs_per_carton", itemPayload.packs_per_carton);
                    fd.append("barcode_pack", itemPayload.barcode_pack);
                    fd.append("barcode_carton", itemPayload.barcode_carton);
                    if (itemPayload.price_pack != null) fd.append("price_pack", itemPayload.price_pack);
                    if (itemPayload.cost_pack != null) fd.append("cost_pack", itemPayload.cost_pack);
                    if (itemPayload.price_carton != null) fd.append("price_carton", itemPayload.price_carton);
                    if (itemPayload.cost_carton != null) fd.append("cost_carton", itemPayload.cost_carton);
                    if (itemPayload.takeawayPrice) fd.append("takeawayPrice", itemPayload.takeawayPrice);
                    if (itemPayload.takeawayPrice_pack) fd.append("takeawayPrice_pack", itemPayload.takeawayPrice_pack);
                    if (itemPayload.takeawayPrice_carton) fd.append("takeawayPrice_carton", itemPayload.takeawayPrice_carton);
                    if (itemPayload.wholesaleQty) fd.append("wholesaleQty", itemPayload.wholesaleQty);
                    if (itemPayload.wholesalePrice) fd.append("wholesalePrice", itemPayload.wholesalePrice);
                    if (itemPayload.expiry) fd.append("expiry", itemPayload.expiry);
                    if (itemPayload.minStock) fd.append("minStock", itemPayload.minStock);
                    if (itemPayload.note) fd.append("note", itemPayload.note);
                    fd.append("forSale", itemPayload.forSale);

                    const res = await fetch(posBase + "/mobile_entry.php", {
                        method: "POST",
                        body: fd
                    });
                    const json = await res.json();
                    if (json && json.status === "success") {
                        savedLocally = true;
                        if (json.id) itemPayload.id = json.id;
                        if (json.qty !== undefined) itemPayload.finalQty = json.qty;
                    }
                } catch(e) {}
            }

            if (activeChannelId && db) {
                try {
                    const invRef = doc(db, "pos_mobile_inventory", activeChannelId);
                    const snap = await getDoc(invRef);
                    let queue = [];
                    if (snap.exists() && Array.isArray(snap.data()?.pending_items)) {
                        queue = snap.data().pending_items;
                    }
                    if (!savedLocally) {
                        queue.push(itemPayload);
                        await updateDoc(invRef, { pending_items: queue });
                        savedCloud = true;
                    }
                } catch(e) {
                    console.warn("Cloud queue error:", e);
                }
            }

            updateLocalCacheAfterEntry(itemPayload);
            const tokenDetail = (itemPayload.name || "") + (itemPayload.barcode ? " (" + itemPayload.barcode + ")" : "");
            mmDeductTokens(tokenCategory, tokenCost, actionLabel, tokenDetail);

            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-save"></i> <span>تۆمارکرن د سیستەمی دا</span>';
            }

            playChime(true);
            if (navigator.vibrate) navigator.vibrate([60, 40, 100]);

            const syncMsg = savedLocally ? "تۆمارکرا ڕاستەوخۆ د سیستەمێ کاشێری دا" : (savedCloud ? "تۆمارکرا د کلاودێ دا (پەیوەست دکەت ب کاشێری)" : "تۆمارکرا ل مۆبایلێ");
            showRefreshToast(syncMsg, false);

            addRecentEntryItem(itemPayload);
            clearEntryForm();
        }

        function initMobileEntry() {
            populateEntryCategories();
            populateEntryManufacturers();

            const catSel = document.getElementById("mmEntryCatSelect");
            if (catSel) {
                catSel.addEventListener("change", () => {
                    if (catSel.value) {
                        const inEl = document.getElementById("mmEntryCat");
                        if (inEl) inEl.value = catSel.value;
                    }
                });
            }

            const mfrSel = document.getElementById("mmEntryMfrSelect");
            if (mfrSel) {
                mfrSel.addEventListener("change", () => {
                    if (mfrSel.value) {
                        const inEl = document.getElementById("mmEntryMfr");
                        if (inEl) inEl.value = mfrSel.value;
                    }
                });
            }

            const barcodeInput = document.getElementById("mmEntryBarcode");
            if (barcodeInput) {
                barcodeInput.addEventListener("input", () => {
                    clearTimeout(mmEntryLookupTimer);
                    const val = barcodeInput.value.trim();
                    if (val.length >= 2) {
                        mmEntryLookupTimer = setTimeout(() => {
                            lookupEntryBarcode(val);
                        }, 250);
                    } else {
                        resetEntryStatus();
                    }
                });
            }

            const scanBtn = document.getElementById("mmEntryScanBtn");
            if (scanBtn) {
                scanBtn.addEventListener("click", () => {
                    openInvScanner("entry_piece");
                });
            }

            const scanPackBtn = document.getElementById("mmEntryScanPackBtn");
            if (scanPackBtn) {
                scanPackBtn.addEventListener("click", () => {
                    openInvScanner("entry_pack");
                });
            }

            const scanCartonBtn = document.getElementById("mmEntryScanCartonBtn");
            if (scanCartonBtn) {
                scanCartonBtn.addEventListener("click", () => {
                    openInvScanner("entry_carton");
                });
            }

            const autoBtn = document.getElementById("mmEntryAutoBarcodeBtn");
            if (autoBtn) {
                autoBtn.addEventListener("click", () => {
                    autoGenerateBarcode();
                });
            }

            const noNameChk = document.getElementById("mmEntryAllowNoName");
            if (noNameChk) {
                noNameChk.addEventListener("change", syncAllowNoName);
            }

            const togglePackBtn = document.getElementById("mmTogglePackBtn");
            if (togglePackBtn) {
                togglePackBtn.addEventListener("click", () => toggleEntryPack());
            }

            const toggleCartonBtn = document.getElementById("mmToggleCartonBtn");
            if (toggleCartonBtn) {
                toggleCartonBtn.addEventListener("click", () => toggleEntryCarton());
            }

            const toggleTrackBtn = document.getElementById("mmToggleTrackBtn");
            if (toggleTrackBtn) {
                toggleTrackBtn.addEventListener("click", () => toggleEntryTrack());
            }

            const wpPieceInp = document.getElementById("mmEntryWholesalePricePiece");
            const wpDetailsInp = document.getElementById("mmEntryWholesalePrice");
            if (wpPieceInp && wpDetailsInp) {
                wpPieceInp.addEventListener("input", () => { wpDetailsInp.value = wpPieceInp.value; });
                wpDetailsInp.addEventListener("input", () => { wpPieceInp.value = wpDetailsInp.value; });
            }

            ["mmEntryPiecesPerPack", "mmEntryPacksPerCarton", "mmEntryStockPiece", "mmEntryStockPack", "mmEntryStockCarton"].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.addEventListener("input", calcEntryTotalStock);
            });

            const btnAdd = document.getElementById("mmBtnModeAdd");
            const btnSet = document.getElementById("mmBtnModeSet");
            if (btnAdd) btnAdd.addEventListener("click", () => setEntryQtyMode("add"));
            if (btnSet) btnSet.addEventListener("click", () => setEntryQtyMode("set"));

            const resetBtn = document.getElementById("mmEntryResetBtn");
            if (resetBtn) resetBtn.addEventListener("click", clearEntryForm);

            const form = document.getElementById("mmEntryForm");
            if (form) {
                form.addEventListener("submit", (e) => {
                    e.preventDefault();
                    saveEntryProduct();
                });
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

        let mmFollowupRows = [];

        function mmEsc(s) {
            return String(s == null ? "" : s)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;");
        }

        function mmFollowupRowKey(row) {
            return String(parseInt(row && row.sale_id, 10) || 0) + "|" + String((row && row.step_key) || "");
        }

        function mmRenderFollowups(d) {
            const rows = d && Array.isArray(d.followups) ? d.followups : [];
            mmFollowupRows = rows;
            const n = Number(d && d.followupCount != null ? d.followupCount : rows.length) || rows.length;
            const badge = document.getElementById("homeFollowupBadge");
            if (badge) {
                badge.textContent = String(n);
                badge.classList.toggle("hidden", n <= 0);
            }
            const banner = document.getElementById("mmFollowupHomeBanner");
            const bannerText = document.getElementById("mmFollowupHomeBannerText");
            if (banner) banner.classList.toggle("hidden", n <= 0);
            if (bannerText) {
                bannerText.textContent = n === 1
                    ? "ریسالێ بو واتسئاپێ فرێکە"
                    : (n + " کریار: ریسالێ بو واتسئاپێ فرێکە");
            }
            const box = document.getElementById("followupContent");
            if (!box) return;
            if (!rows.length) {
                box.innerHTML = '<div class="detail-empty">ئێستا کریار نینە بۆ واتسئاپێ.<br><br>ل POS سووچێ پەیوەندیا پشتی فرۆتنێ ڤەکە، و کریار دڤێت ناڤ و تەلەفۆن هەبیت.</div>';
                return;
            }
            box.innerHTML = rows.map(function (row, idx) {
                const name = mmEsc(row.customer_name || "کریار");
                const items = mmEsc(row.item_names || "");
                const phoneOk = !!String(row.phone || "").trim();
                const wa = phoneOk
                    ? ('<button type="button" class="btn-wa" data-fu-wa="' + idx + '"><i class="fab fa-whatsapp"></i> واتسئاپ</button>')
                    : '<span class="mm-wa-items">تەلەفۆن نینە</span>';
                return '<div class="mm-wa-row">' +
                    '<div class="mm-wa-name">' + name + '</div>' +
                    (items ? ('<div class="mm-wa-items">' + items + '</div>') : '') +
                    '<div class="mm-wa-actions">' + wa +
                    '<button type="button" class="btn-done" data-fu-done="' + idx + '"><i class="fas fa-check"></i></button>' +
                    '</div></div>';
            }).join("");
        }

        function mmOpenFollowupWa(idx) {
            const row = mmFollowupRows[idx];
            if (!row || !row.phone) {
                showRefreshToast("تەلەفۆن نینە", true);
                return;
            }
            const url = "https://wa.me/" + String(row.phone).replace(/[^\d]/g, "") + "?text=" + encodeURIComponent(row.text || "");
            try { window.open(url, "_blank"); } catch (e) { window.location.href = url; }
        }

        async function mmAckFollowup(idx) {
            const row = mmFollowupRows[idx];
            if (!row || !activeChannelId) return;
            const key = mmFollowupRowKey(row);
            const ackData = {
                sale_id: row.sale_id,
                step_key: row.step_key,
                sale_ids: Array.isArray(row.sale_ids) ? row.sale_ids : [row.sale_id],
                at: Date.now()
            };
            const ackRef = doc(db, "pos_mobile_followup_ack", activeChannelId);
            try {
                await updateDoc(ackRef, { ["acks." + key]: ackData });
            } catch (e1) {
                try {
                    const payload = { acks: {} };
                    payload.acks[key] = ackData;
                    await setDoc(ackRef, payload, { merge: true });
                } catch (e2) {}
            }
            mmFollowupRows = mmFollowupRows.filter(function (_, i) { return i !== idx; });
            mmRenderFollowups({ followups: mmFollowupRows, followupCount: mmFollowupRows.length });
            showRefreshToast("هاتە نیشانەکرن");
        }

        const followupContentEl = document.getElementById("followupContent");
        if (followupContentEl) {
            followupContentEl.addEventListener("click", function (ev) {
                const waBtn = ev.target.closest ? ev.target.closest("[data-fu-wa]") : null;
                const doneBtn = ev.target.closest ? ev.target.closest("[data-fu-done]") : null;
                if (waBtn) mmOpenFollowupWa(parseInt(waBtn.getAttribute("data-fu-wa"), 10));
                if (doneBtn) mmAckFollowup(parseInt(doneBtn.getAttribute("data-fu-done"), 10));
            });
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
                mmRenderFollowups({ followups: [], followupCount: 0 });
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
            mmRenderFollowups(d);
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
                invContent.innerHTML = '<div class="detail-empty">هێشتا داتای کۆگە نییە.<br><br>لە POS: ڕێکخستن → Firebase sync چالاک بکە، پاشان Ctrl+F5.<br>دوای ≈٨ چرکە یان دوای جەرد/فرۆشتن داتا دێت.<br><br><button type="button" class="btn-ghost" onclick="document.getElementById(\'refreshBtn\')&&document.getElementById(\'refreshBtn\').click()" style="margin-top:8px;width:100%;"><i class="fas fa-arrows-rotate"></i> Refresh</button></div>';
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
            // Viewing inventory is 100% free - zero token deduction
            if (typeof populateEntryCategories === "function") populateEntryCategories();
            if (typeof populateEntryManufacturers === "function") populateEntryManufacturers();
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
            // NEVER deduct tokens during refresh, pull-to-refresh, or from cache
            if (!opts.fromCache && !opts.isRefresh && !refreshBusy && Array.isArray(data.sales) && data.sales.length > 0) {
                mmHandleDailySalesTokenDeduction(data, dayKey);
            }
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
                applyDashboardData(snaps[0].exists() ? snaps[0].data() : null, { silent: true, isRefresh: true });
                applyInventoryData(snaps[1].exists() ? snaps[1].data() : null, { silent: true, isRefresh: true });
                applyDebtData(snaps[2].exists() ? snaps[2].data() : null, { silent: true, isRefresh: true });
                applyDetailData(snaps[3].exists() ? snaps[3].data() : null, dayKey, { silent: true, isRefresh: true });
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
            }, () => {
                setStatus("هەڵەی Firebase", false);
                setTimeout(function () {
                    if (!navigator.onLine || !channelId) return;
                    getDocFromServer(ref).then(function (snap) {
                        applyDashboardData(snap.exists() ? snap.data() : null, { silent: true });
                        mmUpdateConnectionStatus({ live: true });
                    }).catch(function () {});
                }, 2500);
            });
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

        window.doLogin = doLogin;

        const themeBtn = document.getElementById("themeToggleBtn");
        const themeIcon = document.getElementById("themeIcon");
        function updateThemeIcon() {
            const isLight = document.documentElement.getAttribute("data-theme") === "light";
            themeIcon.className = isLight ? "fas fa-moon" : "fas fa-sun";
            themeIcon.style.color = isLight ? "#2563eb" : "#fbbf24";
        }
        updateThemeIcon();
        if (themeBtn) {
            themeBtn.addEventListener("click", () => {
                const newTheme = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
                if (newTheme === "light") document.documentElement.setAttribute("data-theme", "light");
                else document.documentElement.removeAttribute("data-theme");
                localStorage.setItem("pos_mobile_theme", newTheme);
                updateThemeIcon();
            });
        }

        const authForm = document.getElementById("authForm");
        if (authForm) {
            authForm.addEventListener("submit", (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                doLogin();
                return false;
            });
        }
        const loginBtn = document.getElementById("loginBtn");
        if (loginBtn) {
            loginBtn.addEventListener("click", (ev) => {
                ev.preventDefault();
                doLogin();
            });
        }
        if (tabHomeBtn) tabHomeBtn.addEventListener("click", () => switchMobileTab("home"));
        if (tabDashBtn) tabDashBtn.addEventListener("click", () => switchMobileTab("dash"));
        if (tabEntryBtn) tabEntryBtn.addEventListener("click", () => switchMobileTab("entry"));
        if (tabInvBtn) tabInvBtn.addEventListener("click", () => switchMobileTab("inv"));
        if (tabDebtBtn) tabDebtBtn.addEventListener("click", () => switchMobileTab("debt"));
        const homeGoEntry = document.getElementById("homeGoEntry");
        if (homeGoEntry) homeGoEntry.addEventListener("click", () => switchMobileTab("entry"));
        const invOpenEntryBtn = document.getElementById("invOpenEntryBtn");
        if (invOpenEntryBtn) invOpenEntryBtn.addEventListener("click", () => switchMobileTab("entry"));
        const homeGoDash = document.getElementById("homeGoDash");
        const homeGoInv = document.getElementById("homeGoInv");
        const homeGoDebt = document.getElementById("homeGoDebt");
        if (homeGoDash) homeGoDash.addEventListener("click", () => switchMobileTab("dash"));
        if (homeGoInv) homeGoInv.addEventListener("click", () => switchMobileTab("inv"));
        if (homeGoDebt) homeGoDebt.addEventListener("click", () => switchMobileTab("debt"));
        const homeGoFollowup = document.getElementById("homeGoFollowup");
        if (homeGoFollowup) homeGoFollowup.addEventListener("click", () => switchMobileTab("followup"));
        const followupBackHome = document.getElementById("followupBackHome");
        if (followupBackHome) followupBackHome.addEventListener("click", () => switchMobileTab("home"));
        const mmFollowupHomeBannerBtn = document.getElementById("mmFollowupHomeBannerBtn");
        if (mmFollowupHomeBannerBtn) mmFollowupHomeBannerBtn.addEventListener("click", () => switchMobileTab("followup"));
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
        if (typeof initMobileEntry === "function") initMobileEntry();

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

        /* =========================================================
           MOBILE MANAGER TOKEN ENGINE (وەکی ئەی ئای)
           ========================================================= */
        const MM_TOKEN_SALT = "LD_MM_2026_";
        let mmTokenState = null;

        function mmGetTokenStorageKey(channelId) {
            return "pos_mm_tokens_" + (channelId || activeChannelId || "default").toLowerCase();
        }

        function mmFormatTokenTime(ts) {
            if (!ts) return "";
            const d = new Date(ts);
            const now = new Date();
            const isToday = d.toDateString() === now.toDateString();
            const hours = String(d.getHours()).padStart(2, "0");
            const mins = String(d.getMinutes()).padStart(2, "0");
            const timeOnly = `${hours}:${mins}`;
            if (isToday) return `ئەمڕۆ ${timeOnly}`;
            const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            if (d.toDateString() === yesterday.toDateString()) return `دوێنێ ${timeOnly}`;
            const month = String(d.getMonth() + 1).padStart(2, "0");
            const day = String(d.getDate()).padStart(2, "0");
            return `${day}/${month} ${timeOnly}`;
        }

        function mmLoadTokenState(channelId) {
            const k = mmGetTokenStorageKey(channelId);
            let state = null;
            try {
                const s = localStorage.getItem(k);
                if (s) state = JSON.parse(s);
            } catch (e) {}

            const now = Date.now();
            const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

            if (!state || typeof state !== "object" || state.schemaVer !== 4) {
                const redeemed = (state && Array.isArray(state.redeemedCodes)) ? state.redeemedCodes : [];
                const bonus = (state && typeof state.bonusLimit === "number") ? state.bonusLimit : 0;
                state = {
                    schemaVer: 4,
                    tier: "basic",
                    baseLimit: 300,
                    bonusLimit: bonus,
                    used: 0,
                    periodStart: now,
                    resetsOn: now + thirtyDaysMs,
                    redeemedCodes: redeemed,
                    chargedSalesDates: {},
                    breakdown: {
                        entry_add: 0,
                        entry_edit: 0,
                        sales: 0,
                        debt: 0,
                        inv: 0
                    },
                    history: [{
                        time: now,
                        type: "plus",
                        cost: 300,
                        category: "reward",
                        title: "دیاریا مانگانە (۳۰۰ خاڵ)",
                        meta: "۳۰۰ خاڵی دیاری بۆ ۳۰ ڕۆژان — ڕیفرێش و بینین ١٠٠٪ خۆڕاییە"
                    }]
                };
                mmSaveTokenState(state, channelId);
            } else {
                if (typeof state.baseLimit !== "number" || state.baseLimit < 300) state.baseLimit = 300;
                if (typeof state.bonusLimit !== "number") state.bonusLimit = 0;
                if (typeof state.used !== "number") state.used = 0;
                if (!Array.isArray(state.redeemedCodes)) state.redeemedCodes = [];
                if (!state.chargedSalesDates || typeof state.chargedSalesDates !== "object") state.chargedSalesDates = {};
                if (!state.resetsOn || typeof state.resetsOn !== "number") {
                    state.periodStart = now;
                    state.resetsOn = now + thirtyDaysMs;
                }
                if (!state.breakdown || typeof state.breakdown !== "object") {
                    state.breakdown = { entry_add: 0, entry_edit: 0, sales: 0, debt: 0, inv: 0 };
                }
                if (!Array.isArray(state.history)) {
                    state.history = [];
                }
            }

            // Monthly Auto-Renewal Gift (وەکی ئەی ئای)
            if (now >= state.resetsOn) {
                state.periodStart = now;
                state.resetsOn = now + thirtyDaysMs;
                state.used = 0;
                state.chargedSalesDates = {};
                state.breakdown = { entry_add: 0, entry_edit: 0, sales: 0, debt: 0, inv: 0 };
                if (!Array.isArray(state.history)) state.history = [];
                state.history.unshift({
                    time: now,
                    type: "plus",
                    cost: state.baseLimit || 300,
                    category: "reward",
                    title: "دیاریا مانگانە (Monthly Gift)",
                    meta: `${state.baseLimit || 300} خاڵی خۆڕایی بۆ ۳۰ ڕۆژی نوێ`
                });
                mmSaveTokenState(state, channelId);
                setTimeout(() => {
                    showRefreshToast(`🎉 پیرۆزە! ${state.baseLimit || 300} خاڵی دیاریا مانگانە نوێ بووەوە!`, false);
                    playChime(true);
                }, 1000);
            }

            return state;
        }

        function mmSaveTokenState(state, channelId) {
            mmTokenState = state;
            const k = mmGetTokenStorageKey(channelId || activeChannelId);
            try {
                localStorage.setItem(k, JSON.stringify(state));
            } catch (e) {}
        }

        function mmGetTokensRemaining(state) {
            const st = state || mmTokenState || mmLoadTokenState();
            const total = (st.baseLimit || 150) + (st.bonusLimit || 0);
            return Math.max(0, total - (st.used || 0));
        }

        function mmUpdateTokenUI() {
            const st = mmTokenState || mmLoadTokenState();
            const total = (st.baseLimit || 150) + (st.bonusLimit || 0);
            const used = Math.min(total, st.used || 0);
            const remaining = Math.max(0, total - used);
            const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;

            const scoreEl = document.getElementById("mmTokenScoreText");
            if (scoreEl) scoreEl.textContent = `${used} / ${total}`;

            const topChip = document.getElementById("topbarTokenChip");
            const topVal = document.getElementById("topbarTokenVal");
            if (topVal) topVal.textContent = remaining;
            if (topChip && activeChannelId) topChip.classList.remove("hidden");

            const barEl = document.getElementById("mmTokenBarFill");
            if (barEl) {
                barEl.style.width = pct + "%";
                if (remaining <= 10) barEl.classList.add("warning");
                else barEl.classList.remove("warning");
            }

            const planBadge = document.getElementById("mmTokenPlanBadge");
            if (planBadge) {
                const planName = st.tier === "pro" ? "Pro · 600/30 ڕۆژ" : "Basic · 300/30 ڕۆژ";
                planBadge.textContent = planName;
            }

            const resetHint = document.getElementById("mmTokenResetHint");
            if (resetHint && st.resetsOn) {
                const d = new Date(st.resetsOn);
                const dayStr = String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0");
                resetHint.textContent = `نوێدەبێتەوە ${dayStr} · 30 ڕۆژ`;
            }

            const remHint = document.getElementById("mmTokenRemainingHint");
            if (remHint) {
                remHint.textContent = `${remaining} ماوە`;
                remHint.style.color = remaining <= 10 ? "#ef4444" : "#38bdf8";
            }

            // 1. Render Analytics Breakdown (% چەند ژ ١٠٠ ل کیڤە چوونە)
            const totalUsedEl = document.getElementById("mmAnalyticsTotalUsed");
            if (totalUsedEl) totalUsedEl.textContent = `کۆی مەسرەفبوو: ${used} خاڵ`;

            const breakdownListEl = document.getElementById("mmCatBreakdownList");
            if (breakdownListEl) {
                if (used <= 0) {
                    breakdownListEl.innerHTML = `
                        <div class="detail-empty" style="padding:14px 6px;text-align:center;color:var(--muted);font-size:0.8rem;">
                            <i class="fas fa-sparkles" style="color:#10b981;display:block;font-size:1.4rem;margin-bottom:6px;"></i>
                            هێشتا هیچ خاڵێک مەسرەف نەکراوە (٠%) — هەموو <strong>${total}</strong> خاڵ ماون!
                        </div>
                    `;
                } else {
                    const catConfigs = [
                        { key: "entry_add", label: "ئیدخالکرنا کاڵایێ نوێ (Add Item)", icon: '<i class="fas fa-plus-circle" style="color:#10b981;"></i>', cls: "entry-add" },
                        { key: "entry_edit", label: "دەستکاریکرنا کاڵایان (Edit Item)", icon: '<i class="fas fa-pen-to-square" style="color:#0ea5e9;"></i>', cls: "entry-edit" },
                        { key: "sales", label: "داتایێن فرۆتنێ (Daily Sales Sync)", icon: '<i class="fas fa-chart-line" style="color:#f59e0b;"></i>', cls: "sales" },
                        { key: "debt", label: "قەرز و حسابات (Debt Sync)", icon: '<i class="fas fa-scale-balanced" style="color:#ef4444;"></i>', cls: "debt" },
                        { key: "inv", label: "کۆگەهـ و مەخزەن (Warehouse Sync)", icon: '<i class="fas fa-boxes-stacked" style="color:#a855f7;"></i>', cls: "inv" }
                    ];

                    const bd = st.breakdown || {};
                    breakdownListEl.innerHTML = catConfigs.map(cat => {
                        const pts = bd[cat.key] || 0;
                        const pctOfUsed = used > 0 ? Math.round((pts / used) * 100) : 0;
                        return `
                            <div class="mm-cat-item">
                                <div class="mm-cat-header">
                                    <span class="mm-cat-label">${cat.icon} <span>${cat.label}</span></span>
                                    <div class="mm-cat-meta">
                                        <span class="mm-cat-pts">${pts} خاڵ</span>
                                        <span class="mm-cat-pct-badge pct-${cat.cls}">${pctOfUsed}%</span>
                                    </div>
                                </div>
                                <div class="mm-cat-bar">
                                    <div class="mm-cat-bar-fill bar-${cat.cls}" style="width: ${pctOfUsed}%;"></div>
                                </div>
                            </div>
                        `;
                    }).join("");
                }
            }

            // 2. Render Transaction History Log
            const historyBadge = document.getElementById("mmHistoryCountBadge");
            const historyListEl = document.getElementById("mmTokenHistoryList");
            const hist = Array.isArray(st.history) ? st.history : [];
            if (historyBadge) historyBadge.textContent = `${hist.length} کردار`;
            if (historyListEl) {
                if (!hist.length) {
                    historyListEl.innerHTML = `<div class="mm-history-empty"><i class="fas fa-circle-check" style="color:#10b981;font-size:1.5rem;margin-bottom:6px;display:block;"></i> هێشتا هیچ کردارەک ئەنجام نەدایە</div>`;
                } else {
                    historyListEl.innerHTML = hist.map(item => {
                        const isPlus = item.type === "plus";
                        const sign = isPlus ? "+" : "−";
                        const costCls = isPlus ? "plus" : "minus";
                        const timeFormatted = mmFormatTokenTime(item.time);
                        let iconHtml = '<i class="fas fa-coins" style="color:#fbbf24;"></i>';
                        if (item.category === "entry_add") iconHtml = '<i class="fas fa-plus-circle" style="color:#10b981;"></i>';
                        else if (item.category === "entry_edit") iconHtml = '<i class="fas fa-pen-to-square" style="color:#0ea5e9;"></i>';
                        else if (item.category === "sales") iconHtml = '<i class="fas fa-chart-line" style="color:#f59e0b;"></i>';
                        else if (item.category === "debt") iconHtml = '<i class="fas fa-scale-balanced" style="color:#ef4444;"></i>';
                        else if (item.category === "inv") iconHtml = '<i class="fas fa-boxes-stacked" style="color:#a855f7;"></i>';
                        else if (item.category === "reward") iconHtml = '<i class="fas fa-gift" style="color:#10b981;"></i>';
                        else if (item.category === "redeem") iconHtml = '<i class="fas fa-key" style="color:#a855f7;"></i>';

                        return `
                            <div class="mm-history-item">
                                <div style="font-size:1.1rem;display:flex;align-items:center;min-width:24px;">${iconHtml}</div>
                                <div class="mm-history-info">
                                    <div class="mm-history-title">${esc(item.title || "کردار")}</div>
                                    <div class="mm-history-meta">
                                        <span><i class="far fa-clock"></i> ${timeFormatted}</span>
                                        ${item.meta ? `<span>· ${esc(item.meta)}</span>` : ""}
                                    </div>
                                </div>
                                <div class="mm-history-cost ${costCls}">${sign}${item.cost} خاڵ</div>
                            </div>
                        `;
                    }).join("");
                }
            }
        }

        function mmCanSpendTokens(cost, actionName) {
            const st = mmTokenState || mmLoadTokenState();
            const remaining = mmGetTokensRemaining(st);
            if (remaining < cost) {
                mmShowTokenExhaustedModal(cost, remaining, actionName);
                return false;
            }
            return true;
        }

        function mmDeductTokens(category, cost, actionName, metaDetail, silentToast = false) {
            if (typeof category === "number") {
                metaDetail = actionName;
                actionName = cost;
                cost = category;
                category = "entry_add";
            }
            const st = mmTokenState || mmLoadTokenState();
            st.used = (st.used || 0) + cost;

            if (!st.breakdown || typeof st.breakdown !== "object") {
                st.breakdown = { entry_add: 0, entry_edit: 0, sales: 0, debt: 0, inv: 0 };
            }
            st.breakdown[category] = (st.breakdown[category] || 0) + cost;

            if (!Array.isArray(st.history)) st.history = [];
            st.history.unshift({
                time: Date.now(),
                type: "minus",
                cost: cost,
                category: category,
                title: actionName || "کردار",
                meta: metaDetail || ""
            });
            if (st.history.length > 60) st.history.length = 60;

            mmSaveTokenState(st);
            mmUpdateTokenUI();
            if (!silentToast) {
                showRefreshToast(`−${cost} خاڵ مەسرەف بوو (${actionName || ""})`, false);
            }
        }

        function mmShowTokenExhaustedModal(cost, remaining, actionName) {
            const modal = document.getElementById("mmTokenModal");
            const desc = document.getElementById("mmTokenModalDesc");
            if (desc) {
                desc.innerHTML = `سنوورا خاڵێن تە ل سەر مۆبایلێ تەواو بوو (تەنها <strong>${remaining}</strong> خاڵ ماون).<br>کرداری «<strong>${actionName || "مۆبایل"}</strong>» پێویستی ب <strong>${cost}</strong> خاڵ هەیە.`;
            }
            if (modal) modal.classList.remove("hidden");
            if (navigator.vibrate) navigator.vibrate([100, 80, 100]);
        }

        function mmCloseTokenModal() {
            const modal = document.getElementById("mmTokenModal");
            if (modal) modal.classList.add("hidden");
        }

        function mmVerifyCodeOffline(codeStr) {
            const clean = String(codeStr || "").trim().toUpperCase();
            const parts = clean.split("-");
            if (parts.length === 4 && parts[0] === "MM") {
                const total = parseInt(parts[1], 10);
                const rand = parts[2];
                const check = parts[3];
                if (total > 0 && rand && check) {
                    const salt = MM_TOKEN_SALT + total + "_" + rand;
                    let hash = 0;
                    for (let i = 0; i < salt.length; i++) {
                        hash = ((hash << 5) - hash) + salt.charCodeAt(i);
                        hash |= 0;
                    }
                    const expected = Math.abs(hash).toString(36).toUpperCase().padStart(4, "X").slice(0, 4);
                    if (check === expected) {
                        return { valid: true, points: total };
                    }
                }
            }
            if (/^AI[A-Z0-9]{10}$/.test(clean)) {
                return { valid: true, points: 170 };
            }
            return { valid: false };
        }

        async function mmRedeemTokenCode(codeRaw, isModal = false) {
            const code = String(codeRaw || "").trim().toUpperCase();
            const msgEl = document.getElementById(isModal ? "mmTokenModalMsg" : "mmTokenRedeemMsg");
            if (!code) {
                if (msgEl) {
                    msgEl.className = "mm-token-redeem-msg error";
                    msgEl.textContent = "تکایە کۆدی چالاککردن بنووسە.";
                    msgEl.style.display = "block";
                }
                return;
            }

            const st = mmTokenState || mmLoadTokenState();
            if (st.redeemedCodes && st.redeemedCodes.includes(code)) {
                if (msgEl) {
                    msgEl.className = "mm-token-redeem-msg error";
                    msgEl.textContent = "ئەم کۆدە پێشتر بەکارهاتووە.";
                    msgEl.style.display = "block";
                }
                return;
            }

            let pointsAdded = 0;
            const posBase = guessPosBase();
            if (posBase && window.location.protocol !== "https:") {
                try {
                    const fd = new FormData();
                    fd.append("action", "redeem_token_code");
                    fd.append("code", code);
                    fd.append("email", activeChannelId || "");
                    const res = await fetch(posBase + "/mobile_entry.php", { method: "POST", body: fd });
                    const json = await res.json();
                    if (json && json.status === "success" && json.points) {
                        pointsAdded = parseInt(json.points, 10);
                    }
                } catch (e) {}
            }

            if (!pointsAdded) {
                const offCheck = mmVerifyCodeOffline(code);
                if (offCheck.valid && offCheck.points) {
                    pointsAdded = offCheck.points;
                }
            }

            if (!pointsAdded) {
                if (msgEl) {
                    msgEl.className = "mm-token-redeem-msg error";
                    msgEl.textContent = "کۆد هەڵەیە یان نەناسراوە. تکایە دڵنیابە لە کۆدەکەت.";
                    msgEl.style.display = "block";
                }
                if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
                return;
            }

            st.bonusLimit = (st.bonusLimit || 0) + pointsAdded;
            if (!st.redeemedCodes) st.redeemedCodes = [];
            st.redeemedCodes.push(code);

            if (!Array.isArray(st.history)) st.history = [];
            st.history.unshift({
                time: Date.now(),
                type: "plus",
                cost: pointsAdded,
                category: "redeem",
                title: "کۆدی خاڵان",
                meta: `کۆد: ${code} (+${pointsAdded} خاڵ)`
            });
            if (st.history.length > 60) st.history.length = 60;

            mmSaveTokenState(st);
            mmUpdateTokenUI();

            if (msgEl) {
                msgEl.className = "mm-token-redeem-msg success";
                msgEl.textContent = `🎉 پیرۆزە! +${pointsAdded} خاڵ بە سەرکەوتوویی زیاد کرا!`;
                msgEl.style.display = "block";
            }

            playChime(true);
            if (navigator.vibrate) navigator.vibrate([80, 50, 120]);

            const inp1 = document.getElementById("mmTokenCodeInput");
            const inp2 = document.getElementById("mmTokenModalCodeInp");
            if (inp1) inp1.value = "";
            if (inp2) inp2.value = "";

            if (isModal) {
                setTimeout(() => { mmCloseTokenModal(); }, 1500);
            }
        }

        function mmHandleDailySalesTokenDeduction(data, dayKey) {
            // 1. NEVER deduct tokens during refresh, pull-to-refresh, or background busy state!
            if (refreshBusy) return;
            const salesCount = (data && Array.isArray(data.sales)) ? data.sales.length : 0;
            if (salesCount <= 0) return;
            const bizDate = String(data?.meta?.businessDate || dayKey || "").trim();
            if (!bizDate) return;

            const st = mmTokenState || mmLoadTokenState();
            st.chargedSalesDates = st.chargedSalesDates || {};

            // 2. 100% PERSISTENT LOCK: Deduct AT MOST ONCE per calendar day!
            // If already charged for this business date, NEVER charge again!
            if (st.chargedSalesDates[bizDate]) return;

            st.chargedSalesDates[bizDate] = true;
            st.lastSalesDate = bizDate;
            st.lastSalesSyncTime = Date.now();

            // 3. Fair single token per entire calendar date (regardless of sales count)
            const cost = 1;

            if (mmCanSpendTokens(cost, "داتای فرۆشتنی ئەمڕۆ")) {
                const detailMeta = `${salesCount} وەسڵ · هەموو ڕۆژەکە بە ١ خاڵ (${bizDate})`;
                mmDeductTokens("sales", cost, "فرۆشتنی ڕۆژانە", detailMeta, true);
            }
        }

        // Viewing debt and warehouse is 100% free - zero token deduction
        function mmHandleDebtTokenDeduction() {}
        function mmHandleInventoryTokenDeduction() {}

        function initMobileTokens(channelId) {
            mmTokenState = mmLoadTokenState(channelId);
            mmUpdateTokenUI();

            const topChip = document.getElementById("topbarTokenChip");
            if (topChip && !topChip.__bound) {
                topChip.__bound = true;
                topChip.addEventListener("click", () => {
                    switchMobileTab("home");
                    const card = document.getElementById("mmTokenCard");
                    if (card) {
                        card.scrollIntoView({ behavior: "smooth", block: "start" });
                        const subtabAnalytics = document.querySelector('.mm-token-subtab-btn[data-tab="analytics"]');
                        if (subtabAnalytics) subtabAnalytics.click();
                    }
                });
            }

            // Subtab navigation inside Token Card
            document.querySelectorAll(".mm-token-subtab-btn").forEach(btn => {
                if (!btn.__bound) {
                    btn.__bound = true;
                    btn.addEventListener("click", () => {
                        const tab = btn.getAttribute("data-tab");
                        document.querySelectorAll(".mm-token-subtab-btn").forEach(b => b.classList.remove("active"));
                        btn.classList.add("active");

                        const viewAnalytics = document.getElementById("mmTokenViewAnalytics");
                        const viewHistory = document.getElementById("mmTokenViewHistory");
                        const viewPacks = document.getElementById("mmTokenViewPacks");
                        const viewRules = document.getElementById("mmTokenViewRules");

                        if (viewAnalytics) viewAnalytics.style.display = tab === "analytics" ? "block" : "none";
                        if (viewHistory) viewHistory.style.display = tab === "history" ? "block" : "none";
                        if (viewPacks) viewPacks.style.display = tab === "packs" ? "block" : "none";
                        if (viewRules) viewRules.style.display = tab === "rules" ? "block" : "none";

                        if (tab === "analytics" || tab === "history") {
                            mmUpdateTokenUI();
                        }
                    });
                }
            });

            const redeemBtn = document.getElementById("mmTokenRedeemBtn");
            const codeInp = document.getElementById("mmTokenCodeInput");
            if (redeemBtn && !redeemBtn.__bound) {
                redeemBtn.__bound = true;
                redeemBtn.addEventListener("click", () => {
                    mmRedeemTokenCode(codeInp ? codeInp.value : "", false);
                });
            }
            if (codeInp && !codeInp.__bound) {
                codeInp.__bound = true;
                codeInp.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        mmRedeemTokenCode(codeInp.value, false);
                    }
                });
            }

            const modalRedeemBtn = document.getElementById("mmTokenModalRedeemBtn");
            const modalCodeInp = document.getElementById("mmTokenModalCodeInp");
            const modalCloseBtn = document.getElementById("mmTokenModalCloseBtn");
            if (modalRedeemBtn && !modalRedeemBtn.__bound) {
                modalRedeemBtn.__bound = true;
                modalRedeemBtn.addEventListener("click", () => {
                    mmRedeemTokenCode(modalCodeInp ? modalCodeInp.value : "", true);
                });
            }
            if (modalCodeInp && !modalCodeInp.__bound) {
                modalCodeInp.__bound = true;
                modalCodeInp.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        mmRedeemTokenCode(modalCodeInp.value, true);
                    }
                });
            }
            if (modalCloseBtn && !modalCloseBtn.__bound) {
                modalCloseBtn.__bound = true;
                modalCloseBtn.addEventListener("click", mmCloseTokenModal);
            }

            document.querySelectorAll(".mm-token-pack-card").forEach((card) => {
                if (!card.__bound) {
                    card.__bound = true;
                    card.addEventListener("click", () => {
                        const packKey = card.getAttribute("data-pack");
                        let packText = "+100 خاڵ · $4";
                        if (packKey === "mm200") packText = "+200 خاڵ · $8";
                        if (packKey === "mm400") packText = "+400 خاڵ · $12";
                        showRefreshToast(`پاکێتی ${packText} هەڵبژێردرا. تکایە کۆدی کڕین چالاک بکە.`, false);
                        if (codeInp) codeInp.focus();
                    });
                }
            });
        }

        const appShell = document.getElementById("appShell");

        onAuthStateChanged(auth, async (user) => {
            if (mmSwitchingShop && !user) return;
            if (!user || !user.email) {
                activeChannelId = "";
                mmHasLocalCache = false;
                mmLastCacheSavedAt = null;
                if (appShell) appShell.classList.remove("is-logged-in");
                if (refreshBtn) refreshBtn.classList.add("hidden");
                const topChip = document.getElementById("topbarTokenChip");
                if (topChip) topChip.classList.add("hidden");
                if (unsub) { unsub(); unsub = null; }
                if (unsubDetail) { unsubDetail(); unsubDetail = null; }
                if (unsubInventory) { unsubInventory(); unsubInventory = null; }
                if (unsubDebt) { unsubDebt(); unsubDebt = null; }
                if (unsubBackup) { unsubBackup(); unsubBackup = null; }
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
            const savedTab = (function () {
                if (location.hash === "#entry" || location.hash === "#inv" || location.hash === "#dash" || location.hash === "#debt") {
                    return location.hash.replace("#", "");
                }
                try {
                    return localStorage.getItem("pos_mobile_tab") || "home";
                } catch (e) { return "home"; }
            })();
            switchMobileTab(
                savedTab === "backup" ? "backup" :
                savedTab === "debt" ? "debt" :
                savedTab === "inv" ? "inv" :
                savedTab === "entry" ? "entry" :
                savedTab === "dash" ? "dash" : "home"
            );
            const channelId = user.email.toLowerCase();
            activeChannelId = channelId;
            initMobileTokens(channelId);
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
