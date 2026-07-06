from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


ALGORITHM_VERSION = "classical-image-analysis-v1"
MAX_ANALYSIS_DIMENSION = int(os.environ.get("IMAGE_ANALYSIS_MAX_DIMENSION", "1024"))
PREVIEW_DIMENSION = int(os.environ.get("IMAGE_ANALYSIS_PREVIEW_DIMENSION", "512"))


@dataclass(frozen=True)
class Thresholds:
    blur_blurry: float = float(os.environ.get("IMAGE_ANALYSIS_BLUR_BLURRY", "80"))
    blur_slightly_blurry: float = float(os.environ.get("IMAGE_ANALYSIS_BLUR_SLIGHTLY_BLURRY", "180"))
    duplicate_hash_distance: int = int(os.environ.get("IMAGE_ANALYSIS_DUPLICATE_HASH_DISTANCE", "4"))
    similar_hash_distance: int = int(os.environ.get("IMAGE_ANALYSIS_SIMILAR_HASH_DISTANCE", "6"))
    heavy_compression_blockiness: float = float(os.environ.get("IMAGE_ANALYSIS_HEAVY_BLOCKINESS", "9.0"))


def default_db_path() -> Path:
    return Path(os.environ.get("IMAGE_ANALYSIS_DB", "data/image_analysis.db"))


def default_preview_dir() -> Path:
    return Path(os.environ.get("IMAGE_ANALYSIS_PREVIEW_DIR", "data/image-analysis/previews"))


def init_db(db_path: Path | None = None) -> None:
    db = Path(db_path or default_db_path())
    db.parent.mkdir(parents=True, exist_ok=True)
    schema_path = Path(__file__).with_name("schema.sql")
    with sqlite3.connect(db) as conn:
        conn.executescript(schema_path.read_text(encoding="utf-8"))


def query_analysis(
    db_path: Path | None = None,
    group_id: str | None = None,
    media_id: str | None = None,
) -> list[dict[str, Any]]:
    db = Path(db_path or default_db_path())
    if not db.exists():
        return []
    where: list[str] = []
    values: list[str] = []
    if group_id:
        where.append("group_id = ?")
        values.append(group_id)
    if media_id:
        where.append("media_id = ?")
        values.append(media_id)
    sql = "SELECT * FROM image_analysis"
    if where:
        sql += " WHERE " + " AND ".join(where)
    with sqlite3.connect(db) as conn:
        conn.row_factory = sqlite3.Row
        return [_decode_row(dict(row)) for row in conn.execute(sql, values)]


def analyze_image_file(
    image_path: Path,
    group_id: str,
    media_id: str,
    *,
    db_path: Path | None = None,
    preview_dir: Path | None = None,
    force: bool = False,
    thresholds: Thresholds | None = None,
) -> dict[str, Any]:
    thresholds = thresholds or Thresholds()
    db = Path(db_path or default_db_path())
    previews = Path(preview_dir or default_preview_dir())
    init_db(db)

    if not force:
        existing = query_analysis(db, group_id, media_id)
        if existing and existing[0].get("status") == "success":
            return existing[0]

    started = time.perf_counter()
    _record_status(db, group_id, media_id, "processing", ALGORITHM_VERSION)
    try:
        result = _calculate_signals(image_path, group_id, media_id, previews, thresholds, db)
        result["status"] = "success"
        result["error_message"] = None
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        _record_error(db, group_id, media_id, str(exc), elapsed_ms)
        raise

    result["processing_time_ms"] = int((time.perf_counter() - started) * 1000)
    result["algorithm_version"] = ALGORITHM_VERSION
    result["thresholds"] = asdict(thresholds)
    _upsert_success(db, group_id, media_id, result)
    return result


