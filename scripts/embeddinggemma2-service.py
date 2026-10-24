"""Private loopback inference service for Google's official EmbeddingGemma 2."""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import subprocess
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

PROJECT_ROOT = Path(__file__).resolve().parents[1]
from local_env import load_project_env

load_project_env(PROJECT_ROOT / ".env.local")
os.environ.setdefault("HF_HOME", str(PROJECT_ROOT / ".huggingface-cache"))

import numpy as np
import torch
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

MODEL_ID = "google/embeddinggemma-2"
MEDIA_ROOT = Path(os.getenv("RECALL_MEDIA_DIR", ".local-media")).resolve()


def bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


def bounded_float(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


MAX_FILE_BYTES = bounded_int("EG2_MAX_FILE_BYTES", 100 * 1024 * 1024, 1 * 1024 * 1024, 1024 * 1024 * 1024)
MAX_DURATION_SECONDS = bounded_int("EG2_MAX_VIDEO_SECONDS", 180, 1, 600)
SEGMENT_SECONDS = bounded_int("EG2_SEGMENT_SECONDS", 30, 5, 60)
VIDEO_MAX_FRAMES = bounded_int("EG2_VIDEO_MAX_FRAMES", 8, 1, 16)
VIDEO_SAMPLE_FPS = bounded_float("EG2_VIDEO_SAMPLE_FPS", 0.5, 0.1, 2.0)
INFERENCE_TOKEN = os.getenv("EMBEDDINGGEMMA_TOKEN", "")
MODEL: SentenceTransformer | None = None
INFERENCE_LOCK = asyncio.Lock()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global MODEL
    if not INFERENCE_TOKEN:
        raise RuntimeError("Set EMBEDDINGGEMMA_TOKEN before starting the local inference service.")
    torch.set_num_threads(max(1, min(4, int(os.getenv("EG2_CPU_THREADS", "4")))))
    requested_device = os.getenv("EG2_DEVICE", "auto")
    device = "mps" if requested_device in ("auto", "mps") and torch.backends.mps.is_available() else "cpu"
    if requested_device == "cpu":
        device = "cpu"
    MODEL = SentenceTransformer(MODEL_ID, device=device, local_files_only=True)
    yield
    MODEL = None


app = FastAPI(title="Recall local EmbeddingGemma 2", docs_url=None, redoc_url=None, lifespan=lifespan)


class QueryRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)


class MediaRequest(BaseModel):
    path: str | None = Field(default=None, max_length=4096)
    scope: Literal["media", "metadata", "all"]
    title: str = Field(default="", max_length=300)
    notes: str = Field(default="", max_length=4000)
    tags: list[str] = Field(default_factory=list, max_length=40)


def verify_token(authorization: str | None) -> None:
    expected = f"Bearer {INFERENCE_TOKEN}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Local inference authentication failed.")


def encode(value, **kwargs) -> list[float]:
    if MODEL is None:
        raise HTTPException(status_code=503, detail="The local embedding model is not loaded.")
    vector = np.asarray(MODEL.encode(value, normalize_embeddings=True, **kwargs), dtype=np.float32)
    if vector.shape != (768,) or not np.isfinite(vector).all():
        raise HTTPException(status_code=500, detail="The model returned an invalid vector shape.")
    return vector.tolist()


def run(args: list[str], timeout_seconds: int = 180) -> str:
    try:
        result = subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout_seconds)
        return result.stdout.strip()
    except subprocess.TimeoutExpired as error:
        raise HTTPException(status_code=422, detail="Local media preprocessing timed out.") from error
    except (subprocess.CalledProcessError, OSError) as error:
        raise HTTPException(status_code=422, detail="FFmpeg could not read the local video or audio stream.") from error


