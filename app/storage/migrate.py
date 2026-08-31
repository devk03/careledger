from app.config import get_settings
from app.storage.database import Database


def main() -> None:
    settings = get_settings()
    settings.ensure_directories()
    status = Database(settings.database_path).initialize()
    print(  # noqa: T201 - intentional operator command output
        f"CareLedger schema ready: version={status.version} migrations={status.migration_count}"
    )


if __name__ == "__main__":
    main()