def _calculate_signals(
    image_path: Path,
    group_id: str,
    media_id: str,
    preview_dir: Path,
    thresholds: Thresholds,
    db_path: Path,
) -> dict[str, Any]:
    import cv2
    import imagehash
    import numpy as np
    from PIL import Image, ImageOps

    file_size = image_path.stat().st_size
    sha256 = hashlib.sha256(image_path.read_bytes()).hexdigest()

    with Image.open(image_path) as original:
        image_format = original.format or image_path.suffix.lstrip(".").upper() or "unknown"
        exif_date = _extract_exif_date(original)
        width, height = original.size
        aspect_ratio = width / height if height else 0
        color_mode = "grayscale" if original.mode in {"1", "L", "I;16"} else "color"

        # Keep a bounded RGB copy for analysis so large phone images do not
        # consume Raspberry Pi memory unnecessarily.
        rgb = ImageOps.exif_transpose(original).convert("RGB")
        rgb.thumbnail((MAX_ANALYSIS_DIMENSION, MAX_ANALYSIS_DIMENSION), Image.Resampling.LANCZOS)
        rgb_array = np.asarray(rgb)

    gray = cv2.cvtColor(rgb_array, cv2.COLOR_RGB2GRAY)
    brightness_mean = float(np.mean(gray))
    contrast_stddev = float(np.std(gray))

    # The Laplacian responds strongly to fine detail. Low variance usually
    # means few sharp transitions, which is a practical blur heuristic.
    laplacian = cv2.Laplacian(gray, cv2.CV_64F)
    blur_score = float(laplacian.var())

    # Canny marks strong intensity transitions; edge density is the percentage
    # of pixels classified as edges after hysteresis thresholding.
    edges = cv2.Canny(gray, 100, 200)
    edge_density = float(np.count_nonzero(edges) / edges.size)

    # This noise score is approximate: high-pass residuals include both sensor
    # noise and real image texture, so treat it as a diagnostic signal only.
    denoised = cv2.medianBlur(gray, 3)
    noise_score = float(np.std(gray.astype(np.float32) - denoised.astype(np.float32)))

    dominant_colors = _dominant_colors(rgb_array)
    histogram = _color_histogram(rgb_array)
    average_rgb = [int(v) for v in np.mean(rgb_array.reshape(-1, 3), axis=0)]

    phash = str(imagehash.phash(Image.fromarray(rgb_array)))
    dhash = str(imagehash.dhash(Image.fromarray(rgb_array)))
    average_hash = str(imagehash.average_hash(Image.fromarray(rgb_array)))

    exact_duplicate_of, similar_matches = _find_duplicates(
        db_path,
        group_id,
        media_id,
        sha256,
        phash,
        dhash,
        average_hash,
        thresholds,
    )

    blockiness_score = _jpeg_blockiness(gray)
    low_energy, medium_energy, high_energy, fourier_preview = _fourier_signals(gray)
    preview_paths = _write_previews(preview_dir, group_id, media_id, gray, edges, fourier_preview, histogram)

    return {
        "width": width,
        "height": height,
        "aspect_ratio": aspect_ratio,
        "file_format": image_format,
        "file_size_bytes": file_size,
        "color_mode": color_mode,
        "exif_date": exif_date,
        "brightness_mean": brightness_mean,
        "brightness_label": _brightness_label(brightness_mean),
        "contrast_stddev": contrast_stddev,
        "contrast_label": _contrast_label(contrast_stddev),
        "blur_score": blur_score,
        "blur_label": _blur_label(blur_score, thresholds),
        "edge_density": edge_density,
        "noise_score": noise_score,
        "average_rgb": average_rgb,
        "dominant_colors": dominant_colors,
        "color_histogram": histogram,
        "phash": phash,
        "dhash": dhash,
        "average_hash": average_hash,
        "sha256": sha256,
        "exact_duplicate_of": exact_duplicate_of,
        "similar_matches": similar_matches,
        "blockiness_score": blockiness_score,
        "compression_label": "heavily compressed" if blockiness_score >= thresholds.heavy_compression_blockiness else "normal",
        "low_frequency_energy": low_energy,
        "medium_frequency_energy": medium_energy,
        "high_frequency_energy": high_energy,
        "is_screenshot": _looks_like_screenshot(width, height, edge_density, color_mode),
        **preview_paths,
    }


def _extract_exif_date(image: Image.Image) -> str | None:
    try:
        exif = image.getexif()
    except Exception:
        return None
    for tag in (36867, 36868, 306):
        value = exif.get(tag)
        if value:
            return str(value)
    return None


def _brightness_label(value: float) -> str:
    if value < 45:
        return "very dark"
    if value < 85:
        return "dark"
    if value > 230:
        return "overexposed"
    if value > 185:
        return "bright"
    return "normal"


