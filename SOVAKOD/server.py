from __future__ import annotations

import gzip
import hashlib
import io
import itertools
import json
import logging
import mimetypes
import os
import queue
import re
import secrets
import sys
import threading
import time
import urllib.request
import urllib.error
import urllib.parse
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse, urlencode, quote as urlquote
from app_version import APP_VERSION
from app_updater import fetch_update, launch_update

try:
    import yt_dlp
except ImportError:
    yt_dlp = None

# --- Единый источник конфигурации (см. config.py) ---
# Импортируем всё из config.py, чтобы не дублировать хардкод.
from config import (
    AUDIODB_BASE,
    DEEZER_API_BASE,
    DEFAULT_HOST as HOST,
    DEFAULT_PORT as PORT,
    DEFAULT_UA,
    GENIUS_API_BASE,
    GENIUS_WEB_BASE,
    LRCLIB_BASE,
    MB_BASE,
    MB_UA as _MB_UA_FALLBACK,  # используется ниже, если не переопределено
    PYPI_BASE,
    SERVER_VERSION,
    STREAM_CHUNK_SIZE,
    WIKIDATA_BASE,
    WIKIMEDIA_BASE,
)

ROOT = Path(os.getenv("APP_ROOT", str(Path(__file__).resolve().parent)))
# MusicBrainz UA — берём из config, но оставляем возможность переопределить
MB_UA = os.getenv("MB_UA", _MB_UA_FALLBACK)

# Compiled regexes (avoid recompilation per request)
_RE_LYRICS_CONTAINER = re.compile(r'data-lyrics-container="true"')
_RE_HTML_TAG = re.compile(r"<[^>]+>")
_RE_MULTI_SPACE = re.compile(r"\s+")
_RE_LEADING_NUM = re.compile(r"^\s*\d+[\.\)]\s*")
def _best_thumbnail(thumbnails) -> str:
    """Выбирает самое большое изображение из списка превью (yt-dlp возвращает
    их от меньшего к большему). Возвращает URL или пустую строку."""
    if not thumbnails:
        return ""
    best_url = ""
    best_area = -1
    for t in thumbnails:
        if isinstance(t, dict):
            url = t.get("url", "")
            try:
                area = int(t.get("height") or 0) * int(t.get("width") or 0)
            except (TypeError, ValueError):
                area = -1
        elif isinstance(t, str):
            url = t
            area = -1
        else:
            continue
        if not url:
            continue
        if area > best_area:
            best_area = area
            best_url = url
    if best_url:
        return best_url
    last = thumbnails[-1]
    return last.get("url", "") if isinstance(last, dict) else (last if isinstance(last, str) else "")


def _force_utf8_stdio() -> None:
    """Фоновые загрузки (yt-dlp и т.п.) пишут в stdout unicode-символы,
    которые падают на cp1251, а в windowed exe потоки вообще None.
    Переводим потоки в UTF-8; при отсутствии подставляем заглушку.

    Важно: подменяем и sys.__stdout__/__stderr__ — библиотеки при скачивании
    оборачивают их в свои proxy, и если они None, write(file=None)
    падает обратно на sys.stdout (сам proxy) -> бесконечная рекурсия."""

    class _NullWriter:
        def write(self, s): return len(s)
        def flush(self): return None
        def isatty(self): return False
        def close(self): return None

    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None:
            writer = _NullWriter()
            setattr(sys, name, writer)
            setattr(sys, f"__{name}__", writer)
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass
    if getattr(sys, "__stdout__", None) is None:
        sys.__stdout__ = _NullWriter()
    if getattr(sys, "__stderr__", None) is None:
        sys.__stderr__ = _NullWriter()


# Импорт TTL и лимитов из единого config.py (не дублировать хардкод)
from config import (
    ARTIST_BIO_TTL,
    ARTIST_IMG_TTL,
    AUDIO_FILE_TTL,
    BIND_RETRIES,
    CACHE_CLEANUP_INTERVAL,
    EXTERNAL_API_CONCURRENCY,
    LYRICS_TTL,
    MAX_ARTIST_IMAGE_BYTES,
    MAX_CACHE_ENTRIES,
    MAX_JSON_BODY,
    SC_DOWNLOAD_QUEUE_SIZE,
    SC_DOWNLOAD_WORKERS,
    SC_JOB_TTL,
    SC_URL_TTL,
    WIKI_PAGE_TTL,
    YDL_CONCURRENCY,
    ZVUK_SEARCH_TTL,
    ZVUK_URL_TTL,
)

_force_utf8_stdio()
CACHE_LOCK = threading.RLock()
MB_LAST_REQUEST = 0.0
MB_LOCK = threading.Lock()
LYRICS_CACHE_LOCK = threading.Lock()
LYRICS_CACHE: dict[str, dict] = {}
AUDIO_FILE_CACHE: dict[str, tuple[str, float]] = {}
ARTIST_IMG_CACHE: dict[str, tuple[bytes, str, float]] = {}
ARTIST_BIO_CACHE: dict[str, tuple[float, dict]] = {}
WIKI_PAGE_CACHE: dict[str, tuple[float, dict]] = {}
# Папка рядом с .exe (или со скриптом) — сюда кладётся artist_overrides.json,
# который можно править без пересборки.
_ENV_DATA_DIR = os.getenv("APP_DATA_DIR", "").strip()
if _ENV_DATA_DIR:
    # Android (и любая упаковка, где каталог приложения только для чтения)
    # передаёт сюда путь к приватной writable-папке.
    APP_DATA_DIR = Path(_ENV_DATA_DIR)
elif getattr(sys, "frozen", False):
    APP_DATA_DIR = Path(sys.executable).resolve().parent
else:
    APP_DATA_DIR = Path(__file__).resolve().parent
try:
    APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    pass
ARTIST_OVERRIDES_PATH = APP_DATA_DIR / "artist_overrides.json"
ARTIST_OVERRIDES_CACHE: dict[str, object] = {"mtime": 0.0, "data": {}}
log = logging.getLogger("umbrella")
try:
    _log_handler = logging.FileHandler(str(APP_DATA_DIR / "umbrella.log"), encoding="utf-8")
    _log_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    log.addHandler(_log_handler)
    log.setLevel(logging.INFO)
except OSError:  # pragma: no cover
    pass
log.info("Server import OK: root=%s data_dir=%s", ROOT, APP_DATA_DIR)

# ---- SoundCloud-подсистема (через yt-dlp: поиск scsearch + прямая загрузка) ----
SC_DIR = APP_DATA_DIR / "sc_music"
SC_CACHE_DIR = APP_DATA_DIR / "_sc_cache"
SC_URL_CACHE: dict[str, tuple] = {}  # track_url -> (audio_url, kind, ts, title, duration)
SC_JOB_SEQ = itertools.count(1)
SC_JOBS: dict[str, dict] = {}
SC_STREAM_LOCKS: dict[str, threading.Lock] = {}
SC_STREAM_LOCKS_GUARD = threading.Lock()
SC_JOBS_GUARD = threading.Lock()
ZVUK_TOKEN = os.getenv("ZVUK_TOKEN", "").strip().lstrip("\ufeff")
if not ZVUK_TOKEN:
    try:
        _tok_file = APP_DATA_DIR / "zvuk_token.txt"
        if _tok_file.is_file():
            ZVUK_TOKEN = _tok_file.read_text(encoding="utf-8-sig").strip().lstrip("\ufeff")
    except Exception:
        pass
ZVUK_URL_CACHE: dict[str, tuple[str, float]] = {}
ZVUK_SEARCH_CACHE: dict[str, tuple[list[dict], float]] = {}
ZVUK_CLIENT_LOCK = threading.Lock()
ZVUK_CLIENT: object | None = None
ZVUK_ANON_TOKEN: str | None = None
API_TOKEN = secrets.token_urlsafe(32)
YDL_LIMIT = threading.BoundedSemaphore(YDL_CONCURRENCY)
EXTERNAL_API_LIMIT = threading.BoundedSemaphore(EXTERNAL_API_CONCURRENCY)
SC_DOWNLOAD_QUEUE: queue.Queue[dict | None] = queue.Queue(maxsize=SC_DOWNLOAD_QUEUE_SIZE)
SERVER_STOPPING = threading.Event()


class ServiceBusyError(RuntimeError):
    pass


@contextmanager
def _limited_ydl(options: dict, timeout: float = 0.75):
    if SERVER_STOPPING.is_set() or not YDL_LIMIT.acquire(timeout=timeout):
        raise ServiceBusyError("Сервис занят, повторите через несколько секунд")
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            yield ydl
    finally:
        YDL_LIMIT.release()


@contextmanager
def _metadata_urlopen(request, timeout: float):
    if SERVER_STOPPING.is_set() or not EXTERNAL_API_LIMIT.acquire(timeout=0.75):
        raise ServiceBusyError("Внешний сервис занят, повторите позже")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            yield response
    finally:
        EXTERNAL_API_LIMIT.release()


def _cache_timestamp(value: tuple, timestamp_index: int) -> float:
    if isinstance(value, dict):
        try:
            return float(value.get("_ts", 0.0))
        except (TypeError, ValueError):
            return 0.0
    try:
        return float(value[timestamp_index])
    except (IndexError, TypeError, ValueError):
        return 0.0


def _trim_cache(cache: dict, timestamp_index: int, limit: int = MAX_CACHE_ENTRIES) -> None:
    """Keep process-local caches bounded without changing their public shape."""
    if len(cache) <= limit:
        return
    excess = len(cache) - limit
    for key, _ in sorted(cache.items(), key=lambda item: _cache_timestamp(item[1], timestamp_index))[:excess]:
        cache.pop(key, None)


