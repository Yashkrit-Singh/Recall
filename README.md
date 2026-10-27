# Recall

Recall is a private saved-content library for links, notes, tags, and videos. EmbeddingGemma 2 through the local Sentence Transformers service is the primary multimodal semantic-search model for video, audio, metadata, and text queries. Nomic remains an isolated rollback path; vectors from the two models are never compared. An experimental, opt-in local yt-dlp adapter can attempt supported public Reel links; availability is not guaranteed and a saved URL is never represented as transcribed content.

## Requirements

- Node.js 20.9 or newer
- A Supabase project
- Local Python/Sentence Transformers dependencies for EmbeddingGemma 2 semantic indexing (optional; keyword search remains available)
- A Supabase service-role key for the trusted local embedding worker
- FFmpeg/ffprobe for local video indexing; whisper.cpp and Tesseract are optional exact-text tools
- Optional Telegram bot credentials for private video search

## Local setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and fill in your Supabase project URL and publishable key (or the older anon key). EmbeddingGemma runs locally and does not need a paid API key.
3. In the Supabase SQL Editor, run [`supabase/migrations/202610230001_create_saved_items.sql`](supabase/migrations/202610230001_create_saved_items.sql) if you have not already created the Stage 1 table.
4. Run [`supabase/migrations/202610230002_semantic_search.sql`](supabase/migrations/202610230002_semantic_search.sql) to enable pgvector and add the embedding column and search functions. Stage 1 users should run only this new migration; do not rerun the first migration.
5. If moving from the previous OpenAI Stage 2 schema, run [`supabase/migrations/202610230003_ollama_nomic_embeddings.sql`](supabase/migrations/202610230003_ollama_nomic_embeddings.sql) manually in SQL Editor. It preserves saved items and resets only incompatible 1536-dimensional vectors before changing the column to 768 dimensions. Do not run this automatically or skip it when the old vector column is 1536-dimensional.
6. For a fresh setup, apply [`supabase/migrations/202610230004_durable_embedding_jobs.sql`](supabase/migrations/202610230004_durable_embedding_jobs.sql) in Supabase SQL Editor. It adds indexing status/version fields and a private persistent job queue without deleting records or changing vector dimensions. If your existing project already has the durable `embedding_jobs` queue, do not rerun this historical migration; Stage 3 only needs migration 006.
7. Install the local EmbeddingGemma Python dependencies and model as described in **Primary local multimodal search** below. Ollama and `nomic-embed-text` are needed only if you later roll back to the isolated Nomic index.
8. In Supabase Project Settings → API, copy the server-side service-role key into `.env.local` as `SUPABASE_SERVICE_ROLE_KEY`. Keep it out of `NEXT_PUBLIC_` variables and browser code. The worker needs it to claim private jobs; normal app requests continue to use the signed-in user's Supabase session and RLS.
9. In Supabase Authentication → URL Configuration, set the local Site URL to `http://localhost:3000` and add `http://localhost:3000/auth/callback` as a redirect URL.
10. Review and manually apply the EmbeddingGemma migration below, then start `npm run dev`, `npm run embeddinggemma:service`, and `npm run worker` in separate terminals. Visit [http://localhost:3000](http://localhost:3000).
11. For Stage 3 uploads, review and manually run [`supabase/migrations/202610230006_video_processing.sql`](supabase/migrations/202610230006_video_processing.sql) after the current saved-item, pgvector, and durable embedding queue migrations. It is additive and does not remove rows or vectors. Never run it automatically.
12. If the video worker reports `column reference "media_version" is ambiguous`, run the additive [`supabase/migrations/202610230007_fix_video_job_claim_ambiguity.sql`](supabase/migrations/202610230007_fix_video_job_claim_ambiguity.sql) in Supabase SQL Editor. It replaces only the claim function and preserves queued jobs and saved media.
13. Follow the local media setup below and run `npm run worker:video` when you want the separate video-processing statuses and optional transcript/OCR extraction. Direct EmbeddingGemma indexing is automatically queued as soon as a saved item has media.
14. For experimental link retrieval only, review and apply [`supabase/migrations/202610240001_media_retrieval_queue.sql`](supabase/migrations/202610240001_media_retrieval_queue.sql) after migrations 001–007. Review its full SQL and the preservation notes below before applying it; it is never applied by the app or worker.
15. After the Stage 3, retrieval, and EmbeddingGemma migrations above, inspect [`supabase/migrations/202610260001_video_metadata_generation.sql`](supabase/migrations/202610260001_video_metadata_generation.sql) and apply it manually only after reviewing its effects. This adds an independent metadata queue and status fields; it does not rewrite existing saved items or vector tables. Existing metadata is marked user-edited so it is protected.
16. To use the Telegram video-search bot, inspect and manually apply [`supabase/migrations/202610270001_telegram_video_bot.sql`](supabase/migrations/202610270001_telegram_video_bot.sql). It adds private pairing tables and a one-time link RPC only; it does not change saved items, vectors, or queues.

Supabase email confirmation may be enabled by default. With confirmation enabled, sign-up shows a message and the user must click the emailed link before signing in. For quick local-only testing, you can disable confirmation in Supabase Auth settings.

## Environment variables

| Name | Purpose | Browser visible? |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project endpoint | Yes |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public publishable key (preferred); database access is still restricted by RLS | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Older public anon key; accepted as a fallback | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Trusted background worker access to the private queue | **No** |
| `SUPABASE_JWT_SECRET` | Legacy HS256 signing secret used only to mint a 60-second authenticated JWT for Telegram searches under RLS | **No** |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API credential; used only by the server and polling worker | **No** |
| `TELEGRAM_BOT_USERNAME` | Public bot username used to create a Telegram deep link | No |
| `RECALL_TELEGRAM_WORKER_SECRET` | Shared random secret between the local polling worker and Next.js route | **No** |
| `RECALL_TELEGRAM_APP_URL` | Local Next.js origin the polling worker calls; set to the actual port | No |
| `RECALL_TELEGRAM_MIN_SIMILARITY` | EmbeddingGemma-only semantic match floor; initial local pilot value `0.63` | No |
| `RECALL_TELEGRAM_MIN_KEYWORD_RANK` | Existing keyword RPC rank floor; default `2.5` | No |
| `RECALL_TELEGRAM_MAX_RESULTS` | Maximum number of bot results, capped at three | No |
| `NEXT_PUBLIC_SITE_URL` | Origin used to construct the email confirmation callback | Yes |
| `RECALL_SEARCH_PROVIDER` | `embeddinggemma2` (default) or `nomic` for explicit rollback | No |
| `EMBEDDINGGEMMA_URL` | Local inference service; defaults to `http://127.0.0.1:11601` | No |
| `EMBEDDINGGEMMA_PORT` | Local service port; defaults to `11601` | No |
| `EMBEDDINGGEMMA_TOKEN` | Server-only token for the local inference service | **No** |
| `EG2_DEVICE` | `auto`, `mps`, or `cpu` for local inference | No |
| `EMBEDDING_PROVIDER` | Legacy Nomic provider (`ollama`) or optional `openai`, used only with `RECALL_SEARCH_PROVIDER=nomic` | No |
| `OLLAMA_BASE_URL` | Local Ollama server, normally `http://localhost:11434` | No |
| `OLLAMA_EMBEDDING_MODEL` | Legacy local embedding model, normally `nomic-embed-text` | No |
| `OLLAMA_METADATA_MODEL` | Local Ollama vision-language model used for factual metadata after a video file exists; falls back to `OLLAMA_VISION_MODEL` | No |
| `OLLAMA_METADATA_NUM_CTX` | Ollama context window for frame batches and metadata consolidation (default 8192) | No |
| `VIDEO_METADATA_TRANSCRIPTION_ENABLED` | Full-track Whisper transcription for generated metadata (default `true`) | No |
| `VIDEO_METADATA_SAMPLE_INTERVAL_SECONDS` | Target spacing between timeline anchors (default 4 seconds) | No |
| `VIDEO_METADATA_MAX_FRAMES` | Maximum full-timeline sample frames (default 24, capped at 48) | No |
| `VIDEO_METADATA_FRAMES_PER_SEGMENT` | Ordered still frames per Ollama visual-analysis request (default 4) | No |
| `VIDEO_METADATA_SCENE_THRESHOLD` | FFmpeg scene detection sensitivity (default `0.32`) | No |
| `VIDEO_METADATA_FRAME_WIDTH` | Maximum extracted frame width, aspect ratio preserved (default 768) | No |
| `WHISPER_MODEL_PATH` | Local whisper.cpp model used to summarize audio evidence | No |
| `VIDEO_METADATA_MAX_FILE_BYTES` | Maximum local media size eligible for metadata analysis (default 100 MiB) | No |
| `VIDEO_METADATA_MAX_DURATION_SECONDS` | Maximum duration eligible for metadata analysis (default 600) | No |
| `OLLAMA_METADATA_TIMEOUT_MS` | Local metadata request timeout (default 240000) | No |
| `METADATA_WORKER_POLL_MS` | Metadata worker idle polling interval (default 2000) | No |
| `OPENAI_API_KEY` | Optional server-only key; used only when `EMBEDDING_PROVIDER=openai` | **No** |
| `EMBEDDING_WORKER_POLL_MS` | Worker idle polling interval, default `1500` | No |
| `RECALL_YTDLP_ENABLED` | Explicit local-only link-retrieval opt-in; defaults to `false` | No |
| `MEDIA_RETRIEVAL_PROVIDER` | Retrieval adapter ID; currently `yt-dlp` | No |
| `YTDLP_PATH` | yt-dlp executable path; defaults to `yt-dlp` on PATH | No |
| `YTDLP_DYLD_LIBRARY_PATH` | Optional macOS Homebrew Expat path passed only to the yt-dlp child | No |
| `YTDLP_TIMEOUT_MS` | Download timeout; defaults to 15 minutes and is capped at 25 minutes | No |
| `MEDIA_RETRIEVAL_WORKER_POLL_MS` | Retrieval worker idle interval, default `2000` | No |

Never put a Supabase service-role key or an inference token in a `NEXT_PUBLIC_` variable. EmbeddingGemma requests run through the local loopback Python service. If it or the separate migration is unavailable, Recall shows keyword results with a setup warning; it does not silently search the Nomic vector index. `OPENAI_API_KEY` is not needed for the primary provider.

## Database and privacy

The first migration creates `public.saved_items`, an index for each user's newest items, and the `search_saved_items` database function. Row-level security is enabled with separate read, insert, update, and delete policies. The primary EmbeddingGemma migration creates a separate 768-dimensional segment table, persistent queue, and authenticated search RPC without changing Nomic vectors or saved content. Its queue uses model-specific rows; the search RPC filters by the EmbeddingGemma model ID, current media/metadata versions, and `auth.uid()`. Queue rows are not readable by browser roles. The legacy Nomic queue/index remain isolated for rollback. While EmbeddingGemma is selected, the Nomic worker exits before claiming jobs, so it cannot produce new Nomic vectors.

Keyword search checks title, tags, notes, source URL, and available extracted text. EmbeddingGemma uses the documented `task: search result | query: ...` format for text queries and its multimodal video/audio encoders for timestamped media segments. Metadata vectors use the same EmbeddingGemma model. Search combines EmbeddingGemma ranks with keyword ranks; if the model service or migration is unavailable, it returns keyword matches with a warning and never queries Nomic vectors. Saving does not wait for model inference: database triggers atomically enqueue metadata/media jobs, and the local worker handles durable retries and version checks. The user-scoped backfill action calls the authenticated RPC. Nomic vectors are never converted or mixed into the EmbeddingGemma index.

## How to run and try it

1. Create an account and sign in.
2. Paste a link beginning with `https://` or `http://`; that is the only required field. Recall saves it immediately. If local retrieval is enabled and obtains a video, the metadata worker analyzes real video frames and any available transcript to propose a title, notes, and tags. You can edit generated metadata afterward. It never infers video contents from the URL alone.
3. Try exact keywords such as `trip song memory`, then a paraphrase such as `music from a journey with friends`.
4. Stop Ollama temporarily, save or edit an item, and confirm the save succeeds while its status stays pending. Restart Ollama; the worker retries automatically. After five failures, use **Retry failed indexing**.
5. Edit an item while an indexing job is running. The content version prevents the earlier job from overwriting the newer content's embedding.
6. Edit or delete an item, then verify its status/results update.
7. Create a second account and confirm its library does not show the first account's items.

## Queue recovery and worker operation

The queue is stored in Supabase, so stopping the Node worker does not lose queued work. Run `npm run worker` again to resume it; expired processing leases are reclaimed automatically. Transient errors retry with delays of 5, 10, 20, and 40 seconds (capped at one hour) up to five attempts. After the limit, the item becomes failed and shows a safe error summary. Fix Ollama/model availability, then use **Retry failed indexing**. Existing records with no queue entry can be queued with **Backfill existing items**. A production deployment must run this same worker as a continuously supervised Node process alongside the Next.js app; the Next.js request lifecycle does not run jobs.

Run the automated worker tests with `npm test`.

## Automatic video metadata generation

Metadata generation runs only after a video file is attached. The worker probes
the complete stream inventory and duration, transcribes the full audio track
with local whisper.cpp when configured, detects scene changes, and samples the
timeline with evenly spaced anchors plus distributed scene-change frames. It
analyzes timestamped still-image batches in chronological order through local
Ollama. This is frame-based analysis; it does not claim Ollama natively
understands continuous video or motion. Existing OCR, when available, is
supporting evidence rather than the sole source. Missing audio, transcription,
or frames are reported as warnings; visual analysis can still finish partially.
Without a transcript, the model must not claim speech, lyrics, or speakers. The
source URL is never evidence.

The validated JSON stores a title, 2–4 sentence summary, factual notes, tags,
transcript summary, visual summary, and warnings. User-edited title, notes, and
tags remain protected by the existing per-field flags. The summary fields are
separate from user notes and feed the current EmbeddingGemma metadata indexing
input; they do not alter or mix the Nomic index.

Install and start Ollama locally, then install a vision-language model that
your machine can run. Set the exact installed model name in `.env.local`:

```dotenv
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_METADATA_MODEL=<installed-vision-language-model>
VIDEO_METADATA_TRANSCRIPTION_ENABLED=true
WHISPER_MODEL_PATH=<path-to-whisper.cpp-model>
VIDEO_METADATA_SAMPLE_INTERVAL_SECONDS=4
VIDEO_METADATA_MAX_FRAMES=24
VIDEO_METADATA_FRAMES_PER_SEGMENT=4
VIDEO_METADATA_SCENE_THRESHOLD=0.32
```

The Ollama model is configured independently from `EMBEDDINGGEMMA_TOKEN` and
the port-11601 EmbeddingGemma service. That service is already running if it
successfully bound to `127.0.0.1:11601`; do not launch a duplicate copy. The
metadata worker calls only loopback Ollama and does not send media externally.
Set `RECALL_YTDLP_ENABLED=true` only for local authorized retrieval. Manual
uploads still work when retrieval is off.

## Telegram bot: find saved videos

The Telegram bot's only task is retrieval: send a natural-language description and it returns up to three strong, deduplicated saved-video links. It does not answer questions about video contents or expose the web assistant that was previously planned. The saved library remains the place to manage records, metadata, uploads, and indexing.

Create a bot with Telegram's BotFather, then set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` in `.env.local`. Set `SUPABASE_JWT_SECRET` to the project's **legacy HS256 JWT signing secret** (from Supabase API settings), not the publishable or service-role key. This server-only secret lets Recall mint a 60-second token with the linked user's `sub` and `role=authenticated`; existing semantic and keyword RPCs then run as that user and enforce `auth.uid()` and RLS. Projects that have disabled legacy HS256 signing need a compatible authenticated-token signing method before this integration can be used; do not replace this with a service-role search.

Generate a worker secret with `openssl rand -hex 32` and set it as `RECALL_TELEGRAM_WORKER_SECRET`. Set `RECALL_TELEGRAM_APP_URL` to the local Next.js origin (for example `http://127.0.0.1:3001` if Recall is on port 3001). Apply the Telegram migration manually. Then start `npm run dev` and, in a separate terminal, `npm run worker:telegram`. The worker uses Telegram long polling, so no public webhook or inbound tunnel is needed. In `/saved`, select **Connect Telegram**, open the one-time deep link in a private Telegram chat, and check the connection status. Codes expire after ten minutes; disconnect from the same Recall page to revoke the mapping.

The worker polls Telegram and forwards updates only to the configured local Recall server with the shared secret. Searches use the existing `searchSavedItems` implementation and local EmbeddingGemma query service; no video is reprocessed. EmbeddingGemma similarity is filtered only against its own configured threshold, while keyword-only matches use the existing keyword rank floor. These numeric values are independent and never fused together. `RECALL_TELEGRAM_MIN_SIMILARITY` defaults to `0.63`, a provisional setting checked against two queries over the current seven-item local library: a protein-product paraphrase scored `0.836` for the matching video, while the unrelated “underwater volcano on Mars” query scored at most `0.593`. That gap supported `0.63` for this small pilot; it is not a probability, correctness percentage, or broad calibration. Collect labeled queries from your library and tune it as you use the bot. If no candidate clears its own gate, the bot returns no cards instead of filling the response with weak matches.

This local setup depends on the Mac, Next.js, the EmbeddingGemma service, and internet access to Telegram remaining available. For always-on use, run the poller beside a self-hosted Recall server and local inference service on an always-on machine. A remote hosted app cannot reach a model bound only to your Mac's loopback address without a deliberate private-network deployment.

Review and apply the migrations manually, in order, using Supabase Dashboard →
SQL Editor → New query. Apply
`supabase/migrations/202610260001_video_metadata_generation.sql` first if it
has not already been applied, then review and apply
`supabase/migrations/202610260002_video_timeline_analysis.sql`. Migration 002
adds three summary columns, a version-checked completion RPC, extends the
EmbeddingGemma metadata trigger, and lengthens the metadata-job lease for the
longer analysis. It does not delete or rewrite saved items, media, jobs, or
vectors. Existing rows get empty summary values. If SQL fails, its transaction
rolls back; fix the error and rerun the full migration. Do not drop the queue
or edit an already-applied migration as the only fix.

Set `WHISPER_MODEL_PATH` to an installed whisper.cpp model to include spoken
content. The metadata worker attempts full-track transcription by default;
set `VIDEO_METADATA_TRANSCRIPTION_ENABLED=false` to turn it off. If no model is
configured, it records a warning and continues visual analysis. The maximum
frame count is capped at 48; the sample interval controls timeline anchor
density, and frames are resized with aspect ratio preserved. After both
migrations are applied, start `npm run worker:metadata` in its own terminal.
Once metadata is stored, the database queues EmbeddingGemma indexing
automatically.

After applying it, start this worker in its own terminal alongside the other
workers:

```sh
npm run worker:metadata
```

The worker uses bounded leases and retries. A user can request **Regenerate
missing metadata** on a video item; each field previously edited by the user
is protected from later generation. If Ollama/model inference fails, the URL
and media remain saved, the job retries, and the item displays a safe error.
When retrieval fails or is unsupported, no metadata is invented; URL and
existing user text remain searchable. Existing videos are not silently
backfilled. Regenerate metadata per eligible video as needed.

URL-only items always keep the source link and user-provided text. Experimental URL-to-video retrieval is disabled by default and intended for local development only. When enabled, supported Reel/post links are queued after save; the saved row and retrieval job are recorded atomically. A separate Node worker makes the attempt. A successful download is not proof of permission: use the experiment only for content you are authorized to retrieve and process. Do not enable it for public users until the intended automated collection and processing have been appropriately authorized.

## Experimental link-to-video retrieval

The adapter recognizes only ordinary HTTPS Instagram `/reel/`, `/reels/`, and `/p/` permalinks on `instagram.com` and `www.instagram.com`. It does not accept arbitrary URLs. The worker invokes the configured yt-dlp executable with an argument array and `shell: false`, passes `--ignore-config`, and never enables `--netrc` or uses passwords, cookies, browser sessions, proxies, or CAPTCHA workarounds. Unsupported links, private/authentication challenges, and rate limits become terminal states instead of automatic retry loops. Public links may still fail or stop working; Recall does not claim arbitrary Reels are downloadable.

For a local experiment, install yt-dlp (for example, `brew install yt-dlp ffmpeg`) and set these values in `.env.local`, then restart the Next.js server:

```dotenv
RECALL_YTDLP_ENABLED=true
MEDIA_RETRIEVAL_PROVIDER=yt-dlp
YTDLP_PATH=/opt/homebrew/bin/yt-dlp
YTDLP_DYLD_LIBRARY_PATH=/opt/homebrew/opt/expat/lib
```

Check your actual paths with `command -v yt-dlp` and `brew --prefix expat`; paste the resolved paths into `.env.local` because shell substitutions are not expanded there. `YTDLP_DYLD_LIBRARY_PATH` is added only to the yt-dlp child process; the Next server, parent worker, ffprobe, and video worker do not receive that override. The worker loads this project's `.env.local` before it reads worker settings.

The durable retrieval queue is private to the trusted worker and globally limits the app to one active download. It uses claim tokens, a 30-minute lease, duplicate prevention, four attempts, and exponential backoff for transient network/server errors. yt-dlp runs in a per-job temporary directory with generated output names and a timeout. The worker checks the real output path, file size, duration, video stream, and supported container with ffprobe before it moves the file into `.local-media/`. It does not transcode every download: an MP4 extension describes a container, not a codec, so VP9 and other FFmpeg-readable codecs are left for the existing video worker.

After validation, a transaction-safe RPC attaches the generated UUID file to the owning saved item and queues the existing `video_processing_jobs` entry. The existing video worker performs transcription/OCR and queues embeddings through the existing embedding worker. UI statuses separate retrieval, video processing, and indexing. If the provider blocks or requires authorization, Recall keeps the link and user-entered text searchable. Fix local configuration before using **Retry retrieval**; do not retry a source while it is rate limiting or blocking requests.

Review the full SQL in [`supabase/migrations/202610240001_media_retrieval_queue.sql`](supabase/migrations/202610240001_media_retrieval_queue.sql) before manually running it in Supabase SQL Editor. The additive migration adds retrieval status/version fields, a private queue table, triggers, and RPCs; it does not delete or rewrite existing saved content, embeddings, media files, embedding jobs, or video jobs. Existing items receive `media_retrieval_opt_in=false`, `not_requested`, and version `0`; no existing links are backfilled. If SQL execution fails, the transaction rolls back. Keep prior data and migrations, fix the error, and rerun migration 008. Never drop the new queue or columns as a rollback after jobs exist.

Run `npm run worker:retrieval` in its own terminal alongside `npm run worker:video` and `npm run worker`. If the worker stops, retrieval jobs remain in Supabase and resume after restart or lease expiry. If a completion RPC response is ambiguous after a network interruption, the worker intentionally keeps the generated file because the database may already point to it; inspect `media_storage_key` before removing any suspected orphan file.

To diagnose yt-dlp without changing queue rows, set `RECALL_YTDLP_DIAGNOSTIC_URL` for a public Reel URL you own or are authorized to test, then run `RECALL_YTDLP_DIAGNOSTIC_URL='https://www.instagram.com/reel/your-authorized-test/' npm run worker:retrieval:diagnose`. This checks `--version` and then runs the configured retrieval command in a temporary directory; it validates the returned media and removes the temporary file afterward. It does not claim or update a queue job. The worker normalizes Markdown input to a plain allowlisted URL and does not use a duration `--match-filter` in either production or diagnostic retrieval. It retains `--max-filesize`, an active download-directory size monitor, final file-size/duration checks, and `--no-quiet --verbose --no-simulate` in diagnostics. yt-dlp's `--print` option takes `after_move:filepath` as its separate template argument. Logs show the configured print template and sanitized process output, never the test URL or environment values. This mode makes a real request to the source, so only use a URL you are authorized to test.

## Stage 3: user-uploaded videos

Recall accepts MP4, MOV, and WebM files explicitly uploaded by the signed-in user. The upload route validates size and duration with `ffprobe`, writes a random UUID filename to `.local-media/` (Git-ignored), and calls a Postgres RPC that atomically inserts the saved-item row and its durable media job. A private authenticated route serves the file only after Supabase RLS returns the owning user's row. Manual upload remains available when link retrieval is disabled, unsupported, or unsuccessful.

This file storage is persistent on the development Mac and survives worker restarts, but it is local to that machine. A deployment with multiple hosts will need shared private object storage before uploads can be processed or played from other machines. The database metadata and jobs persist in Supabase.

### Install local tools on macOS

```sh
brew install ffmpeg
# Optional exact transcript/OCR tools:
brew install tesseract whisper.cpp
mkdir -p "$HOME/models/whisper"
curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin -o "$HOME/models/whisper/ggml-base.bin"
```

Whisper and Tesseract are disabled by default and are not required for semantic video/audio search. To opt into exact transcripts or OCR, set `VIDEO_TRANSCRIPTION_ENABLED=true` and/or `VIDEO_OCR_ENABLED=true`. For transcription, set `WHISPER_MODEL_PATH` in `.env.local` to a local multilingual whisper.cpp model file; `WHISPER_LANGUAGE=auto` uses language detection. Transcription and OCR remain local. Audio is converted to mono 16 kHz and whisper.cpp emits timestamped JSON segments independently of OCR. Tesseract reads sampled frames with explicit `VIDEO_OCR_LANGUAGE` (default `eng`), page segmentation mode 6, and TSV word confidences. The default OCR sampling interval is 2 seconds, expands to cover long videos within a 60-frame cap, preserves portrait orientation, and keeps frames at up to 1440 pixels wide. OCR copies are enlarged 2x, converted to grayscale, and mildly contrast-enhanced; confidence, minimum glyph height, and text-character quality filter the searchable text.

To inspect OCR on an existing local upload without claiming a queue job or changing database content, run `npm run worker:video:ocr-debug -- <generated-media-filename.mp4>`. The filename must be a generated media file inside `.local-media/`. The command saves selected source frames, enhanced OCR frames, raw TSV, word confidence/acceptance details, timestamps, and accepted text under `.local-media/ocr-debug/<random-id>/`. Directories use owner-only permissions and `.local-media/` is Git-ignored. You can also set `VIDEO_OCR_DEBUG=true` when running the video worker to retain a diagnostic report for normal processing. Set `VIDEO_OCR_MIN_CONFIDENCE`, `VIDEO_OCR_MIN_WORD_HEIGHT`, `VIDEO_OCR_PSM`, and `VIDEO_FRAME_INTERVAL_SECONDS` in `.env.local` to tune processing; lower thresholds retain more uncertain text.

Optional visual summaries use a separate local Ollama vision model. For example, run `ollama pull llava:7b` and set `OLLAMA_VISION_MODEL=llava:7b`. This does not change the primary EmbeddingGemma provider. Leave the vision variable blank to disable visual captions. Set `VIDEO_OCR_VISION_VERIFY=true` to additionally ask the same local vision model to transcribe only visible text; this requires `VIDEO_OCR_ENABLED=true`. No media is sent to an external service.

Stage 3 environment variables (all server-side): `RECALL_MEDIA_DIR` (`.local-media`), `RECALL_VIDEO_MAX_BYTES` (100 MB), `RECALL_VIDEO_MAX_DURATION_SECONDS` (600), `VIDEO_WORKER_POLL_MS` (2000), `FFMPEG_BIN`, `FFPROBE_BIN`, `VIDEO_TRANSCRIPTION_ENABLED` (default `false`), `VIDEO_OCR_ENABLED` (default `false`), `WHISPER_CPP_BIN`, `WHISPER_MODEL_PATH` (only when transcription is enabled), `WHISPER_LANGUAGE` (`auto`), `WHISPER_USE_GPU` (`false` by default), and the `VIDEO_OCR_*` options when OCR is enabled.

Run `npm run worker` for EmbeddingGemma multimodal indexing. `npm run worker:video` consumes the separate extraction queue when needed; with Whisper and OCR disabled it records that no exact text extraction was requested, while EmbeddingGemma indexes the actual media independently. The EmbeddingGemma worker uses a durable Supabase queue, leases, bounded retries, and content-version checks. Restarting it resumes queued work. For rollback, set `RECALL_SEARCH_PROVIDER=nomic`, configure the legacy Ollama provider, and run `npm run worker:nomic`; enable Whisper/OCR if you want those extracted texts in Nomic vectors.

Migration 006 adds columns, a private `video_processing_jobs` table, service-worker RPCs, an authenticated retry RPC, and a keyword-search update. It leaves existing vectors and saved items intact. Review it before applying in Supabase SQL Editor. For recovery, pause workers, keep the uploaded files and queue rows, inspect `media_error` and `video_processing_jobs.last_error`, fix the local dependency, then retry failed items. Do not drop the queue or media columns as a rollback; existing uploads reference them.

## Project map

```text
app/
  auth/callback/route.ts  Exchanges the email confirmation code for a session
  login/                  Sign-in and account creation
  saved/                  Protected library, item forms, search UI, and server actions
  api/search/             Authenticated hybrid search endpoint
  api/telegram/           Authenticated pairing and internal polling-update endpoints
  api/videos/             Authenticated video upload, playback, and retry endpoints
  globals.css             Tailwind base and page defaults
  layout.tsx              Root layout and metadata
lib/supabase/             Server client and session-refresh helper
proxy.ts                  Refreshes Supabase auth cookies for requests
lib/video-search.mjs       Shared high-precision video candidate filter for the bot
lib/                       Server-only Ollama/OpenAI embedding and hybrid search helpers
supabase/migrations/      Table security, pgvector, queues, and video processing schema
scripts/video-worker.mjs  Local FFmpeg/whisper.cpp/Tesseract queue worker
scripts/video-metadata-worker.mjs Local-only video metadata generation worker
scripts/media-retrieval-worker.mjs  Opt-in local yt-dlp retrieval queue worker
scripts/telegram-bot-worker.mjs     Optional Telegram long-polling adapter
```
# Primary local multimodal search (EmbeddingGemma 2)

The existing Nomic `saved_items.embedding` index stays available for rollback.
Recall stores `google/embeddinggemma-2` vectors in a separate 768-dimensional
table and uses a separate query RPC. Equal dimensions do not make vectors from
different models compatible. The app defaults to this separate index and never
compares Nomic vectors with EmbeddingGemma vectors.

## Local setup on macOS Apple Silicon

EmbeddingGemma 2 is Google's official multimodal Sentence Transformers model.
The published model repository is about 1.53 GB. This project uses a local
Python 3.12 environment, FFmpeg preprocessing, CPU inference when MPS is
unavailable, and one worker at a time to control memory use. The benchmark on
this Mac peaked at about 1.64 GiB RSS for the model process. Python packages
and model cache together currently use about 2.4 GB. Keep additional disk space
for temporary audio/video clips.

Install dependencies (Python 3.10–3.14 is supported by the PyTorch install
guidance; use Python 3.12 for this setup):

```sh
brew install python@3.12 ffmpeg
python3.12 -m venv .venv-embeddinggemma
source .venv-embeddinggemma/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-embeddinggemma.txt
```

`HF_HOME` defaults to the project-local `.huggingface-cache` for the service
and setup commands. Download the model weights once, locally:

```sh
HF_HOME=.huggingface-cache python -c 'from sentence_transformers import SentenceTransformer; SentenceTransformer("google/embeddinggemma-2")'
```

The inference service is restricted to `127.0.0.1` and requires a local bearer
token. Generate one with `openssl rand -hex 32` and add it to `.env.local` as `EMBEDDINGGEMMA_TOKEN`
(server only; never prefix it with `NEXT_PUBLIC_`). Add these settings:

```dotenv
RECALL_MEDIA_DIR=.local-media
HF_HOME=.huggingface-cache
EMBEDDINGGEMMA_URL=http://127.0.0.1:11601
EMBEDDINGGEMMA_PORT=11601
EMBEDDINGGEMMA_TOKEN=<a-long-random-local-token>
EG2_DEVICE=auto
EG2_CPU_THREADS=4
RECALL_SEARCH_PROVIDER=embeddinggemma2
```

Set `RECALL_SEARCH_PROVIDER=embeddinggemma2` as shown. If the local model
service or migration is unavailable, search shows keyword results and a clear
warning; it does not query Nomic vectors. To roll back, set
`RECALL_SEARCH_PROVIDER=nomic`, restart Next.js, and run `npm run worker:nomic`.

Start three local processes in separate terminals:

```sh
npm run dev
npm run embeddinggemma:service
npm run worker
npm run worker:video
```

The worker uses a durable Supabase queue and the local service, with one claim
at a time. It validates saved media paths, checks versions before accepting
vectors, and uses the database lease/retry RPCs. Current defaults are 30-second
segments, 0.5 sampled frames per second, at most 8 frames per model call, at
most 180 seconds and 100 MiB per video. Adjust `EG2_*` values only after
measuring memory and latency on the actual machine.

Direct multimodal EmbeddingGemma indexing is the normal path. Whisper and
Tesseract are off by default and remain optional for exact transcript or OCR
search. Set `VIDEO_TRANSCRIPTION_ENABLED=true` and/or `VIDEO_OCR_ENABLED=true`
to enable them; raw audio/video indexing does not depend on either tool.

## Separate database migration

Review the full file
`supabase/migrations/202610250001_embeddinggemma2_multimodal_index.sql`, then
paste the entire migration into the Supabase SQL Editor and run it manually. It is additive: it
adds EmbeddingGemma version/status fields, a separate segment-vector table, its
own durable queue, queue/claim/complete/fail RPCs, a distinct search RPC, and a
user-scoped manual backfill RPC. It does not alter or delete Nomic vectors,
existing saved items, the existing embedding queue, or the current search RPC.
The triggers enqueue metadata jobs for saved items and media jobs for
media-backed items when they are created or their indexed fields change. Thus
title/notes/tags remain searchable even if link retrieval is unavailable. Apply
this migration manually before switching the provider; neither the app nor a
worker runs SQL migrations automatically.

After applying the migration, sign in to Recall and click **Backfill / retry
EmbeddingGemma items**. The server action uses the signed-in user's Supabase
session to call `enqueue_existing_multimodal_items()`, so it queues only that
user's metadata and media-backed records. New saved rows, edits, and added media
are queued automatically by database triggers. The server-only multimodal
worker processes the durable jobs. If migration execution needs recovery, first inspect the
Supabase SQL Editor error and migration state; because it runs in a transaction,
an unsuccessful application should roll back its DDL. Do not drop the new
tables or re-run ad hoc destructive SQL. Reapplying the additive migration is
safe for its `if not exists` objects and replaceable functions/triggers.

## Optional local pilot benchmark

The reproducible pilot dataset and result file live under ignored
`.local-media/embeddinggemma2-pilot.json` and
`.local-media/embeddinggemma2-pilot-results.json`. Run:

```sh
HF_HOME=.huggingface-cache npm run embeddinggemma:benchmark
```

The pilot runner writes vectors and rankings locally; it does not change the
database. It evaluates text queries against whole-video, whole-audio, and
metadata vectors. The production worker instead uses timestamped segments. It
reports Recall@1/3/5, indexing/query time, peak RSS, and failures. This pilot is
diagnostic only; it is not a gate for using EmbeddingGemma as the primary
provider.
