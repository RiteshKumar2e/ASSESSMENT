"""Central configuration: study window, market conventions and environment settings."""

import os
from dataclasses import dataclass, field
from datetime import date, time
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

LONDON = ZoneInfo("Europe/London")
BACKEND_DIR = Path(__file__).resolve().parent.parent

# backend/.env is optional; real environment variables take precedence over it.
load_dotenv(BACKEND_DIR / ".env", override=False)

# Purchase decisions made in January 2026 => delivery days 2 Jan .. 1 Feb 2026.
DECISION_FIRST_DAY = date(2026, 1, 1)
DECISION_LAST_DAY = date(2026, 1, 31)
DELIVERY_FIRST_DAY = date(2026, 1, 2)
DELIVERY_LAST_DAY = date(2026, 2, 1)

# GB day-ahead auction (N2EX / EPEX GB hourly) gate closure, UK local time, on D-1.
DEFAULT_CUTOFF = time(9, 20)

# WINDFOR runs reach ~66h ahead (fetch window); beyond 48h coverage is partial,
# so accuracy-by-horizon analysis stops there.
MAX_HORIZON_HOURS = 66
CURVE_MAX_HOURS = 48

# Bias correction learns from the trailing N delivery days that were fully settled
# before the decision cutoff. WARMUP_DAYS of December history seed early January.
BIAS_WINDOW_DAYS = 7
WARMUP_DAYS = 10

# WINDFOR is published 8 times a day; used to flag days with missing runs.
EXPECTED_RUNS_PER_DAY = 8

ELEXON_BASE_URL = "https://data.elexon.co.uk/bmrs/api/v1"


def _path(name: str, default: str) -> Path:
    """Path from the environment; relative paths are resolved against backend/."""
    path = Path(os.getenv(name) or default)
    return path if path.is_absolute() else BACKEND_DIR / path


def _csv(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


@dataclass(frozen=True)
class Settings:
    """Values that differ between environments. Read once from environment variables."""

    snapshot_path: Path = field(default_factory=lambda: _path("SNAPSHOT_PATH", "data/snapshot.json"))
    static_dir: Path = field(default_factory=lambda: _path("STATIC_DIR", "static"))
    cors_origins: list[str] = field(default_factory=lambda: _csv(os.getenv("CORS_ORIGINS", "*")))
    log_level: str = field(default_factory=lambda: os.getenv("LOG_LEVEL", "INFO"))
    # Send HSTS only when the app is served over HTTPS in production.
    enable_hsts: bool = field(default_factory=lambda: os.getenv("ENABLE_HSTS", "false").lower() == "true")


settings = Settings()
