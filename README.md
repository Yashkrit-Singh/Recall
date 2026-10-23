# Recall

Recall is a private saved-content library for links, notes, and tags. It supports ranked keyword search and semantic search over the text a user chose to save. Ollama with `nomic-embed-text` is the default local embedding provider. Recall does not scrape pages, download videos, or claim that a link has been transcribed.

## Requirements

- Node.js 20.9 or newer
- A Supabase project
- Ollama for local embeddings (optional; keyword search still works without it)
- A Supabase service-role key for the trusted local embedding worker
- For Stage 3: FFmpeg/ffprobe, whisper.cpp, and Tesseract; optional local Ollama vision model

## Local setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and fill in your Supabase project URL and publishable key (or the older anon key). The default `EMBEDDING_PROVIDER=ollama` does not need an AI API key.
3. In the Supabase SQL Editor, run [`supabase/migrations/202610230001_create_saved_items.sql`](supabase/migrations/202610230001_create_saved_items.sql) if you have not already created the Stage 1 table.
4. Run [`supabase/migrations/202610230002_semantic_search.sql`](supabase/migrations/202610230002_semantic_search.sql) to enable pgvector and add the embedding column and search functions. Stage 1 users should run only this new migration; do not rerun the first migration.
5. If moving from the previous OpenAI Stage 2 schema, run [`supabase/migrations/202610230003_ollama_nomic_embeddings.sql`](supabase/migrations/202610230003_ollama_nomic_embeddings.sql) manually in SQL Editor. It preserves saved items and resets only incompatible 1536-dimensional vectors before changing the column to 768 dimensions. Do not run this automatically or skip it when the old vector column is 1536-dimensional.
6. For a fresh setup, apply [`supabase/migrations/202610230004_durable_embedding_jobs.sql`](supabase/migrations/202610230004_durable_embedding_jobs.sql) in Supabase SQL Editor. It adds indexing status/version fields and a private persistent job queue without deleting records or changing vector dimensions. If your existing project already has the durable `embedding_jobs` queue, do not rerun this historical migration; Stage 3 only needs migration 006.
7. Install Ollama for macOS from [ollama.com/download](https://ollama.com/download), start the Ollama app, then run `ollama pull nomic-embed-text` in Terminal. The model uses 768-dimensional vectors and Ollama serves them through its local `/api/embed` endpoint.
8. In Supabase Project Settings → API, copy the server-side service-role key into `.env.local` as `SUPABASE_SERVICE_ROLE_KEY`. Keep it out of `NEXT_PUBLIC_` variables and browser code. The worker needs it to claim private jobs; normal app requests continue to use the signed-in user's Supabase session and RLS.
9. In Supabase Authentication → URL Configuration, set the local Site URL to `http://localhost:3000` and add `http://localhost:3000/auth/callback` as a redirect URL.
10. Start the app in one terminal with `npm run dev`, then start the worker in another with `npm run worker`. Visit [http://localhost:3000](http://localhost:3000).
11. For Stage 3 uploads, review and manually run [`supabase/migrations/202610230006_video_processing.sql`](supabase/migrations/202610230006_video_processing.sql) after the current saved-item, pgvector, and durable embedding queue migrations. It is additive and does not remove rows or vectors. Never run it automatically.
12. If the video worker reports `column reference "media_version" is ambiguous`, run the additive [`supabase/migrations/202610230007_fix_video_job_claim_ambiguity.sql`](supabase/migrations/202610230007_fix_video_job_claim_ambiguity.sql) in Supabase SQL Editor. It replaces only the claim function and preserves queued jobs and saved media.
13. Follow the local media setup below and run `npm run worker:video` in a third terminal.

Supabase email confirmation may be enabled by default. With confirmation enabled, sign-up shows a message and the user must click the emailed link before signing in. For quick local-only testing, you can disable confirmation in Supabase Auth settings.

## Environment variables

| Name | Purpose | Browser visible? |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project endpoint | Yes |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public publishable key (preferred); database access is still restricted by RLS | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Older public anon key; accepted as a fallback | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Trusted background worker access to the private queue | **No** |
| `NEXT_PUBLIC_SITE_URL` | Origin used to construct the email confirmation callback | Yes |
| `EMBEDDING_PROVIDER` | `ollama` (default) or optional `openai` | No |
| `OLLAMA_BASE_URL` | Local Ollama server, normally `http://localhost:11434` | No |
| `OLLAMA_EMBEDDING_MODEL` | Local embedding model, normally `nomic-embed-text` | No |
| `OPENAI_API_KEY` | Optional server-only key; used only when `EMBEDDING_PROVIDER=openai` | **No** |
| `EMBEDDING_WORKER_POLL_MS` | Worker idle polling interval, default `1500` | No |

Never put a Supabase service-role key or an AI provider key in a `NEXT_PUBLIC_` variable. With Ollama selected, Recall sends embedding requests from the server to the local Ollama process and does not read or require `OPENAI_API_KEY`. If Ollama is unavailable, saves and keyword search continue to work and semantic search shows a setup message. OpenAI remains available only when explicitly selected.

## Database and privacy

The first migration creates `public.saved_items`, an index for each user's newest items, and the `search_saved_items` database function. Row-level security is enabled with separate read, insert, update, and delete policies. Stage 2 enabled pgvector. The optional OpenAI-to-Ollama migration changes the vector width to 768 and clears only incompatible vectors; it does not delete or rewrite saved text. Migration 004 leaves the current 768-dimension schema intact, adds `embedding_status` and a persistent `embedding_jobs` table, and creates database triggers that enqueue each insert or text edit in the same transaction. Existing saved rows and vectors remain; records with existing vectors are marked ready, while older rows without vectors can be queued with the manual backfill button. Queue rows are inaccessible to browser roles. Worker RPCs use claim tokens and compare the job's content version before writing a vector; semantic search remains an authenticated security-invoker RPC with explicit user filtering.

Keyword search checks title, tags, notes, and source URL, giving title matches the highest score. Semantic search embeds the user's query and compares it with saved title, notes/description, and tags using cosine similarity. Ollama uses the same configured model for indexing and queries, with `search_document:` and `search_query:` task prefixes. The app combines semantic and keyword rankings with reciprocal rank fusion. Saving and editing do not wait for Ollama: database triggers atomically enqueue work, and the separate worker generates vectors and retries failures up to five times with exponential backoff. A three-minute lease recovers jobs abandoned by a crashed worker. The UI shows pending, processing, ready, or failed status and refreshes while indexing is active. Keyword results remain available while an item is pending or failed. **Backfill existing items** queues only unindexed legacy records; **Retry failed indexing** recovers terminal failures after Ollama is available again.

## How to run and try it

1. Create an account and sign in.
2. Add a link beginning with `https://` or `http://`, a title, optional notes, and comma-separated tags. The database trigger queues indexing immediately; the worker updates the status to ready when successful.
3. Try exact keywords such as `trip song memory`, then a paraphrase such as `music from a journey with friends`.
4. Stop Ollama temporarily, save or edit an item, and confirm the save succeeds while its status stays pending. Restart Ollama; the worker retries automatically. After five failures, use **Retry failed indexing**.
5. Edit an item while an indexing job is running. The content version prevents the earlier job from overwriting the newer content's embedding.
6. Edit or delete an item, then verify its status/results update.
7. Create a second account and confirm its library does not show the first account's items.

## Queue recovery and worker operation

The queue is stored in Supabase, so stopping the Node worker does not lose queued work. Run `npm run worker` again to resume it; expired processing leases are reclaimed automatically. Transient errors retry with delays of 5, 10, 20, and 40 seconds (capped at one hour) up to five attempts. After the limit, the item becomes failed and shows a safe error summary. Fix Ollama/model availability, then use **Retry failed indexing**. Existing records with no queue entry can be queued with **Backfill existing items**. A production deployment must run this same worker as a continuously supervised Node process alongside the Next.js app; the Next.js request lifecycle does not run jobs.

Run the automated worker tests with `npm test`.

URL-only items keep the source link and user-provided text; Recall does not download or inspect linked media. User-uploaded video files are stored and processed locally as described below.

## Stage 3: user-uploaded videos

Recall accepts MP4, MOV, and WebM files explicitly uploaded by the signed-in user. The upload route validates size and duration with `ffprobe`, writes a random UUID filename to `.local-media/` (Git-ignored), and calls a Postgres RPC that atomically inserts the saved-item row and its durable media job. A private authenticated route serves the file only after Supabase RLS returns the owning user's row. Recall does not scrape or download video links.

This file storage is persistent on the development Mac and survives worker restarts, but it is local to that machine. A deployment with multiple hosts will need shared private object storage before uploads can be processed or played from other machines. The database metadata and jobs persist in Supabase.

### Install local tools on macOS

```sh
brew install ffmpeg tesseract whisper.cpp ollama
mkdir -p "$HOME/models/whisper"
curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin -o "$HOME/models/whisper/ggml-base.bin"
```

Set `WHISPER_MODEL_PATH` in `.env.local` to the absolute model path, such as `/Users/your-name/models/whisper/ggml-base.bin`. `WHISPER_LANGUAGE=auto` uses multilingual detection. The worker defaults to the `whisper-cli` binary; set `WHISPER_CPP_BIN` if Homebrew installs it elsewhere. The default `WHISPER_USE_GPU=false` uses CPU mode; set it to `true` only if your local Metal/GPU path runs successfully. Transcription and OCR are local. Audio is converted to mono 16 kHz, whisper.cpp emits timestamped JSON segments, and Tesseract processes sampled frames. Repeated exact OCR strings are deduplicated.

Optional visual summaries use a separate local Ollama vision model. For example, run `ollama pull llava:7b` and set `OLLAMA_VISION_MODEL=llava:7b`. This does not change `OLLAMA_EMBEDDING_MODEL=nomic-embed-text`. Leave the vision variable blank to disable visual captions. If a configured vision model is unavailable, successful transcription/OCR is retained and the item's status is `partially_ready` with an explanation. No media is sent to an external service.

Stage 3 environment variables (all server-side): `RECALL_MEDIA_DIR` (`.local-media`), `RECALL_VIDEO_MAX_BYTES` (100 MB), `RECALL_VIDEO_MAX_DURATION_SECONDS` (600), `VIDEO_WORKER_POLL_MS` (2000), `FFMPEG_BIN`, `FFPROBE_BIN`, `TESSERACT_BIN`, `WHISPER_CPP_BIN`, `WHISPER_MODEL_PATH` (required), `WHISPER_LANGUAGE` (`auto`), `WHISPER_USE_GPU` (`false` by default), `VIDEO_FRAME_INTERVAL_SECONDS` (10), `VIDEO_MAX_FRAMES` (30, hard-capped at 60), `OLLAMA_VISION_MODEL` (optional), and `VIDEO_MAX_VISION_FRAMES` (8).

Run three terminals: `npm run dev`, `npm run worker`, and `npm run worker:video`. The video worker uses a durable Supabase queue, 15-minute leases, five attempts, and exponential backoff. Restarting it resumes queued work; an interrupted lease can be reclaimed after expiry. After extraction, a trigger queues the new text in the existing embedding queue. Run both workers so video content becomes searchable. Failed jobs can be retried from the item's **Retry processing** control. Keyword search includes extracted text while embeddings are pending.

Migration 006 adds columns, a private `video_processing_jobs` table, service-worker RPCs, an authenticated retry RPC, and a keyword-search update. It leaves existing vectors and saved items intact. Review it before applying in Supabase SQL Editor. For recovery, pause workers, keep the uploaded files and queue rows, inspect `media_error` and `video_processing_jobs.last_error`, fix the local dependency, then retry failed items. Do not drop the queue or media columns as a rollback; existing uploads reference them.

## Project map

```text
app/
  auth/callback/route.ts  Exchanges the email confirmation code for a session
  login/                  Sign-in and account creation
  saved/                  Protected library, item forms, search UI, and server actions
  api/search/             Authenticated hybrid search endpoint
  api/videos/             Authenticated video upload, playback, and retry endpoints
  globals.css             Tailwind base and page defaults
  layout.tsx              Root layout and metadata
lib/supabase/             Server client and session-refresh helper
proxy.ts                  Refreshes Supabase auth cookies for requests
lib/                       Server-only Ollama/OpenAI embedding and hybrid search helpers
supabase/migrations/      Table security, pgvector, queues, and video processing schema
scripts/video-worker.mjs  Local FFmpeg/whisper.cpp/Tesseract queue worker
```
