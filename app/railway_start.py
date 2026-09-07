"""Initialize the Railway mount, then irreversibly drop root before starting Adeno."""

import os
from pathlib import Path


def main() -> None:
    if os.environ.get("DATA_DIR") != "/data":
        raise RuntimeError("Railway entrypoint requires DATA_DIR=/data")
    if os.getuid() == 0:
        data = Path("/data")
        if data.is_symlink():
            raise RuntimeError("data mount must not be a symlink")
        data.mkdir(mode=0o700, exist_ok=True)
        os.chown(data, 10001, 10001)
        os.chmod(data, 0o700)
        os.setgroups([])
        os.setgid(10001)
        os.setuid(10001)
    if os.getuid() != 10001 or os.getgid() != 10001:
        raise RuntimeError("Adeno must run as its unprivileged application user")
    os.execv("/app/.venv/bin/python", ["python", "-m", "app.run"])  # noqa: S606 - fixed executable


if __name__ == "__main__":
    main()
