# Laptop Duhok POS â€” Mobile Manager (GitHub Pages)

**Ù„ÛŒÙ†Ú©ÛŒ Ø¦Û•Ù¾:**
https://laptopduhokpos.github.io/LP/

**Ù¾Ø§Ø´Û•Ú©Û•ÙˆØª (WiFi + PIN):**
https://laptopduhokpos.github.io/LP/mobile_app_github/backup.html

## Upload Ø¨Û† GitHub

**Ú¯Ø±Ù†Ú¯ â€” 405 Not Allowed = Ù„ÛŒÙ†Ú© ÛŒØ§Ù† ÙÛ†ÚµØ¯Û•Ø± Ù‡Û•ÚµÛ•ÛŒÛ•**

### Ú•ÛŽÚ¯Û•ÛŒ Ù¡ (Ù¾ÛŽØ´Ù†ÛŒØ§Ø±): Ù†Ø§ÙˆÛ•Ú•Û†Ú©ÛŒ Ø¦Û•Ù… ÙÛ†ÚµØ¯Û•Ø±Û• Ø¨Ø®Û• **root**ÛŒ repo

```
repo-root/
  .nojekyll
  index.html
  mobile_app_github/
    index.html
    mm-app.js
    ...
```

**Ù†Û•Ø®Û•** ÙÛ†ÚµØ¯Û•Ø±ÛŒ `github_pages_LP` Ø®Û†ÛŒ Ù†Ø§Ùˆ repo â€” Ø¦Û•ÙˆÛ• Ø¯Û•Ø¨ÛŽØªÛ•:
`.../github_pages_LP/mobile_app_github/` â† Ù‡Û•ÚµÛ• Â· 405

### Ù†Ù…ÙˆÙˆÙ†Û•ÛŒ Ù„ÛŒÙ†Ú©ÛŒ Ø¯Ø±ÙˆØ³Øª

| Repo | Ù„ÛŒÙ†Ú© |
|------|------|
| laptopduhokpos/LP | https://laptopduhokpos.github.io/LP/mobile_app_github/ |
| hershkhald-lang/laptopduhok | https://hershkhald-lang.github.io/laptopduhok/mobile_app_github/ |

### Ú•ÛŽÚ¯Û•ÛŒ Ù¢: Pages Ù„Û• ÙÛ†ÚµØ¯Û•Ø±ÛŒ `/github_pages_LP`

Settings â†’ Pages â†’ Branch: main â†’ Folder: **/github_pages_LP**

Ø¦Û•ÙˆØ§ Ù„ÛŒÙ†Ú© Ø¯Û•Ø¨ÛŽØª: `https://USER.github.io/REPO/` (Ø¨ÛŽ `github_pages_LP` Ù„Û• URL)

1. Ù‡Û•Ù…ÙˆÙˆ Ù†Ø§ÙˆÛ•Ú•Û†Ú©ÛŒ Ø¦Û•Ù… ÙÛ†ÚµØ¯Û•Ø±Û• upload Ø¨Ú©Û• ÛŒØ§Ù† push Ø¨Ú©Û•
2. Settings â†’ Pages â†’ Deploy from branch `main`
3. Supabase â†’ Authentication â†’ URL Configuration â†’ `USER.github.io`

## Ù†ÙˆÛŽÚ©Ø±Ø¯Ù†Û•ÙˆÛ• Ù„Û• POS

```powershell
.\_PRIVATE\scripts\build-github-lp.ps1
```

Ø¯ÙˆØ§ØªØ± ÙØ§ÛŒÙ„Û•Ú©Ø§Ù† Ø¯ÙˆÙˆØ¨Ø§Ø±Û• upload Ø¨Ú©Û• Ø¨Û† GitHub.