def validate_media(path_value: str) -> tuple[Path, float, bool]:
    candidate = Path(path_value).resolve(strict=True)
    if candidate.parent != MEDIA_ROOT or not candidate.is_file():
        raise HTTPException(status_code=403, detail="Media path is outside Recall's private local storage.")
    size = candidate.stat().st_size
    if size < 1 or size > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="Video file is empty or exceeds the local processing size limit.")
    try:
        duration = float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(candidate)], 30))
        streams = json.loads(run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", str(candidate)], 30))
    except ValueError as error:
        raise HTTPException(status_code=422, detail="ffprobe returned invalid media metadata.") from error
    if duration <= 0 or duration > MAX_DURATION_SECONDS:
        raise HTTPException(status_code=422, detail=f"Video duration must be at most {MAX_DURATION_SECONDS} seconds.")
    types = {stream.get("codec_type") for stream in streams.get("streams", [])}
    if "video" not in types:
        raise HTTPException(status_code=422, detail="The media file has no video stream.")
    return candidate, duration, "audio" in types


def metadata_text(request: MediaRequest) -> str:
    clean_tags = [tag.strip()[:100] for tag in request.tags if tag.strip()]
    content = "\n".join(part for part in [request.notes.strip(), f"Tags: {', '.join(clean_tags)}" if clean_tags else ""] if part)
    return f"title: {request.title.strip() or 'none'} | text: {content or request.title.strip()}"


@app.get("/health")
async def health(authorization: str | None = Header(default=None)):
    verify_token(authorization)
    return {"ready": MODEL is not None, "model": MODEL_ID, "dimensions": 768, "device": str(MODEL.device) if MODEL else None}


@app.post("/v1/embed-query")
async def embed_query(request: QueryRequest, authorization: str | None = Header(default=None)):
    verify_token(authorization)
    async with INFERENCE_LOCK:
        vector = encode(f"task: search result | query: {request.query.strip()}")
    return {"model": MODEL_ID, "dimensions": 768, "embedding": vector}


@app.post("/v1/index-media")
async def index_media(request: MediaRequest, authorization: str | None = Header(default=None)):
    verify_token(authorization)
    media_path = None
    duration = 0.0
    has_audio = False
    if request.scope in ("media", "all"):
        if not request.path:
            raise HTTPException(status_code=422, detail="A private local video path is required for media indexing.")
        media_path, duration, has_audio = validate_media(request.path)
    output: list[dict] = []
    async with INFERENCE_LOCK:
        if request.scope in ("metadata", "all"):
            output.append({"modality": "metadata", "start": None, "end": None, "embedding": encode(metadata_text(request))})
        if request.scope in ("media", "all"):
            with tempfile.TemporaryDirectory(prefix="recall-eg2-") as temp_dir:
                temp_root = Path(temp_dir)
                for start in range(0, int(duration + 0.999), SEGMENT_SECONDS):
                    segment_duration = min(SEGMENT_SECONDS, duration - start)
                    if segment_duration <= 0:
                        continue
                    video_clip = temp_root / f"v-{start}.mp4"
                    run([
                        "ffmpeg", "-v", "error", "-ss", str(start), "-t", str(segment_duration), "-i", str(media_path),
                        "-map", "0:v:0", "-an", "-vf", f"fps={VIDEO_SAMPLE_FPS},scale=512:-2:flags=lanczos",
                        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", str(video_clip), "-y",
                    ])
                    video_vector = encode({"video": str(video_clip)}, processing_kwargs={"video": {
                        "max_frames": VIDEO_MAX_FRAMES, "fps": VIDEO_SAMPLE_FPS,
                        "overflow_strategy": "uniform", "add_timestamps": True,
                    }})
                    output.append({"modality": "video", "start": float(start), "end": float(start + segment_duration), "embedding": video_vector})
                    if has_audio:
                        audio_clip = temp_root / f"a-{start}.wav"
                        run([
                            "ffmpeg", "-v", "error", "-ss", str(start), "-t", str(segment_duration), "-i", str(media_path),
                            "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(audio_clip), "-y",
                        ])
                        audio_vector = encode({"audio": str(audio_clip)})
                        output.append({"modality": "audio", "start": float(start), "end": float(start + segment_duration), "embedding": audio_vector})
    return {"model": MODEL_ID, "dimensions": 768, "duration_seconds": duration or None, "segments": output}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("EMBEDDINGGEMMA_PORT", "11601")), log_level="warning")
