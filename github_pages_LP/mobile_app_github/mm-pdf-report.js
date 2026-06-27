/**
 * پوختەی ئەمڕۆ → A4 PDF (mobile: Print → Save as PDF / Share)
 */

function mmReportDateLabel(dayKey) {
    if (!dayKey) return "—";
    try {
        const p = String(dayKey).split("-");
        if (p.length === 3) {
            return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).toLocaleDateString("ar-IQ", {
                weekday: "long", year: "numeric", month: "long", day: "numeric"
            });
        }
    } catch (e) {}
    return dayKey;
}

function mmReportNow() {
    return new Date().toLocaleString("ar-IQ", {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false
    });
}

function mmSumReturns(returns, formatMoney) {
    let t = 0;
    (returns || []).forEach(function (r) { t += Number(r.total) || 0; });
    return formatMoney(t);
}

function mmBuildTodayReportHtml(ctx) {
    const esc = ctx.esc || function (s) { return String(s || ""); };
    const fmt = ctx.formatMoney || function (v) { return String(v); };
    const dash = ctx.dashboard || {};
    const detail = ctx.detail || {};
    const inv = ctx.inv || {};
    const debt = ctx.debt || {};
    const privacy = ctx.privacy || {};
    const hideProfit = !!privacy.hideProfit;
    const hideSalesDetail = !!privacy.hideSalesDetail;
    const sales = hideSalesDetail ? [] : (Array.isArray(detail.sales) ? detail.sales : []);
    const returns = Array.isArray(detail.returns) ? detail.returns : [];
    const expenses = Array.isArray(detail.expenses) ? detail.expenses : [];
    const purchases = Array.isArray(detail.purchases) ? detail.purchases : [];
    const dayLabel = mmReportDateLabel(ctx.dayKey);
    const cur = ctx.currency === "USD" ? "دۆلار ($)" : "دینار (د.ع)";
    const ver = esc(ctx.version || "");
    const net = hideProfit ? "— · شاردراوە" : fmt(dash.netProfitToday);
    const salesT = fmt(dash.salesToday);
    const expT = fmt(dash.expensesToday);
    const retT = mmSumReturns(returns, fmt);

    let salesRows = "";
    sales.slice(0, 25).forEach(function (s, i) {
        salesRows += "<tr><td>" + (i + 1) + "</td><td>#" + esc(s.id) + "</td><td>" + esc(s.cashier || "—") + "</td><td>" + esc(s.payment_method || "—") + "</td><td class=\"num\">" + fmt(s.total) + "</td></tr>";
    });
    if (!salesRows) {
        salesRows = hideSalesDetail
            ? "<tr><td colspan=\"5\" class=\"empty\">— وردەکاری فرۆشتن شاردراوە —</td></tr>"
            : "<tr><td colspan=\"5\" class=\"empty\">— هیچ فرۆشتنێک نییە —</td></tr>";
    }

    let retRows = "";
    returns.slice(0, 12).forEach(function (r) {
        retRows += "<tr><td>#" + esc(r.id) + "</td><td class=\"num\">" + fmt(r.total) + "</td></tr>";
    });
    if (!retRows) retRows = "<tr><td colspan=\"2\" class=\"empty\">—</td></tr>";

    let expRows = "";
    expenses.slice(0, 12).forEach(function (e) {
        expRows += "<tr><td>" + esc(e.type || "—") + "</td><td>" + esc(e.note || "") + "</td><td class=\"num\">" + fmt(e.amount) + "</td></tr>";
    });
    if (!expRows) expRows = "<tr><td colspan=\"3\" class=\"empty\">—</td></tr>";

    let purchaseRows = "";
    purchases.slice(0, 20).forEach(function (p) {
        purchaseRows += "<tr><td>" + esc(p.invoiceNo || "—") + "</td><td>" + esc(p.company || "—") + "</td><td class=\"num\">" + fmt(p.total) + "</td></tr>";
    });
    if (!purchaseRows) purchaseRows = "<tr><td colspan=\"3\" class=\"empty\">—</td></tr>";

    return "<!DOCTYPE html><html lang=\"ku\" dir=\"rtl\"><head><meta charset=\"UTF-8\"><title>پوختەی ئەمڕۆ — " + esc(ctx.shopLabel) + "</title><style>" +
        "@page { size: A4 portrait; margin: 10mm 12mm; }" +
        "* { box-sizing: border-box; }" +
        "body { margin: 0; font-family: 'Segoe UI', Tahoma, 'Noto Kufi Arabic', Arial, sans-serif; color: #0f172a; background: #fff; font-size: 11pt; line-height: 1.45; }" +
        ".sheet { max-width: 186mm; margin: 0 auto; }" +
        ".head { background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 55%, #2563eb 100%); color: #fff; border-radius: 14px; padding: 18px 20px; margin-bottom: 14px; position: relative; overflow: hidden; }" +
        ".head::after { content: ''; position: absolute; top: -40px; left: -40px; width: 120px; height: 120px; background: rgba(255,255,255,.08); border-radius: 50%; }" +
        ".head-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; position: relative; z-index: 1; }" +
        ".brand { font-size: 1.05rem; font-weight: 800; letter-spacing: .02em; }" +
        ".brand small { display: block; font-size: .72rem; font-weight: 600; opacity: .85; margin-top: 4px; }" +
        ".badge { background: rgba(255,255,255,.15); border: 1px solid rgba(255,255,255,.25); border-radius: 999px; padding: 4px 10px; font-size: .68rem; font-weight: 700; }" +
        ".shop { margin-top: 12px; font-size: 1.15rem; font-weight: 800; }" +
        ".date { font-size: .82rem; opacity: .9; margin-top: 4px; }" +
        ".hero { background: linear-gradient(160deg, #ecfdf5, #f0fdf4); border: 2px solid #34d399; border-radius: 16px; padding: 16px 18px; text-align: center; margin-bottom: 14px; }" +
        ".hero .lbl { font-size: .78rem; color: #047857; font-weight: 700; }" +
        ".hero .val { font-size: 2rem; font-weight: 900; color: #059669; margin: 6px 0 2px; }" +
        ".hero .sub { font-size: .7rem; color: #64748b; }" +
        ".grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }" +
        ".stat { border: 1px solid #e2e8f0; border-radius: 12px; padding: 10px 8px; text-align: center; background: #f8fafc; }" +
        ".stat .l { font-size: .65rem; color: #64748b; font-weight: 700; }" +
        ".stat .v { font-size: .95rem; font-weight: 800; margin-top: 4px; color: #0f172a; }" +
        ".stat.sales .v { color: #2563eb; }" +
        ".stat.exp .v { color: #d97706; }" +
        ".stat.ret .v { color: #dc2626; }" +
        ".stat.inv .v { color: #7c3aed; }" +
        ".row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }" +
        ".mini { border: 1px dashed #cbd5e1; border-radius: 12px; padding: 10px 12px; background: #fafafa; }" +
        ".mini h4 { margin: 0 0 8px; font-size: .75rem; color: #475569; }" +
        ".mini p { margin: 4px 0; font-size: .72rem; }" +
        ".sec { margin-bottom: 12px; }" +
        ".sec h3 { margin: 0 0 8px; font-size: .85rem; color: #1e40af; border-right: 4px solid #3b82f6; padding-right: 8px; }" +
        "table { width: 100%; border-collapse: collapse; font-size: .72rem; }" +
        "th { background: #eff6ff; color: #1e3a8a; font-weight: 700; padding: 7px 6px; border: 1px solid #dbeafe; text-align: right; }" +
        "td { padding: 6px; border: 1px solid #e2e8f0; vertical-align: top; }" +
        "td.num { text-align: left; direction: ltr; font-weight: 700; white-space: nowrap; }" +
        "td.empty { text-align: center; color: #94a3b8; padding: 12px; }" +
        ".cols { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }" +
        ".foot { margin-top: 16px; padding-top: 10px; border-top: 1px solid #e2e8f0; font-size: .65rem; color: #94a3b8; text-align: center; }" +
        ".note { background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 8px 10px; font-size: .68rem; color: #92400e; margin-bottom: 12px; }" +
        "@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .no-print { display: none !important; } }" +
        "</style></head><body><div class=\"sheet\">" +
        "<div class=\"head\"><div class=\"head-top\"><div><div class=\"brand\">Laptop Duhok POS<small>Mobile Manager · پوختەی ڕۆژانە</small></div></div>" +
        "<span class=\"badge\">" + (ver ? "v" + ver : "PDF") + "</span></div>" +
        "<div class=\"shop\">" + esc(ctx.shopLabel || ctx.shopEmail || "دووکان") + "</div>" +
        "<div class=\"date\"><i>📅</i> " + esc(dayLabel) + " · دراو: " + esc(cur) + "</div></div>" +
        "<div class=\"note\">تەنها بینین — ژمارەکان لە POS sync دەکرێن · " + esc(ctx.shopEmail || "") +
        (hideProfit || hideSalesDetail ? " · <strong>هەندێک بەش شاردراوە</strong>" : "") + "</div>" +
        (hideProfit
            ? "<div class=\"hero\" style=\"background:linear-gradient(160deg,#f1f5f9,#e2e8f0);border-color:#94a3b8;\"><div class=\"lbl\">قازانجی خاو</div><div class=\"val\" style=\"color:#64748b;font-size:1.35rem;\">— · شاردراوە</div><div class=\"sub\">لە ڕێکخستنەکانی POS شاردراوە</div></div>"
            : "<div class=\"hero\"><div class=\"lbl\">قازانجی خاو (ئەمڕۆ)</div><div class=\"val\">" + net + "</div><div class=\"sub\">دوای مەسرەف و گەڕانەوە</div></div>") +
        "<div class=\"grid\">" +
        "<div class=\"stat sales\"><div class=\"l\">فرۆشتن</div><div class=\"v\">" + salesT + "</div></div>" +
        "<div class=\"stat exp\"><div class=\"l\">مەسرەف</div><div class=\"v\">" + expT + "</div></div>" +
        "<div class=\"stat ret\"><div class=\"l\">گەڕانەوە</div><div class=\"v\">" + retT + "</div></div>" +
        "<div class=\"stat inv\"><div class=\"l\">پسوولە</div><div class=\"v\">" + String(Number(dash.invoicesCountToday || sales.length || 0)) + "</div></div>" +
        "</div>" +
        "<div class=\"row2\">" +
        "<div class=\"mini\"><h4>📦 کۆگە</h4>" +
        "<p>لە کۆگەدا: <strong>" + String(Number(inv.inStock || 0)) + "</strong> · کەمبوو: <strong>" + String(Number(inv.lowStock || 0)) + "</strong> · نەما: <strong>" + String(Number(inv.outOfStock || 0)) + "</strong></p>" +
        "<p>جەرد ئەمڕۆ: <strong>" + String(Number(inv.stocktakeCountToday || 0)) + "</strong></p></div>" +
        "<div class=\"mini\"><h4>⚖️ قەرز</h4>" +
        "<p>کڕیار: <strong>" + fmt(debt.customerReceivables) + "</strong> (" + String(Number(debt.customerDebtorCount || 0)) + ")</p>" +
        "<p>کڕین کۆمپانیا: <strong>" + fmt(debt.supplierPayables) + "</strong> (" + String(Number(debt.supplierDebtCount || 0)) + ")</p></div>" +
        "</div>" +
        "<div class=\"sec\"><h3>کڕین (" + purchases.length + ")</h3>" +
        "<table><thead><tr><th>ژمارەی پسوولە</th><th>کۆمپانیا</th><th>بڕ</th></tr></thead><tbody>" + purchaseRows + "</tbody></table></div>" +
        "<div class=\"sec\"><h3>فرۆشتن (" + sales.length + ")</h3>" +
        "<table><thead><tr><th>#</th><th>پسوولە</th><th>کاشێر</th><th>پارەدان</th><th>کۆ</th></tr></thead><tbody>" + salesRows + "</tbody></table></div>" +
        "<div class=\"cols\">" +
        "<div class=\"sec\"><h3>گەڕانەوە (" + returns.length + ")</h3><table><thead><tr><th>پسوولە</th><th>بڕ</th></tr></thead><tbody>" + retRows + "</tbody></table></div>" +
        "<div class=\"sec\"><h3>مەسرەف (" + expenses.length + ")</h3><table><thead><tr><th>جۆر</th><th>تێبینی</th><th>بڕ</th></tr></thead><tbody>" + expRows + "</tbody></table></div>" +
        "</div>" +
        "<div class=\"foot\">دروستکراو: " + mmReportNow() + " · Laptop Duhok POS Mobile Manager" +
        (sales.length > 25 ? " · تەنها ٢٥ پسوولەی سەرەتای فرۆشتن" : "") + "</div>" +
        "<p class=\"no-print\" style=\"text-align:center;margin-top:20px;font-size:.8rem;color:#64748b;\">ئەم پەڕەیە دادەخرێت بۆ چاپ… · iPhone: Share → Print → Save as PDF</p>" +
        "</div><script>window.onload=function(){setTimeout(function(){window.focus();window.print();},350);};<\/script></body></html>";
}

export function mmPrintTodaySummary(ctx) {
    const html = mmBuildTodayReportHtml(ctx);
    let frame = document.getElementById("mmPrintFrame");
    if (!frame) {
        frame = document.createElement("iframe");
        frame.id = "mmPrintFrame";
        frame.setAttribute("title", "PDF print");
        frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;";
        document.body.appendChild(frame);
    }
    const win = frame.contentWindow;
    const doc = win.document;
    doc.open();
    doc.write(html);
    doc.close();
    try {
        win.focus();
        setTimeout(function () {
            try { win.print(); } catch (e) {
                const blob = new Blob([html], { type: "text/html;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const w2 = window.open(url, "_blank");
                if (!w2) alert("Pop-up block — ڕێگە بە پەڕەی نوێ بدە.");
            }
        }, 400);
    } catch (e2) {
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        window.open(URL.createObjectURL(blob), "_blank");
    }
}
