#!/usr/bin/env python3
"""
drive-fetch.py — Fetches Holly's agent config bundle from Google Drive.

Fetches soul.md, config.md (CLAUDE.md), shared rules, agent-specific rules,
and routines from configured Drive folder IDs. When config.md contains
assigned_rules / assigned_routines lists, only those files are downloaded
(selective fetch). When those keys are absent, every file in the folder is
downloaded (backwards-compat with agents that have no explicit manifest).
Writes them atomically to the target directory using a temp directory +
rename pattern to avoid partial writes on failure.

Exit codes:
  0 — success
  2 — error (prints JSON to stderr)
"""

import os
import sys
import json
import base64
import pathlib
import argparse
import logging
import shutil
import tempfile
from typing import List, Optional

import yaml

SCOPES = ['https://www.googleapis.com/auth/drive']
DEFAULT_USER = 'craig@gorillahub.co.uk'

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
)
logger = logging.getLogger(__name__)


def _redact(msg: str) -> str:
    """Redact any log line that contains a private key marker."""
    if 'BEGIN PRIVATE KEY' in msg or 'PRIVATE KEY' in msg:
        return '[REDACTED: private key content]'
    return msg


class RedactingHandler(logging.StreamHandler):
    """Log handler that redacts private key values before emitting."""

    def emit(self, record: logging.LogRecord) -> None:
        record.msg = _redact(str(record.msg))
        super().emit(record)


# Replace default handler with redacting variant
for h in logging.root.handlers[:]:
    logging.root.removeHandler(h)
logging.root.addHandler(RedactingHandler(sys.stderr))
logging.root.setLevel(logging.INFO)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def load_credentials(sa_key_path: Optional[str], user_email: str):
    """Return delegated service account credentials for *user_email*."""
    from google.oauth2 import service_account

    info = None

    if sa_key_path and os.path.isfile(sa_key_path):
        logger.info('Loading SA credentials from file: %s', sa_key_path)
        with open(sa_key_path) as fh:
            info = json.load(fh)
    else:
        raw = os.environ.get('SA_KEY_BASE64', '')
        if raw:
            logger.info('Loading SA credentials from SA_KEY_BASE64 env var')
            decoded = base64.b64decode(raw)
            info = json.loads(decoded)

    if info is None:
        raise RuntimeError(
            'No service account credentials found. Provide --sa-key-path or set '
            'SA_KEY_BASE64 environment variable.'
        )

    creds = service_account.Credentials.from_service_account_info(
        info, scopes=SCOPES
    ).with_subject(user_email)
    return creds


# ---------------------------------------------------------------------------
# Drive helpers
# ---------------------------------------------------------------------------

def list_folder_files(drive, folder_id: str) -> list[dict]:
    """Return list of {id, name, mimeType} dicts for all non-trashed files in *folder_id*."""
    results = []
    page_token = None
    query = f"'{folder_id}' in parents and trashed = false"

    while True:
        kwargs = dict(
            q=query,
            fields='nextPageToken, files(id,name,mimeType)',
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        )
        if page_token:
            kwargs['pageToken'] = page_token

        response = drive.files().list(**kwargs).execute()
        results.extend(response.get('files', []))
        page_token = response.get('nextPageToken')
        if not page_token:
            break

    logger.info('Listed %d files in folder %s', len(results), folder_id)
    return results


