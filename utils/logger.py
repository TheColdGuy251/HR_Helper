from __future__ import annotations

import sys
from pathlib import Path
from loguru import logger

from config import settings


def setup_logger() -> None:
    logger.remove()
    logger.add(
        sys.stdout,
        level="DEBUG" if settings.debug else "INFO",
        format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{line}</cyan> - {message}",
    )

    log_file = Path(settings.logs_dir) / "app.log"
    logger.add(
        log_file,
        rotation="20 MB",
        retention="14 days",
        level="INFO",
        encoding="utf-8",
        enqueue=True,
    )


__all__ = ["logger", "setup_logger"]
