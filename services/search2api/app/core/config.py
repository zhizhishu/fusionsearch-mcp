from typing import Optional

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    SEARCH_SH_COOKIE: Optional[str] = ""
    SEARCH_SH_USER_AGENT: Optional[str] = None
    API_MASTER_KEY: Optional[str] = None

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
