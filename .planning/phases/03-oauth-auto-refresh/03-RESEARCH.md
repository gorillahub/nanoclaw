# Phase 3: OAuth Auto-Refresh — Research

**Researched:** 2026-03-12
**Domain:** OAuth token lifecycle management for Claude Max 20x
**Confidence:** HIGH

## Summary

NanoClaw currently stores a static `CLAUDE_CODE_OAUTH_TOKEN` in `.env`. This token expires every ~15 hours, requiring manual intervention to keep Holly alive. The Claude Code CLI uses a standard OAuth2 refresh token flow — POST to `https://platform.claude.com/v1/oauth/token` with the refresh token gets a new access token.

The fix is straightforward: store the full credential set (access token, refresh token, expiry) in a JSON file, check expiry before each container spawn, and refresh proactively when near expiry. The refresh token itself appears long-lived (no observed expiry), but the response may include a rotated refresh token which must be persisted.

**Primary recommendation:** Add an `oauth-credentials.json` file alongside `.env`, a `readOAuthToken()` function that checks expiry and refreshes automatically, and wire it into `readSecrets()` in `container-runner.ts`.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js `https` / `fetch` | built-in | HTTP POST to token endpoint | Zero dependencies — NanoClaw already avoids adding deps |
| `fs` (Node.js) | built-in | Read/write credentials JSON file | Atomic write pattern already used throughout NanoClaw |

### Supporting

No additional libraries needed. This is pure Node.js — HTTP POST with URL-encoded body, JSON response, file I/O. NanoClaw already has all the patterns.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Raw fetch/https | `oauth4webapi` or `openid-client` | Over-engineered for a single token refresh call. NanoClaw avoids unnecessary deps. |
| JSON credentials file | Store in SQLite | Overkill — single credential set, atomic file write is simpler and debuggable |
| Proactive timer refresh | Check-on-demand before spawn | Timer adds complexity (drift, race conditions). Check-on-demand is simpler and sufficient — containers spawn frequently enough. |

## Architecture Patterns

### Credentials File Layout

```
/opt/nanoclaw/oauth-credentials.json
```

```json
{
  "accessToken": "sk-ant-oat01-...",
  "refreshToken": "sk-ant-ort01-...",
  "expiresAt": 1773329971167,
  "scopes": ["user:inference", "user:mcp_servers", "user:profile", "user:sessions:claude_code"],
  "subscriptionType": "max",
  "rateLimitTier": "default_claude_max_20x"
}
```

This mirrors the `claudeAiOauth` object from the Claude Code CLI's keychain storage.

### Pattern: Check-and-Refresh on Demand

```
readSecrets() called
  → readOAuthToken()
    → read oauth-credentials.json
    → if expiresAt > now + 5min buffer → return accessToken (fast path)
    → if expiresAt <= now + 5min buffer → refreshOAuthToken()
      → POST to token endpoint
      → write new credentials to oauth-credentials.json (atomic)
      → return new accessToken
    → if refresh fails → log error, return stale token (let it fail naturally)
```

**Why 5-minute buffer:** Prevents edge case where token is valid when read but expires during container boot (~15-20s cold start).

### Pattern: Atomic File Write

NanoClaw already uses temp+rename for IPC files. Same pattern for credentials:

```typescript
const tmpFile = credentialsPath + '.tmp';
fs.writeFileSync(tmpFile, JSON.stringify(credentials, null, 2));
fs.renameSync(tmpFile, credentialsPath);
```

### Anti-Patterns to Avoid

- **Storing tokens in `.env`:** `.env` is parsed line-by-line, not structured. OAuth needs structured data (expiry, refresh token). Keep `.env` for non-expiring config.
- **Background timer for refresh:** Adds complexity — race conditions between timer and container spawns, timer drift, process restart losing timer state. On-demand is simpler.
- **Refreshing on every spawn:** Wasteful. Only refresh when near expiry.
- **Ignoring the rotated refresh token:** The response MAY include a new refresh token. If it does and you don't persist it, the old refresh token may be invalidated.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| URL-encoded POST body | Manual string concatenation | `URLSearchParams` | Handles encoding edge cases |
| File locking for concurrent refresh | Custom mutex | Single-threaded Node.js | NanoClaw is single-process — `readSecrets()` is synchronous, no concurrent refresh possible |