def _contrast_label(value: float) -> str:
    if value < 35:
        return "low"
    if value > 85:
        return "high"
    return "normal"


def _blur_label(value: float, thresholds: Thresholds) -> str:
    if value < thresholds.blur_blurry:
        return "blurry"
    if value < thresholds.blur_slightly_blurry:
        return "slightly blurry"
    return "sharp"


def _dominant_colors(rgb_array: np.ndarray, clusters: int = 5) -> list[dict[str, Any]]:
    import numpy as np
    from scipy.cluster.vq import kmeans2

    sample = rgb_array.reshape(-1, 3).astype(np.float32)
    if len(sample) > 5000:
        sample = sample[np.linspace(0, len(sample) - 1, 5000, dtype=np.int64)]
    unique_count = len(np.unique(sample.astype(np.uint8), axis=0))
    k = max(1, min(clusters, unique_count))
    centroids, labels = kmeans2(sample, k, minit="points", iter=20)
    counts = np.bincount(labels, minlength=k)
    total = max(1, int(counts.sum()))
    ranked = sorted(zip(centroids, counts), key=lambda item: int(item[1]), reverse=True)
    return [
        {"rgb": [int(max(0, min(255, round(v)))) for v in centroid], "percent": float(count / total)}
        for centroid, count in ranked
    ]


def _color_histogram(rgb_array: np.ndarray) -> dict[str, list[float]]:
    import numpy as np

    histogram: dict[str, list[float]] = {}
    for channel, name in enumerate(("r", "g", "b")):
        counts, _ = np.histogram(rgb_array[:, :, channel], bins=16, range=(0, 256))
        total = max(1, int(counts.sum()))
        histogram[name] = [float(count / total) for count in counts]
    return histogram


