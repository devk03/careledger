from dataclasses import dataclass
from datetime import UTC, datetime, timedelta


@dataclass(frozen=True)
class LoginBackoffPolicy:
    free_failures: int = 4
    base_delay_seconds: int = 2
    max_delay_seconds: int = 15 * 60

    def delay_seconds(self, consecutive_failures: int) -> int:
        if consecutive_failures <= self.free_failures:
            return 0
        exponent = consecutive_failures - self.free_failures - 1
        delay = int(self.base_delay_seconds * pow(2, exponent))
        return min(delay, self.max_delay_seconds)

    def locked_until(self, consecutive_failures: int, *, now: datetime | None = None) -> datetime:
        current = now or datetime.now(UTC)
        return current + timedelta(seconds=self.delay_seconds(consecutive_failures))
