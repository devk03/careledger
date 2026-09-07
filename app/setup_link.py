"""Display setup access only to an operator with shell access, never routine logs."""

from app.config import get_settings
from app.security.bootstrap import BootstrapManager
from app.storage.database import Database


def main() -> None:
    settings = get_settings()
    database = Database(settings.database_path)
    database.verify()
    state = BootstrapManager(
        settings.secrets_dir,
        settings.public_base_url,
        token_ttl_seconds=settings.bootstrap_token_ttl_seconds,
    ).initialize(setup_complete=database.is_setup_complete())
    print(state.setup_url or "Setup already complete.")


if __name__ == "__main__":
    main()