## Common Pitfalls

### Pitfall 1: Refresh Token Rotation
**What goes wrong:** Response includes a new refresh token, code ignores it, old refresh token gets invalidated by the server.
**Why it happens:** Not all OAuth servers rotate refresh tokens, so devs assume the original stays valid.
**How to avoid:** Always persist `response.refresh_token` when present. Fall back to existing refresh token if response omits it.
**Warning signs:** Refresh starts failing after first successful refresh.

### Pitfall 2: Race Condition on Concurrent Spawns
**What goes wrong:** Two containers spawning simultaneously both see expired token, both try to refresh, second refresh uses already-rotated refresh token.
**Why it happens:** NanoClaw can spawn multiple containers rapidly (concurrent messages).
**How to avoid:** NanoClaw is single-threaded Node.js. `readSecrets()` is synchronous. But `refreshOAuthToken()` must be async (HTTP call). Use a module-level "refreshing" promise — if a refresh is in-flight, subsequent callers await the same promise instead of starting a new refresh.
**Warning signs:** "invalid_grant" errors in logs during burst traffic.

### Pitfall 3: Clock Skew
**What goes wrong:** VPS clock is slightly off, token appears valid but server rejects it.
**Why it happens:** `expiresAt` is an absolute timestamp from Claude's server. VPS clock may drift.
**How to avoid:** Use a generous buffer (5 minutes). NTP should be running on the VPS anyway.
**Warning signs:** Intermittent 401s despite token appearing valid.

### Pitfall 4: Credentials File Permissions
**What goes wrong:** File created with world-readable permissions, or wrong owner.
**Why it happens:** Default `fs.writeFileSync` uses umask.
**How to avoid:** Set `mode: 0o600` on write. Verify file owned by `nanoclaw` user.
**Warning signs:** Other processes on VPS can read the refresh token.

### Pitfall 5: Stale `.env` Override
**What goes wrong:** `.env` still has `CLAUDE_CODE_OAUTH_TOKEN` which takes precedence over the credentials file.
**Why it happens:** `readSecrets()` reads from `.env` first.
**How to avoid:** Remove `CLAUDE_CODE_OAUTH_TOKEN` from `.env` after migration. Or: credentials file takes precedence when present.
**Warning signs:** Token never refreshes because `.env` value is always used.

## Code Examples

### Token Refresh Request

```typescript
// Source: Claude Code CLI source analysis + macOS keychain verification
const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

async function refreshOAuthToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth refresh failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,  // may be undefined (no rotation)
    expiresIn: data.expires_in,        // seconds until expiry
  };
}
```

### Credentials File Read/Write

```typescript
interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;  // epoch milliseconds
}

const CREDENTIALS_PATH = path.join(process.cwd(), 'oauth-credentials.json');
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

function readCredentials(): OAuthCredentials | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCredentials(creds: OAuthCredentials): void {
  const tmp = CREDENTIALS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CREDENTIALS_PATH);
}
```

### Deduplication of Concurrent Refreshes

```typescript
let refreshPromise: Promise<OAuthCredentials> | null = null;

async function getValidToken(): Promise<string> {
  const creds = readCredentials();
  if (!creds) {
    // Fall back to .env (migration path)
    return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN']).CLAUDE_CODE_OAUTH_TOKEN || '';
  }

  if (creds.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
    return creds.accessToken; // Still valid
  }

  // Need refresh — deduplicate concurrent calls
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const result = await refreshOAuthToken(creds.refreshToken);
        const newCreds: OAuthCredentials = {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken || creds.refreshToken,
          expiresAt: result.expiresIn
            ? Date.now() + result.expiresIn * 1000
            : Date.now() + 15 * 60 * 60 * 1000, // default 15h
        };
        writeCredentials(newCreds);
        return newCreds;
      } finally {
        refreshPromise = null;
      }
    })();
  }

  const newCreds = await refreshPromise;
  return newCreds.accessToken;
}
```

