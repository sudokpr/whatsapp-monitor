import tempfile
import unittest
from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

try:
    from PIL import Image, ImageFilter
    from image_analysis.analyzer import analyze_image_file, init_db, query_analysis
except Exception as exc:  # pragma: no cover - lets old environments run other tests.
    Image = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


@unittest.skipIf(IMPORT_ERROR is not None, f"image analysis dependencies unavailable: {IMPORT_ERROR}")
class ImageAnalysisTests(unittest.TestCase):
    def test_generated_image_records_core_signals_and_previews(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image_path = root / "bright.jpg"
            Image.new("RGB", (320, 180), (230, 225, 220)).save(image_path, quality=92)

            db_path = root / "analysis.db"
            preview_dir = root / "previews"
            init_db(db_path)
            result = analyze_image_file(image_path, "group-1", "media-1", db_path=db_path, preview_dir=preview_dir)

            self.assertEqual(result["width"], 320)
            self.assertEqual(result["height"], 180)
            self.assertIn(result["brightness_label"], {"bright", "overexposed"})
            self.assertIn("blur_score", result)
            self.assertTrue(Path(result["preview_grayscale_path"]).exists())
            self.assertTrue(Path(result["preview_edges_path"]).exists())
            self.assertTrue(Path(result["preview_fourier_path"]).exists())
            self.assertTrue(Path(result["preview_histogram_path"]).exists())

            rows = query_analysis(db_path, "group-1", "media-1")
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["status"], "success")

    def test_duplicate_detection_uses_hash_distance(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "first.jpg"
            second = root / "second.jpg"
            image = Image.new("RGB", (256, 256), (30, 100, 190))
            image.save(first, quality=90)
            image.filter(ImageFilter.GaussianBlur(radius=0.2)).save(second, quality=90)

            db_path = root / "analysis.db"
            preview_dir = root / "previews"
            analyze_image_file(first, "group-1", "media-1", db_path=db_path, preview_dir=preview_dir)
            result = analyze_image_file(second, "group-1", "media-2", db_path=db_path, preview_dir=preview_dir)

            self.assertTrue(result["similar_matches"])
            self.assertEqual(result["similar_matches"][0]["media_id"], "media-1")


if __name__ == "__main__":
    unittest.main()
