/**
 * Mobile Manager — Supabase read/sync (realtime + REST polling + retry).
 * Works globally: polling fallback when WebSocket/realtime is slow or blocked.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const MM_POLL_MS = 12000;
const MM_FETCH_RETRIES = 3;

let sb = null;
let sbCfg = null;

export function mmSbEnabled() {
    const backend = String(window.MM_SYNC_BACKEND || "supabase").toLowerCase();
    if (backend === "firebase") return false;
    const c = window.POS_SUPABASE_MOBILE || {};
    return !!(c.enabled && c.url && c.anonKey);
}

export function mmSbInit(cfg) {
    sbCfg = cfg || window.POS_SUPABASE_MOBILE || {};
    if (!sbCfg.url || !sbCfg.anonKey) return null;
    if (!sb) {
        sb = createClient(sbCfg.url, sbCfg.anonKey, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
        });
    }
    return sb;
}

export function mmSbClient() {
    if (!sb && mmSbEnabled()) mmSbInit(window.POS_SUPABASE_MOBILE);
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
    const client = mmSbClient();
    if (!client) return "";
    const { data } = await client.auth.getSession();
    const u = data && data.session && data.session.user;
    return u && u.email ? String(u.email).toLowerCase() : "";
}

function mmSbBindTable(opts) {
    const client = mmSbClient();
    if (!client) return function () {};
    const ch = String(opts.channelId || "").trim().toLowerCase();
    const table = opts.table;
    const channelKey = opts.channelKey || "channel_id";
    const dayKey = opts.dayKey != null ? String(opts.dayKey) : "";
    const rtName = opts.rtName || ("mm-" + table + "-" + ch);
    let stopped = false;

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
    const pollId = setInterval(pull, MM_POLL_MS);

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

    return function () {
        stopped = true;
        clearInterval(pollId);
        try { client.removeChannel(rt); } catch (e) {}
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
    const client = mmSbClient();
    if (!client) return function () {};
    const sub = client.auth.onAuthStateChange(function (_event, session) {
        cb(session && session.user ? session.user : null);
    });
    return function () {
        try { sub.data.subscription.unsubscribe(); } catch (e) {}
    };
}

export async function mmSbFetchAll(channelId, dayKey) {
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