## Integration Points

### Where to Wire In

1. **`src/oauth.ts`** (new file) — `getValidToken()`, `readCredentials()`, `writeCredentials()`, `refreshOAuthToken()`
2. **`src/container-runner.ts`** — `readSecrets()` becomes async, calls `getValidToken()` instead of reading `CLAUDE_CODE_OAUTH_TOKEN` from `.env`
3. **`src/container-runner.ts`** — `runContainerAgent()` already async, so awaiting `readSecrets()` is straightforward
4. **VPS `.env`** — remove `CLAUDE_CODE_OAUTH_TOKEN` after `oauth-credentials.json` is seeded
5. **VPS deployment** — seed `oauth-credentials.json` from current keychain values

### Async Propagation

`readSecrets()` is currently synchronous (line 218 of container-runner.ts). It's called synchronously at line 318: `input.secrets = readSecrets()`. This is inside the `runContainerAgent()` async function, so making it `await readSecretsAsync()` is a minimal change. But callers must be checked — `readSecrets()` isn't called anywhere else (verified by grep).

### Migration Path

1. Create `oauth-credentials.json` on VPS with current tokens from keychain
2. Deploy code that reads from credentials file, falls back to `.env`
3. Verify refresh works (check logs after ~15h)
4. Remove `CLAUDE_CODE_OAUTH_TOKEN` from `.env`

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Static access token in `.env` | OAuth credentials file with auto-refresh | Phase 3 | Holly stays alive indefinitely without manual intervention |

## Open Questions

1. **Does Claude's OAuth server rotate refresh tokens?**
   - What we know: The keychain shows a single refresh token that's been stable across multiple manual refreshes
   - What's unclear: Whether the server will eventually rotate it
   - Recommendation: Always persist response `refresh_token` if present. Safe regardless.

2. **What's the actual token lifetime?**
   - What we know: `expiresAt` from keychain shows ~15 hours. The `expires_in` field in the refresh response would confirm.
   - What's unclear: Whether it's always exactly 15h or varies
   - Recommendation: Use `expires_in` from response when available. Fall back to 15h.

3. **What happens when the refresh token itself expires?**
   - What we know: No observed expiry so far. Claude Max subscriptions likely keep refresh tokens valid indefinitely while subscription is active.
   - What's unclear: Definitive lifetime of refresh tokens
   - Recommendation: Log a CRITICAL error if refresh fails with `invalid_grant`. This would require manual re-auth (Craig runs `claude` CLI on VPS to re-authenticate).

## Sources

### Primary (HIGH confidence)
- macOS Keychain (`security find-generic-password -s "Claude Code-credentials" -w`) — verified token structure, confirmed fields
- VPS `/opt/nanoclaw/.env` — confirmed current token format
- NanoClaw source code (`container-runner.ts`, `env.ts`) — verified `readSecrets()` flow

### Secondary (MEDIUM confidence)
- Claude Code CLI source analysis (from previous session) — token endpoint URL, client ID, request format
- Previous session testing — manual token refresh confirmed working

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — pure Node.js, no new deps, patterns already in codebase
- Architecture: HIGH — single integration point (`readSecrets`), clear migration path
- Pitfalls: HIGH — OAuth2 refresh is well-understood, NanoClaw's single-threaded model simplifies concurrency
- Token endpoint details: MEDIUM — from CLI source analysis, confirmed by manual testing but not from official docs

**Research date:** 2026-03-12
**Valid until:** 2026-04-12 (OAuth endpoints are stable; Claude may change client ID but unlikely)
