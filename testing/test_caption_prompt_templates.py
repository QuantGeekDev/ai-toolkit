import json
import tempfile
import unittest
from pathlib import Path

from extensions_built_in.captioner.prompts.caption_prompt_templates import (
    load_caption_prompt_templates,
)


class TestCaptionPromptTemplates(unittest.TestCase):
    def test_local_templates_extend_and_override_bundled_templates(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            bundled_path = root / "bundled.json"
            local_directory = root / "local"
            local_directory.mkdir()
            bundled_path.write_text(
                json.dumps({"general": {"label": "General", "prompt": "Bundled prompt"}}),
                encoding="utf-8",
            )
            (local_directory / "general.json").write_text(
                json.dumps({"schema_version": 1, "label": "General v2", "prompt": "Local prompt"}),
                encoding="utf-8",
            )
            (local_directory / "experiment-v1.json").write_text(
                json.dumps({"schema_version": 1, "label": "Experiment", "prompt": "Experimental prompt"}),
                encoding="utf-8",
            )
            (local_directory / "index.json").write_text(
                json.dumps({"schema_version": 1, "default_template": "experiment-v1"}),
                encoding="utf-8",
            )

            templates = load_caption_prompt_templates(bundled_path, local_directory)

            self.assertEqual(templates["general"]["prompt"], "Local prompt")
            self.assertEqual(templates["experiment-v1"]["prompt"], "Experimental prompt")
            self.assertNotIn("index", templates)

    def test_malformed_local_variation_does_not_hide_valid_prompts(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            bundled_path = root / "bundled.json"
            local_directory = root / "local"
            local_directory.mkdir()
            bundled_path.write_text(
                json.dumps({"general": {"label": "General", "prompt": "Bundled prompt"}}),
                encoding="utf-8",
            )
            (local_directory / "broken.json").write_text("{bad json", encoding="utf-8")

            templates = load_caption_prompt_templates(bundled_path, local_directory)

            self.assertEqual(list(templates), ["general"])


if __name__ == "__main__":
    unittest.main()