def _mb_rate_limit() -> None:
    global MB_LAST_REQUEST
    with MB_LOCK:
        now = time.time()
        wait = MB_LAST_REQUEST + 1.05 - now
        if wait > 0:
            time.sleep(wait)
        MB_LAST_REQUEST = time.time()




def _cleanup_caches() -> None:
    while True:
        time.sleep(CACHE_CLEANUP_INTERVAL)
        now = time.time()
        for cache, ttl, timestamp_index in (
            (LYRICS_CACHE, LYRICS_TTL, 0),
            (AUDIO_FILE_CACHE, AUDIO_FILE_TTL, 1),
            (ARTIST_IMG_CACHE, ARTIST_IMG_TTL, 2), (ARTIST_BIO_CACHE, ARTIST_BIO_TTL, 0),
            (WIKI_PAGE_CACHE, WIKI_PAGE_TTL, 0),
            (SC_URL_CACHE, SC_URL_TTL, 2), (ZVUK_URL_CACHE, ZVUK_URL_TTL, 1),
            (ZVUK_SEARCH_CACHE, ZVUK_SEARCH_TTL, 1),
        ):
            for key, value in list(cache.items()):
                timestamp = _cache_timestamp(value, timestamp_index)
                if timestamp and now - timestamp >= ttl:
                    if cache is AUDIO_FILE_CACHE:
                        try:
                            path = value[0] if isinstance(value, tuple) else ""
                            if path and os.path.isfile(path):
                                os.remove(path)
                        except OSError:
                            pass
                    cache.pop(key, None)
            _trim_cache(cache, timestamp_index)
        with SC_JOBS_GUARD:
            for key, job in list(SC_JOBS.items()):
                if job.get("finished") and now - job["finished"] > SC_JOB_TTL:
                    SC_JOBS.pop(key, None)
        try:
            for cache_dir, ttl in ((SC_CACHE_DIR, AUDIO_FILE_TTL),):
                if not cache_dir.is_dir():
                    continue
                for p in cache_dir.iterdir():
                    try:
                        if now - p.stat().st_mtime > ttl:
                            p.unlink()
                    except OSError:
                        pass
        except OSError:
            pass


threading.Thread(target=_cleanup_caches, daemon=True, name="cache-cleanup").start()




def _sc_stream_lock(key: str) -> threading.Lock:
    with SC_STREAM_LOCKS_GUARD:
        lock = SC_STREAM_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            SC_STREAM_LOCKS[key] = lock
        return lock


def _sc_download_file(url: str, outtmpl: str) -> str | None:
    """Скачивает трек SoundCloud через yt-dlp. Возвращает путь к файлу или None."""
    if yt_dlp is None:
        return None
    ydl_opts = {
        "format": "bestaudio",
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 30,
        "noplaylist": True,
        "outtmpl": outtmpl,
    }
    with _limited_ydl(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
    req = info.get("requested_downloads") or []
    if req and req[0].get("filepath") and os.path.exists(req[0]["filepath"]):
        return req[0]["filepath"]
    # fallback: ищем свежий файл в папке загрузки
    parent = os.path.dirname(outtmpl)
    if parent and os.path.isdir(parent):
        newest = None
        newest_t = -1
        for f in os.listdir(parent):
            fp = os.path.join(parent, f)
            if os.path.isfile(fp) and f.lower().endswith((".mp3", ".flac", ".m4a", ".mp4", ".ogg", ".opus")):
                t = os.path.getmtime(fp)
                if t > newest_t:
                    newest_t = t
                    newest = fp
        if newest:
            return newest
    return None


def _sc_run_download(job: dict) -> None:
    """Фоновая задача: скачивание трека SoundCloud в папку библиотеки."""
    out_dir = Path(job["output_dir"])
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        with SC_JOBS_GUARD:
            job["state"] = "error"
            job["error"] = f"Не удалось создать папку: {e}"
            job["finished"] = time.time()
        return
    with SC_JOBS_GUARD:
        job["state"] = "downloading"
        job["message"] = "Скачивание…"
    outtmpl = str(out_dir / f"{job['id']}-%(title)s - %(uploader)s.%(ext)s")
    try:
        _force_utf8_stdio()
        downloaded = _sc_download_file(job["url"], outtmpl)
    except Exception as e:  # pragma: no cover
        log.exception("SoundCloud job %s download error", job.get("id"))
        with SC_JOBS_GUARD:
            job["state"] = "error"
            job["error"] = str(e)[:500]
            job["message"] = "Ошибка"
    else:
        if downloaded and os.path.isfile(downloaded):
            files = [downloaded]
            with SC_JOBS_GUARD:
                job["files"] = [os.path.relpath(f, out_dir).replace("\\", "/") for f in files]
                job["state"] = "done"
                job["message"] = "Готово: 1 файл"
        else:
            with SC_JOBS_GUARD:
                job["state"] = "error"
                job["error"] = "Не удалось скачать трек. Проверьте ссылку и соединение."
                job["message"] = "Ошибка"
    finally:
        with SC_JOBS_GUARD:
            job["finished"] = time.time()


def _sc_download_worker() -> None:
    while True:
        job = SC_DOWNLOAD_QUEUE.get()
        try:
            if job is None:
                return
            _sc_run_download(job)
        finally:
            SC_DOWNLOAD_QUEUE.task_done()


for worker_index in range(SC_DOWNLOAD_WORKERS):
    threading.Thread(
        target=_sc_download_worker,
        daemon=True,
        name=f"sc-download-{worker_index + 1}",
    ).start()


def _get_zvuk_client():
    global ZVUK_CLIENT, ZVUK_ANON_TOKEN
    try:
        from zvuk_music import Client as ZvukClient
    except ImportError:
        return None
    with ZVUK_CLIENT_LOCK:
        if ZVUK_CLIENT is not None:
            return ZVUK_CLIENT
        token = ZVUK_TOKEN
        if not token:
            try:
                if ZVUK_ANON_TOKEN:
                    token = ZVUK_ANON_TOKEN
                else:
                    token = ZvukClient.get_anonymous_token()
                    ZVUK_ANON_TOKEN = token
                    log.info("Zvuk anonymous token obtained")
            except Exception as e:
                log.warning("Zvuk anon token failed: %s", e)
                return None
        try:
            ZVUK_CLIENT = ZvukClient(token=token)
            return ZVUK_CLIENT
        except Exception as e:
            log.warning("Zvuk client init failed: %s", e)
            return None


def _zvuk_get_stream_url(track_id: str) -> str:
    cached = ZVUK_URL_CACHE.get(track_id)
    now = time.time()
    if cached and (now - cached[1]) < ZVUK_URL_TTL:
        return cached[0]
    client = _get_zvuk_client()
    if client is None:
        raise RuntimeError("Zvuk не настроен (нет токена и не удалось получить анонимный)")
    url = ""
    try:
        from zvuk_music import Quality
        url = client.get_stream_url(track_id, quality=Quality.MID)
    except Exception as e:
        log.info("Zvuk MID failed for %s: %s, trying HIGH fallback", track_id, e)
        try:
            from zvuk_music import Quality as Q2
            url = client.get_stream_url(track_id, quality=Q2.MID)
        except Exception:
            raise
    if not url:
        raise RuntimeError("Не удалось получить ссылку Zvuk")
    ZVUK_URL_CACHE[track_id] = (url, now)
    _trim_cache(ZVUK_URL_CACHE, 1)
    return url


def _proxy_stream(handler: SimpleHTTPRequestHandler, upstream, content_type: str | None = None) -> None:
    """Forward upstream response to client with unified headers and chunked copy."""
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "*")
    handler.send_header("Cache-Control", "no-store")
    if content_type:
        handler.send_header("Content-Type", content_type)
    else:
        ctype = upstream.headers.get_content_type() or "application/octet-stream"
        handler.send_header("Content-Type", ctype)
    if "Content-Length" in getattr(upstream, "headers", {}):
        handler.send_header("Content-Length", upstream.headers["Content-Length"])
    if "Content-Range" in getattr(upstream, "headers", {}):
        handler.send_header("Content-Range", upstream.headers["Content-Range"])
    if "Accept-Ranges" in getattr(upstream, "headers", {}):
        handler.send_header("Accept-Ranges", upstream.headers["Accept-Ranges"])
    else:
        handler.send_header("Accept-Ranges", "bytes")
    handler.end_headers()
    while True:
        chunk = upstream.read(STREAM_CHUNK_SIZE)
        if not chunk:
            break
        handler.wfile.write(chunk)
        handler.wfile.flush()


def _sc_extract_audio_url(page_url: str, fresh: bool = False) -> tuple[str, str, str, int]:
    """Извлекает прямой аудиопоток страницы SoundCloud без скачивания.

    Возвращает (audio_url, kind, title, duration), где kind 'http' —
    progressive-URL (можно отдавать 302 редиректом), 'hls' — только HLS
    (нужен download-фолбэк). Результат кэшируется в SC_URL_CACHE.
    fresh=True пропускает кэш: нужен при повторе, т.к. подписанные URL
    SoundCloud протухают (~10 мин) раньше, чем истекает TTL кэша."""
    now = time.time()
    if not fresh:
        cached = SC_URL_CACHE.get(page_url)
        if cached and (now - cached[2]) < SC_URL_TTL:
            return cached[0], cached[1], cached[3], cached[4]
    ydl_opts = {
        "format": "http_mp3_1_0/http_mp3/bestaudio[protocol^=http]/bestaudio",
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 20,
        "noplaylist": True,
    }
    with _limited_ydl(ydl_opts) as ydl:
        info = ydl.extract_info(page_url, download=False)
    audio_url = info.get("url") or ""
    if not audio_url:
        for fmt in info.get("formats", []):
            if fmt.get("acodec") != "none" and fmt.get("url"):
                audio_url = fmt["url"]
                break
    if not audio_url:
        raise RuntimeError("Не удалось извлечь аудиопоток")
    proto = (info.get("protocol") or "").lower()
    kind = "hls" if ("m3u8" in proto or "hls" in proto) else "http"
    title = info.get("title", "")
    duration = info.get("duration") or 0
    SC_URL_CACHE[page_url] = (audio_url, kind, now, title, duration)
    _trim_cache(SC_URL_CACHE, 2)
    return audio_url, kind, title, duration


