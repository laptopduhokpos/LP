/**
 * Jewelry item entry for LD Manager.
 * Loaded only when the connected shop is systemMode=jewelry.
 * Market shops never import this file.
 */
const GOLD_KARATS = [18, 21, 22, 24];
const SILVER_DEFAULTS = ["925", "900", "800"];

let mmJewRates = null;
let mmJewReady = false;

function el(id) {
    return document.getElementById(id);
}

function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
}

function rateFor(metal, karat) {
    const r = mmJewRates || {};
    if (metal === "silver") {
        const grades = Array.isArray(r.silverGrades) ? r.silverGrades : [];
        const code = String(karat || "925");
        const g = grades.find((x) => String(x.code || x.karat) === code);
        if (g && Number(g.sell || g.rate) > 0) return Number(g.sell || g.rate);
        return Number(r.silver) || 0;
    }
    const k = Math.round(num(karat));
    if (k === 18) return Number(r.gold18) || 0;
    if (k === 21) return Number(r.gold21) || 0;
    if (k === 22) return Number(r.gold22) || 0;
    if (k === 24) return Number(r.gold24) || 0;
    return Number(r.gold21) || 0;
}

function fillKaratOptions() {
    const metal = (el("mmJewMetal") && el("mmJewMetal").value) || "silver";
    const karatEl = el("mmJewKarat");
    if (!karatEl) return;
    const prev = karatEl.value;
    if (metal === "gold") {
        karatEl.innerHTML = GOLD_KARATS.map((k) => `<option value="${k}">${k}</option>`).join("");
        karatEl.value = GOLD_KARATS.indexOf(Number(prev)) >= 0 ? String(Math.round(Number(prev))) : "21";
    } else {
        const grades = Array.isArray(mmJewRates && mmJewRates.silverGrades) ? mmJewRates.silverGrades : [];
        const codes = grades.length ? grades.map((g) => String(g.code || g.karat || "")).filter(Boolean) : SILVER_DEFAULTS.slice();
        karatEl.innerHTML = codes.map((c) => `<option value="${c}">${c}</option>`).join("");
        karatEl.value = codes.indexOf(String(prev)) >= 0 ? String(prev) : (codes[0] || "925");
    }
}

function syncKindUi() {
    const kind = (el("mmJewKind") && el("mmJewKind").value) || "metal";
    const metalBox = el("mmJewMetalFields");
    const unitWrap = document.querySelector("#mmEntryForm .entry-unit-toggle-wrap");
    const packCard = el("mmCardPack");
    const cartonCard = el("mmCardCarton");
    const isMetal = kind === "metal";
    if (metalBox) metalBox.style.display = isMetal ? "block" : "none";
    if (unitWrap) unitWrap.style.display = isMetal ? "none" : "";
    if (isMetal) {
        if (packCard) packCard.style.display = "none";
        if (cartonCard) cartonCard.style.display = "none";
    }
    previewPrice();
}

function previewPrice() {
    const hint = el("mmJewPreview");
    if (!hint) return;
    const kind = (el("mmJewKind") && el("mmJewKind").value) || "metal";
    if (kind !== "metal") {
        hint.textContent = "";
        return;
    }
    const mode = (el("mmJewPriceMode") && el("mmJewPriceMode").value) || "by_weight";
    const grams = num(el("mmJewWeight") && el("mmJewWeight").value);
    const making = num(el("mmJewMaking") && el("mmJewMaking").value);
    const metal = (el("mmJewMetal") && el("mmJewMetal").value) || "silver";
    const karat = (el("mmJewKarat") && el("mmJewKarat").value) || "";
    const rate = rateFor(metal, karat);
    if (mode === "by_weight" && grams > 0 && rate > 0) {
        const sell = Math.round(grams * rate + making);
        const priceEl = el("mmEntryPrice");
        if (priceEl && !priceEl.dataset.userPicked) priceEl.value = String(sell);
        hint.textContent = "فرۆشتن ≈ " + sell.toLocaleString("en-US") + " (گرام × نرخی ڕۆژ + کرێی کار)";
    } else if (mode === "by_weight") {
        hint.textContent = rate > 0 ? "گرام بنڤیسە — نرخ ژ ڕۆژانە دێت" : "نرخی ڕۆژ ل POS (ئایکۆنی زیڤ/زێر) دابنێ";
    } else {
        hint.textContent = "نرخێ جێگیر — ل خانا فرۆشتنێ بنڤیسە";
    }
}

