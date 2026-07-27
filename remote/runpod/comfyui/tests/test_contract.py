import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ImageContractTests(unittest.TestCase):
    def test_exact_turbo_manifest(self):
        manifest = json.loads((ROOT / "model-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["revision"], "952f49d49653cb42e7d6cf7cbfad74738073ec7d")
        self.assertEqual(manifest["comfyUiCommit"], "4800e78518ebb1f2a9443ea5418edbff6c3935f9")
        self.assertEqual(
            [item["path"] for item in manifest["files"]],
            [
                "diffusion_models/krea2_turbo_bf16.safetensors",
                "text_encoders/qwen3vl_4b_bf16.safetensors",
                "vae/qwen_image_vae.safetensors",
            ],
        )
        self.assertEqual(sum(item["bytes"] for item in manifest["files"]), 35_412_858_238)

    def test_image_is_pinned_and_contains_no_model_weights(self):
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertRegex(dockerfile.splitlines()[0], r"^FROM .+@sha256:[0-9a-f]{64}$", "base image must be immutable")
        context_files = [item for item in ROOT.rglob("*") if item.is_file()]
        self.assertFalse(any(item.suffix == ".safetensors" for item in context_files))
        self.assertNotIn("ComfyUI-Manager", dockerfile)
        self.assertNotRegex(dockerfile, re.compile(r"RUNPOD_API_KEY|AI_TOOLKIT_COMFY_MASTER_SECRET"))
        self.assertIn("comfy-requirements.lock", dockerfile)
        requirements = (ROOT / "comfy-requirements.lock").read_text(encoding="utf-8").splitlines()
        self.assertTrue(requirements)
        self.assertTrue(all(re.fullmatch(r"[A-Za-z0-9_.-]+==[A-Za-z0-9_.+-]+", line) for line in requirements))

    def test_sshd_is_internal_sftp_only(self):
        config = (ROOT / "sshd_config").read_text(encoding="utf-8")
        self.assertIn("ForceCommand internal-sftp", config)
        self.assertIn("DisableForwarding yes", config)
        self.assertIn("PasswordAuthentication no", config)
        self.assertIn("PermitRootLogin no", config)


if __name__ == "__main__":
    unittest.main()
