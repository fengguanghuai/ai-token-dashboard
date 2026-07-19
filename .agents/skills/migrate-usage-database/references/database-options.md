# Database options

## Selection

| Target | Best fit | Connection setting |
|---|---|---|
| SQLite | One machine, no shared service | `DB_PATH=data/usage.sqlite` |
| Supabase/PostgreSQL | Managed shared database, simplest multi-device setup | `DATABASE_URL=postgresql://...?...sslmode=require` |
| Self-hosted PostgreSQL | Full infrastructure control | `DATABASE_URL=postgresql://user:password@host:5432/database` |
| Self-hosted MySQL 8+ | Existing MySQL operations and backups | `DATABASE_URL=mysql://user:password@host:3306/database` |

## Supabase

- Prefer the **Session pooler** connection string for this long-running Node service and for networks that need IPv4.
- Keep `sslmode=require` in the URL.
- Use the generated database password, URL-encoding reserved characters when constructing a URL.
- Direct connections are suitable only when the client network has working IPv6 or the project provides IPv4 support.
- The dashboard uses the PostgreSQL protocol directly; Supabase Data API can remain disabled.

## Configuration precedence

The application resolves database settings in this order:

1. Explicit CLI/script input.
2. `DATABASE_URL`.
3. `DB_DRIVER` and `DB_PATH`.
4. Default SQLite file `data/usage.sqlite`.

`DATABASE_URL` determines the driver from its protocol. Do not set conflicting `DB_DRIVER` and `DATABASE_URL` values.

## Migration behavior

- `daily_usage`, `session_usage`, and `time_usage` use primary-key upserts and are safe to migrate again.
- Migration copies exact token/cost/timestamp values from SQLite in batches.
- `collection_runs` is copied only into an empty target to avoid duplicate operational logs, then pruned to the configured retention limit.
- Verification requires every durable target table to contain at least as many rows as the SQLite source; the target may contain more rows from other devices.

## Multi-device rollout

1. Migrate the first device's existing SQLite history.
2. Put the same remote `DATABASE_URL` in each device's untracked `.env`.
3. Run initialization and connection checks on each device.
4. Give every device a stable distinct collection name with `COLLECT_DEVICE` when hostnames are not reliable.
5. Run the collector or scheduled server normally. Composite keys already include `device`, so different machines merge without overwriting each other.
