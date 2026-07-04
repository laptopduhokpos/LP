# mobile_manager — سەرچاوەی ئەپ

**تەنها شوێنی دەستکاری.** هەموو گۆڕانکاری لێرە بکە، پاشان build.

## پێکهاتە

```
mobile_manager/
├── index.html          ← UI، login، panels
├── backup.html         ← داونلۆدی ZIP لە LAN (WiFi+PIN)
├── manifest.json       ← PWA
├── sw.js               ← Service Worker (لە root — PWA scope)
├── css/
│   └── mm-app.css
├── js/
│   ├── mm-app.js       ← Firebase، dashboard، کۆگە، قەرز
│   ├── mm-snapshot-store.js
│   └── mm-pdf-report.js
└── assets/
    ├── brand/
    └── icons/          ← generate-mm-pwa-icons.ps1
```

## localhost

```
http://localhost/pos/_PRIVATE/mobile_manager/
```

## GitHub

```powershell
cd C:\xampp\htdocs\pos
.\_PRIVATE\scripts\build-github-lp.ps1
```

وردەکاری: `../docs/MOBILE_MANAGER.md`
