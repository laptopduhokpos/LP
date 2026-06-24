# Mobile Manager — Laptop Duhok POS

ئەپلیکەیشنی **بەڕێوەبەری موبایل** (داشبۆرد · کۆگە · جەرد).

## فولدەری سەرەکی لە POS

هەموو فایلەکان لە:

`public/mobile_manager/`

```
mobile_manager/
├── index.html          ← ئەپەکە
├── manifest.json       ← PWA
├── sw.js               ← Service Worker
└── assets/brand/
    └── laptop-duhok-logo.png
```

## لینک (XAMPP)

http://localhost/pos/public/mobile_manager/

(لینکی کۆن `manager_mobile.html` خۆکار دەگوازرێتەوە.)

## GitHub Pages

ئەم فۆڵدەرە (`mobile_app_github`) هەمان ناوەڕۆکی `public/mobile_manager/` ـە.

**لینکی دروست:**
`https://hershkhald-lang.github.io/laptopduhok/mobile_app_github/`

1. فایلەکانی ئەم فۆڵدەرە upload بکە بۆ GitHub repo (`mobile_app_github/`)
2. Settings → Pages → branch `main`
3. Firebase → Authorized domains: `hershkhald-lang.github.io`

**دوای هەر نوێکردنەوە:** لە موبایل hard refresh (`Ctrl+Shift+R`) یان PWA لاببە و دووبارە زیاد بکە — service worker کاش دەکات.

## POS sync

لە POS: ڕێکخستن → Firebase sync (تەنها خوێndنەوە — مەخزەن ناگۆڕێت)

EOF