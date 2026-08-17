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
import re
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app.services.symbol_extract import (
    _entry_version_key,
    find_cache_entry,
    norm_name,
    parse_spec,
    scan_library,
)

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


def _payload_for(root: Path, entry: Path) -> dict:
    """Cached scan of one entry (same disk cache get_symbols uses)."""
    sym_file = root / ".symbols" / f"{entry.name}.json"
    if sym_file.is_file():
        try:
            return json.loads(sym_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    payload = scan_library(entry)
    _write_symbol_cache(sym_file, payload)
    return payload


_TYPE_INDEX_NAME = "_types.json"
_TYPE_INDEX_MAX_AGE_S = 6 * 3600


def _type_index(root: Path) -> dict[str, str]:
    """owner-class name -> cache entry dir name, over the whole library
    cache. Built by scanning every entry once (each scan is itself disk-
    cached), persisted under .symbols/_types.json and rebuilt when older than
    a few hours or when the cache has grown. When two entries declare the
    same class (a library and its fork, or two versions), the newest entry
    for the alphabetically-first library wins -- deterministic and, for the
    common case of one library per class, irrelevant."""
    idx_file = root / ".symbols" / _TYPE_INDEX_NAME
    entries = sorted(
        d.name for d in root.iterdir() if d.is_dir() and not d.name.startswith(".")
    )
    if idx_file.is_file():
        try:
            cached = json.loads(idx_file.read_text(encoding="utf-8"))
            fresh = (time.time() - idx_file.stat().st_mtime) < _TYPE_INDEX_MAX_AGE_S
            if fresh and cached.get("entry_count") == len(entries):
                return cached["types"]
        except (OSError, ValueError, KeyError):
            pass

    # Many classes are declared by more than one cached library: the real
    # one plus forks and bundles that vendor a copy (PubSubClient ships inside
    # "ESP8266 Microgear", NTPClient inside "ESP8266 Weather Station",
    # AccelStepper inside "Arduino Learning Board"). Pick, per class:
    #   1. the library whose normalized name equals the class name, else
    #   2. the library declaring the MOST members of that class (the
    #      canonical copy is the complete one; vendored copies are trimmed),
    #   3. ties: alphabetical, deterministic.
    best: dict[str, tuple[int, int, str]] = {}  # owner -> (name_match, member_count, entry) with a sortable key
    by_name: dict[str, list[Path]] = {}
    for name in entries:
        by_name.setdefault(name.partition("@")[0], []).append(root / name)
    for lib_name in sorted(by_name):
        newest = sorted(by_name[lib_name], key=_entry_version_key, reverse=True)[0]
        try:
            payload = _payload_for(root, newest)
        except Exception as e:  # noqa: BLE001 - one bad library must not kill the index
            logger.warning("[intellisense] type index: skipping %s: %s", newest.name, e)
            continue
        counts: dict[str, int] = {}
        for sym in payload.get("symbols", []):
            owner = sym.get("owner")
            if owner:
                counts[owner] = counts.get(owner, 0) + 1
        for owner, n in counts.items():
            name_match = 1 if norm_name(owner) == lib_name else 0
            candidate = (name_match, n, newest.name)
            cur = best.get(owner)
            # higher name_match, then higher count, then (already alphabetical
            # by iteration order) keep the first
            if cur is None or (candidate[0], candidate[1]) > (cur[0], cur[1]):
                best[owner] = candidate
    types = {owner: entry for owner, (_, _, entry) in best.items()}
    _write_symbol_cache(idx_file, {"entry_count": len(entries), "types": types})
    return types


@router.get("/type/{name}")
def get_type_members(name: str) -> JSONResponse:
    """Members of one class/struct, whichever cached library declares it.

    This is the long-tail path that is safe for completion quality: the
    engine calls it only after tree-sitter has resolved a receiver to a
    declared type that the embedded catalog does not know (`PubSubClient
    client(espClient); client.` -> PubSubClient), and it returns ONLY that
    type's members -- never a library's module-level constants or macros,
    which are what made feeding whole library sets into the candidate pool
    measurably worse. Payload shape matches /symbols/ so the engine's
    RemoteSymbolCache can store it unchanged."""
    root = _cache_root()
    if not root.is_dir():
        raise HTTPException(status_code=404, detail=f"library cache not available at {root}")
    if not re.fullmatch(r"[A-Za-z_]\w{0,80}", name):
        raise HTTPException(status_code=400, detail="not a type name")
    entry_name = _type_index(root).get(name)
    if entry_name is None:
        raise HTTPException(status_code=404, detail=f"no cached library declares {name}")
    entry = root / entry_name
    if not entry.is_dir():
        raise HTTPException(status_code=404, detail=f"stale type index for {name}")
    payload = _payload_for(root, entry)
    members = [s for s in payload.get("symbols", []) if s.get("owner") == name]
    return JSONResponse(
        content={
            "id": payload.get("id") or entry_name,
            "triggers": payload.get("triggers", []),
            "type": name,
            "symbols": members,
        },
        headers=_CACHE_HEADERS,
    )


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

    return JSONResponse(content=_payload_for(root, entry), headers=_CACHE_HEADERS)
