from typing import Optional

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # search.sh 直连所需的 cf_clearance cookie（走干净出口/代理时可留空）
    SEARCH_SH_COOKIE: Optional[str] = ""
    SEARCH_SH_USER_AGENT: Optional[str] = None

    # 出口轮询（白嫖 search.sh 免费层 5 次/天/IP）：
    # - SEARCH_SH_BASE_URL: 覆盖直连 URL。为空则直连 https://search.sh/api/search；
    #   设成 resin 反代 URL（如 https://resin.host/<token>/Default/https/search.sh/api/search）即经代理出站。
    # - SEARCH_SH_ROTATE_HEADER: 每请求轮换的请求头名（resin 用 X-Resin-Account，换值即换出口 IP）。
    # - SEARCH_SH_ROTATE_VALUES: 显式轮换值列表（换行或 ||| 分隔）；优先于 COUNT。
    # - SEARCH_SH_ROTATE_COUNT: 未给 VALUES 时自动生成 r1..rN 个轮换身份。
    SEARCH_SH_BASE_URL: Optional[str] = ""
    SEARCH_SH_ROTATE_HEADER: Optional[str] = ""
    SEARCH_SH_ROTATE_VALUES: Optional[str] = ""
    SEARCH_SH_ROTATE_COUNT: Optional[int] = 0

    API_MASTER_KEY: Optional[str] = None

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
