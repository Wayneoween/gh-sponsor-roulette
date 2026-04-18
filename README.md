# Sponsor Roulette 🎲

A tiny local web app that loads your GitHub stars, filters to those that accept sponsorship (GitHub Sponsors or `FUNDING.yml`), and randomly picks N of them so you can decide who to support.

No build step. No npm. Just three files: `index.html`, `style.css`, `app.js`.

## Run it

Either open `index.html` directly in your browser, or serve the folder:

```sh
cd ~/sponsor-roulette
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Get a token

1. Go to <https://github.com/settings/tokens> → **Generate new token (classic)**
2. Tick **`public_repo`** (required so the API returns each repo's `fundingLinks`). Add `read:user` too if you want private stars.
3. Copy the token, paste it into the app, click **Save**.

Token is stored in your browser's `localStorage` only. It never leaves your machine except in direct calls to `api.github.com`.

## How it works

A single GraphQL query against `viewer.starredRepositories` pulls each repo's `fundingLinks` (parsed `FUNDING.yml`) and `owner.hasSponsorsListing` in one shot. Stars are paginated 100 at a time and cached in `localStorage` for 24 hours so spinning again doesn't re-fetch.

## Forget everything

Click **Forget** in the token section. That clears both the token and the cached stars.

## Why a PAT and not "Login with GitHub"?

"Login with GitHub" would be friendlier, but it requires a backend to hold an OAuth client secret and do the `code` for `token` exchange, which GitHub Pages can't run. Adding that backend would also mean every user passes through infrastructure I control, so I could (intentionally or not) see who's using the app. The PAT flow keeps this a genuinely static site: the token goes straight from your browser to `api.github.com`, nothing touches a server in between, and the handful of files here is the whole app, so you can read it and see exactly what happens with your token.
