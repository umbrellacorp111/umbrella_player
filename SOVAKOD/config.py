"""Centralized configuration — единый источник истины для всего проекта.

Все магические числа, URL-ы и лимиты вынесены сюда, чтобы:
- не дублировать их по server.py / app2.js / main.py
- менять поведение через .env без правки кода
- код оставался читаемым: вместо `86400` — `ARTIST_IMG_TTL`
"""
from __future__ import annotations

import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Network / HTTP
# ---------------------------------------------------------------------------
DEFAULT_HOST = os.getenv("HOST", "127.0.0.1")
DEFAULT_PORT = int(os.getenv("PORT", "8000"))

DEFAULT_UA = os.getenv(
    "UMBRELLA_UA",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
)
MB_UA = os.getenv("MB_UA", "UmbrellaPlayer/1.0 (personal music player)")
STREAM_CHUNK_SIZE = int(os.getenv("UMBRELLA_CHUNK_SIZE", "65536"))
SERVER_VERSION = "UmbrellaUniversalMusic/2.0"

# Внешние сервисы — можно переопределить для тестов / зеркал
LRCLIB_BASE = os.getenv("LRCLIB_BASE", "https://lrclib.net")
GENIUS_API_BASE = os.getenv("GENIUS_API_BASE", "https://api.genius.com")
GENIUS_WEB_BASE = os.getenv("GENIUS_WEB_BASE", "https://genius.com")
DEEZER_API_BASE = os.getenv("DEEZER_API_BASE", "https://api.deezer.com")
MB_BASE = os.getenv("MB_BASE", "https://musicbrainz.org")
WIKIDATA_BASE = os.getenv("WIKIDATA_BASE", "https://www.wikidata.org")
WIKIMEDIA_BASE = os.getenv("WIKIMEDIA_BASE", "https://commons.wikimedia.org")
AUDIODB_BASE = os.getenv("AUDIODB_BASE", "https://www.theaudiodb.com")
PYPI_BASE = os.getenv("PYPI_BASE", "https://pypi.org")

# ---------------------------------------------------------------------------
# Cache TTL (sec) — все времена жизни кэшей в одном месте
# ---------------------------------------------------------------------------
LYRICS_TTL = 3600
AUDIO_FILE_TTL = 1800  # 30 мин — временный файловый кэш стримов
ARTIST_IMG_TTL = 86400
ARTIST_BIO_TTL = 86400
WIKI_PAGE_TTL = 86400
SC_URL_TTL = 480  # 8 мин — подписанные URL SoundCloud живут ~10 мин, дольше кэшировать нельзя

# ---------------------------------------------------------------------------
# Limits / Concurrency
# ---------------------------------------------------------------------------
MAX_JSON_BODY = 16_384
MAX_CACHE_ENTRIES = 512
MAX_ARTIST_IMAGE_BYTES = 8 * 1024 * 1024
YDL_CONCURRENCY = 3
EXTERNAL_API_CONCURRENCY = 8
SC_DOWNLOAD_QUEUE_SIZE = 8
SC_DOWNLOAD_WORKERS = 2
BIND_RETRIES = 25

# ---------------------------------------------------------------------------
# Timeouts & intervals (sec)
# ---------------------------------------------------------------------------
CACHE_CLEANUP_INTERVAL = 300  # 5 мин
SC_JOB_TTL = 900  # 15 мин — хранить завершённые задачи
YTDL_TIMEOUT_SHORT = 15
YTDL_TIMEOUT_MEDIUM = 20
YTDL_TIMEOUT_LONG = 30
EXTERNAL_API_TIMEOUT = 10
GENIUS_TIMEOUT = 8
PYPI_TIMEOUT = 10

# ---------------------------------------------------------------------------
# UI / Window
# ---------------------------------------------------------------------------
WINDOW_WIDTH = 1280
WINDOW_HEIGHT = 800
WINDOW_MIN_WIDTH = 900
WINDOW_MIN_HEIGHT = 600

# ---------------------------------------------------------------------------
# Frontend mirrors (должны совпадать с app2.js — см. комментарий там)
# ---------------------------------------------------------------------------

# Theme presets (mirrors app2.js THEME_PRESETS)
THEME_PRESETS = [
    {"hue": 262, "sw": "#8b5cf6", "label": "Фиолетовый"},
    {"hue": 222, "sw": "#4f8cff", "label": "Синий"},
    {"hue": 192, "sw": "#22d3ee", "label": "Циан"},
    {"hue": 155, "sw": "#34d399", "label": "Изумруд"},
    {"hue": 342, "sw": "#f472b6", "label": "Розовый"},
    {"hue": 38, "sw": "#fbbf24", "label": "Янтарный"},
]

PLAYLIST_GRADIENTS = [
    "linear-gradient(145deg,#362a68,#b03066 52%,#111)",
    "linear-gradient(145deg,#cc8a54,#734343 50%,#1f2539)",
    "linear-gradient(145deg,#072f39,#278889 48%,#d4a447)",
    "linear-gradient(145deg,#242642,#77499c 48%,#df657c)",
    "linear-gradient(145deg,#1a3a2a,#43d68f 50%,#15303a)",
    "linear-gradient(145deg,#3a1a2e,#e04070 48%,#1a1028)",
]