def _find_duplicates(
    db_path: Path,
    group_id: str,
    media_id: str,
    sha256: str,
    phash: str,
    dhash: str,
    average_hash: str,
    thresholds: Thresholds,
) -> tuple[str | None, list[dict[str, Any]]]:
    exact_duplicate_of = None
    matches: list[dict[str, Any]] = []
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT group_id, media_id, phash, dhash, average_hash, json_extract(thresholds_json, '$.sha256') AS sha256
            FROM image_analysis
            WHERE status = 'success' AND NOT (group_id = ? AND media_id = ?)
            """,
            (group_id, media_id),
        ).fetchall()

    for row in rows:
        other_id = f"{row['group_id']}/{row['media_id']}"
        if row["sha256"] == sha256 and not exact_duplicate_of:
            exact_duplicate_of = other_id
        distances = [
            _hash_distance(phash, row["phash"]),
            _hash_distance(dhash, row["dhash"]),
            _hash_distance(average_hash, row["average_hash"]),
        ]
        distance = min(value for value in distances if value is not None) if any(v is not None for v in distances) else None
        if distance is not None and distance <= thresholds.similar_hash_distance:
            matches.append({
                "group_id": row["group_id"],
                "media_id": row["media_id"],
                "distance": int(distance),
                "duplicate": distance <= thresholds.duplicate_hash_distance,
            })
    matches.sort(key=lambda match: match["distance"])
    return exact_duplicate_of, matches[:10]


def _hash_distance(left: str | None, right: str | None) -> int | None:
    if not left or not right:
        return None
    return bin(int(left, 16) ^ int(right, 16)).count("1")


def _jpeg_blockiness(gray: np.ndarray) -> float:
    import numpy as np

    # JPEG encodes 8x8 blocks. A larger average jump across 8-pixel boundaries
    # than inside blocks is a rough blockiness indicator, not proof of quality.
    vertical_boundary = np.abs(np.diff(gray[:, 7::8].astype(np.float32), axis=1)).mean() if gray.shape[1] > 16 else 0
    horizontal_boundary = np.abs(np.diff(gray[7::8, :].astype(np.float32), axis=0)).mean() if gray.shape[0] > 16 else 0
    vertical_inside = np.abs(np.diff(gray[:, 3::8].astype(np.float32), axis=1)).mean() if gray.shape[1] > 16 else 0
    horizontal_inside = np.abs(np.diff(gray[3::8, :].astype(np.float32), axis=0)).mean() if gray.shape[0] > 16 else 0
    return float(max(0.0, ((vertical_boundary + horizontal_boundary) / 2) - ((vertical_inside + horizontal_inside) / 2)))


def _fourier_signals(gray: np.ndarray) -> tuple[float, float, float, np.ndarray]:
    import numpy as np

    # FFT decomposes the image into spatial frequencies. The proportions below
    # are educational diagnostics and should not be treated as final quality.
    spectrum = np.fft.fftshift(np.fft.fft2(gray.astype(np.float32)))
    magnitude = np.abs(spectrum)
    energy = magnitude ** 2
    rows, cols = gray.shape
    y, x = np.ogrid[:rows, :cols]
    radius = np.sqrt((y - rows / 2) ** 2 + (x - cols / 2) ** 2)
    max_radius = math.sqrt((rows / 2) ** 2 + (cols / 2) ** 2)
    total = float(energy.sum()) or 1.0
    low = float(energy[radius <= max_radius * 0.15].sum() / total)
    medium = float(energy[(radius > max_radius * 0.15) & (radius <= max_radius * 0.45)].sum() / total)
    high = float(energy[radius > max_radius * 0.45].sum() / total)
    log_magnitude = np.log1p(magnitude)
    preview = (255 * (log_magnitude - log_magnitude.min()) / (np.ptp(log_magnitude) or 1)).astype(np.uint8)
    return low, medium, high, preview


def _write_previews(
    preview_dir: Path,
    group_id: str,
    media_id: str,
    gray: np.ndarray,
    edges: np.ndarray,
    fourier: np.ndarray,
    histogram: dict[str, list[float]],
) -> dict[str, str]:
    out_dir = preview_dir / _safe_name(group_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = _safe_name(media_id)
    paths = {
        "preview_grayscale_path": out_dir / f"{stem}_grayscale.png",
        "preview_edges_path": out_dir / f"{stem}_edges.png",
        "preview_fourier_path": out_dir / f"{stem}_fourier.png",
        "preview_histogram_path": out_dir / f"{stem}_histogram.png",
    }
    _save_thumbnail(gray, paths["preview_grayscale_path"])
    _save_thumbnail(edges, paths["preview_edges_path"])
    _draw_fourier_preview(fourier).save(paths["preview_fourier_path"])
    _draw_histogram(histogram).save(paths["preview_histogram_path"])
    return {key: str(value) for key, value in paths.items()}


def _save_thumbnail(array: np.ndarray, path: Path) -> None:
    from PIL import Image

    image = Image.fromarray(array)
    image.thumbnail((PREVIEW_DIMENSION, PREVIEW_DIMENSION), Image.Resampling.LANCZOS)
    image.save(path)


def _draw_histogram(histogram: dict[str, list[float]]) -> Image.Image:
    from PIL import Image, ImageDraw

    width, height = 640, 360
    left, right, top, bottom = 62, 22, 44, 58
    plot_width = width - left - right
    plot_height = height - top - bottom
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    colors = {"r": (190, 45, 45), "g": (35, 135, 70), "b": (45, 85, 190)}
    bins = len(histogram["r"])
    max_value = max(max(values) for values in histogram.values()) or 1.0

    draw.text((left, 14), "Colour histogram", fill=(20, 24, 22))
    draw.line((left, top, left, top + plot_height, left + plot_width, top + plot_height), fill=(90, 96, 92), width=1)
    for tick, label in ((0, "0"), (64, "64"), (128, "128"), (192, "192"), (255, "255")):
        x = left + int((tick / 255) * plot_width)
        draw.line((x, top + plot_height, x, top + plot_height + 5), fill=(90, 96, 92), width=1)
        draw.text((x - 10, top + plot_height + 10), label, fill=(45, 52, 48))
    for fraction, label in ((0.0, "0%"), (0.5, "50%"), (1.0, "max")):
        y = top + plot_height - int(fraction * plot_height)
        draw.line((left - 5, y, left, y), fill=(90, 96, 92), width=1)
        draw.text((14, y - 7), label, fill=(45, 52, 48))
    draw.text((left + plot_width // 2 - 54, height - 24), "Pixel intensity, dark to bright", fill=(45, 52, 48))
    draw.text((8, 20), "Share of pixels", fill=(45, 52, 48))

    bar_width = plot_width / bins
    for channel, values in histogram.items():
        for index, value in enumerate(values):
            x0 = left + int(index * bar_width)
            x1 = left + int((index + 1) * bar_width) - 2
            y0 = top + plot_height - int((value / max_value) * plot_height)
            draw.rectangle((x0, max(top, y0), x1, top + plot_height), outline=colors[channel])

    legend_x = left + 168
    for offset, (label, color) in enumerate((("Red channel", colors["r"]), ("Green channel", colors["g"]), ("Blue channel", colors["b"]))):
        x = legend_x + offset * 132
        draw.rectangle((x, 18, x + 14, 30), fill=color)
        draw.text((x + 20, 17), label, fill=(45, 52, 48))
    return image


def _draw_fourier_preview(fourier: np.ndarray) -> Image.Image:
    from PIL import Image, ImageDraw

    base = Image.fromarray(fourier).convert("RGB")
    base.thumbnail((512, 512), Image.Resampling.LANCZOS)
    width, height = base.size
    margin_top = 64
    margin_bottom = 54
    image = Image.new("RGB", (width, height + margin_top + margin_bottom), "white")
    image.paste(base, (0, margin_top))
    draw = ImageDraw.Draw(image)
    center_x, center_y = width // 2, margin_top + height // 2
    radius_low = int(min(width, height) * 0.15)
    radius_medium = int(min(width, height) * 0.45)
    draw.text((12, 12), "Fourier spectrum, log magnitude", fill=(20, 24, 22))
    draw.text((12, 34), "Centre = smooth shapes and lighting. Outer area = edges, texture, noise.", fill=(45, 52, 48))
    draw.ellipse((center_x - radius_low, center_y - radius_low, center_x + radius_low, center_y + radius_low), outline=(64, 180, 105), width=2)
    draw.ellipse((center_x - radius_medium, center_y - radius_medium, center_x + radius_medium, center_y + radius_medium), outline=(220, 160, 52), width=2)
    draw.line((center_x - 8, center_y, center_x + 8, center_y), fill=(255, 255, 255), width=1)
    draw.line((center_x, center_y - 8, center_x, center_y + 8), fill=(255, 255, 255), width=1)
    draw.text((12, margin_top + height + 12), "Green ring: low frequencies. Yellow ring: medium frequencies. Outside: high frequencies.", fill=(45, 52, 48))
    return image


def _looks_like_screenshot(width: int, height: int, edge_density: float, color_mode: str) -> int:
    ratio = width / height if height else 0
    phone_ratio = 0.42 <= ratio <= 0.62 or 1.6 <= ratio <= 2.4
    return int(color_mode == "color" and phone_ratio and edge_density > 0.06)


def _safe_name(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in value)[:160]


def _record_status(db_path: Path, group_id: str, media_id: str, status: str, version: str) -> None:
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO image_analysis(group_id, media_id, status, algorithm_version, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(group_id, media_id) DO UPDATE SET
              status = excluded.status,
              error_message = NULL,
              algorithm_version = excluded.algorithm_version,
              updated_at = CURRENT_TIMESTAMP
            """,
            (group_id, media_id, status, version),
        )


