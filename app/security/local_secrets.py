import os
from pathlib import Path


def load_or_create_secret(path: Path, *, length: int = 32) -> bytes:
    if length < 32:
        raise ValueError("local secrets must contain at least 32 bytes")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        value = path.read_bytes()
    else:
        value = os.urandom(length)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
    if len(value) != length or path.is_symlink():
        raise ValueError("local secret has an invalid shape")
    if path.stat().st_mode & 0o777 != 0o600:
        path.chmod(0o600)
    return value
