"""Intellisense symbol server.

Serves editor symbol tables (classes, public methods, constants, enum values)
for Arduino libraries present in the server-side content-addressed library
cache (VELXIO_LIBCACHE_DIR, default /var/velxio/libcache — entries named
`<norm_name>@<norm_version>-<sha12>`). Extraction is done by the
dependency-free scanner in app.services.symbol_extract, which also mirrors
the pro overlay's cache naming rules; this module never imports app.pro.

Scans are cached on disk under `<cache_root>/.symbols/<entry>.json`: entry
names are content-addressed, so a cached scan can never go stale and the
response is safe to cache aggressively client-side too. A host with no cache
dir (plain OSS self-host) simply 404s — the frontend degrades gracefully.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app.services.symbol_extract import find_cache_entry, parse_spec, scan_library

logger = logging.getLogger(__name__)

router = APIRouter()

# Entry dir names are content-addressed (sha12 suffix), so the payload for a
# given spec resolution can be cached hard by browsers/proxies.
_CACHE_HEADERS = {"Cache-Control": "public, max-age=86400"}


def _cache_root() -> Path:
    """Resolved per-request so tests (and container reconfigs) can point the
    endpoint elsewhere via the environment."""
    return Path(os.environ.get("VELXIO_LIBCACHE_DIR", "/var/velxio/libcache"))


def _write_symbol_cache(sym_file: Path, payload: dict) -> None:
    """Atomically persist a scan result (tmp file + rename). Failures are
    logged and ignored — the response was already computed."""
    try:
        sym_file.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(sym_file.parent), prefix=".tmp-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            os.replace(tmp, sym_file)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except OSError as e:
        logger.warning("[intellisense] symbol cache write failed for %s: %s", sym_file, e)


@router.get("/symbols/{spec}")
def get_symbols(spec: str) -> JSONResponse:
    """Symbol table for one library. `spec` is `Name@Version` or a bare
    `Name` (which resolves to the newest cached version). Names and versions
    are normalized with the same rules the cache uses, so `Adafruit GFX
    Library@1.12.6` and `adafruitgfxlibrary@1.12.6` hit the same entry."""
    name, version = parse_spec(spec)
    root = _cache_root()
    if not root.is_dir():
        raise HTTPException(status_code=404, detail=f"library cache not available at {root}")
    entry = find_cache_entry(root, name, version)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"library not found in cache: {spec}")

    sym_file = root / ".symbols" / f"{entry.name}.json"
    if sym_file.is_file():
        try:
            cached = json.loads(sym_file.read_text(encoding="utf-8"))
            return JSONResponse(content=cached, headers=_CACHE_HEADERS)
        except (OSError, ValueError):
            pass  # corrupt/unreadable cache file -> rescan below

    payload = scan_library(entry)
    _write_symbol_cache(sym_file, payload)
    return JSONResponse(content=payload, headers=_CACHE_HEADERS)