def _record_error(db_path: Path, group_id: str, media_id: str, error: str, elapsed_ms: int) -> None:
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO image_analysis(group_id, media_id, status, error_message, algorithm_version, processing_time_ms, updated_at)
            VALUES (?, ?, 'error', ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(group_id, media_id) DO UPDATE SET
              status = 'error',
              error_message = excluded.error_message,
              algorithm_version = excluded.algorithm_version,
              processing_time_ms = excluded.processing_time_ms,
              updated_at = CURRENT_TIMESTAMP
            """,
            (group_id, media_id, error[:1000], ALGORITHM_VERSION, elapsed_ms),
        )


def _upsert_success(db_path: Path, group_id: str, media_id: str, result: dict[str, Any]) -> None:
    thresholds = dict(result["thresholds"])
    thresholds["sha256"] = result["sha256"]
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO image_analysis (
              group_id, media_id, status, error_message, algorithm_version, processing_time_ms,
              width, height, aspect_ratio, file_format, file_size_bytes, color_mode, exif_date,
              brightness_mean, brightness_label, contrast_stddev, contrast_label, blur_score, blur_label,
              edge_density, noise_score, average_rgb_json, dominant_colors_json, color_histogram_json,
              phash, dhash, average_hash, exact_duplicate_of, similar_matches_json,
              blockiness_score, compression_label, low_frequency_energy, medium_frequency_energy,
              high_frequency_energy, is_screenshot, preview_grayscale_path, preview_edges_path,
              preview_fourier_path, preview_histogram_path, thresholds_json, updated_at
            ) VALUES (
              ?, ?, 'success', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
            )
            ON CONFLICT(group_id, media_id) DO UPDATE SET
              status = 'success',
              error_message = NULL,
              algorithm_version = excluded.algorithm_version,
              processing_time_ms = excluded.processing_time_ms,
              width = excluded.width,
              height = excluded.height,
              aspect_ratio = excluded.aspect_ratio,
              file_format = excluded.file_format,
              file_size_bytes = excluded.file_size_bytes,
              color_mode = excluded.color_mode,
              exif_date = excluded.exif_date,
              brightness_mean = excluded.brightness_mean,
              brightness_label = excluded.brightness_label,
              contrast_stddev = excluded.contrast_stddev,
              contrast_label = excluded.contrast_label,
              blur_score = excluded.blur_score,
              blur_label = excluded.blur_label,
              edge_density = excluded.edge_density,
              noise_score = excluded.noise_score,
              average_rgb_json = excluded.average_rgb_json,
              dominant_colors_json = excluded.dominant_colors_json,
              color_histogram_json = excluded.color_histogram_json,
              phash = excluded.phash,
              dhash = excluded.dhash,
              average_hash = excluded.average_hash,
              exact_duplicate_of = excluded.exact_duplicate_of,
              similar_matches_json = excluded.similar_matches_json,
              blockiness_score = excluded.blockiness_score,
              compression_label = excluded.compression_label,
              low_frequency_energy = excluded.low_frequency_energy,
              medium_frequency_energy = excluded.medium_frequency_energy,
              high_frequency_energy = excluded.high_frequency_energy,
              is_screenshot = excluded.is_screenshot,
              preview_grayscale_path = excluded.preview_grayscale_path,
              preview_edges_path = excluded.preview_edges_path,
              preview_fourier_path = excluded.preview_fourier_path,
              preview_histogram_path = excluded.preview_histogram_path,
              thresholds_json = excluded.thresholds_json,
              updated_at = CURRENT_TIMESTAMP
            """,
            (
                group_id,
                media_id,
                ALGORITHM_VERSION,
                result["processing_time_ms"],
                result["width"],
                result["height"],
                result["aspect_ratio"],
                result["file_format"],
                result["file_size_bytes"],
                result["color_mode"],
                result["exif_date"],
                result["brightness_mean"],
                result["brightness_label"],
                result["contrast_stddev"],
                result["contrast_label"],
                result["blur_score"],
                result["blur_label"],
                result["edge_density"],
                result["noise_score"],
                json.dumps(result["average_rgb"]),
                json.dumps(result["dominant_colors"]),
                json.dumps(result["color_histogram"]),
                result["phash"],
                result["dhash"],
                result["average_hash"],
                result["exact_duplicate_of"],
                json.dumps(result["similar_matches"]),
                result["blockiness_score"],
                result["compression_label"],
                result["low_frequency_energy"],
                result["medium_frequency_energy"],
                result["high_frequency_energy"],
                int(result["is_screenshot"]),
                result["preview_grayscale_path"],
                result["preview_edges_path"],
                result["preview_fourier_path"],
                result["preview_histogram_path"],
                json.dumps(thresholds),
            ),
        )


def _decode_row(row: dict[str, Any]) -> dict[str, Any]:
    for source, target in (
        ("average_rgb_json", "average_rgb"),
        ("dominant_colors_json", "dominant_colors"),
        ("color_histogram_json", "color_histogram"),
        ("similar_matches_json", "similar_matches"),
        ("thresholds_json", "thresholds"),
    ):
        value = row.pop(source, None)
        row[target] = json.loads(value) if value else ([] if target != "thresholds" else {})
    row["is_screenshot"] = bool(row.get("is_screenshot"))
    return row
