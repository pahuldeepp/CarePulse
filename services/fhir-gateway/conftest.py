"""pytest configuration — sets required env vars before any module is imported."""

import os

os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost:5432/test")