def _sc_search_tracks(text: str, count: int = 15) -> list[dict]:
    """Плоский поиск SoundCloud через yt-dlp (scsearch). Возвращает
    список {id, url, title, artist, thumbnail, duration}."""
    count = min(max(count, 1), 50)
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 20,
        "extract_flat": True,
        "default_search": "scsearch",
    }
    with _limited_ydl(ydl_opts) as ydl:
        result = ydl.extract_info(f"scsearch{count}:{text}", download=False)
    items = []
    for entry in (result.get("entries") or [])[:count]:
        if not isinstance(entry, dict):
            continue
        url = entry.get("webpage_url") or entry.get("url") or ""
        if not url:
            continue
        items.append({
            "id": str(entry.get("id", "")),
            "url": url,
            "title": entry.get("title", "") or "",
            "artist": entry.get("uploader") or entry.get("channel") or "",
            "thumbnail": _best_thumbnail(entry.get("thumbnails") or []),
            "duration": entry.get("duration") or 0,
        })
    return items


class AppHandler(SimpleHTTPRequestHandler):
    server_version = SERVER_VERSION

    def translate_path(self, path: str) -> str:
        parsed = urlparse(path).path
        relative = parsed.lstrip("/") or "index.html"
        target = (ROOT / relative).resolve()
        if ROOT not in target.parents and target != ROOT:
            return str(ROOT / "index.html")
        return str(target)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    _GZIP_EXTS = {".html", ".css", ".js", ".json", ".svg", ".txt", ".md"}
    _GZIP_MIN_BYTES = 1024
    _GZIP_CACHE: dict[tuple[str, float, int], bytes] = {}

    def send_head(self):
        if self.command == "GET" and not self.headers.get("Range"):
            if "gzip" in (self.headers.get("Accept-Encoding") or ""):
                try:
                    path = self.translate_path(self.path)
                except Exception:
                    path = ""
                if path and not os.path.isdir(path):
                    ext = os.path.splitext(path)[1].lower()
                    if ext in self._GZIP_EXTS:
                        try:
                            st = os.stat(path)
                            if st.st_size >= self._GZIP_MIN_BYTES:
                                key = (path, st.st_mtime, st.st_size)
                                data = self._GZIP_CACHE.get(key)
                                if data is None:
                                    with open(path, "rb") as f:
                                        data = gzip.compress(f.read(), compresslevel=6)
                                    if len(self._GZIP_CACHE) > 64:
                                        self._GZIP_CACHE.clear()
                                    self._GZIP_CACHE[key] = data
                                self.send_response(200)
                                self.send_header("Content-Type", self.guess_type(path))
                                self.send_header("Content-Encoding", "gzip")
                                self.send_header("Content-Length", str(len(data)))
                                self.send_header("Accept-Ranges", "none")
                                self.end_headers()
                                return io.BytesIO(data)
                        except OSError:
                            pass
        return super().send_head()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        route = parsed.path
        if route == "/api/archaeo/related":
            self.handle_archaeo_related(parse_qs(parsed.query))
            return
        if route == "/api/lyrics":
            self.handle_lyrics(parse_qs(parsed.query))
            return
        if route == "/api/music/albums":
            self.handle_music_albums(parse_qs(parsed.query))
            return
        if route == "/api/music/album-tracks":
            self.handle_music_album_tracks(parse_qs(parsed.query))
            return
        if route == "/api/artist-image":
            self.handle_artist_image(parse_qs(parsed.query))
            return
        if route == "/api/artist/bio":
            self.handle_artist_bio(parse_qs(parsed.query))
            return
        if route == "/api/sc/search":
            self.handle_sc_search(parse_qs(parsed.query))
            return
        if route == "/api/sc/resolve":
            self.handle_sc_resolve(parse_qs(parsed.query))
            return
        if route == "/api/sc/stream":
            self.handle_sc_stream(parse_qs(parsed.query))
            return
        if route == "/api/sc/status":
            self.handle_sc_status(parse_qs(parsed.query))
            return
        if route == "/api/session":
            self.send_json({"token": API_TOKEN})
            return
        if route == "/api/version":
            self.send_json({"version": APP_VERSION})
            return
        if route == "/api/update":
            update = fetch_update()
            self.send_json(update or {"version": APP_VERSION, "available": False})
            return
        if route == "/api/sc/library":
            self.handle_sc_library()
            return
        if route == "/api/sc/file":
            self.handle_sc_file(parse_qs(parsed.query))
            return
        if route == "/api/zvuk/search":
            self.handle_zvuk_search(parse_qs(parsed.query))
            return
        if route == "/api/zvuk/resolve":
            self.handle_zvuk_resolve(parse_qs(parsed.query))
            return
        if route == "/api/zvuk/stream":
            self.handle_zvuk_stream(parse_qs(parsed.query))
            return
        if route.startswith("/api/"):
            self.send_json({"error": f"Маршрут не найден: {route}"}, HTTPStatus.NOT_FOUND)
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/shutdown":
            if not self._authorized():
                return
            self.handle_shutdown()
        elif parsed.path == "/api/update/apply":
            if not self._authorized():
                return
            self.handle_update_apply()
        elif parsed.path == "/api/sc/download":
            body = self.read_json()
            if body is not None:
                self.handle_sc_download(body)
        else:
            self.send_json({"error": f"Маршрут не найден: {parsed.path}"}, HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/sc/file":
            if not self._authorized():
                return
            self.handle_sc_delete(parse_qs(parsed.query))
        else:
            self.send_json({"error": f"Маршрут не найден: {parsed.path}"}, HTTPStatus.NOT_FOUND)

    def _authorized(self) -> bool:
        supplied = self.headers.get("X-Umbrella-Token", "")
        if secrets.compare_digest(supplied, API_TOKEN):
            return True
        self.send_json({"error": "Требуется авторизация"}, HTTPStatus.FORBIDDEN)
        return False

    def handle_archaeo_related(self, query: dict[str, list[str]]) -> None:
        seeds = [s.strip() for s in query.get("s", []) if s.strip()][:10]
        if not seeds:
            self.send_json({"error": "Нужен хотя бы один сид s=«артист — трек»"}, HTTPStatus.BAD_REQUEST)
            return
        if yt_dlp is None:
            self.send_json({"error": "yt-dlp не установлен"}, HTTPStatus.SERVICE_UNAVAILABLE)
            return
        try:
            limit = min(max(int(query.get("limit", ["10"])[0]), 3), 15)
        except ValueError:
            limit = 10

        def _related(seed: str) -> list[dict]:
            try:
                found = _sc_search_tracks(seed, limit + 4)
            except Exception:
                return []
            out = []
            seen = set()
            for t in found:
                key = f"{(t.get('title') or '').strip().lower()}|{(t.get('artist') or '').strip().lower()}"
                if not key.strip('|') or key in seen:
                    continue
                seen.add(key)
                out.append({"key": key, "url": t.get("url", "")})
                if len(out) >= limit:
                    break
            return out

        result: dict[str, list[dict]] = {}
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(_related, s): s for s in seeds}
            for fut in as_completed(futures):
                s = futures[fut]
                try:
                    result[s] = fut.result()
                except Exception:
                    result[s] = []
        self.send_json({"map": result})

    def _serve_local_file(self, file_path: str) -> None:
        now = time.time()
        file_size = os.path.getsize(file_path)
        ext = os.path.splitext(file_path)[1].lower()
        ctype = {
            ".mp3": "audio/mpeg",
            ".flac": "audio/flac",
            ".m4a": "audio/mp4",
            ".mp4": "audio/mp4",
            ".ogg": "audio/ogg",
            ".opus": "audio/ogg",
        }.get(ext, "audio/m4a")
        range_header = self.headers.get("Range")
        if range_header:
            if file_size <= 0 or not range_header.startswith("bytes="):
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.end_headers()
                return
            m = range_header[6:].split("-", 1)
            try:
                if len(m) != 2 or (not m[0] and not m[1]):
                    raise ValueError("invalid range")
                if m[0]:
                    start = int(m[0])
                    end = int(m[1]) if m[1] else file_size - 1
                else:
                    suffix = int(m[1])
                    start = max(0, file_size - suffix)
                    end = file_size - 1
            except ValueError:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.end_headers()
                return
            if start >= file_size or start < 0:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.end_headers()
                return
            start = max(0, min(start, file_size - 1))
            end = max(start, min(end, file_size - 1))
            length = end - start + 1
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(STREAM_CHUNK_SIZE, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        else:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(file_size))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            with open(file_path, "rb") as f:
                while True:
                    chunk = f.read(STREAM_CHUNK_SIZE)
                    if not chunk:
                        break
                    self.wfile.write(chunk)


    def _lrclib_request(self, url: str) -> dict | None:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "UmbrellaPlayer/2.0 (https://github.com/umbrella-player)"})
            with _metadata_urlopen(req, timeout=10) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception:
            return None

    def _lrclib_best_match(self, results: list, duration: int) -> dict | None:
        if not results:
            return None
        if duration > 0:
            best = min(results, key=lambda r: abs((r.get("duration") or 0) - duration))
        else:
            best = results[0]
        lrclib_id = best.get("id")
        if not lrclib_id:
            return best
        detail = self._lrclib_request(f"{LRCLIB_BASE}/api/get/{lrclib_id}")
        return detail or best

    def _syncedlyrics_fetch(self, track: str, artist: str) -> dict | None:
        """Fallback: syncedlyrics aggregates Musixmatch, NetEase, Megalobiz, Genius, LRCLIB."""
        try:
            import syncedlyrics
        except ImportError:
            log.warning("syncedlyrics not installed, skipping")
            return None
        search_term = f"{track} {artist}".strip()
        try:
            lrc = syncedlyrics.search(search_term, plain_only=False, synced_only=False)
            if not lrc:
                return None
            synced, plain = "", ""
            if lrc.startswith("["):
                synced = lrc
            else:
                plain = lrc
            return {
                "trackName": track,
                "artistName": artist,
                "albumName": "",
                "duration": 0,
                "instrumental": False,
                "syncedLyrics": synced,
                "plainLyrics": plain,
                "_source": "syncedlyrics",
            }
        except Exception as e:
            log.warning("syncedlyrics fetch error: %s", e)
            return None

    def _translit_ru(self, s: str) -> str:
        m = {'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'}
        return "".join(m.get(ch, ch) for ch in s.lower())

    def _genius_search_once(self, q: str, token: str) -> dict | None:
        q = q.strip()
        if not q:
            return None
        try:
            if token:
                url = f"{GENIUS_API_BASE}/search?per_page=5&q={urlquote(q)}"
                headers = {"User-Agent": DEFAULT_UA, "Accept": "application/json", "Authorization": f"Bearer {token}"}
                req = urllib.request.Request(url, headers=headers)
                with _metadata_urlopen(req, timeout=8) as r:
                    data = json.loads(r.read().decode("utf-8", "ignore"))
                for h in (data.get("response", {}).get("hits") or []):
                    if h.get("type") == "song":
                        hit = h.get("result") or h
                        if hit and (hit.get("url") or hit.get("path")):
                            return hit
                return None
            else:
                url = f"{GENIUS_WEB_BASE}/api/search/multi?per_page=5&q={urlquote(q)}"
                headers = {"User-Agent": DEFAULT_UA, "Accept": "application/json, text/plain, */*", "Referer": f"{GENIUS_WEB_BASE}/", "Accept-Language": "en-US,en;q=0.9,ru;q=0.8", "X-Requested-With": "XMLHttpRequest"}
                req = urllib.request.Request(url, headers=headers)
                with _metadata_urlopen(req, timeout=8) as r:
                    data = json.loads(r.read().decode("utf-8", "ignore"))
                for sec in (data.get("response", {}).get("sections") or []):
                    for h in sec.get("hits") or []:
                        if h.get("type") == "song":
                            hit = h.get("result") or h
                            if hit:
                                return hit
                return None
        except Exception as e:
            log.info("Genius search failed for %r: %s", q, e)
            return None

    def _genius_fetch(self, track: str, artist: str) -> dict | None:
        clean_track = _RE_LEADING_NUM.sub('', track or "").strip()
        if ' - ' in clean_track:
            clean_track = clean_track.split(' - ')[-1].strip()
        clean_track = _RE_MULTI_SPACE.sub(' ', clean_track).strip()
        raw_q = f"{track} {artist}".strip()
        token = os.getenv("GENIUS_TOKEN", "").strip()
        queries: list[str] = []
        if clean_track and artist:
            queries.append(f"{clean_track} {artist}")
        if clean_track:
            queries.append(clean_track)
        tr = self._translit_ru(clean_track) if clean_track else ""
        if tr and tr != clean_track.lower():
            queries.append(tr)
            if artist:
                queries.append(f"{tr} {artist}")
        seen: set[str] = set()
        uniq: list[str] = []
        for q in queries:
            q = _RE_MULTI_SPACE.sub(' ', q).strip()
            if q and q.lower() not in seen:
                seen.add(q.lower())
                uniq.append(q)
        hit = None
        last_q = ""
        for q in uniq:
            last_q = q
            hit = self._genius_search_once(q, token)
            if hit:
                break
        if not hit:
            return None
        try:
            song_url = hit.get("url") or hit.get("path") and f"{GENIUS_WEB_BASE}{hit['path']}"
            if not song_url:
                return None
            html_headers = {
                "User-Agent": DEFAULT_UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
                "Accept-Encoding": "gzip",
                "Referer": f"{GENIUS_WEB_BASE}/",
                "Cache-Control": "no-cache",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "same-origin",
                "Sec-Fetch-User": "?1",
                "Upgrade-Insecure-Requests": "1",
                "Priority": "u=0, i",
            }
            try:
                req2 = urllib.request.Request(song_url, headers=html_headers)
                with _metadata_urlopen(req2, timeout=10) as r2:
                    raw = r2.read()
                    try:
                        import gzip
                        if r2.headers.get("Content-Encoding") == "gzip":
                            raw = gzip.decompress(raw)
                    except Exception:
                        pass
                    html = raw.decode("utf-8", "ignore")
            except urllib.error.HTTPError as he:
                if he.code in (403, 401):
                    for proxy in (f"https://api.allorigins.win/raw?url={urlquote(song_url)}", f"https://cc.bingj.com/cache.cgi?d=1&w={urlquote(song_url)}"):
                        try:
                            preq = urllib.request.Request(proxy, headers={"User-Agent": DEFAULT_UA})
                            with _metadata_urlopen(preq, timeout=10) as pr:
                                html = pr.read().decode("utf-8", "ignore")
                            if "data-lyrics-container" in html or "Lyrics__Container" in html:
                                break
                        except Exception:
                            continue
                    else:
                        api_path = hit.get("api_path") or ""
                        if api_path and token:
                            try:
                                api_url = f"{GENIUS_API_BASE}{api_path}?text_format=plain"
                                api_headers = {"User-Agent": DEFAULT_UA, "Accept": "application/json", "Authorization": f"Bearer {token}"}
                                req3 = urllib.request.Request(api_url, headers=api_headers)
                                with _metadata_urlopen(req3, timeout=8) as r3:
                                    j = json.loads(r3.read().decode("utf-8", "ignore"))
                                desc = (j.get("response", {}).get("song") or {}).get("description", {}).get("plain") or ""
                                if desc and len(desc.strip()) > 20:
                                    return {"trackName": track, "artistName": artist, "albumName": "", "duration": 0, "instrumental": False, "syncedLyrics": "", "plainLyrics": desc.strip(), "_source": "genius"}
                            except Exception:
                                pass
                        raise
                else:
                    raise
            m = re.findall(r'data-lyrics-container[^>]*>(.*?)</div>', html, re.S)
            if not m:
                m = re.findall(r'class="Lyrics__Container[^>]*>(.*?)</div>', html, re.S)
            if not m:
                return None
            text = ""
            for block in m:
                block = re.sub(r'<br\s*/?>', '\n', block)
                block = _RE_HTML_TAG.sub('', block)
                block = block.replace('&amp;', '&').replace('&quot;', '"').replace('&#39;', "'")
                text += block.strip() + "\n\n"
            text = text.strip()
            if len(text) < 20:
                return None
            return {
                "trackName": track, "artistName": artist, "albumName": "", "duration": 0,
                "instrumental": False, "syncedLyrics": "", "plainLyrics": text, "_source": "genius",
            }
        except Exception as e:
            log.info("Genius fetch failed for %r: %s", last_q, e)
            return None

    def handle_lyrics(self, query: dict[str, list[str]]) -> None:
        track = query.get("track_name", [""])[0].strip()
        artist = query.get("artist_name", [""])[0].strip()
        album = query.get("album_name", [""])[0].strip()
        try:
            duration = int(query.get("duration", ["0"])[0])
        except ValueError:
            duration = 0
        if not track:
            self.send_json({"error": "track_name обязателен"}, HTTPStatus.BAD_REQUEST)
            return
        cache_key = f"{track}|{artist}|{album}|{duration}"
        now = time.time()
        cached = LYRICS_CACHE.get(cache_key)
        if cached and (now - cached.get("_ts", 0)) < LYRICS_TTL:
            self.send_json(cached)
            return
        result = None
        if track and artist and album and duration > 0:
            params = urllib.parse.urlencode({"track_name": track, "artist_name": artist, "album_name": album, "duration": duration})
            data = self._lrclib_request(f"{LRCLIB_BASE}/api/get?{params}")
            if data and not data.get("notFound") and (data.get("syncedLyrics") or data.get("plainLyrics")):
                result = data
        if not result:
            query_parts = [track]
            if artist:
                query_parts.append(artist)
            search_q = " ".join(query_parts)
            params = urllib.parse.urlencode({"q": search_q})
            search_data = self._lrclib_request(f"{LRCLIB_BASE}/api/search?{params}")
            if search_data and isinstance(search_data, list) and search_data:
                best = self._lrclib_best_match(search_data, duration)
                if best and (best.get("syncedLyrics") or best.get("plainLyrics")):
                    result = best
        if not result:
            mux = self._syncedlyrics_fetch(track, artist)
            if mux:
                result = mux
        if not result:
            g = self._genius_fetch(track, artist)
            if g:
                result = g
        if result:
            out = {
                "trackName": result.get("trackName", ""),
                "artistName": result.get("artistName", ""),
                "albumName": result.get("albumName", ""),
                "duration": result.get("duration", 0),
                "instrumental": result.get("instrumental", False),
                "syncedLyrics": result.get("syncedLyrics") or "",
                "plainLyrics": result.get("plainLyrics") or "",
            }
            out["_ts"] = now
            with LYRICS_CACHE_LOCK:
                LYRICS_CACHE[cache_key] = out
                _trim_cache(LYRICS_CACHE, 0)
            self.send_json(out)
        else:
            self.send_json({"notFound": True, "syncedLyrics": "", "plainLyrics": ""})

    def handle_shutdown(self) -> None:
        self.send_json({"ok": True, "message": "Сервер останавливается"})
        SERVER_STOPPING.set()
        threading.Thread(target=self.server.shutdown, daemon=True, name="server-shutdown").start()

    def handle_update_apply(self) -> None:
        update = fetch_update()
        if not update or not launch_update(update, log):
            self.send_json({"error": "Обновление недоступно"}, HTTPStatus.CONFLICT)
            return
        self.send_json({"ok": True})
        SERVER_STOPPING.set()
        threading.Thread(target=self.server.shutdown, daemon=True, name="server-update-shutdown").start()

    def _deezer_get(self, path: str) -> dict | None:
        try:
            req = urllib.request.Request(
                f"{DEEZER_API_BASE}{path}",
                headers={"User-Agent": MB_UA},
            )
            with _metadata_urlopen(req, timeout=10) as resp:
                return json.loads(resp.read())
        except Exception:
            return None

    def handle_music_albums(self, query: dict[str, list[str]]) -> None:
        text = query.get("q", [""])[0].strip()
        if not text:
            self.send_json({"error": "Пустой запрос"}, HTTPStatus.BAD_REQUEST)
            return
        try:
            limit = min(max(int(query.get("limit", ["20"])[0]), 1), 50)
        except ValueError:
            limit = 20
        data = self._deezer_get(f"/search/album?q={urlquote(text)}&limit={limit}")
        if data is None:
            self.send_json({"error": "Deezer API недоступен"}, HTTPStatus.BAD_GATEWAY)
            return
        albums = []
        for item in (data.get("data") or []):
            albums.append({
                "id": item.get("id"),
                "title": item.get("title", ""),
                "artist": (item.get("artist") or {}).get("name", ""),
                "cover": item.get("cover_xl") or item.get("cover_big") or item.get("cover_medium") or "",
                "trackCount": item.get("nb_tracks") or 0,
            })
        self.send_json({"albums": albums})

    @staticmethod
    def _is_deezer_placeholder(url: str) -> bool:
        # Заглушка Deezer «нет фото»: hash пустой (двойной слэш) ИЛИ
        # md5 пустой строки d41d8cd98f00b204e9800998ecf8427e.
        if not url:
            return True
        return (
            "/artist//" in url
            or "d41d8cd98f00b204e9800998ecf8427e" in url
            or url.rstrip("/").endswith("/artist")
        )

    @staticmethod
    def _pick_pic(obj: dict) -> str:
        return obj.get("picture_xl") or obj.get("picture_big") or obj.get("picture_medium") or ""

    @staticmethod
    def _json_get(url: str, timeout: float = 5.0, ua: str = "UmbrellaPlayer/1.0"):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read() or b"{}")
        except Exception:
            return None

    def _mb_wikidata_picture(self, artist_id: str) -> str:
        # Портрет ИМЕННО этого артиста, без угадывания по имени:
        # Deezer id -> MusicBrainz (по прямой ссылке на Deezer) -> Wikidata P18 -> Викисклад.
        if not artist_id:
            return ""
        # 1) Находим MBID артиста по его ссылке на Deezer (однозначно).
        lookup = self._json_get(
            f"{MB_BASE}/ws/2/url?resource=https://www.deezer.com/artist/{artist_id}&inc=artist-rels&fmt=json",
            timeout=5.0, ua=MB_UA,
        )
        mbid = ""
        if lookup:
            for rel in (lookup.get("relations") or []):
                art = rel.get("artist") or {}
                if art.get("id"):
                    mbid = art["id"]
                    break
        if not mbid:
            return ""
        _mb_rate_limit()
        # 2) У артиста берём связь с Wikidata (и заодно возможную прямую картинку).
        art = self._json_get(
            f"{MB_BASE}/ws/2/artist/{mbid}?inc=url-rels&fmt=json",
            timeout=5.0, ua=MB_UA,
        )
        if not art:
            return ""
        qid = ""
        for rel in (art.get("relations") or []):
            rtype = rel.get("type", "")
            res = (rel.get("url") or {}).get("resource", "")
            if rtype == "image" and res:
                # Прямая картинка (обычно Wikimedia Commons File:...).
                direct = self._commons_filepath(res)
                if direct:
                    return direct
            if rtype == "wikidata" and "wikidata.org" in res:
                qid = res.rstrip("/").split("/")[-1]
        if not qid:
            return ""
        # 3) Wikidata -> свойство P18 (изображение) -> файл на Викискладе.
        wd = self._json_get(
            f"{WIKIDATA_BASE}/wiki/Special:EntityData/{qid}.json",
            timeout=5.0, ua=MB_UA,
        )
        try:
            claims = wd["entities"][qid]["claims"]
            fname = claims["P18"][0]["mainsnak"]["datavalue"]["value"]
            return self._commons_filename_url(fname)
        except Exception:
            return ""

    @staticmethod
    def _commons_filename_url(fname: str) -> str:
        if not fname:
            return ""
        safe = urlquote(fname.replace(" ", "_"))
        return f"{WIKIMEDIA_BASE}/wiki/Special:FilePath/{safe}?width=600"

    @classmethod
    def _commons_filepath(cls, url: str) -> str:
        # Из ссылки вида https://commons.wikimedia.org/wiki/File:Name.jpg делаем
        # стабильный прямой URL картинки.
        marker = "/wiki/File:"
        if marker in url:
            return cls._commons_filename_url(url.split(marker, 1)[1])
        if "commons.wikimedia.org/wiki/Special:FilePath/" in url:
            return url
        return ""

    @staticmethod
    def _norm_name(s: str) -> str:
        # Нормализуем имя для сравнения/ключей: только буквы+цифры, нижний регистр.
        return "".join(ch for ch in (s or "").lower() if ch.isalnum())

    def _load_overrides(self) -> dict:
        # Ручные переопределения фото: {"Имя артиста": "https://...jpg"}.
        # Файл читается заново при изменении, перезапуск не нужен.
        try:
            st = ARTIST_OVERRIDES_PATH.stat()
        except FileNotFoundError:
            return {}
        if st.st_mtime != ARTIST_OVERRIDES_CACHE["mtime"]:
            try:
                with open(ARTIST_OVERRIDES_PATH, "r", encoding="utf-8") as f:
                    raw = json.load(f)
                data = {
                    self._norm_name(k): v
                    for k, v in raw.items()
                    if isinstance(v, str) and v and not k.startswith("__")
                }
                ARTIST_OVERRIDES_CACHE["mtime"] = st.st_mtime
                ARTIST_OVERRIDES_CACHE["data"] = data
                log.info("Загружено artist_overrides.json: %d записей", len(data))
            except Exception as e:
                log.warning("artist_overrides.json не читается: %s", e)
        return ARTIST_OVERRIDES_CACHE["data"]  # type: ignore[return-value]

    def _theaudiodb_picture(self, artist_name: str) -> str:
        # TheAudioDB — база с курируемыми ПОРТРЕТАМИ артистов (не баннерами).
        if not artist_name:
            return ""
        try:
            url = f"{AUDIODB_BASE}/api/v1/json/2/search.php?s={urlquote(artist_name)}"
            req = urllib.request.Request(url, headers={"User-Agent": MB_UA})
            with _metadata_urlopen(req, timeout=6) as r:
                data = json.loads(r.read() or b"{}")
            for a in (data.get("artists") or []):
                # Берём только точное совпадение имени, чтобы не подхватить
                # однофамильца.
                if self._norm_name(a.get("strArtist", "")) != self._norm_name(artist_name):
                    continue
                thumb = a.get("strArtistThumb") or a.get("strArtistThumb2") or ""
                if thumb:
                    return thumb
        except Exception as e:
            log.info("TheAudioDB недоступен для %r: %s", artist_name, e)
        return ""

    def _wiki_query(self, lang: str, titles: str) -> dict | None:
        # Один запрос к Википедии, который сразу отдаёт текст, описание,
        # портрет и Wikidata-QID — чтобы не ходить на сайт по три раза.
        try:
            req = urllib.request.Request(
                f"https://{lang}.wikipedia.org/w/api.php?action=query&format=json"
                f"&prop=extracts%7Cpageimages%7Cpageprops%7Cdescription"
                f"&exintro&explaintext&exsentences=6"
                f"&piprop=thumbnail%7Coriginal&pithumbsize=900"
                f"&ppprop=wikibase_item&redirects=1&titles={urlquote(titles)}",
                headers={"User-Agent": MB_UA},
            )
            with _metadata_urlopen(req, timeout=8) as r:
                return json.loads(r.read())
        except Exception as e:
            log.info("Wikipedia (%s / %s) недоступна: %s", lang, titles, e)
            return None

    @staticmethod
    def _wiki_build(page: dict, lang: str, fallback_title: str) -> dict | None:
        extract = (page.get("extract") or "").strip()
        thumb = (page.get("thumbnail") or {}).get("source") or ""
        original = (page.get("original") or {}).get("source") or ""
        if not extract and not thumb:
            return None
        title = page.get("title") or fallback_title
        return {
            "title": title,
            "extract": extract,
            "description": (page.get("description") or "").strip(),
            "image": thumb,
            "imageOriginal": original,
            "qid": (page.get("pageprops") or {}).get("wikibase_item", ""),
            "lang": lang,
            "url": f"https://{lang}.wikipedia.org/wiki/{urlquote(title.replace(' ', '_'))}",
        }

    def _wikipedia_page(self, artist_name: str) -> dict | None:
        # Единая карточка артиста из Википедии (текст + описание + портрет + QID).
        # Результат кэшируется, поэтому и фото, и биография берутся с ОДНОЙ страницы.
        if not artist_name:
            return None
        key = self._norm_name(artist_name)
        now = time.time()
        cached = WIKI_PAGE_CACHE.get(key)
        if cached and (now - cached[0]) < WIKI_PAGE_TTL:
            return cached[1] or None

        found: dict | None = None
        # 1) Прямые заголовки с музыкальными уточнениями — сначала RU, потом EN,
        #    чтобы не попасть на страницу-разъяснение (напр. "Joji" -> "Joji (musician)").
        variants = {
            "ru": [f"{artist_name} (музыкант)", f"{artist_name} (рэпер)", f"{artist_name} (певец)", f"{artist_name} (группа)", artist_name],
            "en": [f"{artist_name} (musician)", f"{artist_name} (rapper)", f"{artist_name} (singer)", f"{artist_name} (band)", f"{artist_name} (DJ)", artist_name],
        }
        for lang in ("ru", "en"):
            # Заголовки можно спрашивать пачкой через "|" — один запрос на язык.
            data = self._wiki_query(lang, "|".join(variants[lang]))
            if not data:
                continue
            pages = ((data.get("query") or {}).get("pages") or {})
            best = None
            for p in pages.values():
                if str(p.get("pageid", "")) in ("", "-1"):
                    continue
                built = self._wiki_build(p, lang, artist_name)
                if not built:
                    continue
                # Приоритет странице с портретом и текстом.
                score = (1 if built["image"] else 0) + (1 if built["extract"] else 0)
                if best is None or score > best[0]:
                    best = (score, built)
            if best:
                found = best[1]
                break

        # 2) Точной страницы нет (напр. имя ютуб-канала) — ищем ближайшую статью.
        if not found:
            for lang in ("ru", "en"):
                try:
                    req = urllib.request.Request(
                        f"https://{lang}.wikipedia.org/w/api.php?action=query&format=json"
                        f"&list=search&srsearch={urlquote(artist_name)}&srlimit=1&srnamespace=0",
                        headers={"User-Agent": MB_UA},
                    )
                    with _metadata_urlopen(req, timeout=8) as r:
                        hit = (((json.loads(r.read()).get("query") or {}).get("search") or [None])[0]) or {}
                    title = hit.get("title")
                    if not title:
                        continue
                    data = self._wiki_query(lang, title)
                    if not data:
                        continue
                    for p in ((data.get("query") or {}).get("pages") or {}).values():
                        built = self._wiki_build(p, lang, title)
                        if built:
                            found = built
                            break
                    if found:
                        break
                except Exception as e:
                    log.info("Wikipedia search (%s) для %r: %s", lang, artist_name, e)

        WIKI_PAGE_CACHE[key] = (now, found or {})
        return found

    def _wikipedia_picture(self, artist_name: str) -> str:
        page = self._wikipedia_page(artist_name)
        if not page:
            return ""
        return page.get("image") or page.get("imageOriginal") or ""

    def _wikidata_facts(self, qid: str, lang: str = "ru") -> list[dict]:
        # Короткие факты для карточки артиста: жанры, страна, годы активности.
        if not qid:
            return []
        try:
            data = self._json_get(
                f"{WIKIDATA_BASE}/wiki/Special:EntityData/{qid}.json",
                timeout=6.0, ua=MB_UA,
            )
            claims = ((data or {}).get("entities") or {}).get(qid, {}).get("claims") or {}
        except Exception:
            return []

        def entity_ids(prop: str, limit: int = 4) -> list[str]:
            out = []
            for c in (claims.get(prop) or [])[:limit]:
                try:
                    out.append(c["mainsnak"]["datavalue"]["value"]["id"])
                except Exception:
                    continue
            return out

        def year(prop: str) -> str:
            for c in (claims.get(prop) or []):
                try:
                    return c["mainsnak"]["datavalue"]["value"]["time"][1:5]
                except Exception:
                    continue
            return ""

        genres = entity_ids("P136", 3)
        country = entity_ids("P495", 1) or entity_ids("P27", 1)
        ids = genres + country
        labels: dict[str, str] = {}
        if ids:
            try:
                ld = self._json_get(
                    f"{WIKIDATA_BASE}/w/api.php?action=wbgetentities&format=json"
                    f"&ids={'|'.join(ids)}&props=labels&languages={lang}%7Cen",
                    timeout=6.0, ua=MB_UA,
                )
                for eid, ent in ((ld or {}).get("entities") or {}).items():
                    lab = (ent.get("labels") or {})
                    labels[eid] = ((lab.get(lang) or lab.get("en") or {}).get("value") or "")
            except Exception:
                pass

        facts: list[dict] = []
        genre_names = [labels.get(g, "") for g in genres if labels.get(g)]
        if genre_names:
            facts.append({"key": "Жанр", "value": ", ".join(genre_names)})
        country_name = next((labels.get(c) for c in country if labels.get(c)), "")
        if country_name:
            facts.append({"key": "Откуда", "value": country_name})
        start = year("P571") or year("P2031") or year("P569")
        end = year("P576") or year("P2032") or year("P570")
        if start:
            facts.append({"key": "Годы", "value": f"{start} — {end}" if end else f"с {start}"})
        return facts

    def _get_artist_picture(self, artist_name: str, artist_id: str = "") -> str:
        # Порядок подобран так, чтобы получать НАСТОЯЩИЙ портрет ИМЕННО этого
        # артиста и не путать однофамильцев.
        # 0) Ручное переопределение — всегда побеждает.
        overrides = self._load_overrides()
        key = self._norm_name(artist_name)
        if key and key in overrides:
            log.info("Artist picture (override) for %r: %s", artist_name, overrides[key])
            return overrides[key]
        # 1) MusicBrainz(по ссылке Deezer) -> Wikidata -> Викисклад.
        #    Однозначная привязка к артисту + реальный портрет. Работает для
        #    большинства артистов, кто есть на Deezer и в Wikidata.
        pic = self._mb_wikidata_picture(artist_id)
        if pic:
            log.info("Artist picture (Wikidata) for %r: %s", artist_name, pic)
            return pic
        # 2) Точный артист по ID из альбома (быстро, правильный человек).
        if artist_id:
            a = self._deezer_get(f"/artist/{artist_id}")
            if a:
                p = self._pick_pic(a)
                if p and not self._is_deezer_placeholder(p):
                    log.info("Artist picture (Deezer id=%s) for %r: %s", artist_id, artist_name, p)
                    return p
                log.info("У артиста id=%s нет годного фото в Deezer", artist_id)
        # 3) Википедия — настоящий ПОРТРЕТ со страницы артиста, а не обложка
        #    альбома. Идёт раньше Deezer-поиска по имени: поиск по имени часто
        #    возвращает арт релиза, а не фото человека.
        pic = self._wikipedia_picture(artist_name)
        if pic:
            log.info("Artist picture (Wikipedia) for %r: %s", artist_name, pic)
            return pic
        # 4) TheAudioDB (по точному имени) — курируемые портреты.
        pic = self._theaudiodb_picture(artist_name)
        if pic:
            log.info("Artist picture (TheAudioDB) for %r: %s", artist_name, pic)
            return pic
        # 5) Поиск в Deezer по имени — первый с настоящим (не заглушка) фото.
        if artist_name:
            search_data = self._deezer_get(f"/search/artist?q={urlquote(artist_name)}&limit=5")
            for a in ((search_data or {}).get("data") or []):
                p = self._pick_pic(a)
                if p and not self._is_deezer_placeholder(p):
                    log.info("Artist picture (Deezer search) for %r: %s", artist_name, p)
                    return p
        log.info("Фото артиста не найдено нигде: %r", artist_name)
        return ""

    def handle_artist_image(self, query: dict[str, list[str]]) -> None:
        name = query.get("name", [""])[0].strip()
        artist_id = query.get("id", [""])[0].strip()
        if not name and not artist_id:
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.end_headers()
            return
        cache_key = f"{artist_id}|{name}"
        now = time.time()
        cached = ARTIST_IMG_CACHE.get(cache_key)
        if cached and (now - cached[2]) < ARTIST_IMG_TTL:
            body, ctype = cached[0], cached[1]
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return
        url = self._get_artist_picture(name, artist_id)
        if not url:
            # Ничего не нашли — фронт по onerror сам поставит обложку альбома.
            self.send_response(HTTPStatus.NOT_FOUND)
            self.end_headers()
            return
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "UmbrellaPlayer/1.0 (personal music player)", "Referer": ""})
            with _metadata_urlopen(req, timeout=10) as upstream:
                length = int(upstream.headers.get("Content-Length", "0") or 0)
                if length > MAX_ARTIST_IMAGE_BYTES:
                    self.send_response(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
                    self.end_headers()
                    return
                body = upstream.read(MAX_ARTIST_IMAGE_BYTES + 1)
                if len(body) > MAX_ARTIST_IMAGE_BYTES:
                    self.send_response(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
                    self.end_headers()
                    return
                ctype = upstream.headers.get("Content-Type", "image/jpeg")
            ARTIST_IMG_CACHE[cache_key] = (body, ctype, now)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            log.warning("Не удалось скачать фото артиста %r (%s): %s", name, url, e)
            self.send_response(HTTPStatus.BAD_GATEWAY)
            self.end_headers()

    def handle_artist_bio(self, query: dict[str, list[str]]) -> None:
        name = query.get("name", [""])[0].strip()
        if not name:
            self.send_json({"error": "name обязателен"}, HTTPStatus.BAD_REQUEST)
            return
        cache_key = self._norm_name(name)
        now = time.time()
        cached = ARTIST_BIO_CACHE.get(cache_key)
        if cached and (now - cached[0]) < ARTIST_BIO_TTL:
            self.send_json(cached[1])
            return
        page = self._wikipedia_page(name)
        if not page:
            bio = {"ok": False}
        else:
            bio = dict(page)
            bio["ok"] = True
            # Факты (жанр / страна / годы) — только если Википедия дала QID.
            try:
                bio["facts"] = self._wikidata_facts(page.get("qid", ""), page.get("lang", "ru"))
            except Exception:
                bio["facts"] = []
        ARTIST_BIO_CACHE[cache_key] = (now, bio)
        self.send_json(bio)

    def handle_music_album_tracks(self, query: dict[str, list[str]]) -> None:
        album_id = query.get("id", [""])[0].strip()
        if not album_id:
            self.send_json({"error": "id альбома обязателен"}, HTTPStatus.BAD_REQUEST)
            return
        search_title = query.get("title", [""])[0].strip()
        log.debug("album_tracks: id=%s title=%s", album_id, search_title)
        info = self._deezer_get(f"/album/{album_id}")
        data = self._deezer_get(f"/album/{album_id}/tracks?limit=100")
        log.debug("album_tracks deezer: info=%s data=%s", info is not None, data is not None)
        if info is not None and data is not None:
            log.debug("album_tracks deezer data keys: %s", list(data.keys()) if data else 'none')
            log.debug("album_tracks deezer info keys: %s", list(info.keys()) if info else 'none')
            album_artist = (info.get("artist") or {}).get("name", "")
            artist_id = (info.get("artist") or {}).get("id", "")
            cover = (info.get("cover_xl") or info.get("cover_big") or info.get("cover_medium") or "")
            album_title = info.get("title", "")
            raw_tracks = data.get("data") or []
            log.debug("album_tracks deezer raw tracks count: %d", len(raw_tracks))
            tracks = []
            for item in raw_tracks:
                tracks.append({
                    "title": item.get("title", ""),
                    "artist": (item.get("artist") or {}).get("name", "") or album_artist,
                    "duration": item.get("duration") or 0,
                    "position": item.get("track_position") or 0,
                    "id": item.get("id", ""),
                    "previewUrl": item.get("preview") or "",
                    "link": item.get("link") or "",
                })
            if tracks:
                log.debug("album_tracks returning %d tracks from Deezer", len(tracks))
                self.send_json({
                    "albumTitle": album_title,
                    "albumArtist": album_artist,
                    "artistId": artist_id,
                    "cover": cover,
                    "tracks": tracks,
                })
                return
        # Фоллбэк: SoundCloud поиск по названию альбома
        if yt_dlp is not None and search_title:
            try:
                ydl_opts = {
                    "quiet": True, "no_warnings": True, "socket_timeout": 15,
                    "extract_flat": True, "default_search": "scsearch",
                }
                with _limited_ydl(ydl_opts) as ydl:
                    result = ydl.extract_info(f"scsearch20:{search_title}", download=False)
                items = []
                for entry in (result.get("entries") or [])[:20]:
                    if not isinstance(entry, dict):
                        continue
                    items.append({
                        "title": entry.get("title", ""),
                        "artist": entry.get("uploader", "") or entry.get("channel", ""),
                        "duration": entry.get("duration") or 0,
                        "position": 0,
                        "id": entry.get("id", ""),
                    })
                log.debug("album_tracks returning %d tracks from SC fallback", len(items))
                self.send_json({
                    "albumTitle": search_title,
                    "albumArtist": "",
                    "artistId": "",
                    "cover": "",
                    "tracks": items,
                })
                return
            except Exception as e:
                log.warning("SC fallback for album tracks failed: %s", e)
        self.send_json({"error": "Не удалось загрузить треки альбома (Deezer пуст и SoundCloud недоступен)"}, HTTPStatus.BAD_GATEWAY)

    # ================== SoundCloud ==================

    def handle_sc_search(self, query: dict[str, list[str]]) -> None:
        text = query.get("q", [""])[0].strip()
        if not text:
            self.send_json({"error": "Пустой поисковый запрос"}, HTTPStatus.BAD_REQUEST)
            return
        if yt_dlp is None:
            self.send_json({"error": "yt-dlp не установлен"}, HTTPStatus.SERVICE_UNAVAILABLE)
            return
        try:
            count = min(max(int(query.get("count", ["15"])[0]), 1), 50)
        except ValueError:
            count = 15
        try:
            self.send_json({"tracks": _sc_search_tracks(text, count)})
        except ServiceBusyError as error:
            self.send_json({"error": str(error)}, HTTPStatus.SERVICE_UNAVAILABLE)
        except Exception as error:
            self.send_json({"error": f"Ошибка поиска SoundCloud: {error}"}, HTTPStatus.BAD_GATEWAY)

    def handle_sc_resolve(self, query: dict[str, list[str]]) -> None:
        url = query.get("url", [""])[0].strip()
        if not url:
            self.send_json({"error": "url обязателен"}, HTTPStatus.BAD_REQUEST)
            return
        if yt_dlp is None:
            self.send_json({"error": "yt-dlp не установлен"}, HTTPStatus.SERVICE_UNAVAILABLE)
            return
        fresh = query.get("fresh", [""])[0].strip() == "1"
        try:
            audio_url, kind, title, duration = _sc_extract_audio_url(url, fresh=fresh)
            self.send_json({
                "url": audio_url,
                "kind": kind,
                "title": title,
                "duration": duration,
            })
        except ServiceBusyError as error:
            self.send_json({"error": str(error)}, HTTPStatus.SERVICE_UNAVAILABLE)
        except Exception as error:
            self.send_json({"error": f"Ошибка извлечения аудио: {error}"}, HTTPStatus.BAD_GATEWAY)

    def handle_sc_stream(self, query: dict[str, list[str]]) -> None:
        """Проигрывание: progressive-URL отдаём 302 редиректом на подпись
        SoundCloud (мгновенный старт, Range на стороне CDN). Только треки
        без progressive-URL (HLS-only) скачиваем в кэш и отдаём локально
        с поддержкой Range."""
        url = query.get("url", [""])[0].strip()
        if not url:
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.end_headers()
            return
        if yt_dlp is None:
            self.send_response(HTTPStatus.SERVICE_UNAVAILABLE)
            self.end_headers()
            return
        try:
            audio_url, kind, _, _ = _sc_extract_audio_url(url)
        except ServiceBusyError:
            self.send_response(HTTPStatus.SERVICE_UNAVAILABLE)
            self.end_headers()
            return
        except Exception as error:
            log.warning("SC stream extract failed for %s: %s", url, error)
            self.send_response(HTTPStatus.BAD_GATEWAY)
            self.end_headers()
            return
        if kind == "http" and audio_url.startswith("http"):
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", audio_url)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        key = hashlib.sha1(url.encode("utf-8")).hexdigest()
        cached = AUDIO_FILE_CACHE.get(key)
        if cached and os.path.exists(cached[0]) and (time.time() - cached[1]) < AUDIO_FILE_TTL:
            self._serve_local_file(cached[0])
            return
        try:
            SC_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        except OSError:  # pragma: no cover
            pass
        outtmpl = str(SC_CACHE_DIR / f"{key}.%(ext)s")
        with _sc_stream_lock(key):
            cached = AUDIO_FILE_CACHE.get(key)
            if cached and os.path.exists(cached[0]) and (time.time() - cached[1]) < AUDIO_FILE_TTL:
                self._serve_local_file(cached[0])
                return
            path = _sc_download_file(url, outtmpl)
        if not path or not os.path.isfile(path):
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.end_headers()
            return
        AUDIO_FILE_CACHE[key] = (path, time.time())
        self._serve_local_file(path)

    def handle_sc_status(self, query: dict[str, list[str]]) -> None:
        job_id = query.get("id", [""])[0].strip()
        with SC_JOBS_GUARD:
            job = dict(SC_JOBS.get(job_id) or {})
        if not job:
            self.send_json({"error": "Задача не найдена"}, HTTPStatus.NOT_FOUND)
            return
        self.send_json({
            "id": job.get("id"),
            "state": job.get("state", "queued"),
            "message": job.get("message", ""),
            "files": job.get("files") or [],
            "error": job.get("error", ""),
        })

    def handle_sc_download(self, body: dict) -> None:
        if SERVER_STOPPING.is_set():
            self.send_json({"error": "Сервер останавливается"}, HTTPStatus.SERVICE_UNAVAILABLE)
            return
        url = (body.get("url") or "").strip()
        if not url:
            self.send_json({"error": "url обязателен"}, HTTPStatus.BAD_REQUEST)
            return
        if yt_dlp is None:
            self.send_json({"error": "yt-dlp не установлен"}, HTTPStatus.SERVICE_UNAVAILABLE)
            return
        job_id = f"sc{next(SC_JOB_SEQ)}"
        job = {
            "id": job_id,
            "url": url,
            "state": "queued",
            "message": "В очереди…",
            "files": [],
            "error": "",
            "output_dir": str(SC_DIR),
            "created": time.time(),
            "finished": None,
        }
        with SC_JOBS_GUARD:
            if len(SC_JOBS) >= MAX_CACHE_ENTRIES or SC_DOWNLOAD_QUEUE.full():
                self.send_json({"error": "Слишком много задач, повторите позже"}, HTTPStatus.TOO_MANY_REQUESTS)
                return
            SC_JOBS[job_id] = job
        try:
            SC_DOWNLOAD_QUEUE.put_nowait(job)
        except queue.Full:
            with SC_JOBS_GUARD:
                SC_JOBS.pop(job_id, None)
            self.send_json({"error": "Очередь загрузок заполнена"}, HTTPStatus.TOO_MANY_REQUESTS)
            return
        self.send_json({"id": job_id})

    def handle_sc_library(self) -> None:
        files = []
        if SC_DIR.is_dir():
            for p in sorted(SC_DIR.rglob("*")):
                if not p.is_file() or p.suffix.lower() not in (".mp3", ".flac", ".m4a", ".mp4", ".ogg", ".opus"):
                    continue
                name = p.stem
                title, _, artist = name.rpartition(" - ")
                files.append({
                    "path": str(p.relative_to(SC_DIR)),
                    "name": name,
                    "title": title or name,
                    "artist": artist,
                    "size": p.stat().st_size if p.exists() else 0,
                    "ext": p.suffix.lstrip(".").lower(),
                })
        self.send_json({"files": files})

    def handle_sc_file(self, query: dict[str, list[str]]) -> None:
        rel = query.get("path", [""])[0].strip()
        if not rel:
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.end_headers()
            return
        try:
            target = (SC_DIR / rel).resolve()
            target.relative_to(SC_DIR.resolve())
        except Exception:
            self.send_response(HTTPStatus.FORBIDDEN)
            self.end_headers()
            return
        if not target.is_file():
            self.send_response(HTTPStatus.NOT_FOUND)
            self.end_headers()
            return
        ext = target.suffix.lower()
        ctype = {
            ".mp3": "audio/mpeg",
            ".flac": "audio/flac",
            ".m4a": "audio/mp4",
            ".mp4": "audio/mp4",
            ".ogg": "audio/ogg",
            ".opus": "audio/ogg",
        }.get(ext, "application/octet-stream")
        self._serve_file_stream(str(target), ctype)

    def handle_sc_delete(self, query: dict[str, list[str]]) -> None:
        rel = query.get("path", [""])[0].strip()
        if not rel:
            self.send_json({"error": "path обязателен"}, HTTPStatus.BAD_REQUEST)
            return
        try:
            target = (SC_DIR / rel).resolve()
            target.relative_to(SC_DIR.resolve())
        except Exception:
            self.send_json({"error": "Недопустимый путь"}, HTTPStatus.FORBIDDEN)
            return
        if not target.is_file():
            self.send_json({"error": "Файл не найден"}, HTTPStatus.NOT_FOUND)
            return
        try:
            target.unlink()
            self.send_json({"ok": True})
        except OSError as e:
            self.send_json({"error": f"Не удалось удалить: {e}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def handle_zvuk_search(self, query: dict[str, list[str]]) -> None:
        text = query.get("q", [""])[0].lstrip("\ufeff").strip()
        if not text:
            self.send_json({"error": "Пустой поисковый запрос"}, HTTPStatus.BAD_REQUEST)
            return
        try:
            count = min(max(int(query.get("count", ["18"])[0]), 1), 30)
        except ValueError:
            count = 18
        cache_key = f"{text.lower()}|{count}"
        now = time.time()
        cached = ZVUK_SEARCH_CACHE.get(cache_key)
        if cached and (now - cached[1]) < ZVUK_SEARCH_TTL:
            self.send_json({"tracks": cached[0]})
            return
        client = _get_zvuk_client()
        if client is None:
            self.send_json({"error": "Zvuk не доступен: pip install zvuk-music и токен (ZVUK_TOKEN или анонимный)"}, HTTPStatus.SERVICE_UNAVAILABLE)
            return
        try:
            result = client.search(text, limit=count)
            items = []
            if result and result.tracks and result.tracks.items:
                items = result.tracks.items
            if not items:
                qs = client.quick_search(text, limit=count)
                if qs and qs.tracks:
                    items = qs.tracks
            tracks = []
            for t in items[:count]:
                try:
                    tid = str(getattr(t, "id", ""))
                    if not tid:
                        continue
                    title = getattr(t, "title", "") or ""
                    artist = ""
                    try:
                        artist = t.get_artists_str() if hasattr(t, "get_artists_str") else ", ".join(a.title for a in getattr(t, "artists", []))
                    except Exception:
                        artist = ""
                    duration = int(getattr(t, "duration", 0) or 0)
                    cover = ""
                    try:
                        cover = t.get_cover_url(400) if hasattr(t, "get_cover_url") else ""
                    except Exception:
                        cover = ""
                    if not cover:
                        try:
                            rel = getattr(t, "release", None)
                            if rel and getattr(rel, "image", None):
                                cover = rel.image.get_url(400, 400)
                        except Exception:
                            cover = ""
                    tracks.append({"id": tid, "title": title, "artist": artist, "thumbnail": cover, "duration": duration, "source": "zvuk"})
                except Exception:
                    continue
            ZVUK_SEARCH_CACHE[cache_key] = (tracks, now)
            _trim_cache(ZVUK_SEARCH_CACHE, 1)
            self.send_json({"tracks": tracks})
        except Exception as error:
            log.exception("Zvuk search failed for %r", text)
            self.send_json({"error": f"Ошибка поиска Zvuk: {error}"}, HTTPStatus.BAD_GATEWAY)

    def handle_zvuk_resolve(self, query: dict[str, list[str]]) -> None:
        track_id = query.get("trackId", [""])[0].strip() or query.get("id", [""])[0].strip()
        if not track_id:
            self.send_json({"error": "trackId обязателен"}, HTTPStatus.BAD_REQUEST)
            return
        try:
            url = _zvuk_get_stream_url(track_id)
            self.send_json({"url": url, "trackId": track_id})
        except Exception as error:
            log.warning("Zvuk resolve failed for %s: %s", track_id, error)
            self.send_json({"error": f"Ошибка Zvuk resolve: {error}"}, HTTPStatus.BAD_GATEWAY)

    def handle_zvuk_stream(self, query: dict[str, list[str]]) -> None:
        track_id = query.get("trackId", [""])[0].strip() or query.get("id", [""])[0].strip()
        if not track_id:
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.end_headers()
            return
        try:
            audio_url = _zvuk_get_stream_url(track_id)
        except Exception as error:
            log.warning("Zvuk stream url failed for %s: %s", track_id, error)
            self.send_response(HTTPStatus.BAD_GATEWAY)
            self.end_headers()
            return
        try:
            range_header = self.headers.get("Range")
            upstream_headers = {"User-Agent": DEFAULT_UA, "Accept": "*/*"}
            if range_header:
                upstream_headers["Range"] = range_header
            req = urllib.request.Request(audio_url, headers=upstream_headers)
            with urllib.request.urlopen(req, timeout=15) as upstream:
                status = HTTPStatus(upstream.status if upstream.status in (200, 206) else 200)
                self.send_response(status)
                ctype = upstream.headers.get_content_type() or "audio/mpeg"
                self.send_header("Content-Type", ctype)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-store")
                for h in ("Content-Length", "Content-Range", "Accept-Ranges"):
                    if h in upstream.headers:
                        self.send_header(h, upstream.headers[h])
                if "Accept-Ranges" not in upstream.headers:
                    self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                while True:
                    chunk = upstream.read(STREAM_CHUNK_SIZE)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except Exception as error:
            log.warning("Zvuk proxy stream error for %s: %s", track_id, error)
            try:
                self.send_response(HTTPStatus.BAD_GATEWAY)
                self.end_headers()
            except Exception:
                pass

    def _serve_file_stream(self, file_path: str, content_type: str) -> None:
        file_size = os.path.getsize(file_path)
        range_header = self.headers.get("Range")
        if range_header:
            if file_size <= 0 or not range_header.startswith("bytes="):
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.end_headers()
                return
            m = range_header[6:].split("-", 1)
            try:
                if len(m) != 2 or (not m[0] and not m[1]):
                    raise ValueError("invalid range")
                if m[0]:
                    start = int(m[0])
                    end = int(m[1]) if m[1] else file_size - 1
                else:
                    start = max(0, file_size - int(m[1]))
                    end = file_size - 1
            except ValueError:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.end_headers()
                return
            if start >= file_size or start < 0:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.end_headers()
                return
            start = max(0, min(start, file_size - 1))
            end = max(start, min(end, file_size - 1))
            length = end - start + 1
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(STREAM_CHUNK_SIZE, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        else:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(file_size))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            with open(file_path, "rb") as f:
                while True:
                    chunk = f.read(STREAM_CHUNK_SIZE)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

    def read_json(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > MAX_JSON_BODY:
                self.send_json({"error": "Слишком большой JSON-запрос"}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
                return None
            return json.loads(self.rfile.read(length)) if length else {}
        except (ValueError, json.JSONDecodeError):
            return {}

    def send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK, headers: dict | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def guess_type(self, path: str) -> str:
        return mimetypes.guess_type(path)[0] or "application/octet-stream"


def open_browser(port: int = 0) -> None:
    webbrowser.open(f"http://{HOST}:{port or PORT}")


def bind_server(start_port: int = 0, tries: int = 25) -> tuple[ThreadingHTTPServer, int]:
    """Поднимает сервер на первом свободном порту, начиная со start_port.

    Нужно, чтобы плеер не падал с «Address already in use», когда порт занят
    другой копией приложения.
    """
    first = start_port or PORT
    for candidate in range(first, first + tries):
        try:
            return ThreadingHTTPServer((HOST, candidate), AppHandler), candidate
        except OSError:
            continue
    srv = ThreadingHTTPServer((HOST, 0), AppHandler)
    return srv, srv.server_address[1]


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    server, port = bind_server(PORT)
    if port != PORT:
        print(f"Порт {PORT} занят — запускаюсь на {port}")
    print(f"Umbrella Universal Music: http://{HOST}:{port}")
    threading.Timer(0.6, open_browser, args=[port]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен.")
    finally:
        server.server_close()