function injectCard() {
    if (el("mmJewelryCard")) return;
    const form = el("mmEntryForm");
    const unitWrap = form && form.querySelector(".entry-unit-toggle-wrap");
    if (!form || !unitWrap) return;
    const box = document.createElement("div");
    box.id = "mmJewelryCard";
    box.style.cssText = "margin-bottom:14px;padding:12px;border:1px dashed #c9a227;border-radius:14px;background:rgba(201,162,39,0.10);";
    box.innerHTML = `
        <div style="font-weight:800;font-size:0.88rem;color:#c9a227;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
            <i class="fas fa-coins"></i> زیڤ و زێر
        </div>
        <div class="form-group" style="margin-bottom:8px;">
            <label class="field-label" for="mmJewKind">زیڤە یان جەدوەلی دانە؟</label>
            <select id="mmJewKind" class="input-std">
                <option value="metal" selected>زیڤ / زێر — بە گرام (نرخی ڕۆژانە)</option>
                <option value="piece">سەعات، قفڵ، قوطی — جەدوەلی دانە</option>
            </select>
        </div>
        <div id="mmJewMetalFields">
            <div class="grid-2-col" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
                <div class="form-group" style="margin:0;">
                    <label class="field-label" for="mmJewMetal">مەعدەن</label>
                    <select id="mmJewMetal">
                        <option value="silver" selected>زیڤ</option>
                        <option value="gold">زێر</option>
                    </select>
                </div>
                <div class="form-group" style="margin:0;">
                    <label class="field-label" for="mmJewKarat">دەرجە / عیار</label>
                    <select id="mmJewKarat"></select>
                </div>
            </div>
            <div class="grid-2-col" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
                <div class="form-group" style="margin:0;">
                    <label class="field-label" for="mmJewWeight">کێش (گرام)</label>
                    <input id="mmJewWeight" type="number" min="0" step="0.001" placeholder="0.000" inputmode="decimal" dir="ltr">
                </div>
                <div class="form-group" style="margin:0;">
                    <label class="field-label" for="mmJewMaking">کرێی کار</label>
                    <input id="mmJewMaking" type="number" min="0" step="1" placeholder="0" inputmode="numeric" dir="ltr">
                </div>
            </div>
            <div class="form-group" style="margin-bottom:6px;">
                <label class="field-label" for="mmJewPriceMode">شێوازێ نرخێ</label>
                <select id="mmJewPriceMode">
                    <option value="by_weight" selected>بە گرام (نرخی ڕۆژانە)</option>
                    <option value="fixed">نرخێ جێگیر</option>
                </select>
            </div>
            <p id="mmJewPreview" style="margin:0;font-size:0.75rem;color:#c9a227;"></p>
            <p style="margin:6px 0 0;font-size:0.72rem;color:var(--muted);">نرخی کڕینی گرام ل POS (ئایکۆنی زیڤ/زێر) دابنێ — لێرە پێویست نییە.</p>
        </div>
    `;
    form.insertBefore(box, unitWrap);
    const bind = (id, ev, fn) => {
        const n = el(id);
        if (n) n.addEventListener(ev, fn);
    };
    bind("mmJewKind", "change", syncKindUi);
    bind("mmJewMetal", "change", () => { fillKaratOptions(); previewPrice(); });
    bind("mmJewKarat", "change", previewPrice);
    bind("mmJewWeight", "input", previewPrice);
    bind("mmJewMaking", "input", previewPrice);
    bind("mmJewPriceMode", "change", previewPrice);
    const priceEl = el("mmEntryPrice");
    if (priceEl) {
        priceEl.addEventListener("input", () => { priceEl.dataset.userPicked = "1"; });
    }
    fillKaratOptions();
    syncKindUi();
}

