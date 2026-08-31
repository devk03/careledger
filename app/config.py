from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

if TYPE_CHECKING:
    from app.ai.provider import AIProviderRuntime


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_environment: str = "development"
    app_host: str = "0.0.0.0"  # noqa: S104 - required inside a container
    app_port: int = Field(default=8080, validation_alias=AliasChoices("APP_PORT", "PORT"))
    data_dir: Path = Path("./.local-data")
    public_base_url: str = "http://localhost:8080"
    ai_provider: str = "auto"
    ai_model: str = Field(
        default="openai/gpt-5.4-mini",
        validation_alias=AliasChoices("AI_MODEL", "OPENAI_MODEL"),
    )
    openrouter_api_key: str | None = Field(default=None, repr=False)
    openai_api_key: str | None = Field(default=None, repr=False)
    custom_ai_api_key: str | None = Field(default=None, repr=False)
    custom_ai_base_url: str | None = None
    max_upload_bytes: int = 30 * 1024 * 1024
    max_pdf_pages: int = 200
    max_image_pixels: int = 40_000_000
    max_image_dimension: int = 20_000
    max_filename_chars: int = 180
    bootstrap_token_ttl_seconds: int = 60 * 60

    @property
    def secrets_dir(self) -> Path:
        return self.data_dir / "secrets"

    @property
    def object_dir(self) -> Path:
        return self.data_dir / "objects" / "sha256"

    @property
    def quarantine_dir(self) -> Path:
        return self.data_dir / "quarantine"

    @property
    def database_path(self) -> Path:
        return self.data_dir / "app.sqlite"

    @property
    def backup_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def web_dist_dir(self) -> Path:
        return Path(__file__).resolve().parent.parent / "web" / "dist"

    def ai_runtime(self) -> "AIProviderRuntime":
        from app.ai.provider import resolve_provider

        return resolve_provider(
            provider=self.ai_provider,
            model=self.ai_model,
            openrouter_api_key=self.openrouter_api_key,
            openai_api_key=self.openai_api_key,
            custom_api_key=self.custom_ai_api_key,
            custom_base_url=self.custom_ai_base_url,
        )

    def ensure_directories(self) -> None:
        for path in (
            self.data_dir,
            self.secrets_dir,
            self.object_dir,
            self.quarantine_dir,
            self.backup_dir,
        ):
            path.mkdir(mode=0o700, parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
