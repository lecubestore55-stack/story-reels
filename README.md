# Story Reels Studio

Turn proven viral story reels into **new, original** vertical story reels, all in one dashboard.

```
Competitor reel (MP4)
   │  Gemini watches it (picture + sound) → why it works: hook, pattern, twist, beats
   ▼
New original story   ← Claude keeps only the emotional pattern; new characters, setting, conflict, twist
   │  you review / edit / ask for a rewrite
   ▼
Character photos     ← fal.ai Nano Banana 2 (one reference photo per character)
   ▼
Scene start frames   ← Nano Banana 2 Edit, using the character photos so faces/outfits stay the same
   ▼
Video clips          ← fal.ai Veo 3.1 Lite (default, cheapest) or Kling / Veo 3.1, image-to-video, 9:16
   ▼
Final MP4            ← ffmpeg: joins clips, 1080×1920, hook text on top, optional music
```

Every paid step stops for your review unless you tick **Run all steps without review**.

## Deploy to the cloud (Railway): recommended

The web app and the worker run together in **one container**, plus a Railway Postgres database and a 5 GB volume for the videos. Nothing runs on your own server.

1. Push this folder to a private GitHub repo.
2. On [railway.com](https://railway.com), create a project with **Deploy from GitHub repo** and pick the repo. Railway finds the `Dockerfile` and `railway.json` by itself.
3. In the same project, click **+ New → Database → PostgreSQL**.
4. Click your app service:
   - **Variables:** add the variables from `.env.example` (`ADMIN_PASSWORD`, `SESSION_SECRET`, `FAL_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `COOKIE_SECURE=true`). Also add `DATABASE_URL` with the value `${{Postgres.DATABASE_URL}}`.
   - **Volume:** right-click the service, choose **Attach volume**, and set the mount path to `/data`.
   - **Settings → Networking:** click **Generate domain**, or add your own subdomain such as `reels.yourdomain.com`.
5. Deploy. Open the domain and log in with `ADMIN_PASSWORD`.

**Cost:** the Hobby plan is $5/month and includes $5 of usage. The app plus Postgres usually lands around $5–10/month, mostly from the database and the worker staying on. Volumes on Hobby are 5 GB, which holds about 150 finished reels. Download your finals and delete old reels from the dashboard to free space.

The same `Dockerfile` also runs on Render, Fly.io or Google Cloud Run. It needs a Postgres `DATABASE_URL` and a persistent disk mounted at `/data`.

## Or run it on your own VPS (Docker Compose)

```bash
cp .env.example .env        # fill in the passwords and the 3 API keys
docker compose up -d --build
```

Compose runs the web and the worker as two containers with a local Postgres, listening on `127.0.0.1:3000`. Put Apache in front of it:

```apache
<VirtualHost *:443>
  ServerName reels.example.com
  ProxyPreserveHost On
  ProxyPass / http://127.0.0.1:3000/
  ProxyPassReverse / http://127.0.0.1:3000/
  LimitRequestBody 314572800
</VirtualHost>
```

## How to use it

1. **Proven stories** page: upload a competitor reel that already went viral. Add notes if you like (its caption, views, the blog story text). Gemini breaks it down in about 30 seconds.
2. On the reference page, choose the video model, number of scenes and seconds per clip. Then click **Write N new stories**. Each story is different from the reference and from the other stories made from it.
3. On each reel page:
   - **Story:** edit anything (hook text, characters' looks, each scene's frame and motion), or ask Claude for a rewrite with your notes. Check the *Originality check* box.
   - **Characters:** generate, then regenerate any face you don't like (you can add a note like "older, grey hair").
   - **Start frames:** check these carefully, because a good frame is the cheapest way to get a good clip.
   - **Video clips:** the paid step. You can regenerate a single clip, and the final MP4 rebuilds automatically.
   - **Final reel:** download the MP4, toggle the hook text, add background music.

## Costs per reel (fal.ai list prices, 720p; the app counts as you go)

| Video model | Price per second | 3 clips × 6 s |
| --- | --- | --- |
| **Veo 3.1 Lite** (default) | $0.05 with sound, $0.03 silent | $0.90 / $0.54 |
| Kling 2.5 Turbo Pro (silent) | $0.07 | $1.05 (3 × 5 s) |
| Kling 3 Turbo (sound) | $0.112 | $2.02 |
| Kling 3 Pro | $0.168 with sound | $3.02 |
| Veo 3.1 | $0.40 with sound | $7.20 (3 × 6 s) |

Images: Nano Banana 2 costs about $0.08 each, Nano Banana Lite about $0.05 each (estimated). A reel needs one image per character plus one per scene, usually 6.

| Setup | Total per reel |
| --- | --- |
| Veo 3.1 Lite + sound + Nano Banana 2 (default) | about $1.38 |
| Veo 3.1 Lite silent + your music + Nano Banana Lite | about $0.84 |
| Kling 3 Pro + sound (premium) | about $3.50 |

Ways to spend less:
- Generate a clip only after you've checked its start frame. A bad frame is a bad clip.
- Regenerate one clip, not all of them.
- Turn off AI sound and add one music track on the final step.
- Write 3–5 stories per reference (writing costs cents) and only make video for the best one.
- For cheaper writing, set `CLAUDE_MODEL=claude-haiku-5-5`. For cheaper analysis, set `GEMINI_MODEL` to a Flash-Lite model.

## Changing models

All model IDs live in `.env` (`GEMINI_MODEL`, `CLAUDE_MODEL`, `FAL_*`). To add another fal video model, add an entry to `VIDEO_MODELS` in `lib/config.ts` with its endpoint, input fields and price. You can switch the video model per reel on the Video clips step.

## Staying original and monetizable

- The writer is told to keep only the abstract pattern and change the plot, relationships, setting, key detail, discovery and twist. It never reuses dialogue, captions or shot compositions. Still read the *Originality check* before you generate video.
- Facebook demonetizes reposts and lightly edited copies, not AI itself. Post only the reels you generate here, never the reference videos, and turn on the **AI info** label when you upload.
- Content rules sent to the writer: no violence, injuries, nudity, or harm to children shown on screen.

## Project layout

```
app/                Next.js pages + API routes
  api/references    upload + list proven stories, re-analyze
  api/projects      create reels, edit story/settings, run steps, music
  api/files         serves stored media (with Range support for video)
lib/ai/             gemini.ts (analysis), claude.ts (story), fal.ts (images/video)
lib/ffmpeg.ts       final reel assembly
worker/             background job runner (npm run worker)
db/schema.sql       tables: story_references, projects, assets, jobs
```

`scripts/start-all.mjs` runs web + worker in one container (cloud). The worker is restart-safe. Interrupted jobs go back in the queue, and video requests already sent to fal are resumed rather than paid for twice.
