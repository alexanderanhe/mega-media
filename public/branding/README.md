Custom Branding

This project supports a default branding bundle and optional local overrides.

Default files (tracked in git):
- public/branding/default/favicon.svg
- public/branding/default/apple-touch-icon.png
- public/branding/default/manifest.webmanifest

Local overrides (ignored by git):
- public/branding/custom/favicon.svg
- public/branding/custom/apple-touch-icon.png
- public/branding/custom/manifest.webmanifest
- public/branding/custom/icons/icon-192.png
- public/branding/custom/icons/icon-512.png

How to use custom branding:
1. Put your SVG in public/branding/custom/favicon.svg.
2. Run: node scripts/generate-branding-icons.mjs public/branding/custom/favicon.svg public/branding/custom
3. Set VITE_BRANDING_DIR=custom in .env (or environment).

If VITE_BRANDING_DIR is not set, the app uses /branding/default.
