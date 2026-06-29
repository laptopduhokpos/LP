/**
 * Supabase read layer for Mobile Manager (POS pushes via pos_mobile_sync.js).
 */
const MM_SB_POLL_MS = 5000;

function sbCfg() {
    return window.POS_SUPABASE_MOBILE || null;
}

export function mmSyncBackend() {
    return String(window.MM_SYNC_BACKEND || "supabase").toLowerCase();
}

export function mmSupabaseDataEnabled() {
    const b = mmSyncBackend();
    const c = sbCfg();
    const ok = !!(c && c.enabled !== false && c.url && c.anonKey);
    return ok && (b === "supabase" || b === "both");
}

export function mmFirebaseDataEnabled() {
    const b = mmSyncBackend();
    return b === "firebase" || b === "both";
}

export function mmSupabaseAuthPrimary() {
    return false;
}

function normalizeDocData(raw) {
    if (!raw || typeof raw !== "object") return raw;
    const out = Object.assign({}, raw);
    if (out.updatedAt && typeof out.updatedAt === "string") {
        out._updatedAtIso = out.updatedAt;
    } else if (out.pushedAt && typeof out.pushedAt === "string") {
        out._pushedAtIso = out.pushedAt;
    }
    return out;
}

let sbClient = null;
let sbLoadPromise = null;
let sbAuthSub = null;
let sbAuthCb = null;

function loadClient() {
    const c = sbCfg();
    if (!c || !c.url || !c.anonKey) {
        return Promise.reject(new Error("Missing POS_SUPABASE_MOBILE"));
    }
    if (sbClient) return Promise.resolve(sbClient);
    if (sbLoadPromise) return sbLoadPromise;
    sbLoadPromise = import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm")
        .catch(function () {
            return import("https://esm.sh/@supabase/supabase-js@2.49.1");
        })
        .then(function (mod) {
            sbClient = mod.createClient(c.url, c.anonKey, {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true,
                    detectSessionInUrl: false
                }
            });
            if (!sbAuthSub) {
                const sub = sbClient.auth.onAuthStateChange(function (event, session) {
                    if (typeof sbAuthCb === "function") {
                        const user = session && session.user ? { email: session.user.email } : null;
                        sbAuthCb(user);
                    }
                });
                sbAuthSub = function () {
                    try { sub.data.subscription.unsubscribe(); } catch (e) {}
                };
            }
            return sbClient;
        })
        .catch(function (err) {
            sbLoadPromise = null;
            throw err;
        });
    return sbLoadPromise;
}

export function mmSbSignIn(email, password) {
    const em = String(email || "").trim().toLowerCase();
    return loadClient().then(function (client) {
        return client.auth.signInWithPassword({ email: em, password: password || "" });
    }).then(function (res) {
        if (res.error) throw res.error;
        return res.data.session;
    });
}

export function mmSbSignOut() {
    if (!sbClient) return Promise.resolve();
    return sbClient.auth.signOut();
}

export function mmSbOnAuthStateChanged(cb) {
    sbAuthCb = cb;
    return loadClient()
        .then(function (client) {
            return client.auth.getSession().then(function (res) {
                const session = res && res.data ? res.data.session : null;
                const user = session && session.user ? { email: session.user.email } : null;
                cb(user);
            });
        })
        .catch(function () {
            cb(null);
        });
}

export function mmSbGetSessionUser() {
    if (!sbClient) return Promise.resolve(null);
    return sbClient.auth.getSession().then(function (res) {
        const session = res && res.data ? res.data.session : null;
        return session && session.user ? { email: session.user.email } : null;
    });
}

/** Hub refresh for secondary shops (isolated session per account). */
export async function mmSbHubFetchForAccount(email, password) {
    const c = sbCfg();
    if (!c || !c.url || !c.anonKey) throw new Error("Missing POS_SUPABASE_MOBILE");
    const mod = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm").catch(function () {
        return import("https://esm.sh/@supabase/supabase-js@2.49.1");
    });
    const key = String(email || "").trim().toLowerCase();
    const client = mod.createClient(c.url, c.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    const login = await client.auth.signInWithPassword({ email: key, password: password || "" });
    if (login.error) throw login.error;
    try {
        const [dash, inv] = await Promise.all([
            fetchDocWithClient(client, "pos_mobile_dashboard", key, null),
            fetchDocWithClient(client, "pos_mobile_inventory", key, null)
        ]);
        return { dash, inv };
    } finally {
        try { await client.auth.signOut(); } catch (e) {}
    }
}

async function fetchDocWithClient(client, table, channelId, dayKey) {
    let q = client.from(table).select("data, updated_at").eq("channel_id", channelId);
    if (dayKey) q = q.eq("day_key", dayKey);
    const res = await q.maybeSingle();
    if (res.error) throw res.error;
    if (!res.data || !res.data.data) return null;
    return normalizeDocData(res.data.data);
}

async function fetchDoc(table, channelId, dayKey) {
    const client = await loadClient();
    return fetchDocWithClient(client, table, channelId, dayKey);
}

/**
 * Subscribe to a mobile sync table row. Returns unsubscribe async function.
 */
export function mmSbBindRow(table, channelId, dayKey, applyFn) {
    let stopped = false;
    let pollId = null;
    let channel = null;
    const filter = dayKey
        ? "channel_id=eq." + channelId + ",day_key=eq." + dayKey
        : "channel_id=eq." + channelId;

    function deliver(data, opts) {
        if (stopped) return;
        applyFn(data, opts || { silent: false, fromCache: false });
    }

    function onErr() {
        if (stopped) return;
        deliver(null, { silent: true, fromCache: true });
    }

    loadClient().then(function (client) {
        if (stopped) return;
        fetchDoc(table, channelId, dayKey).then(function (data) {
            deliver(data, { silent: false, fromCache: false });
        }).catch(onErr);

        pollId = setInterval(function () {
            if (!navigator.onLine || stopped) return;
            fetchDoc(table, channelId, dayKey).then(function (data) {
                deliver(data, { silent: true, fromCache: false });
            }).catch(function () {});
        }, MM_SB_POLL_MS);

        const chName = "mm-" + table + "-" + channelId + (dayKey ? "-" + dayKey : "");
        channel = client.channel(chName);
        channel.on(
            "postgres_changes",
            { event: "*", schema: "public", table: table, filter: filter },
            function (payload) {
                if (payload.new && payload.new.data) {
                    deliver(normalizeDocData(payload.new.data), { silent: false, fromCache: false });
                }
            }
        );
        channel.subscribe();
    }).catch(onErr);

    return function () {
        stopped = true;
        if (pollId) clearInterval(pollId);
        if (sbClient && channel) {
            try { sbClient.removeChannel(channel); } catch (e) {}
        }
    };
}

export async function mmSbFetchAll(channelId, dayKey) {
    const [dash, inv, debt, detail] = await Promise.all([
        fetchDoc("pos_mobile_dashboard", channelId, null),
        fetchDoc("pos_mobile_inventory", channelId, null),
        fetchDoc("pos_mobile_debt", channelId, null),
        fetchDoc("pos_mobile_daily_detail", channelId, dayKey)
    ]);
    return { dash, inv, debt, detail };
}

/** Hub refresh for secondary shops (same Supabase project, per-account session). */
export async function mmSbFetchHubPair(email) {
    return mmSbHubFetchForAccount(email, "");
}
