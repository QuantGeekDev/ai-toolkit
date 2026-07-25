from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from toolkit.training_bundle import (
    BundleValidationError,
    export_training_bundle,
    inspect_training_bundle,
    safe_extract_training_bundle,
    validate_training_bundle_request,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Create or verify an AI Toolkit training bundle")
    subparsers = parser.add_subparsers(dest="command", required=True)

    export_parser = subparsers.add_parser("export")
    export_parser.add_argument("--request", required=True)
    export_parser.add_argument("--validate-only", action="store_true")

    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("--bundle", required=True)

    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("--bundle", required=True)
    extract_parser.add_argument("--destination", required=True)

    args = parser.parse_args()
    try:
        if args.command == "export":
            request = json.loads(Path(args.request).read_text(encoding="utf-8"))
            if args.validate_only:
                report, _ = validate_training_bundle_request(request)
                result = {"ok": not report["errors"], "validation": report}
            else:
                result = export_training_bundle(request)
        elif args.command == "inspect":
            result = inspect_training_bundle(args.bundle)
        else:
            result = safe_extract_training_bundle(args.bundle, args.destination)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0 if result.get("ok") else 2
    except BundleValidationError as exc:
        print(json.dumps({"ok": False, "validation": exc.report}, ensure_ascii=False, separators=(",", ":")))
        return 2
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    sys.exit(main())
