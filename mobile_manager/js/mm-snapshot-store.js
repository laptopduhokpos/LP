/**
 * IndexedDB snapshot cache — offline-first Mobile Manager data layer.
 */
const MM_SNAP_DB = "ld-mobile-manager";
const MM_SNAP_STORE = "snapshots";
const MM_SNAP_KEY_PREFIX = "v1|";
const MM_SNAP_DEBOUNCE_MS = 400;

const snapWriteTimers = Object.create(null);
let snapDbPromise = null;

function mmSnapKey(channelId, docType) {
    return MM_SNAP_KEY_PREFIX + String(channelId || "").trim().toLowerCase() + "|" + String(docType || "");
}

function mmSerializeForStore(data) {
    return JSON.parse(JSON.stringify(data, function (_key, val) {
        if (val && typeof val === "object" && typeof val.toDate === "function") {
            return { __fsTimestamp: val.toDate().toISOString() };
        }
        if (val && typeof val === "object" && typeof val.seconds === "number" && typeof val.nanoseconds === "number") {
            return { __fsTimestamp: new Date(val.seconds * 1000 + val.nanoseconds / 1e6).toISOString() };
        }
        return val;
    }));
}

function mmRestoreTimestamps(val) {
    if (!val || typeof val !== "object") return val;
    if (Array.isArray(val)) return val.map(mmRestoreTimestamps);
    if (val.__fsTimestamp) {
        const iso = String(val.__fsTimestamp);
        return {
            toDate: function () { return new Date(iso); },
            toMillis: function () { return new Date(iso).getTime(); }
        };
    }
    const out = {};
    Object.keys(val).forEach(function (k) {
        out[k] = mmRestoreTimestamps(val[k]);
    });
    return out;
}

function mmOpenSnapDb() {
    if (!("indexedDB" in window)) {
        return Promise.reject(new Error("indexedDB unavailable"));
    }
    if (snapDbPromise) return snapDbPromise;
    snapDbPromise = new Promise(function (resolve, reject) {
        const req = indexedDB.open(MM_SNAP_DB, 1);
        req.onerror = function () {
            snapDbPromise = null;
            reject(req.error || new Error("indexedDB open failed"));
        };
        req.onupgradeneeded = function (e) {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(MM_SNAP_STORE)) {
                db.createObjectStore(MM_SNAP_STORE);
            }
        };
        req.onsuccess = function () { resolve(req.result); };
    });
    return snapDbPromise;
}

function mmSnapRead(key) {
    return mmOpenSnapDb().then(function (db) {
        return new Promise(function (resolve, reject) {
            const tx = db.transaction(MM_SNAP_STORE, "readonly");
            const req = tx.objectStore(MM_SNAP_STORE).get(key);
            req.onerror = function () { reject(req.error); };
            req.onsuccess = function () {
                const row = req.result;
                if (!row || !row.data) {
                    resolve(null);
                    return;
                }
                resolve({
                    data: mmRestoreTimestamps(row.data),
                    savedAt: row.savedAt || null,
                    updatedAt: row.updatedAt || null
                });
            };
        });
    });
}

function mmSnapWrite(key, payload) {
    return mmOpenSnapDb().then(function (db) {
        return new Promise(function (resolve, reject) {
            const tx = db.transaction(MM_SNAP_STORE, "readwrite");
            tx.oncomplete = function () { resolve(true); };
            tx.onerror = function () { reject(tx.error); };
            tx.objectStore(MM_SNAP_STORE).put(payload, key);
        });
    });
}

export function mmSnapDetailType(dayKey) {
    return "detail_" + String(dayKey || "");
}

export async function mmSnapSave(channelId, docType, data) {
    if (!channelId || !docType || !data) return false;
    const key = mmSnapKey(channelId, docType);
    const now = Date.now();
    let updatedAt = null;
    try {
        if (data.updatedAt && typeof data.updatedAt.toDate === "function") {
            updatedAt = data.updatedAt.toDate().toISOString();
        } else if (data.pushedAt && typeof data.pushedAt.toDate === "function") {
            updatedAt = data.pushedAt.toDate().toISOString();
        } else if (data.meta && data.meta.pushedAt) {
            updatedAt = String(data.meta.pushedAt);
        }
    } catch (e) {}
    try {
        await mmSnapWrite(key, {
            data: mmSerializeForStore(data),
            savedAt: now,
            updatedAt: updatedAt
        });
        return true;
    } catch (e) {
        return false;
    }
}

export function mmSnapSaveDebounced(channelId, docType, data) {
    if (!channelId || !docType || !data) return;
    const timerKey = mmSnapKey(channelId, docType);
    if (snapWriteTimers[timerKey]) clearTimeout(snapWriteTimers[timerKey]);
    snapWriteTimers[timerKey] = setTimeout(function () {
        delete snapWriteTimers[timerKey];
        mmSnapSave(channelId, docType, data).catch(function () {});
    }, MM_SNAP_DEBOUNCE_MS);
}

export async function mmSnapLoad(channelId, docType) {
    if (!channelId || !docType) return null;
    try {
        return await mmSnapRead(mmSnapKey(channelId, docType));
    } catch (e) {
        return null;
    }
}

export async function mmSnapLoadBundle(channelId, dayKey) {
    const detailType = mmSnapDetailType(dayKey);
    const types = ["dashboard", "inventory", "debt", detailType];
    const out = {
        dashboard: null,
        inventory: null,
        debt: null,
        detail: null,
        detailDayKey: dayKey,
        latestSavedAt: null
    };
    try {
        const rows = await Promise.all(types.map(function (t) { return mmSnapLoad(channelId, t); }));
        out.dashboard = rows[0];
        out.inventory = rows[1];
        out.debt = rows[2];
        out.detail = rows[3];
        rows.forEach(function (row) {
            if (row && row.savedAt && (!out.latestSavedAt || row.savedAt > out.latestSavedAt)) {
                out.latestSavedAt = row.savedAt;
            }
        });
    } catch (e) {}
    return out;
}

export async function mmSnapLoadHubBundle(channelId) {
    const rows = await Promise.all([
        mmSnapLoad(channelId, "dashboard"),
        mmSnapLoad(channelId, "inventory")
    ]);
    return {
        dashboard: rows[0],
        inventory: rows[1],
        latestSavedAt: Math.max(
            rows[0] && rows[0].savedAt ? rows[0].savedAt : 0,
            rows[1] && rows[1].savedAt ? rows[1].savedAt : 0
        ) || null
    };
}
