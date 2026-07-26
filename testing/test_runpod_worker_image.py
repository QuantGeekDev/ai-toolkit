import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class RunPodWorkerImageTests(unittest.TestCase):
    def test_docker_context_includes_jobs_package(self):
        ignored = {
            line.strip()
            for line in (ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }

        self.assertNotIn("jobs/", ignored)
        self.assertTrue((ROOT / "jobs" / "__init__.py").is_file())


if __name__ == "__main__":
    unittest.main()