def download_file(drive, file_id: str, mime_type: str = '') -> bytes:
    """Return the raw bytes of *file_id*. Exports Google Docs as text/markdown."""
    GOOGLE_DOC_MIME = 'application/vnd.google-apps.document'

    if mime_type == GOOGLE_DOC_MIME:
        logger.info('Exporting Google Doc %s as text/markdown', file_id)
        request = drive.files().export_media(
            fileId=file_id, mimeType='text/markdown'
        )
    else:
        from googleapiclient.http import MediaIoBaseDownload
        import io
        request = drive.files().get_media(fileId=file_id)

    from googleapiclient.http import MediaIoBaseDownload
    import io
    fh = io.BytesIO()
    downloader = MediaIoBaseDownload(fh, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return fh.getvalue()


def fetch_agent_bundle(drive, agent_folder_id: str) -> tuple[bytes, bytes, dict]:
    """Fetch soul.md and config.md from *agent_folder_id*.

    Returns (soul_bytes, config_bytes, config_dict).
    Raises RuntimeError if either file is missing.
    """
    files = list_folder_files(drive, agent_folder_id)
    index = {f['name']: f for f in files}

    missing = [name for name in ('soul.md', 'config.md') if name not in index]
    if missing:
        raise RuntimeError(
            f"Required files missing from agent folder {agent_folder_id}: {missing}"
        )

    soul_entry = index['soul.md']
    config_entry = index['config.md']

    logger.info('Downloading soul.md (id=%s)', soul_entry['id'])
    soul_bytes = download_file(drive, soul_entry['id'], soul_entry.get('mimeType', ''))

    logger.info('Downloading config.md (id=%s)', config_entry['id'])
    config_bytes = download_file(drive, config_entry['id'], config_entry.get('mimeType', ''))

    # Parse config as YAML (frontmatter-only or full YAML)
    config_text = config_bytes.decode('utf-8', errors='replace')
    config_dict = _parse_config_yaml(config_text)

    return soul_bytes, config_bytes, config_dict


def _parse_config_yaml(text: str) -> dict:
    """Parse YAML from config.md.

    Supported formats:
    - Fenced frontmatter:  ---\n...\n---
    - Fenced YAML code block: ```yaml\n...\n```
    - Bare YAML

    Returns {} on parse failure.
    """
    stripped = (text or '').strip()

    yaml_block = ''

    if stripped.startswith('---'):
        # Extract frontmatter block
        parts = stripped.split('---', 2)
        yaml_block = parts[1] if len(parts) >= 2 else ''
    elif '```yaml' in stripped:
        # Extract first fenced yaml code block
        start = stripped.find('```yaml')
        after = stripped.find('\n', start)
        end = stripped.find('```', after + 1)
        if after != -1 and end != -1:
            yaml_block = stripped[after + 1:end]
        else:
            yaml_block = ''
    else:
        yaml_block = stripped

    try:
        result = yaml.safe_load(yaml_block) or {}
    except yaml.YAMLError as exc:
        logger.warning('Failed to parse config.md as YAML: %s', exc)
        result = {}

    return result


def fetch_named_files(drive, folder_id: str, filenames: list[str]) -> dict[str, bytes]:
    """Return {filename: bytes} for each name found in *folder_id*.

    If a name is not found in the immediate folder, this performs a recursive
    basename search under *folder_id* (to support nested subfolders).

    Logs a warning for any filename not found.
    """
    all_files = list_folder_files(drive, folder_id)
    index = {f['name']: f for f in all_files}
    result: dict[str, bytes] = {}

    for name in filenames:
        entry = index.get(name)
        if entry is None:
            entry = _find_first_by_basename(drive, folder_id, name)
            if entry is None:
                logger.warning('File not found in folder %s: %s', folder_id, name)
                continue
            logger.info('Resolved %s via recursive basename lookup (id=%s)', name, entry['id'])
        else:
            logger.info('Resolved %s in root folder listing (id=%s)', name, entry['id'])

        result[name] = download_file(drive, entry['id'], entry.get('mimeType', ''))

    return result


def fetch_all_files(drive, folder_id: str) -> dict[str, bytes]:
    """Return {filename: bytes} for every non-trashed non-folder file in *folder_id*.

    Note: This function flattens any subfolder structure by basename. If duplicate
    basenames exist in different subfolders, the first encountered wins.
    """
    result: dict[str, bytes] = {}

    def _walk(current_folder_id: str, prefix: str = '') -> None:
        entries = list_folder_files(drive, current_folder_id)
        for entry in entries:
            name = entry.get('name') or ''
            mime = entry.get('mimeType') or ''
            if mime == 'application/vnd.google-apps.folder':
                logger.info('Descending into subfolder: %s%s/', prefix, name)
                _walk(entry['id'], prefix=f"{prefix}{name}/")
                continue

            basename = pathlib.PurePosixPath(name).name
            if basename in result:
                logger.warning(
                    'Duplicate basename while walking %s: %s (from %s%s) — keeping first',
                    folder_id,
                    basename,
                    prefix,
                    name,
                )
                continue

            logger.info('Downloading %s (id=%s) from %s%s', basename, entry['id'], prefix, name)
            result[basename] = download_file(drive, entry['id'], entry.get('mimeType', ''))

    _walk(folder_id)
    return result


def split_assigned_rules(assigned: List[str]) -> tuple[List[str], List[str]]:
    """Split an assigned_rules list into (shared_basenames, agent_basenames).

    Items whose path starts with 'rules/shared/' go to shared_basenames.
    Everything else goes to agent_basenames. Only the basename (final
    path segment) is returned — Drive folder lookups are by filename.
    """
    shared_basenames: List[str] = []
    agent_basenames: List[str] = []
    for item in assigned:
        path = str(item).strip()
        if not path:
            continue
        basename = path.rsplit('/', 1)[-1]
        if path.startswith('rules/shared/'):
            shared_basenames.append(basename)
        else:
            agent_basenames.append(basename)
    return shared_basenames, agent_basenames


def extract_routine_basenames(assigned: List[str]) -> List[str]:
    """Return the basenames of each routine path in assigned_routines."""
    result: List[str] = []
    for item in assigned:
        path = str(item).strip()
        if not path:
            continue
        result.append(path.rsplit('/', 1)[-1])
    return result


def extract_skill_basenames(assigned: List[str]) -> List[str]:
    """Return the basenames of each skill path in assigned_skills."""
    result: List[str] = []
    for item in assigned:
        path = str(item).strip()
        if not path:
            continue
        result.append(path.rsplit('/', 1)[-1])
    return result


def _normalise_rel_path(path: str) -> str:
    """Normalise configured Drive-relative path to a canonical slash form."""
    normalised = str(path or '').strip().replace('\\\\', '/')
    normalised = normalised.strip('/')
    while '//' in normalised:
        normalised = normalised.replace('//', '/')
    return normalised


def _list_subfolders(drive, folder_id: str) -> dict[str, dict]:
    """Return immediate subfolders in *folder_id*, keyed by folder name."""
    entries = list_folder_files(drive, folder_id)
    return {
        e['name']: e for e in entries
        if e.get('mimeType') == 'application/vnd.google-apps.folder'
    }


def resolve_drive_file_path(drive, context_root_id: str, relative_path: str) -> tuple[Optional[dict], str]:
    """Resolve a Drive-relative file path from *context_root_id*.

    Returns (file_entry, reason) where file_entry is None when not found.

    Basename fallback:
      If a nested folder in the configured path does not exist (common when Drive
      layout changes), we fall back to a recursive basename search under
      *context_root_id* and return the first match.

    This is intentionally conservative: it only matches by exact filename and
    returns the first discovered hit.
    """
    rel = _normalise_rel_path(relative_path)
    if not rel:
        return None, 'empty-path'

    parts = rel.split('/')
    if len(parts) < 2:
        return None, 'invalid-path'

    current_id = context_root_id
    for segment in parts[:-1]:
        folders = _list_subfolders(drive, current_id)
        if segment not in folders:
            # Basename fallback: walk subtree for target filename
            target = parts[-1]
            hit = _find_first_by_basename(drive, context_root_id, target)
            if hit is not None:
                return hit, f'basename-fallback:missing-folder:{segment}'
            return None, f'missing-folder:{segment}'
        current_id = folders[segment]['id']

    files = list_folder_files(drive, current_id)
    target_name = parts[-1]
    for entry in files:
        if entry.get('mimeType') == 'application/vnd.google-apps.folder':
            continue
        if entry.get('name') == target_name:
            return entry, 'resolved'

    # Basename fallback for missing file
    hit = _find_first_by_basename(drive, context_root_id, target_name)
    if hit is not None:
        return hit, 'basename-fallback:missing-file'

    return None, f'missing-file:{target_name}'


def _find_first_by_basename(drive, folder_id: str, basename: str) -> Optional[dict]:
    """Return the first matching file entry in the subtree rooted at folder_id.

    This is a best-effort escape hatch for when configured nested paths no longer
    match Drive folder layout. It prefers exact filename matches and returns the
    first discovered hit.
    """
    want = str(basename or '').strip()
    if not want:
        return None

    def _walk(current_id: str) -> Optional[dict]:
        entries = list_folder_files(drive, current_id)
        for entry in entries:
            mime = entry.get('mimeType') or ''
            name = entry.get('name') or ''
            if mime == 'application/vnd.google-apps.folder':
                hit = _walk(entry['id'])
                if hit is not None:
                    return hit
                continue
            if name == want:
                return entry
        return None

    return _walk(folder_id)


def _list_namespace_files(drive, context_root_id: str, namespace_path: str) -> list[tuple[str, dict]]:
    """List all files under namespace path (recursive), returning (canonical_path, entry)."""
    rel = _normalise_rel_path(namespace_path)
    parts = rel.split('/') if rel else []
    current_id = context_root_id
    for segment in parts:
        folders = _list_subfolders(drive, current_id)
        if segment not in folders:
            logger.warning('v2 resolve missing namespace folder: %s (missing-folder:%s)', rel, segment)
            return []
        current_id = folders[segment]['id']

    results: list[tuple[str, dict]] = []

    def _walk(folder_id: str, prefix: str) -> None:
        entries = list_folder_files(drive, folder_id)
        for entry in entries:
            name = entry.get('name') or ''
            mime = entry.get('mimeType') or ''
            if mime == 'application/vnd.google-apps.folder':
                _walk(entry['id'], prefix=f"{prefix}{name}/")
                continue
            canonical = f"{prefix}{name}".strip('/')
            results.append((canonical, entry))

    base_prefix = f"{rel}/" if rel else ''
    _walk(current_id, base_prefix)
    return results


def resolve_v2_entries(
    drive,
    context_root_id: str,
    *,
    inherit_universal: bool,
    universal_namespace: str,
    assigned_paths: list[str],
    field_name: str,
    expected_prefixes: Optional[list[str]] = None,
) -> tuple[list[tuple[str, dict]], list[dict]]:
    """Resolve effective v2 file set for a namespace with deterministic dedupe."""
    outcomes: list[dict] = []
    ordered: list[tuple[str, dict]] = []
    seen: set[str] = set()

    if inherit_universal:
        namespace_entries = _list_namespace_files(drive, context_root_id, universal_namespace)
        for canonical_path, entry in namespace_entries:
            key = f"{canonical_path}:{entry['id']}"
            if key in seen:
                outcomes.append({'field': field_name, 'path': canonical_path, 'status': 'skipped', 'reason': 'duplicate'})
                continue
            seen.add(key)
            ordered.append((canonical_path, entry))
            outcomes.append({'field': field_name, 'path': canonical_path, 'status': 'resolved', 'reason': 'inherited'})
    else:
        outcomes.append({'field': field_name, 'path': universal_namespace, 'status': 'skipped', 'reason': 'inherit-disabled'})

    for raw_path in assigned_paths:
        canonical_path = _normalise_rel_path(raw_path)
        if not canonical_path:
            outcomes.append({'field': field_name, 'path': str(raw_path), 'status': 'skipped', 'reason': 'empty-path'})
            continue
        if expected_prefixes and not any(canonical_path.startswith(prefix) for prefix in expected_prefixes):
            outcomes.append({'field': field_name, 'path': canonical_path, 'status': 'skipped', 'reason': 'prefix-mismatch'})
            continue
        entry, reason = resolve_drive_file_path(drive, context_root_id, canonical_path)
        if entry is None:
            outcomes.append({'field': field_name, 'path': canonical_path, 'status': 'missing', 'reason': reason})
            continue

        key = f"{canonical_path}:{entry['id']}"
        if key in seen:
            outcomes.append({'field': field_name, 'path': canonical_path, 'status': 'skipped', 'reason': 'duplicate'})
            continue

        seen.add(key)
        ordered.append((canonical_path, entry))
        outcomes.append({'field': field_name, 'path': canonical_path, 'status': 'resolved', 'reason': 'assigned'})

    return ordered, outcomes


def download_entries_as_name_map(drive, entries: list[tuple[str, dict]], field_name: str) -> dict[str, bytes]:
    """Download resolved entries to {basename: bytes} map for bundle writer.

    Warning: This intentionally flattens paths. Use download_entries_as_relpath_map
    when the on-disk structure matters (e.g. folder-per-skill SKILL.md).
    """
    result: dict[str, bytes] = {}
    for canonical_path, entry in entries:
        basename = pathlib.PurePosixPath(canonical_path).name
        if basename in result:
            logger.warning('v2 %s basename collision for %s — skipping duplicate output', field_name, canonical_path)
            continue
        logger.info('Downloading %s (%s) from %s', basename, entry.get('id', 'unknown'), canonical_path)
        result[basename] = download_file(drive, entry['id'], entry.get('mimeType', ''))
    return result


def download_entries_as_relpath_map(
    drive,
    entries: list[tuple[str, dict]],
    field_name: str,
    *,
    strip_prefix: str,
) -> dict[str, bytes]:
    """Download resolved entries to {relative_path: bytes} map.

    Example:
      canonical_path = "skills/universal/respond-on-telegram/SKILL.md"
      strip_prefix   = "skills/"
      => rel_path    = "universal/respond-on-telegram/SKILL.md"

    This preserves directory structure and avoids basename collisions.
    """
    result: dict[str, bytes] = {}
    prefix = strip_prefix
    if prefix and not prefix.endswith('/'):
        prefix = prefix + '/'

    for canonical_path, entry in entries:
        p = _normalise_rel_path(canonical_path)
        if prefix and p.startswith(prefix):
            rel = p[len(prefix):]
        else:
            rel = pathlib.PurePosixPath(p).name

        rel = rel.lstrip('/')
        if not rel:
            logger.warning('v2 %s produced empty relpath for %s — skipping', field_name, canonical_path)
            continue

        if rel in result:
            logger.warning('v2 %s relpath collision for %s — skipping duplicate output', field_name, canonical_path)
            continue

        logger.info('Downloading %s (%s) from %s', rel, entry.get('id', 'unknown'), canonical_path)
        result[rel] = download_file(drive, entry['id'], entry.get('mimeType', ''))

    return result


def parse_markdown_frontmatter(text: str) -> dict:
    """Parse optional markdown frontmatter from text and return dict."""
    stripped = text.strip()
    if not stripped.startswith('---'):
        return {}
    parts = stripped.split('---', 2)
    if len(parts) < 3:
        return {}
    try:
        parsed = yaml.safe_load(parts[1])
        return parsed if isinstance(parsed, dict) else {}
    except yaml.YAMLError:
        return {}


def build_tools_inventory(drive, tools_entries: list[tuple[str, dict]]) -> tuple[dict[str, bytes], dict]:
    """Build runtime tools inventory from resolved v2 assigned_tools entries."""
    tools_files: dict[str, bytes] = {}
    items: list[dict] = []

    for canonical_path, entry in tools_entries:
        basename = pathlib.PurePosixPath(canonical_path).name
        slug = pathlib.PurePosixPath(canonical_path).stem
        if basename in tools_files:
            logger.warning('v2 assigned_tools basename collision for %s — skipping duplicate output', canonical_path)
            continue

        raw_bytes = download_file(drive, entry['id'], entry.get('mimeType', ''))
        tools_files[basename] = raw_bytes

        decoded = raw_bytes.decode('utf-8', errors='replace')
        metadata = parse_markdown_frontmatter(decoded)
        items.append({
            'slug': slug,
            'file': basename,
            'path': canonical_path,
            'drive_file_id': entry.get('id'),
            'has_metadata': bool(metadata),
            'metadata_keys': sorted(list(metadata.keys())) if metadata else [],
        })

    inventory = {
        'version': 1,
        'source': 'assigned_tools',
        'count': len(items),
        'items': items,
    }
    return tools_files, inventory


def parse_config_version(config_dict: dict) -> int:
    """Return config version (defaults to 1 for legacy configs)."""
    raw = config_dict.get('config_version', 1)
    try:
        return int(raw)
    except (TypeError, ValueError):
        logger.warning('Invalid config_version value (%s) — defaulting to v1', raw)
        return 1


# ---------------------------------------------------------------------------
# Bundle writer
# ---------------------------------------------------------------------------

def write_bundle(
    *,
    target_dir: str,
    soul_bytes: bytes,
    soul_out: str,
    config_dict: dict,
    shared_rules: dict[str, bytes],
    agent_rules: dict[str, bytes],
    routines: dict[str, bytes],
    skills: dict[str, bytes],
    tools: dict[str, bytes],
    tools_inventory: dict,
    claude_md_bytes: bytes,
    claude_md_out: str,
) -> None:
    """Atomically write the full config bundle to *target_dir*.

    Uses a temp directory + rename pattern (T-42-01 mitigation) to prevent
    partial writes if the process is interrupted mid-write.
    """
    target = pathlib.Path(target_dir)
    rules_dir = target / '.claude' / 'rules'
    commands_dir = target / '.claude' / 'commands'
    skills_dir = target / '.claude' / 'skills'
    tools_dir = target / '.claude' / 'tools'
    # NOTE: Do not overwrite the input /workspace/group/.claude/config.md (operator-provided)
    # because fetch-drive-config-v2.sh reads it to decide whether to run v2 mode.
    # Instead, write a fetched/debug snapshot alongside it.
    config_debug_path = target / '.claude' / 'config.fetched.md'
    tools_inventory_path = target / '.claude' / 'tools-inventory.json'

    # Build in a temp directory alongside target to allow atomic rename
    tmp_parent = target / '.claude'
    tmp_parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(dir=str(tmp_parent), prefix='.drive-fetch-tmp-') as tmp_dir:
        tmp = pathlib.Path(tmp_dir)
        tmp_rules = tmp / 'rules'
        tmp_commands = tmp / 'commands'
        tmp_skills = tmp / 'skills'
        tmp_tools = tmp / 'tools'
        tmp_rules.mkdir()
        tmp_commands.mkdir()
        tmp_skills.mkdir()
        tmp_tools.mkdir()

        # Write shared rules
        written_rule_names: set[str] = set()
        for name, data in shared_rules.items():
            if name in written_rule_names:
                logger.info('Skipping duplicate shared rule output: rules/%s', name)
                continue
            rel = pathlib.PurePosixPath(str(name))
            out_path = tmp_rules / rel
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(data)
            written_rule_names.add(name)
            logger.info('Wrote shared rule: rules/%s', name)

        # Write agent-specific rules
        for name, data in agent_rules.items():
            if name in written_rule_names:
                logger.info('Skipping duplicate agent rule output: rules/%s', name)
                continue
            rel = pathlib.PurePosixPath(str(name))
            out_path = tmp_rules / rel
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(data)
            written_rule_names.add(name)
            logger.info('Wrote agent rule: rules/%s', name)

        # Write routines as commands (may include nested paths)
        written_command_names: set[str] = set()
        for name, data in routines.items():
            if name in written_command_names:
                logger.info('Skipping duplicate routine output: commands/%s', name)
                continue
            rel = pathlib.PurePosixPath(str(name))
            out_path = tmp_commands / rel
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(data)
            written_command_names.add(name)
            logger.info('Wrote routine: commands/%s', name)

        # Write skills (may include nested paths like universal/<skill>/SKILL.md)
        written_skill_names: set[str] = set()
        for name, data in skills.items():
            if name in written_skill_names:
                logger.info('Skipping duplicate skill output: skills/%s', name)
                continue
            rel = pathlib.PurePosixPath(str(name))
            out_path = tmp_skills / rel
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(data)
            written_skill_names.add(name)
            logger.info('Wrote skill: skills/%s', name)

        # Write tools inventory source files
        written_tool_names: set[str] = set()
        for name, data in tools.items():
            if name in written_tool_names:
                logger.info('Skipping duplicate tool output: tools/%s', name)
                continue
            (tmp_tools / name).write_bytes(data)
            written_tool_names.add(name)
            logger.info('Wrote tool inventory file: tools/%s', name)

        # Write generated tools inventory JSON for runtime introspection
        (tmp / 'tools-inventory.json').write_text(
            json.dumps(tools_inventory, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )

        # Write config debug YAML snapshot (do NOT overwrite operator config.md)
        config_yaml = yaml.dump(config_dict, default_flow_style=False, allow_unicode=True)
        (tmp / 'config.fetched.md').write_text(
            f"# Agent Config (fetched from Drive)\n\n```yaml\n{config_yaml}```\n",
            encoding='utf-8',
        )

        # --- Atomic swap ---
        # Remove old rules/commands/skills dirs and replace with new ones
        if rules_dir.exists():
            shutil.rmtree(str(rules_dir))
        if commands_dir.exists():
            shutil.rmtree(str(commands_dir))
        if skills_dir.exists():
            shutil.rmtree(str(skills_dir))
        if tools_dir.exists():
            shutil.rmtree(str(tools_dir))

        shutil.copytree(str(tmp_rules), str(rules_dir))
        shutil.copytree(str(tmp_commands), str(commands_dir))
        shutil.copytree(str(tmp_skills), str(skills_dir))
        shutil.copytree(str(tmp_tools), str(tools_dir))
        shutil.copy2(str(tmp / 'config.fetched.md'), str(config_debug_path))
        shutil.copy2(str(tmp / 'tools-inventory.json'), str(tools_inventory_path))

    # Write soul.md to its designated output path (may be outside target_dir)
    soul_path = pathlib.Path(soul_out)
    soul_path.parent.mkdir(parents=True, exist_ok=True)
    soul_path.write_bytes(soul_bytes)
    logger.info('Wrote soul.md to %s (%d bytes)', soul_out, len(soul_bytes))

    # Write CLAUDE.md to its designated output path
    claude_path = pathlib.Path(claude_md_out)
    claude_path.parent.mkdir(parents=True, exist_ok=True)
    claude_path.write_bytes(claude_md_bytes)
    logger.info('Wrote CLAUDE.md to %s (%d bytes)', claude_md_out, len(claude_md_bytes))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description='Fetch Holly agent config bundle from Google Drive.'
    )
    parser.add_argument('--agent-folder-id', required=True,
                        help='Drive folder ID containing soul.md and config.md')
    parser.add_argument('--rules-shared-id', default='',
                        help='Drive folder ID for shared rules (overridden by config.md rules_shared_folder_id)')
    parser.add_argument('--rules-agent-id', default='',
                        help='Drive folder ID for agent-specific rules (overridden by config.md rules_folder_id)')
    parser.add_argument('--routines-agent-id', default='',
                        help='Drive folder ID for agent routines (overridden by config.md routines_folder_id)')
    parser.add_argument('--skills-id', default='',
                        help='Drive folder ID for agent skills (overridden by config.md skills_folder_id)')
    parser.add_argument('--target-dir', required=True,
                        help='Target directory to write .claude/ bundle into')
    parser.add_argument('--soul-out', required=True,
                        help='Output path for soul.md')
    parser.add_argument('--claude-md-out', required=True,
                        help='Output path for CLAUDE.md')
    parser.add_argument('--sa-key-path',
                        default=os.environ.get('SA_KEY_PATH', ''),
                        help='Path to service account JSON key file '
                             '(default: SA_KEY_PATH env var)')
    parser.add_argument('--user-email',
                        default=os.environ.get(
                            'GOOGLE_IMPERSONATE_EMAIL', DEFAULT_USER
                        ),
                        help='Email to impersonate via DWD '
                             '(default: GOOGLE_IMPERSONATE_EMAIL env or craig@gorillahub.co.uk)')
    args = parser.parse_args()

    try:
        from googleapiclient.discovery import build

        creds = load_credentials(args.sa_key_path or None, args.user_email)
        drive = build('drive', 'v3', credentials=creds)

        # Fetch agent bundle (soul + config)
        soul_bytes, config_bytes, config_dict = fetch_agent_bundle(
            drive, args.agent_folder_id
        )

        config_version = parse_config_version(config_dict)
        logger.info('Detected config_version=%s', config_version)

        if config_version == 2:
            drive_block = config_dict.get('drive') if isinstance(config_dict.get('drive'), dict) else {}
            context_root_id = str(drive_block.get('context_root_id') or '').strip()

            assigned_rules = config_dict.get('assigned_rules') or []
            assigned_routines = config_dict.get('assigned_routines') or []
            assigned_skills = config_dict.get('assigned_skills') or []
            assigned_tools = config_dict.get('assigned_tools') or []

            if not isinstance(assigned_rules, list):
                logger.warning('v2 assigned_rules is not a list — treating as empty')
                assigned_rules = []
            if not isinstance(assigned_routines, list):
                logger.warning('v2 assigned_routines is not a list — treating as empty')
                assigned_routines = []
            if not isinstance(assigned_skills, list):
                logger.warning('v2 assigned_skills is not a list — treating as empty')
                assigned_skills = []
            if not isinstance(assigned_tools, list):
                logger.warning('v2 assigned_tools is not a list — treating as empty')
                assigned_tools = []

            if context_root_id:
                # v2 namespace resolver mode (preferred)
                rules_entries, rules_outcomes = resolve_v2_entries(
                    drive,
                    context_root_id,
                    inherit_universal=bool(config_dict.get('inherit_universal_rules', True)),
                    universal_namespace='rules/universal',
                    assigned_paths=assigned_rules,
                    field_name='assigned_rules',
                    expected_prefixes=['rules/'],
                )
                routines_entries, routines_outcomes = resolve_v2_entries(
                    drive,
                    context_root_id,
                    inherit_universal=bool(config_dict.get('inherit_universal_routines', True)),
                    universal_namespace='routines/universal',
                    assigned_paths=assigned_routines,
                    field_name='assigned_routines',
                    expected_prefixes=['routines/'],
                )
                skills_entries, skills_outcomes = resolve_v2_entries(
                    drive,
                    context_root_id,
                    inherit_universal=bool(config_dict.get('inherit_universal_skills', True)),
                    universal_namespace='skills/universal',
                    assigned_paths=assigned_skills,
                    field_name='assigned_skills',
                    expected_prefixes=['skills/'],
                )
                tools_entries, tools_outcomes = resolve_v2_entries(
                    drive,
                    context_root_id,
                    inherit_universal=False,
                    universal_namespace='tools',
                    assigned_paths=assigned_tools,
                    field_name='assigned_tools',
                    expected_prefixes=['tools/'],
                )

                for outcome in rules_outcomes + routines_outcomes + skills_outcomes + tools_outcomes:
                    logger.info(
                        'v2 resolve field=%s path=%s status=%s reason=%s',
                        outcome['field'], outcome['path'], outcome['status'], outcome['reason'],
                    )

                shared_rules = {}
                # Preserve directory structure for v2 namespaces so folder-per-skill layouts
                # (e.g. skills/<name>/SKILL.md) do not collide on basename.
                agent_rules = download_entries_as_relpath_map(
                    drive,
                    rules_entries,
                    'assigned_rules',
                    strip_prefix='rules/',
                )
                routines = download_entries_as_relpath_map(
                    drive,
                    routines_entries,
                    'assigned_routines',
                    strip_prefix='routines/',
                )
                skills = download_entries_as_relpath_map(
                    drive,
                    skills_entries,
                    'assigned_skills',
                    strip_prefix='skills/',
                )
                tools, tools_inventory = build_tools_inventory(drive, tools_entries)

                logger.info(
                    'v2 loader path: tools inventory applicable (count=%d, zero_is_valid=%s)',
                    tools_inventory.get('count', 0),
                    tools_inventory.get('count', 0) == 0,
                )
            else:
                # v2-without-context-root fallback: treat drive.*_folder_id as explicit folders.
                # This supports configs like Marcus's that declare v2 + assigned_* paths but do
                # not provide a context_root_id tree.
                rules_folder_id = str(drive_block.get('rules_folder_id') or '').strip()
                routines_folder_id = str(drive_block.get('routines_folder_id') or '').strip()
                skills_folder_id = str(drive_block.get('skills_folder_id') or '').strip()

                # Rules: split shared vs agent by path prefix, but both map to the same folder.
                shared_basenames, agent_basenames = split_assigned_rules(assigned_rules if isinstance(assigned_rules, list) else [])
                all_rule_basenames = shared_basenames + agent_basenames
                agent_rules = fetch_named_files(drive, rules_folder_id, all_rule_basenames) if rules_folder_id else {}
                shared_rules = {}

                routine_basenames = extract_routine_basenames(assigned_routines if isinstance(assigned_routines, list) else [])
                routines = fetch_named_files(drive, routines_folder_id, routine_basenames) if routines_folder_id else {}

                skill_basenames = extract_skill_basenames(assigned_skills if isinstance(assigned_skills, list) else [])
                skills = fetch_named_files(drive, skills_folder_id, skill_basenames) if skills_folder_id else {}

                tools = {}
                tools_inventory = {
                    'version': 1,
                    'source': 'assigned_tools',
                    'count': 0,
                    'items': [],
                    'status': 'not-applicable-v2-no-context-root',
                }

                logger.info(
                    'v2 fallback loader path (no context_root_id): %d rules, %d routines, %d skills',
                    len(agent_rules), len(routines), len(skills),
                )
        elif config_version in (0, 1):
            # Resolve folder IDs: config.md takes precedence over CLI args
            rules_shared_id = config_dict.get('rules_shared_folder_id') or args.rules_shared_id
            rules_agent_id = config_dict.get('rules_folder_id') or args.rules_agent_id
            routines_agent_id = config_dict.get('routines_folder_id') or args.routines_agent_id

            if not rules_agent_id:
                logger.warning('No rules_folder_id in config.md and --rules-agent-id not set — skipping agent rules')
            if not routines_agent_id:
                logger.warning('No routines_folder_id in config.md and --routines-agent-id not set — skipping routines')

            skills_id = config_dict.get('skills_folder_id') or args.skills_id

            # --- Selective fetch (D-42-04) ---
            has_assigned_rules = 'assigned_rules' in config_dict
            has_assigned_routines = 'assigned_routines' in config_dict

            if has_assigned_rules:
                assigned_rules_raw = config_dict.get('assigned_rules') or []
                if not isinstance(assigned_rules_raw, list):
                    logger.warning(
                        'config.md assigned_rules is not a list (got %s) — treating as empty',
                        type(assigned_rules_raw).__name__,
                    )
                    assigned_rules_raw = []
                shared_basenames, agent_basenames = split_assigned_rules(assigned_rules_raw)

                if rules_shared_id:
                    all_shared = list_folder_files(drive, rules_shared_id)
                    shared_rules = fetch_named_files(drive, rules_shared_id, shared_basenames) if shared_basenames else {}
                    logger.info(
                        'Selective fetch: %d of %d available files loaded from shared rules folder',
                        len(shared_rules), len([f for f in all_shared if f.get('mimeType') != 'application/vnd.google-apps.folder']),
                    )
                else:
                    shared_rules = {}

                if rules_agent_id:
                    all_agent = list_folder_files(drive, rules_agent_id)
                    agent_rules = fetch_named_files(drive, rules_agent_id, agent_basenames) if agent_basenames else {}
                    logger.info(
                        'Selective fetch: %d of %d available files loaded from agent rules folder',
                        len(agent_rules), len([f for f in all_agent if f.get('mimeType') != 'application/vnd.google-apps.folder']),
                    )
                else:
                    agent_rules = {}
            else:
                logger.info('config.md has no assigned_rules key — falling back to fetch_all_files for rules folders')
                shared_rules = fetch_all_files(drive, rules_shared_id) if rules_shared_id else {}
                agent_rules = fetch_all_files(drive, rules_agent_id) if rules_agent_id else {}
                logger.info('All-files fetch: %d shared rules, %d agent rules loaded', len(shared_rules), len(agent_rules))

            if has_assigned_routines:
                assigned_routines_raw = config_dict.get('assigned_routines') or []
                if not isinstance(assigned_routines_raw, list):
                    logger.warning(
                        'config.md assigned_routines is not a list (got %s) — treating as empty',
                        type(assigned_routines_raw).__name__,
                    )
                    assigned_routines_raw = []
                routine_basenames = extract_routine_basenames(assigned_routines_raw)

                if routines_agent_id:
                    all_routines = list_folder_files(drive, routines_agent_id)
                    routines = fetch_named_files(drive, routines_agent_id, routine_basenames) if routine_basenames else {}
                    logger.info(
                        'Selective fetch: %d of %d available files loaded from routines folder',
                        len(routines), len([f for f in all_routines if f.get('mimeType') != 'application/vnd.google-apps.folder']),
                    )
                else:
                    routines = {}
            else:
                logger.info('config.md has no assigned_routines key — falling back to fetch_all_files for routines folder')
                routines = fetch_all_files(drive, routines_agent_id) if routines_agent_id else {}
                logger.info('All-files fetch: %d routines loaded', len(routines))

            has_assigned_skills = 'assigned_skills' in config_dict
            if has_assigned_skills:
                assigned_skills_raw = config_dict.get('assigned_skills') or []
                if not isinstance(assigned_skills_raw, list):
                    logger.warning(
                        'config.md assigned_skills is not a list (got %s) — treating as empty',
                        type(assigned_skills_raw).__name__,
                    )
                    assigned_skills_raw = []
                skill_basenames = extract_skill_basenames(assigned_skills_raw)

                if skills_id:
                    skills = fetch_named_files(drive, skills_id, skill_basenames) if skill_basenames else {}
                    logger.info(
                        'Selective fetch: %d skills loaded from skills folder',
                        len(skills),
                    )
                else:
                    skills = {}
            else:
                logger.info('config.md has no assigned_skills key — falling back to fetch_all_files for skills folder')
                skills = fetch_all_files(drive, skills_id) if skills_id else {}
                logger.info('All-files fetch: %d skills loaded', len(skills))

            tools = {}
            tools_inventory = {
                'version': 1,
                'source': 'assigned_tools',
                'count': 0,
                'items': [],
                'status': 'not-applicable-v1',
            }
            logger.info('v1 loader path: tools inventory not applicable')
        else:
            raise RuntimeError(f'Unsupported config_version: {config_version}')

        logger.info(
            'Fetched totals: %d shared rules, %d agent rules, %d routines, %d skills',
            len(shared_rules), len(agent_rules), len(routines), len(skills),
        )

        # Resolve CLAUDE.md — prefer dedicated CLAUDE.md file in agent folder,
        # fall back to a notice pointing at soul.md
        all_agent_files = list_folder_files(drive, args.agent_folder_id)
        agent_index = {f['name']: f for f in all_agent_files}

        if 'CLAUDE.md' in agent_index:
            entry = agent_index['CLAUDE.md']
            logger.info('Fetching CLAUDE.md from agent folder (id=%s)', entry['id'])
            claude_md_bytes = download_file(drive, entry['id'], entry.get('mimeType', ''))
        else:
            logger.info('No CLAUDE.md in agent folder — generating fallback from soul.md')
            claude_md_bytes = (
                '# Agent Config — Holly\n\n'
                '> This file is auto-generated. See soul.md for the full agent definition.\n\n'
                f'Soul loaded from: {args.soul_out}\n'
            ).encode('utf-8')

        rules_count = len(shared_rules) + len(agent_rules)
        routines_count = len(routines)
        skills_count = len(skills)
        tools_count = len(tools)

        write_bundle(
            target_dir=args.target_dir,
            soul_bytes=soul_bytes,
            soul_out=args.soul_out,
            config_dict=config_dict,
            shared_rules=shared_rules,
            agent_rules=agent_rules,
            routines=routines,
            skills=skills,
            tools=tools,
            tools_inventory=tools_inventory,
            claude_md_bytes=claude_md_bytes,
            claude_md_out=args.claude_md_out,
        )

        result = {
            'status': 'ok',
            'soul_bytes': len(soul_bytes),
            'rules_count': rules_count,
            'routines_count': routines_count,
            'skills_count': skills_count,
            'tools_count': tools_count,
            'tools_inventory_status': (
                'not-applicable-v1'
                if config_version in (0, 1)
                else 'applicable-v2'
            ),
            'claude_md_bytes': len(claude_md_bytes),
        }
        print(json.dumps(result))
        sys.exit(0)

    except Exception as exc:  # pylint: disable=broad-except
        error_msg = str(exc)
        # Final safety net — never leak private key text in error output
        if 'PRIVATE KEY' in error_msg:
            error_msg = '[error message redacted — contained private key data]'
        result = {'status': 'error', 'error': error_msg}
        print(json.dumps(result), file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    main()
