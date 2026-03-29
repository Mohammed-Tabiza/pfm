import os
from pathlib import Path


def _parse_env_line(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None

    key, value = stripped.split("=", 1)
    key = key.strip()
    value = value.strip().strip("'").strip('"')
    if not key:
        return None

    return key, value


def load_env_files() -> None:
    backend_dir = Path(__file__).resolve().parent
    repo_root = backend_dir.parent
    candidates = [
        repo_root / ".env",
        repo_root / ".env.local",
        backend_dir / ".env",
        backend_dir / ".env.local",
    ]

    for path in candidates:
        if not path.exists():
            continue

        for line in path.read_text(encoding="utf-8").splitlines():
            parsed = _parse_env_line(line)
            if parsed is None:
                continue
            key, value = parsed
            os.environ.setdefault(key, value)
