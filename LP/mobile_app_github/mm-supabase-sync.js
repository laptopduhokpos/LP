/**
 * Mobile Manager — Supabase (CDN fallback for phones worldwide).
 */
const MM_POLL_MS = 12000;
const MM_FETCH_RETRIES = 3;
const SDK_URLS = [
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm",
    "https://esm.sh/@supabase/supabase-js@2.49.1",
    "https://unpkg.com/@supabase/supabase-js@2.49.1/dist/module/index.js"
];

let createClientFn = null;
let sb = null;
let sbCfg = null;
let sdkLoadPromise = null;

async function mmSbLoadSdk() {
    if (createClientFn) return createClientFn;
    if (sdkLoadPromise) return sdkLoadPromise;
    sdkLoadPromise = (async function () {
        let lastErr = null;
        for (let i = 0; i < SDK_URLS.length; i++) {
            try {
                const mod = await import(/* @vite-ignore */ SDK_URLS[i]);
                if (mod && typeof mod.createClient === "function") {
                    createClientFn = mod.createClient;
                    return createClientFn;
                }
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr || new Error("supabase_sdk_load_failed");
    })();
    return sdkLoadPromise;
}

export async function mmSbEnsureReady() {
    return mmSbLoadSdk();
}

export function mmSbEnabled() {
    const backend = String(window.MM_SYNC_BACKEND || "supabase").toLowerCase();
    if (backend === "firebase") return false;
    const c = window.POS_SUPABASE_MOBILE || {};
    return !!(c.enabled && c.url && c.anonKey);
}

export async function mmSbInit(cfg) {
    await mmSbLoadSdk();
    sbCfg = cfg || window.POS_SUPABASE_MOBILE || {};
    if (!sbCfg.url || !sbCfg.anonKey) return null;
    if (!sb) {
        sb = createClientFn(sbCfg.url, sbCfg.anonKey, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
        });
    }
    return sb;
}

export function mmSbClient() {
    if (!sb && mmSbEnabled() && createClientFn && sbCfg && sbCfg.url) {
        sb = createClientFn(sbCfg.url, sbCfg.anonKey, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
        });
    }
    return sb;
}

export function mmSbRowToDoc(row) {
    if (!row) return null;
    const d = row.data && typeof row.data === "object" ? Object.assign({}, row.data) : {};
    if (row.updated_at) {
        const ts = new Date(row.updated_at);
        d.updatedAt = { toDate: function () { return ts; } };
    }
    return d;
}

function mmSbSleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function mmSbQueryWithRetry(run) {
    let lastErr = null;
    for (let i = 0; i < MM_FETCH_RETRIES; i++) {
        try {
            const res = await run();
            if (res && res.error) throw res.error;
            return res;
        } catch (e) {
            lastErr = e;
            if (i < MM_FETCH_RETRIES - 1) await mmSbSleep(350 * (i + 1));
        }
    }
    throw lastErr || new Error("fetch_failed");
}

export async function mmSbSignIn(email, password) {
    await mmSbInit(window.POS_SUPABASE_MOBILE);
    const client = mmSbClient();
    if (!client) throw new Error("supabase_not_configured");
    const em = String(email || "").trim().toLowerCase();
    return client.auth.signInWithPassword({ email: em, password: password || "" });
}

export async function mmSbSignOut() {
    const client = mmSbClient();
    if (!client) return;
    return client.auth.signOut();
}

export async function mmSbGetSessionEmail() {
    await mmSbInit(window.POS_SUPABASE_MOBILE);
    const client = mmSbClient();
    if (!client) return "";
    const { data } = await client.auth.getSession();
    const u = data && data.session && data.session.user;
    return u && u.email ? String(u.email).toLowerCase() : "";
}

