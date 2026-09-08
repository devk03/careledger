"""Public project metadata only; no credentials, database or user input are used."""

import threading
import time

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(tags=["public-project"])
REPOSITORY_URL = "https://github.com/devk03/careledger"
API_URL = "https://api.github.com/repos/devk03/careledger"


class ProjectStats(BaseModel):
    stars: int | None = None
    checked_at: int | None = None
    stale: bool = False


class StarCache:
    def __init__(self) -> None:
        self.value = ProjectStats()
        self.retry_at = 0.0
        self.lock = threading.Lock()

    def get(self) -> ProjectStats:
        if time.monotonic() < self.retry_at or not self.lock.acquire(blocking=False):
            return self.value.model_copy(deep=True)
        try:
            # Recheck after acquiring the lock to avoid concurrent refreshes.
            if time.monotonic() < self.retry_at:
                return self.value.model_copy(deep=True)
            self.retry_at = time.monotonic() + 300
            try:
                with httpx.Client(timeout=3, follow_redirects=False, trust_env=False) as client:
                    response = client.get(
                        API_URL,
                        headers={
                            "Accept": "application/vnd.github+json",
                            "User-Agent": "Adeno-public-stars",
                        },
                    )
                    response.raise_for_status()
                    payload = response.json()
                stars = payload.get("stargazers_count")
                if type(stars) is not int or not 0 <= stars <= 1_000_000_000:
                    raise ValueError("invalid public star count")
                self.value = ProjectStats(stars=stars, checked_at=int(time.time()))
                self.retry_at = time.monotonic() + 3600
            except (httpx.HTTPError, ValueError, TypeError, AttributeError):
                self.value = self.value.model_copy(update={"stale": True})
            return self.value.model_copy(deep=True)
        finally:
            self.lock.release()


star_cache = StarCache()


@router.get("/api/public/project", response_model=ProjectStats)
def project_stats() -> ProjectStats:
    return star_cache.get()
