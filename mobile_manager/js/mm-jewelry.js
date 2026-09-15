/**
 * Jewelry item entry for LD Manager — layout like POS laptop.
 * Loaded only when the connected shop is systemMode=jewelry.
 */
const GOLD_KARATS = [18, 21, 22, 24];
const SILVER_DEFAULTS = ["925", "999"];

let mmJewRates = null;
let mmJewReady = false;

function el(id) {
    return document.getElementById(id);
}

function num(v) {
    const n = parseFloat(String(v == null ? "" : v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
}

function money(v) {
    const n = Math.round(num(v));
    return n > 0 ? n : 0;
}

function normalizeRates(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    let grades = Array.isArray(r.silverGrades) ? r.silverGrades.slice() : [];
    grades = grades.map((g) => ({
        code: String((g && (g.code || g.karat)) || "").trim(),
        name: String((g && (g.name || g.code || g.karat)) || "").trim(),
        sell: money(g && (g.sell != null ? g.sell : g.rate)),
        buy: money(g && g.buy)
    })).filter((g) => g.code);
    if (!grades.length) {
        const legacySell = money(r.silver);
        const legacyBuy = money(r.silverBuy || r.buySilver);
        grades = SILVER_DEFAULTS.map((code) => ({
            code,
            name: code,
            sell: code === "925" ? legacySell : 0,
            buy: code === "925" ? legacyBuy : 0
        }));
    }
    return {
        gold18: money(r.gold18),
        gold21: money(r.gold21),
        gold22: money(r.gold22),
        gold24: money(r.gold24),
        buyGold18: money(r.buyGold18 || r.goldBuy18),
        buyGold21: money(r.buyGold21 || r.goldBuy21),
        buyGold22: money(r.buyGold22 || r.goldBuy22),
        buyGold24: money(r.buyGold24 || r.goldBuy24),
        silver: money(r.silver) || (grades[0] ? grades[0].sell : 0),
        buySilver: money(r.buySilver || r.silverBuy) || (grades[0] ? grades[0].buy : 0),
        silverGrades: grades
    };
}

function rateFor(metal, karat) {
    const r = normalizeRates(mmJewRates);
    if (metal === "silver") {
        const code = String(karat || "925");
        const g = r.silverGrades.find((x) => String(x.code) === code);
        if (g && g.sell > 0) return g.sell;
        return r.silver || 0;
    }
    const k = Math.round(num(karat));
    if (k === 18) return r.gold18;
    if (k === 21) return r.gold21;
    if (k === 22) return r.gold22;
    if (k === 24) return r.gold24;
    return r.gold21;
}

function buyRateFor(metal, karat) {
    const r = normalizeRates(mmJewRates);
    if (metal === "silver") {
        const code = String(karat || "925");
        const g = r.silverGrades.find((x) => String(x.code) === code);
        if (g && g.buy > 0) return g.buy;
        return r.buySilver || 0;
    }
    const k = Math.round(num(karat));
    if (k === 18) return r.buyGold18;
    if (k === 21) return r.buyGold21;
    if (k === 22) return r.buyGold22;
    if (k === 24) return r.buyGold24;
    return r.buyGold21;
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
        const r = normalizeRates(mmJewRates);
        const codes = r.silverGrades.map((g) => g.code).filter(Boolean);
        const list = codes.length ? codes : SILVER_DEFAULTS.slice();
        karatEl.innerHTML = list.map((c) => `<option value="${c}">${c}</option>`).join("");
        karatEl.value = list.indexOf(String(prev)) >= 0 ? String(prev) : (list[0] || "925");
    }
}

function isMetalKind() {
    return ((el("mmJewKind") && el("mmJewKind").value) || "metal") === "metal";
}

function hideFormGroup(node, hide) {
    if (!node) return;
    const wrap = node.closest(".form-group") || node;
    wrap.style.display = hide ? "none" : "";
}

function syncKindUi() {
    const metal = isMetalKind();
    const metalBox = el("mmJewMetalFields");
    const unitWrap = document.querySelector("#mmEntryForm .entry-unit-toggle-wrap");
    const packCard = el("mmCardPack");
    const cartonCard = el("mmCardCarton");
    const pieceCard = document.querySelector("#mmEntryForm .unit-card-piece");
    const stockBox = document.querySelector("#mmEntryForm .stock-summary-box");
    if (metalBox) metalBox.style.display = metal ? "block" : "none";
    if (unitWrap) unitWrap.style.display = "none";
    if (packCard) packCard.style.display = "none";
    if (cartonCard) cartonCard.style.display = "none";
    document.body.classList.toggle("mm-jew-metal", metal);
    document.body.classList.toggle("mm-jew-watch", !metal);
    hideFormGroup(el("mmEntryWholesalePricePiece"), true);
    hideFormGroup(el("mmEntryWholesalePricePack"), true);
    hideFormGroup(el("mmEntryWholesalePriceCarton"), true);
    if (pieceCard) {
        const title = pieceCard.querySelector(".unit-card-head span");
        if (title) title.textContent = metal ? "نرخ و عەدەد" : "سەعات / دانە";
        const badge = pieceCard.querySelector(".unit-card-head span:last-child");
        if (badge && badge !== title) badge.textContent = metal ? "زیڤ / زێر" : "سەعات";
    }
    const sellLbl = document.querySelector("label[for='mmEntryPrice']");
    if (sellLbl) sellLbl.innerHTML = 'فرۆشتن <span style="color:var(--danger)">*</span>';
    const costLbl = document.querySelector("label[for='mmEntryCost']");
    if (costLbl) costLbl.textContent = "کڕین";
    const qtyLbl = document.querySelector("label[for='mmEntryStockPiece']");
    if (qtyLbl) qtyLbl.textContent = "عەدەد";
    if (stockBox) stockBox.style.display = metal ? "none" : "";
    const modeWrap = el("mmJewPriceMode") && el("mmJewPriceMode").closest(".form-group");
    if (modeWrap) modeWrap.style.display = metal ? "none" : "none";
    lockMoneyFields(metal);
    previewPrice();
}

function lockMoneyFields(lock) {
    ["mmEntryPrice", "mmEntryCost"].forEach(function (id) {
        const n = el(id);
        if (!n) return;
        n.readOnly = !!lock;
        n.tabIndex = lock ? -1 : 0;
        n.style.opacity = lock ? "0.92" : "";
        n.style.pointerEvents = lock ? "none" : "";
        n.style.background = lock ? "rgba(15,23,42,0.45)" : "";
        if (lock) delete n.dataset.userPicked;
        n.placeholder = lock ? "خۆکار ژ گرام" : "0";
    });
}

function previewPrice() {
    const hint = el("mmJewPreview");
    if (!isMetalKind()) {
        lockMoneyFields(false);
        if (hint) hint.textContent = "سەعات / قفڵ / قوطی — نرخێ جێگیر ل خانا فرۆشتنێ بنڤیسە.";
        return;
    }
    lockMoneyFields(true);
    const grams = num(el("mmJewWeight") && el("mmJewWeight").value);
    const making = num(el("mmJewMaking") && el("mmJewMaking").value);
    const metal = (el("mmJewMetal") && el("mmJewMetal").value) || "silver";
    const karat = (el("mmJewKarat") && el("mmJewKarat").value) || "";
    const rate = rateFor(metal, karat);
    const buy = buyRateFor(metal, karat);
    const priceEl = el("mmEntryPrice");
    const costEl = el("mmEntryCost");
    if (grams > 0 && rate > 0) {
        const sell = Math.round(grams * rate + making);
        const cost = buy > 0 ? Math.round(grams * buy) : 0;
        if (priceEl) priceEl.value = String(sell);
        if (costEl) costEl.value = cost > 0 ? String(cost) : "0";
        if (hint) hint.textContent = "فرۆشتن " + sell.toLocaleString("en-US") + " = گرام × نرخێ ڕۆژ + کرێی کار · کڕین " + (cost ? cost.toLocaleString("en-US") : "—") + " — دەستکاری ناهێت.";
    } else {
        if (priceEl) priceEl.value = "";
        if (costEl) costEl.value = "";
        if (hint) {
            hint.textContent = rate > 0
                ? "کێش (گرام) بنڤیسە — بهایێ فرۆشتن و کڕینێ خۆکار دێت."
                : "دوگمێ نرخێ ڕۆژانە بگرە و کڕین/فرۆشتن بنڤیسە.";
        }
    }
    updateFabChip();
}

function fillRatesForm() {
    const r = normalizeRates(mmJewRates);
    const setVal = (id, v) => {
        const n = el(id);
        if (n) n.value = v > 0 ? String(v) : "";
    };
    setVal("mmJewBuy18", r.buyGold18);
    setVal("mmJewSell18", r.gold18);
    setVal("mmJewBuy21", r.buyGold21);
    setVal("mmJewSell21", r.gold21);
    setVal("mmJewBuy22", r.buyGold22);
    setVal("mmJewSell22", r.gold22);
    setVal("mmJewBuy24", r.buyGold24);
    setVal("mmJewSell24", r.gold24);
    const list = el("mmJewSilverRates");
    if (!list) return;
    list.innerHTML = r.silverGrades.map((g, i) => `
        <div class="mm-jew-rate-row" data-sg-i="${i}">
            <span class="mm-jew-rate-k">${escapeHtml(g.name || g.code)}</span>
            <input type="number" min="0" step="1" inputmode="numeric" dir="ltr" data-sg-buy placeholder="کڕین" value="${g.buy > 0 ? g.buy : ""}">
            <input type="number" min="0" step="1" inputmode="numeric" dir="ltr" data-sg-sell placeholder="فرۆشتن" value="${g.sell > 0 ? g.sell : ""}">
        </div>
    `).join("");
}

function escapeHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function readRatesFromForm() {
    const r = normalizeRates(mmJewRates);
    const grades = [];
    const list = el("mmJewSilverRates");
    if (list) {
        list.querySelectorAll(".mm-jew-rate-row").forEach((row, i) => {
            const prev = r.silverGrades[i] || { code: "925", name: "925" };
            const buyEl = row.querySelector("[data-sg-buy]");
            const sellEl = row.querySelector("[data-sg-sell]");
            grades.push({
                code: prev.code,
                name: prev.name || prev.code,
                buy: money(buyEl && buyEl.value),
                sell: money(sellEl && sellEl.value)
            });
        });
    }
    if (!grades.length) grades.push({ code: "925", name: "925", buy: 0, sell: 0 });
    const primary = grades.find((g) => g.code === "925") || grades[0];
    return {
        gold18: money(el("mmJewSell18") && el("mmJewSell18").value),
        gold21: money(el("mmJewSell21") && el("mmJewSell21").value),
        gold22: money(el("mmJewSell22") && el("mmJewSell22").value),
        gold24: money(el("mmJewSell24") && el("mmJewSell24").value),
        buyGold18: money(el("mmJewBuy18") && el("mmJewBuy18").value),
        buyGold21: money(el("mmJewBuy21") && el("mmJewBuy21").value),
        buyGold22: money(el("mmJewBuy22") && el("mmJewBuy22").value),
        buyGold24: money(el("mmJewBuy24") && el("mmJewBuy24").value),
        silver: primary.sell,
        buySilver: primary.buy,
        silverGrades: grades
    };
}

function flashRatesMsg(ok, text) {
    const msg = el("mmJewRatesMsg");
    if (!msg) return;
    msg.style.color = ok ? "#34d399" : "#f87171";
    msg.textContent = text;
    setTimeout(() => { if (msg.textContent === text) msg.textContent = ""; }, 3500);
}

function updateFabChip() {
    const txt = el("mmJewRatesFabTxt");
    if (!txt) return;
    const r = normalizeRates(mmJewRates);
    const g = r.silverGrades.find((x) => x.code === "925") || r.silverGrades[0];
    const sell = g ? g.sell : r.silver;
    txt.textContent = sell > 0 ? ("نرخێ ڕۆژ · " + sell.toLocaleString("en-US")) : "نرخێ ڕۆژانە";
}

function openRatesModal() {
    fillRatesForm();
    const m = el("mmJewRatesModal");
    if (m) m.style.display = "flex";
}

function closeRatesModal() {
    const m = el("mmJewRatesModal");
    if (m) m.style.display = "none";
}

function saveDailyRates() {
    const rates = readRatesFromForm();
    mmJewRates = rates;
    window.mmJewelryRates = rates;
    fillKaratOptions();
    previewPrice();
    updateFabChip();
    document.dispatchEvent(new CustomEvent("mm-jewelry-save-rates", { detail: rates }));
    flashRatesMsg(true, "نرخێ ڕۆژانە هاتە پاراستن — لاپتۆب ژی دگوهۆڕیت");
    setTimeout(closeRatesModal, 450);
}

function injectCard() {
    const form = el("mmEntryForm");
    const unitWrap = form && form.querySelector(".entry-unit-toggle-wrap");
    const panel = el("panelEntry");
    if (!form || !unitWrap || !panel) return;
    ["mmJewelryRatesCard", "mmJewelryCard", "mmJewRatesFab", "mmJewRatesModal"].forEach((id) => {
        const old = el(id);
        if (old) old.remove();
    });

    const fab = document.createElement("button");
    fab.type = "button";
    fab.id = "mmJewRatesFab";
    fab.className = "mm-jew-rates-fab";
    fab.innerHTML = '<i class="fas fa-coins"></i><span id="mmJewRatesFabTxt">نرخێ ڕۆژانە</span>';
    fab.addEventListener("click", openRatesModal);
    panel.appendChild(fab);

    const modal = document.createElement("div");
    modal.id = "mmJewRatesModal";
    modal.className = "mm-jew-rates-modal";
    modal.style.display = "none";
    modal.innerHTML = `
        <div class="mm-jew-rates-sheet" role="dialog" aria-modal="true">
            <div class="mm-jew-rates-sheet-head">
                <div class="mm-jew-card-title" style="margin:0;"><i class="fas fa-coins"></i> نرخێ ڕۆژانە</div>
                <button type="button" id="mmJewRatesCloseBtn" class="mm-jew-rates-close" aria-label="داخستن">✖</button>
            </div>
            <p class="mm-jew-help">کڕین و فرۆشتنا هەر گرامێک — ل لاپتۆب و موبایل پێکڤە دگوهۆڕیت.</p>
            <div class="mm-jew-sub">زیڤ</div>
            <div class="mm-jew-rate-head"><span>دەرجە</span><span>کڕین</span><span>فرۆشتن</span></div>
            <div id="mmJewSilverRates"></div>
            <div class="mm-jew-sub" style="margin-top:10px;">زێر</div>
            <div class="mm-jew-rate-head"><span>عیار</span><span>کڕین</span><span>فرۆشتن</span></div>
            <div class="mm-jew-rate-row"><span class="mm-jew-rate-k">21K</span><input id="mmJewBuy21" type="number" min="0" step="1" inputmode="numeric" dir="ltr" placeholder="کڕین"><input id="mmJewSell21" type="number" min="0" step="1" inputmode="numeric" dir="ltr" placeholder="فرۆشتن"></div>
            <div class="mm-jew-rate-row"><span class="mm-jew-rate-k">18K</span><input id="mmJewBuy18" type="number" min="0" step="1" inputmode="numeric" dir="ltr" placeholder="کڕین"><input id="mmJewSell18" type="number" min="0" step="1" inputmode="numeric" dir="ltr" placeholder="فرۆشتن"></div>
            <div class="mm-jew-rate-row"><span class="mm-jew-rate-k">22K</span><input id="mmJewBuy22" type="number" min="0" step="1" inputmode="numeric" dir="ltr" placeholder="کڕین"><input id="mmJewSell22" type="number" min="0" step="1" inputmode="numeric" dir="ltr" placeholder="فرۆشتن"></div>
            <div class="mm-jew-rate-row"><span class="mm-jew-rate-k">24K</span><input id="mmJewBuy24" type="number" min="0" step="1" inputmode="numeric" dir="ltr" placeholder="کڕین"><input id="mmJewSell24" type="number" min="0" step="1" inputmode="numeric" dir="ltr" placeholder="فرۆشتن"></div>
            <button type="button" id="mmJewSaveRatesBtn" class="mm-jew-save-btn"><i class="fas fa-save"></i> پاراستن</button>
            <p id="mmJewRatesMsg" class="mm-jew-msg"></p>
        </div>
    `;
    modal.addEventListener("click", (e) => { if (e.target === modal) closeRatesModal(); });
    panel.appendChild(modal);

    const box = document.createElement("div");
    box.id = "mmJewelryCard";
    box.className = "mm-jew-card";
    box.innerHTML = `
        <div class="mm-jew-card-title"><i class="fas fa-gem"></i> جۆرێ ئایتمێ</div>
        <div class="form-group" style="margin-bottom:8px;">
            <label class="field-label" for="mmJewKind">ئەڤە چییە؟</label>
            <select id="mmJewKind" class="input-std">
                <option value="metal" selected>پارچەی زیڤ / زێر (گوستیرک، گۆهوار…)</option>
                <option value="piece">سەعات، قفڵ، قوطی — دانە</option>
            </select>
        </div>
        <div id="mmJewMetalFields">
            <div class="mm-jew-grid2">
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
            <div class="mm-jew-grid2" style="margin-top:8px;">
                <div class="form-group" style="margin:0;">
                    <label class="field-label" for="mmJewWeight">کێش (گرام)</label>
                    <input id="mmJewWeight" type="number" min="0" step="0.001" placeholder="0.000" inputmode="decimal" dir="ltr">
                </div>
                <div class="form-group" style="margin:0;">
                    <label class="field-label" for="mmJewMaking">کرێی کار</label>
                    <input id="mmJewMaking" type="number" min="0" step="1" placeholder="0" inputmode="numeric" dir="ltr">
                </div>
            </div>
            <div class="form-group" style="margin:8px 0 6px;display:none;">
                <label class="field-label" for="mmJewPriceMode">شێوازێ نرخێ</label>
                <select id="mmJewPriceMode">
                    <option value="by_weight" selected>بە گرام (نرخێ ڕۆژانە)</option>
                    <option value="fixed">نرخێ جێگیر</option>
                </select>
            </div>
            <p id="mmJewPreview" class="mm-jew-preview"></p>
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
    bind("mmJewSaveRatesBtn", "click", saveDailyRates);
    bind("mmJewRatesCloseBtn", "click", closeRatesModal);
    fillRatesForm();
    fillKaratOptions();
    syncKindUi();
    updateFabChip();
}

export function mmJewelryInit(opts) {
    opts = opts || {};
    document.body.classList.add("mm-jewelry-shop");
    if (mmJewReady && el("mmJewelryCard") && el("mmJewRatesFab")) {
        if (opts.rates) mmJewelrySetRates(opts.rates);
        return;
    }
    if (opts.rates) mmJewRates = normalizeRates(opts.rates);
    const title = document.querySelector("#panelEntry .dash-title");
    if (title && !title.dataset.jew) {
        title.dataset.jew = "1";
        title.innerHTML = '<i class="fas fa-coins" style="color:#c9a227"></i> ئیدخالا زیڤ و زێر';
    }
    const sub = document.querySelector("#panelEntry p.sub");
    if (sub) sub.textContent = "گرام بنڤیسە — فرۆشتن و کڕین خۆکار ژ نرخێ ڕۆژانە. دوگمێ زێڕین = نرخێ ڕۆژ.";
    injectCard();
    mmJewReady = true;
}

export function mmJewelrySetRates(rates) {
    if (!rates) return;
    const next = normalizeRates(rates);
    try {
        if (mmJewRates && JSON.stringify(normalizeRates(mmJewRates)) === JSON.stringify(next)) {
            return;
        }
    } catch (eEq) {}
    mmJewRates = next;
    if (mmJewReady) {
        fillRatesForm();
        fillKaratOptions();
        previewPrice();
        updateFabChip();
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
    return {
        jewelry_entry_kind: "metal",
        metal_type: metal,
        karat: karat,
        weight_grams: weight,
        making_charge: making,
        jewelry_price_mode: "by_weight"
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
    if (el("mmJewPriceMode")) el("mmJewPriceMode").value = "by_weight";
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
    const costEl = el("mmEntryCost");
    if (costEl) delete costEl.dataset.userPicked;
    syncKindUi();
}