function mmSbBindTable(opts) {
    let stopped = false;
    let pollId = null;
    let teardown = function () {};

    mmSbInit(window.POS_SUPABASE_MOBILE).then(function (client) {
        if (stopped || !client) return;
        const ch = String(opts.channelId || "").trim().toLowerCase();
        const table = opts.table;
        const channelKey = opts.channelKey || "channel_id";
        const dayKey = opts.dayKey != null ? String(opts.dayKey) : "";
        const rtName = opts.rtName || ("mm-" + table + "-" + ch);

        function pull() {
            if (stopped) return;
            let q = client.from(table).select("data, updated_at").eq(channelKey, ch);
            if (opts.dayKey != null) q = q.eq("day_key", dayKey);
            mmSbQueryWithRetry(function () { return q.maybeSingle(); })
                .then(function (res) {
                    if (stopped) return;
                    opts.onData(mmSbRowToDoc(res.data));
                })
                .catch(function (err) {
                    if (!stopped && opts.onErr) opts.onErr(err);
                });
        }

        pull();
        pollId = setInterval(pull, MM_POLL_MS);

        const rt = client.channel(rtName)
            .on("postgres_changes", {
                event: "*",
                schema: "public",
                table: table,
                filter: channelKey + "=eq." + ch
            }, function (payload) {
                if (stopped || !payload.new) return;
                if (opts.dayKey != null && String(payload.new.day_key) !== dayKey) return;
                opts.onData(mmSbRowToDoc(payload.new));
            })
            .subscribe();

        teardown = function () {
            stopped = true;
            if (pollId) clearInterval(pollId);
            try { client.removeChannel(rt); } catch (e) {}
        };
    }).catch(function (err) {
        if (opts.onErr) opts.onErr(err);
    });

    return function () {
        stopped = true;
        if (pollId) clearInterval(pollId);
        teardown();
    };
}

export function mmSbBindDashboard(channelId, onData, onErr) {
    return mmSbBindTable({
        channelId: channelId,
        table: "pos_mobile_dashboard",
        rtName: "mm-dash-" + String(channelId || "").trim().toLowerCase(),
        onData: onData,
        onErr: onErr
    });
}

export function mmSbBindInventory(channelId, onData, onErr) {
    return mmSbBindTable({
        channelId: channelId,
        table: "pos_mobile_inventory",
        rtName: "mm-inv-" + String(channelId || "").trim().toLowerCase(),
        onData: onData,
        onErr: onErr
    });
}

export function mmSbBindDebt(channelId, onData, onErr) {
    return mmSbBindTable({
        channelId: channelId,
        table: "pos_mobile_debt",
        rtName: "mm-debt-" + String(channelId || "").trim().toLowerCase(),
        onData: onData,
        onErr: onErr
    });
}

export function mmSbBindDetail(channelId, dayKey, onData, onErr) {
    const ch = String(channelId || "").trim().toLowerCase();
    const dk = String(dayKey || "");
    return mmSbBindTable({
        channelId: ch,
        table: "pos_mobile_daily_detail",
        dayKey: dk,
        rtName: "mm-detail-" + ch + "-" + dk,
        onData: onData,
        onErr: onErr
    });
}

export function mmSbOnAuthStateChange(cb) {
    let unsub = function () {};
    mmSbInit(window.POS_SUPABASE_MOBILE).then(function (client) {
        if (!client) return;
        const sub = client.auth.onAuthStateChange(function (_event, session) {
            cb(session && session.user ? session.user : null);
        });
        unsub = function () {
            try { sub.data.subscription.unsubscribe(); } catch (e) {}
        };
    }).catch(function () {});
    return function () { unsub(); };
}

export async function mmSbFetchAll(channelId, dayKey) {
    await mmSbInit(window.POS_SUPABASE_MOBILE);
    const client = mmSbClient();
    if (!client) throw new Error("supabase_not_configured");
    const ch = String(channelId || "").trim().toLowerCase();
    const dk = String(dayKey || "");
    const [dash, inv, debt, detail] = await Promise.all([
        mmSbQueryWithRetry(function () {
            return client.from("pos_mobile_dashboard").select("data, updated_at").eq("channel_id", ch).maybeSingle();
        }),
        mmSbQueryWithRetry(function () {
            return client.from("pos_mobile_inventory").select("data, updated_at").eq("channel_id", ch).maybeSingle();
        }),
        mmSbQueryWithRetry(function () {
            return client.from("pos_mobile_debt").select("data, updated_at").eq("channel_id", ch).maybeSingle();
        }),
        mmSbQueryWithRetry(function () {
            return client.from("pos_mobile_daily_detail").select("data, updated_at").eq("channel_id", ch).eq("day_key", dk).maybeSingle();
        })
    ]);
    return {
        dashboard: mmSbRowToDoc(dash.data),
        inventory: mmSbRowToDoc(inv.data),
        debt: mmSbRowToDoc(debt.data),
        detail: mmSbRowToDoc(detail.data)
    };
}
