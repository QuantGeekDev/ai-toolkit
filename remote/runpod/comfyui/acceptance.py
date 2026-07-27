#!/usr/bin/env python3
"""Run the explicitly gated, budget-bounded live EPH-01 acceptance suite."""
from __future__ import annotations

import argparse
import os
from pathlib import Path

from preflight import GateError, main as preflight_main


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--max-cost", required=True, type=float)
    parser.add_argument("--hard-deadline-minutes", type=int, default=15)
    parser.add_argument(
        "--registry-auth-id",
        default=os.environ.get("RUNPOD_COMFY_REGISTRY_AUTH_ID", "").strip(),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).with_name("capability-contract.json"),
    )
    args = parser.parse_args()
    if os.environ.get("RUNPOD_LIVE_TEST") != "1":
        raise GateError("Set RUNPOD_LIVE_TEST=1 to authorize billable acceptance Pods")
    return preflight_main(
        [
            "--live",
            "--image",
            args.image,
            "--max-cost",
            str(args.max_cost),
            "--hard-deadline-minutes",
            str(args.hard_deadline_minutes),
            "--registry-auth-id",
            args.registry_auth_id,
            "--output",
            str(args.output),
        ]
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GateError as error:
        print(f"ERROR: {error}")
        raise SystemExit(2) from None
