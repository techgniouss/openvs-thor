# .secrets

`antigravity.txt` holds the Antigravity Google OAuth **client secret** used by the
experimental `antigravity` chat provider. It is **gitignored** — never commit it.

## Zero-prompt setup

```
cp antigravity.txt.example antigravity.txt
# edit antigravity.txt so it contains the real GOCSPX-… value
```

On activation the extension seeds this value into VS Code SecretStorage **once**, so the
"Add Google account" flow never prompts for it — click → Google login → done.

## Notes

- The value is a Google *desktop/installed-app* client secret. Per Google's own docs,
  installed-app secrets "aren't treated as secret" (they ship inside distributed binaries),
  and this specific value is already public in the archived upstream project
  `NoeFabris/opencode-antigravity-auth`. Keeping it out of *this* repo is still deliberate.
- Resolution order for the secret: `ANTIGRAVITY_CLIENT_SECRET` env → SecretStorage →
  this file.
- Using this provider **violates Google's Terms of Service** and can get the signed-in
  Google account suspended. Experimental, off by default.
