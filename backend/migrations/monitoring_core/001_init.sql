-- Audit log, per-user preferences and RBAC for the monitoring app.

CREATE TABLE audit_log (
    id           text        PRIMARY KEY,
    "timestamp"  timestamptz NOT NULL,
    action       text        NOT NULL,
    performed_by text        NOT NULL,
    target       text        NOT NULL DEFAULT '',
    details      text        NOT NULL DEFAULT '',
    ip_address   text        NOT NULL DEFAULT ''
);
CREATE INDEX audit_log_timestamp_idx    ON audit_log ("timestamp" DESC, id);
CREATE INDEX audit_log_performed_by_idx ON audit_log (lower(performed_by));
CREATE INDEX audit_log_action_idx       ON audit_log (action);

CREATE TABLE user_preferences (
    email       text        PRIMARY KEY,
    preferences jsonb       NOT NULL DEFAULT '{}'::jsonb,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Custom roles and edited built-in roles; the built-in defaults live in code.
CREATE TABLE rbac_roles (
    role_id    text        PRIMARY KEY,
    definition jsonb       NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Per-person role assignments that override AD group mapping.
CREATE TABLE rbac_user_roles (
    email      text        PRIMARY KEY,
    role_id    text        NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
