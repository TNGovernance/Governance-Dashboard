# Governance-Dashboard

A civic dashboard tracking Tamil Nadu governance.

## Local setup

1. Copy `.env.example` to `.env`
2. Add your `newsapi.org` key as `NEWS_API_KEY=...`
3. Set `BLOG_ADMIN_PASSWORD=...` for the one admin who is allowed to publish blog posts
4. Run `node server.mjs`
5. Open `http://127.0.0.1:8001`

## Content flow

- `Assembly` shows live legislative coverage from NewsAPI, filtered toward Tamil Nadu Legislative Assembly proceedings, governance, public policy, and manifesto-related debate
- `News` is your local blog feed; everyone can view posts, but only the admin who knows `BLOG_ADMIN_PASSWORD` can sign in and publish or delete updates

## Production

- Use `Vercel`, not `GitHub Pages`, because this project needs a server for `/api/assembly-news`, `/api/blogs`, `/api/admin/login`, and it must keep `NEWS_API_KEY` and `BLOG_ADMIN_PASSWORD` secret
- GitHub Pages is static hosting only, so it cannot safely run this backend or protect your keys
- This repo now includes Vercel-style serverless routes under `api/`
- On Vercel, deploy the repo, then add environment variables for `NEWS_API_KEY`, `BLOG_ADMIN_PASSWORD`, and optionally `ADMIN_TOKEN_SECRET`
- Important caveat: blog publishing/deleting currently writes to `Data/blogs.json`, which is fine locally but is not durable on Vercel's serverless filesystem
- For true production blog editing on Vercel, the next step is moving blog storage to a persistent service such as Vercel Blob, KV, Postgres, Supabase, or Firebase
