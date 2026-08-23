-- Phase 3 (docs/PLAN.md): WebAuthn passkeys, single-user system — exactly one owner, no users
-- table. `credentials` holds every registered authenticator; `auth_challenges` holds single-use,
-- short-lived registration/login challenges (see src/routes/auth.ts).
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,                 -- credential id, base64url
  public_key_jwk TEXT NOT NULL,        -- JSON JWK (EC P-256 or RSA)
  alg INTEGER NOT NULL,                -- COSE alg: -7 (ES256) or -257 (RS256)
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL DEFAULT '',       -- user label ("iPhone")
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT
);
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,                 -- challenge, base64url (random 32 bytes)
  kind TEXT NOT NULL CHECK(kind IN ('register','login')),
  bootstrap INTEGER NOT NULL DEFAULT 0, -- 1 if issued while zero credentials existed (register only);
                                        -- verify rejects a bootstrap=1 challenge once any credential exists,
                                        -- even with a valid session (closes the empty-credentials race window).
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