export function mmJewelryInit(opts) {
    opts = opts || {};
    if (opts.rates) mmJewRates = opts.rates;
    document.body.classList.add("mm-jewelry-shop");
    const title = document.querySelector("#panelEntry .dash-title");
    if (title && !title.dataset.jew) {
        title.dataset.jew = "1";
        title.innerHTML = '<i class="fas fa-coins" style="color:#c9a227"></i> ئیدخالا زیڤ و زێر ب موبایلێ';
    }
    const sub = document.querySelector("#panelEntry p.sub");
    if (sub) sub.textContent = "ناڤ، مەعدەن، عیار، گرام، کرێی کار و عەدەد — وەک شاشێ POS";
    injectCard();
    mmJewReady = true;
}

export function mmJewelrySetRates(rates) {
    if (rates) mmJewRates = rates;
    if (mmJewReady) {
        fillKaratOptions();
        previewPrice();
    }
}

export function mmJewelryCollect() {
    if (!mmJewReady || !el("mmJewelryCard") || el("mmJewelryCard").style.display === "none") return null;
    const kind = (el("mmJewKind") && el("mmJewKind").value) || "metal";
    if (kind === "piece") {
        return { jewelry_entry_kind: "piece" };
    }
    const metal = (el("mmJewMetal") && el("mmJewMetal").value) || "silver";
    const karat = (el("mmJewKarat") && el("mmJewKarat").value) || (metal === "gold" ? "21" : "925");
    const weight = num(el("mmJewWeight") && el("mmJewWeight").value);
    const making = num(el("mmJewMaking") && el("mmJewMaking").value);
    const mode = (el("mmJewPriceMode") && el("mmJewPriceMode").value) || "by_weight";
    return {
        jewelry_entry_kind: "metal",
        metal_type: metal,
        karat: karat,
        weight_grams: weight,
        making_charge: making,
        jewelry_price_mode: mode === "fixed" ? "fixed" : "by_weight"
    };
}

export function mmJewelryFill(p) {
    if (!p || !mmJewReady) return;
    const kindEl = el("mmJewKind");
    const isMetal = !!(p.metal_type || (Number(p.weight_grams) > 0));
    if (kindEl) kindEl.value = isMetal ? "metal" : "piece";
    if (el("mmJewMetal") && p.metal_type) el("mmJewMetal").value = String(p.metal_type).toLowerCase() === "gold" ? "gold" : "silver";
    fillKaratOptions();
    if (el("mmJewKarat") && p.karat != null && p.karat !== "") el("mmJewKarat").value = String(p.karat);
    if (el("mmJewWeight")) el("mmJewWeight").value = Number(p.weight_grams) > 0 ? String(p.weight_grams) : "";
    if (el("mmJewMaking")) el("mmJewMaking").value = Number(p.making_charge) > 0 ? String(p.making_charge) : "";
    if (el("mmJewPriceMode")) el("mmJewPriceMode").value = p.jewelry_price_mode === "fixed" ? "fixed" : "by_weight";
    const priceEl = el("mmEntryPrice");
    if (priceEl) priceEl.dataset.userPicked = "1";
    syncKindUi();
}

export function mmJewelryReset() {
    if (!mmJewReady) return;
    if (el("mmJewKind")) el("mmJewKind").value = "metal";
    if (el("mmJewMetal")) el("mmJewMetal").value = "silver";
    fillKaratOptions();
    if (el("mmJewWeight")) el("mmJewWeight").value = "";
    if (el("mmJewMaking")) el("mmJewMaking").value = "";
    if (el("mmJewPriceMode")) el("mmJewPriceMode").value = "by_weight";
    const priceEl = el("mmEntryPrice");
    if (priceEl) delete priceEl.dataset.userPicked;
    syncKindUi();
}
