"""Local three-modality pilot for EmbeddingGemma 2; dataset stays Git-ignored."""

from __future__ import annotations

import json
import os
import resource
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
from local_env import load_project_env

load_project_env(ROOT / ".env.local")

import numpy as np
import torch
from sentence_transformers import SentenceTransformer


MEDIA_ROOT = (ROOT / os.getenv("RECALL_MEDIA_DIR", ".local-media")).resolve()
DATASET = Path(os.getenv("EG2_BENCHMARK_DATASET", MEDIA_ROOT / "embeddinggemma2-pilot.json"))
OUTPUT = Path(os.getenv("EG2_BENCHMARK_OUTPUT", MEDIA_ROOT / "embeddinggemma2-pilot-results.json"))
MODEL_ID = "google/embeddinggemma-2"
MAX_DURATION = int(os.getenv("EG2_MAX_VIDEO_SECONDS", "180"))
MAX_FRAMES = int(os.getenv("EG2_VIDEO_MAX_FRAMES", "8"))


def run(args: list[str]) -> str:
    completed = subprocess.run(args, check=True, capture_output=True, text=True)
    return completed.stdout.strip()


def similarity(left: np.ndarray, right: np.ndarray) -> float:
    return float(np.dot(left, right))


def recall_at_k(rows: list[dict], k: int) -> float:
    if not rows:
        return 0.0
    return sum(row["expected_item_id"] in row["ranked_item_ids"][:k] for row in rows) / len(rows)


def main() -> None:
    dataset = json.loads(DATASET.read_text())
    torch.set_num_threads(max(1, min(4, int(os.getenv("EG2_CPU_THREADS", "4")))))
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    started = time.perf_counter()
    model = SentenceTransformer(MODEL_ID, device=device)
    model_load_seconds = time.perf_counter() - started
    item_vectors: dict[str, dict[str, np.ndarray]] = {}
    item_timings: dict[str, dict[str, float]] = {}
    failures: list[dict] = []
    total_queries = []
    for item in dataset["videos"]:
        media_path = (MEDIA_ROOT / item["file"]).resolve()
        if media_path.parent != MEDIA_ROOT or not media_path.is_file():
            failures.append({"item_id": item["id"], "error": "missing_or_unsafe_local_media"})
            continue
        duration = float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(media_path)]))
        if duration <= 0 or duration > MAX_DURATION:
            failures.append({"item_id": item["id"], "error": "video_duration_out_of_pilot_limits", "duration_seconds": duration})
            continue
        vectors: dict[str, np.ndarray] = {}
        timings: dict[str, float] = {}
        try:
            before = time.perf_counter()
            vectors["video"] = model.encode(
                {"video": str(media_path)},
                normalize_embeddings=True,
                processing_kwargs={"video": {"max_frames": MAX_FRAMES, "fps": None, "overflow_strategy": "uniform", "add_timestamps": True}},
            )
            timings["video_seconds"] = time.perf_counter() - before
            with tempfile.TemporaryDirectory(prefix="recall-eg2-audio-") as temp_dir:
                wav_path = Path(temp_dir) / "audio.wav"
                run(["ffmpeg", "-v", "error", "-i", str(media_path), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav_path), "-y"])
                before = time.perf_counter()
                vectors["audio"] = model.encode({"audio": str(wav_path)}, normalize_embeddings=True)
                timings["audio_seconds"] = time.perf_counter() - before
            metadata = f"title: {item['title']} | text: {item['notes']} Tags: {', '.join(item['tags'])}"
            before = time.perf_counter()
            vectors["metadata"] = model.encode(metadata, normalize_embeddings=True)
            timings["metadata_seconds"] = time.perf_counter() - before
            if any(vector.shape != (768,) for vector in vectors.values()):
                raise ValueError("expected three 768-dimensional vectors")
            item_vectors[item["id"]] = vectors
            item_timings[item["id"]] = {"duration_seconds": duration, **timings, "index_seconds": sum(timings.values())}
            for query in item["queries"]:
                total_queries.append({**query, "expected_item_id": item["id"]})
        except Exception as error:  # Keep a failed video from hiding other pilot results.
            failures.append({"item_id": item["id"], "error": f"{type(error).__name__}: {str(error)[:400]}"})

    query_started = time.perf_counter()
    query_texts = [f"task: search result | query: {query['text']}" for query in total_queries]
    query_vectors = model.encode(query_texts, batch_size=4, normalize_embeddings=True)
    query_seconds = time.perf_counter() - query_started
    rows = []
    item_lookup = {item["id"]: item for item in dataset["videos"]}
    for query, query_vector in zip(total_queries, query_vectors, strict=True):
        scores = []
        for item_id, modalities in item_vectors.items():
            by_modality = {key: similarity(query_vector, vector) for key, vector in modalities.items()}
            best_modality = max(by_modality, key=by_modality.get)
            scores.append({"item_id": item_id, "score": by_modality[best_modality], "best_modality": best_modality, "scores": by_modality})
        ranked = sorted(scores, key=lambda row: row["score"], reverse=True)
        rows.append({
            "query": query["text"], "kind": query["kind"], "expected_item_id": query["expected_item_id"],
            "expected_title": item_lookup[query["expected_item_id"]]["title"],
            "ranked_item_ids": [row["item_id"] for row in ranked],
            "ranked_titles": [item_lookup[row["item_id"]]["title"] for row in ranked],
            "top_scores": ranked,
        })
    peak_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if os.uname().sysname == "Darwin":
        peak_rss /= 1024**3
    else:
        peak_rss /= 1024**2
    result = {
        "model": MODEL_ID, "dimensions": 768, "device": str(model.device),
        "dataset_videos": len(item_vectors), "query_count": len(rows), "model_load_seconds": model_load_seconds,
        "query_batch_seconds": query_seconds, "mean_query_seconds": query_seconds / max(1, len(rows)),
        "peak_process_rss_gib": peak_rss, "item_timings": item_timings, "failures": failures,
        "metrics": {f"recall_at_{k}": recall_at_k(rows, k) for k in (1, 3, 5)},
        "scope_note": dataset.get("scope_note", "pilot only"), "queries": rows,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({key: result[key] for key in ("dimensions", "device", "dataset_videos", "query_count", "model_load_seconds", "query_batch_seconds", "mean_query_seconds", "peak_process_rss_gib", "item_timings", "failures", "metrics", "scope_note")}, indent=2))
    print(f"Detailed local-only results: {OUTPUT}")


if __name__ == "__main__":
    main()
