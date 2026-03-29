/**
 * Integration tests for the database abstraction layer.
 *
 * Suites are auto-skipped when credentials are absent, so these can safely
 * run in CI — only test what is available in the current environment.
 *
 * Required env vars:
 *   HAS_LOCAL_PG  → DATABASE_URL pointing to local PostgreSQL
 *   HAS_NEON_DB   → DATABASE_URL pointing to Neon (HTTP queries)
 *   HAS_NEON_MGMT → NEON_API_KEY + NEON_PROJECT_ID (management API)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  detectEnvironment,
  buildConnectionConfig,
  createDatabaseService,
  DatabaseService,
  NeonManagementClient,
  DatabaseError,
} from '@ai-gateway/database/index';

// ── Load env files ─────────────────────────────────────────────────────────────

function loadEnvFile(filePath: string) {
  try {
    const content = readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !process.env[key]) process.env[key] = val;
    }
  } catch {
    // File not found — ignore
  }
}

const ROOT = join(__dirname, '..', '..', '..'); // workspace root
loadEnvFile(join(ROOT, '.env'));
loadEnvFile(join(ROOT, '.env.local'));
loadEnvFile(join(ROOT, '.env.vercel'));

// ── Capability flags ───────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const NEON_API_KEY = process.env.NEON_API_KEY ?? '';
const NEON_PROJECT_ID = process.env.NEON_PROJECT_ID ?? '';

const HAS_LOCAL_PG = !!DATABASE_URL && detectEnvironment(DATABASE_URL) === 'local';
const HAS_NEON_DB = !!DATABASE_URL && detectEnvironment(DATABASE_URL) === 'neon';
const HAS_NEON_MGMT = !!NEON_API_KEY && !!NEON_PROJECT_ID;

// ── Admin URL helper (connect to postgres system DB) ───────────────────────────

function getAdminUrl(): string {
  try {
    const u = new URL(DATABASE_URL);
    u.pathname = '/postgres';
    return u.toString();
  } catch {
    return DATABASE_URL;
  }
}

function getTestDbUrl(dbName: string): string {
  try {
    const u = new URL(DATABASE_URL);
    u.pathname = `/${dbName}`;
    return u.toString();
  } catch {
    return DATABASE_URL;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOCAL POSTGRESQL — FULL LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_LOCAL_PG)('Local PostgreSQL — full lifecycle', () => {
  const TEST_DB = `ai_gateway_test_${Date.now()}`;
  let svc: DatabaseService;

  // ── 1. Create isolated test database ──────────────────────────────────────

  beforeAll(async () => {
    const admin = createDatabaseService({ databaseUrl: getAdminUrl() });
    await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    await admin.close();
    svc = createDatabaseService({ databaseUrl: getTestDbUrl(TEST_DB) });
  });

  // ── 2. Cleanup: destroy test database ─────────────────────────────────────

  afterAll(async () => {
    await svc.close();
    const admin = createDatabaseService({ databaseUrl: getAdminUrl() });
    // Terminate any lingering connections to the test DB before dropping
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DB],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await admin.close();
  });

  // ── 3. Schema creation ────────────────────────────────────────────────────

  it('creates schema: users, posts, tags, post_tags', async () => {
    await svc.query(`
      CREATE TABLE users (
        id         SERIAL PRIMARY KEY,
        email      TEXT    NOT NULL UNIQUE,
        name       TEXT    NOT NULL,
        role       TEXT    NOT NULL DEFAULT 'user',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await svc.query(`
      CREATE TABLE posts (
        id         SERIAL PRIMARY KEY,
        author_id  INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        body       TEXT NOT NULL DEFAULT '',
        published  BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await svc.query(`
      CREATE TABLE tags (
        id   SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      )
    `);
    await svc.query(`
      CREATE TABLE post_tags (
        post_id INT NOT NULL REFERENCES posts(id)  ON DELETE CASCADE,
        tag_id  INT NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
        PRIMARY KEY (post_id, tag_id)
      )
    `);

    // Verify tables exist
    const result = await svc.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const names = result.rows.map((r) => r.tablename);
    expect(names).toContain('users');
    expect(names).toContain('posts');
    expect(names).toContain('tags');
    expect(names).toContain('post_tags');
  });

  // ── 4. Bulk inserts ───────────────────────────────────────────────────────

  it('inserts users', async () => {
    await svc.query(
      `INSERT INTO users (email, name, role) VALUES
        ('alice@example.com', 'Alice', 'admin'),
        ('bob@example.com',   'Bob',   'user'),
        ('carol@example.com', 'Carol', 'user'),
        ('dave@example.com',  'Dave',  'moderator'),
        ('eve@example.com',   'Eve',   'user')`,
    );
    const { rows } = await svc.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
    expect(rows[0].count).toBe('5');
  });

  it('inserts posts', async () => {
    await svc.query(`
      INSERT INTO posts (author_id, title, body, published)
      SELECT u.id, p.title, p.body, p.published
      FROM (VALUES
        ('alice@example.com', 'Hello World',       'My first post',          TRUE),
        ('alice@example.com', 'Draft Post',        'Not ready yet',          FALSE),
        ('bob@example.com',   'Bob writes',        'Bob has thoughts',       TRUE),
        ('carol@example.com', 'Carol on tech',     'Carol loves databases',  TRUE),
        ('carol@example.com', 'Carol on cooking',  'Carol also cooks',       TRUE),
        ('dave@example.com',  'Moderation notes',  'Keeping things civil',   FALSE)
      ) AS p(email, title, body, published)
      JOIN users u ON u.email = p.email
    `);
    const { rows } = await svc.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM posts');
    expect(rows[0].count).toBe('6');
  });

  it('inserts tags and post_tags', async () => {
    await svc.query(`
      INSERT INTO tags (name) VALUES ('tech'), ('databases'), ('cooking'), ('meta')
    `);
    // Tag posts by title
    await svc.query(`
      INSERT INTO post_tags (post_id, tag_id)
      SELECT po.id, t.id FROM posts po, tags t
      WHERE
        (po.title = 'Hello World'       AND t.name = 'meta') OR
        (po.title = 'Bob writes'        AND t.name = 'meta') OR
        (po.title = 'Carol on tech'     AND t.name = 'tech') OR
        (po.title = 'Carol on tech'     AND t.name = 'databases') OR
        (po.title = 'Carol on cooking'  AND t.name = 'cooking')
    `);
    const { rows } = await svc.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM post_tags');
    expect(rows[0].count).toBe('5');
  });

  // ── 5. Query operations ───────────────────────────────────────────────────

  it('counts published posts per author (JOIN + GROUP BY)', async () => {
    const { rows } = await svc.query<{ name: string; published_count: string }>(`
      SELECT u.name, COUNT(p.id)::text AS published_count
      FROM users u
      LEFT JOIN posts p ON p.author_id = u.id AND p.published = TRUE
      GROUP BY u.id, u.name
      ORDER BY u.name
    `);
    const byName = Object.fromEntries(rows.map((r) => [r.name, Number(r.published_count)]));
    expect(byName['Alice']).toBe(1);
    expect(byName['Bob']).toBe(1);
    expect(byName['Carol']).toBe(2);
    expect(byName['Dave']).toBe(0);
    expect(byName['Eve']).toBe(0);
  });

  it('finds posts with their tags (JOIN through junction table)', async () => {
    const { rows } = await svc.query<{ title: string; tags: string }>(`
      SELECT p.title, STRING_AGG(t.name, ',' ORDER BY t.name) AS tags
      FROM posts p
      JOIN post_tags pt ON pt.post_id = p.id
      JOIN tags t       ON t.id = pt.tag_id
      GROUP BY p.id, p.title
      ORDER BY p.title
    `);
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.tags]));
    expect(byTitle['Carol on tech']).toBe('databases,tech');
    expect(byTitle['Carol on cooking']).toBe('cooking');
    expect(byTitle['Hello World']).toBe('meta');
  });

  it('uses parameterized query to filter by role', async () => {
    const { rows } = await svc.query<{ name: string }>(
      `SELECT name FROM users WHERE role = $1 ORDER BY name`,
      ['user'],
    );
    expect(rows.map((r) => r.name)).toEqual(['Bob', 'Carol', 'Eve']);
  });

  it('aggregates post stats', async () => {
    const { rows } = await svc.query<{
      total: string; published: string; drafts: string; authors_with_posts: string;
    }>(`
      SELECT
        COUNT(*)::text                                              AS total,
        COUNT(*) FILTER (WHERE published)::text                    AS published,
        COUNT(*) FILTER (WHERE NOT published)::text                AS drafts,
        COUNT(DISTINCT author_id)::text                            AS authors_with_posts
      FROM posts
    `);
    expect(rows[0].total).toBe('6');
    expect(rows[0].published).toBe('4');
    expect(rows[0].drafts).toBe('2');
    expect(rows[0].authors_with_posts).toBe('4');
  });

  // ── 6. Update operations ──────────────────────────────────────────────────

  it('publishes all drafts', async () => {
    const result = await svc.query(`UPDATE posts SET published = TRUE WHERE published = FALSE`);
    expect(result.rowCount).toBe(2);

    const { rows } = await svc.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM posts WHERE published = FALSE`,
    );
    expect(rows[0].count).toBe('0');
  });

  it('promotes a user to admin', async () => {
    await svc.query(`UPDATE users SET role = 'admin' WHERE email = $1`, ['bob@example.com']);
    const { rows } = await svc.query<{ role: string }>(
      `SELECT role FROM users WHERE email = $1`,
      ['bob@example.com'],
    );
    expect(rows[0].role).toBe('admin');
  });

  it('renames a tag', async () => {
    await svc.query(`UPDATE tags SET name = 'programming' WHERE name = 'tech'`);
    const { rows } = await svc.query<{ name: string }>(
      `SELECT name FROM tags WHERE name = 'programming'`,
    );
    expect(rows).toHaveLength(1);
  });

  // ── 7. Delete operations ──────────────────────────────────────────────────

  it('deletes a user and cascades to their posts', async () => {
    // Dave has 1 post ("Moderation notes")
    await svc.query(`DELETE FROM users WHERE email = 'dave@example.com'`);

    const { rows: users } = await svc.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users`,
    );
    expect(users[0].count).toBe('4');

    const { rows: posts } = await svc.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM posts WHERE title = 'Moderation notes'`,
    );
    expect(posts[0].count).toBe('0');
  });

  it('removes a tag and its post_tag associations', async () => {
    // "meta" is used by 2 posts
    await svc.query(`DELETE FROM tags WHERE name = 'meta'`);

    const { rows } = await svc.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = 'meta'`,
    );
    expect(rows[0].count).toBe('0');
  });

  // ── 8. Transaction tests ──────────────────────────────────────────────────

  it('rolls back a transaction — data is NOT persisted', async () => {
    const before = await svc.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
    const countBefore = Number(before.rows[0].count);

    await svc.query('BEGIN');
    await svc.query(`INSERT INTO users (email, name, role) VALUES ('rollback@example.com', 'Rollback', 'user')`);
    const during = await svc.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
    expect(Number(during.rows[0].count)).toBe(countBefore + 1); // visible inside tx
    await svc.query('ROLLBACK');

    const after = await svc.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
    expect(Number(after.rows[0].count)).toBe(countBefore); // gone after rollback
  });

  it('commits a transaction — data IS persisted', async () => {
    await svc.query('BEGIN');
    await svc.query(`INSERT INTO users (email, name, role) VALUES ('committed@example.com', 'Committed', 'user')`);
    await svc.query('COMMIT');

    const { rows } = await svc.query<{ name: string }>(
      `SELECT name FROM users WHERE email = 'committed@example.com'`,
    );
    expect(rows[0].name).toBe('Committed');
  });

  it('savepoint and partial rollback', async () => {
    await svc.query('BEGIN');
    await svc.query(`INSERT INTO tags (name) VALUES ('savepoint-test-a')`);
    await svc.query('SAVEPOINT sp1');
    await svc.query(`INSERT INTO tags (name) VALUES ('savepoint-test-b')`);
    await svc.query('ROLLBACK TO SAVEPOINT sp1');
    await svc.query('COMMIT');

    const { rows: a } = await svc.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tags WHERE name = 'savepoint-test-a'`,
    );
    const { rows: b } = await svc.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tags WHERE name = 'savepoint-test-b'`,
    );
    expect(a[0].count).toBe('1'); // committed
    expect(b[0].count).toBe('0'); // rolled back to savepoint
  });

  // ── 9. Constraint tests ───────────────────────────────────────────────────

  it('rejects duplicate email (UNIQUE constraint)', async () => {
    await expect(
      svc.query(`INSERT INTO users (email, name) VALUES ('alice@example.com', 'Fake Alice')`),
    ).rejects.toThrow();
  });

  it('rejects orphan post (FK constraint)', async () => {
    await expect(
      svc.query(`INSERT INTO posts (author_id, title) VALUES (99999, 'Ghost post')`),
    ).rejects.toThrow();
  });

  // ── 10. Snapshot state before backup ──────────────────────────────────────

  it('records final state before backup', async () => {
    const { rows: users } = await svc.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
    const { rows: posts } = await svc.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM posts');
    const { rows: tags } = await svc.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM tags');

    // Persist counts for post-restore verification (accessed via closure)
    expect(Number(users[0].count)).toBeGreaterThanOrEqual(4);
    expect(Number(posts[0].count)).toBeGreaterThanOrEqual(5);
    expect(Number(tags[0].count)).toBeGreaterThanOrEqual(3);
  });

  // ── 11. Backup ────────────────────────────────────────────────────────────

  // Shared backup ref across tests (vitest runs tests in order within a describe)
  const state: { backup?: import('@ai-gateway/database/index').BackupInfo } = {};

  it('creates a pg_dump backup', async () => {
    const testSvc = createDatabaseService({ databaseUrl: getTestDbUrl(TEST_DB) });
    const result = await testSvc.backup({ label: 'full-lifecycle-backup' });
    await testSvc.close();

    expect(result.backup.type).toBe('dump');
    expect(result.backup.data.length).toBeGreaterThan(100); // non-empty base64
    expect(result.message).toContain('pg_dump backup created');
    expect(result.backup.metadata?.label).toBe('full-lifecycle-backup');

    // Decode and verify SQL content
    const snapshotSql = Buffer.from(result.backup.data, 'base64').toString('utf8');
    expect(snapshotSql).toContain('CREATE TABLE');
    expect(snapshotSql).toContain('users');
    expect(snapshotSql).toContain('posts');
    expect(snapshotSql).toContain('alice@example.com');

    state.backup = result.backup;
  }, 30_000);

  it('backup metadata includes database name', () => {
    expect(state.backup?.metadata?.database).toBe(TEST_DB);
    expect(state.backup?.id).toMatch(/^[0-9a-f-]{36}$/); // UUID
    expect(new Date(state.backup!.createdAt).getFullYear()).toBeGreaterThanOrEqual(2024);
  });

  // ── 12. Simulate data loss ────────────────────────────────────────────────

  it('drops all tables to simulate data loss', async () => {
    await svc.query('DROP TABLE post_tags CASCADE');
    await svc.query('DROP TABLE tags     CASCADE');
    await svc.query('DROP TABLE posts    CASCADE');
    await svc.query('DROP TABLE users    CASCADE');

    const { rows } = await svc.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    expect(rows).toHaveLength(0); // all gone
  });

  // ── 13. Restore from backup ───────────────────────────────────────────────

  it('restores from pg_dump backup via psql', async () => {
    const restoreSvc = createDatabaseService({ databaseUrl: getTestDbUrl(TEST_DB) });
    await restoreSvc.restore(state.backup!);
    await restoreSvc.close();

    // Tables must exist again
    const { rows } = await svc.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const names = rows.map((r) => r.tablename);
    expect(names).toContain('users');
    expect(names).toContain('posts');
    expect(names).toContain('tags');
    expect(names).toContain('post_tags');
  });

  // ── 14. Verify restored data ──────────────────────────────────────────────

  it('restored users include alice and carol', async () => {
    const { rows } = await svc.query<{ email: string }>(
      `SELECT email FROM users ORDER BY email`,
    );
    const emails = rows.map((r) => r.email);
    expect(emails).toContain('alice@example.com');
    expect(emails).toContain('carol@example.com');
    expect(emails).toContain('committed@example.com'); // committed in transaction test
    expect(emails).not.toContain('dave@example.com');  // was deleted before backup
  });

  it('restored posts belong to correct authors', async () => {
    const { rows } = await svc.query<{ title: string; author: string }>(`
      SELECT p.title, u.name AS author
      FROM posts p
      JOIN users u ON u.id = p.author_id
      ORDER BY p.title
    `);
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.author]));
    expect(byTitle['Hello World']).toBe('Alice');
    expect(byTitle['Bob writes']).toBe('Bob');
    expect(byTitle['Carol on tech']).toBe('Carol');
  });

  it('restored post_tags junction is intact', async () => {
    const { rows } = await svc.query<{ title: string; tag: string }>(`
      SELECT p.title, t.name AS tag
      FROM post_tags pt
      JOIN posts p ON p.id = pt.post_id
      JOIN tags  t ON t.id = pt.tag_id
      ORDER BY p.title, t.name
    `);
    const pairs = rows.map((r) => `${r.title}:${r.tag}`);
    expect(pairs).toContain('Carol on tech:databases');
    expect(pairs).toContain('Carol on tech:programming'); // renamed from tech
    expect(pairs).toContain('Carol on cooking:cooking');
  });

  it('restored data passes FK constraints (no orphans)', async () => {
    const { rows } = await svc.query<{ orphan_count: string }>(`
      SELECT COUNT(*)::text AS orphan_count
      FROM posts p
      WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.author_id)
    `);
    expect(rows[0].orphan_count).toBe('0');
  });

  it('all posts are published after restore (updates survived)', async () => {
    const { rows } = await svc.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM posts WHERE published = FALSE`,
    );
    expect(rows[0].count).toBe('0');
  });

  it('duplicate restore is idempotent (--clean --if-exists handles existing tables)', async () => {
    // Running restore twice should not throw because pg_dump uses DROP IF EXISTS
    const restoreSvc = createDatabaseService({ databaseUrl: getTestDbUrl(TEST_DB) });
    await expect(restoreSvc.restore(state.backup!)).resolves.not.toThrow();
    await restoreSvc.close();
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// LOCAL POSTGRESQL — MULTIPLE CONCURRENT SERVICES
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_LOCAL_PG)('Local PostgreSQL — concurrent service instances', () => {
  const TEST_DB = `ai_gateway_concurrent_${Date.now()}`;
  let svcA: DatabaseService;
  let svcB: DatabaseService;

  beforeAll(async () => {
    const admin = createDatabaseService({ databaseUrl: getAdminUrl() });
    await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    await admin.close();
    svcA = createDatabaseService({ databaseUrl: getTestDbUrl(TEST_DB) });
    svcB = createDatabaseService({ databaseUrl: getTestDbUrl(TEST_DB) });
    await svcA.query(`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  });

  afterAll(async () => {
    await svcA.close();
    await svcB.close();
    const admin = createDatabaseService({ databaseUrl: getAdminUrl() });
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DB],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await admin.close();
  });

  it('two independent service instances can read/write the same database', async () => {
    await svcA.query(`INSERT INTO kv VALUES ('ping', 'from-a')`);
    const { rows } = await svcB.query<{ value: string }>(`SELECT value FROM kv WHERE key = 'ping'`);
    expect(rows[0].value).toBe('from-a');
  });

  it('writes from svcB are visible to svcA', async () => {
    await svcB.query(`INSERT INTO kv VALUES ('pong', 'from-b')`);
    const { rows } = await svcA.query<{ value: string }>(`SELECT value FROM kv WHERE key = 'pong'`);
    expect(rows[0].value).toBe('from-b');
  });

  it('concurrent reads return consistent results', async () => {
    await svcA.query(`INSERT INTO kv VALUES ('shared', 'value')`);
    const [resA, resB] = await Promise.all([
      svcA.query<{ value: string }>(`SELECT value FROM kv WHERE key = 'shared'`),
      svcB.query<{ value: string }>(`SELECT value FROM kv WHERE key = 'shared'`),
    ]);
    expect(resA.rows[0].value).toBe('value');
    expect(resB.rows[0].value).toBe('value');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LOCAL POSTGRESQL — BACKUP INTEGRITY
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_LOCAL_PG)('Local PostgreSQL — backup integrity', () => {
  const TEST_DB_A = `ai_gateway_bkp_src_${Date.now()}`;
  const TEST_DB_B = `ai_gateway_bkp_dst_${Date.now()}`;

  beforeAll(async () => {
    const admin = createDatabaseService({ databaseUrl: getAdminUrl() });
    await admin.query(`CREATE DATABASE "${TEST_DB_A}"`);
    await admin.query(`CREATE DATABASE "${TEST_DB_B}"`);
    await admin.close();

    // Seed source DB
    const src = createDatabaseService({ databaseUrl: getTestDbUrl(TEST_DB_A) });
    await src.query(`CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL, qty INT NOT NULL DEFAULT 0)`);
    await src.query(`INSERT INTO items (name, qty) VALUES ('apple', 10), ('banana', 25), ('cherry', 5)`);
    await src.close();
  });

  afterAll(async () => {
    const admin = createDatabaseService({ databaseUrl: getAdminUrl() });
    for (const db of [TEST_DB_A, TEST_DB_B]) {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${db}"`);
    }
    await admin.close();
  });

  it('dumps source DB and restores to a different target DB', async () => {
    // pg_dump + psql on local socket, may take a few seconds
    // Backup source
    const srcSvc = createDatabaseService({ databaseUrl: getTestDbUrl(TEST_DB_A) });
    const { backup } = await srcSvc.backup({ label: 'cross-db-restore' });
    await srcSvc.close();

    // Restore into target DB (different connection string)
    const dstSvc = createDatabaseService({ databaseUrl: getTestDbUrl(TEST_DB_B) });
    await dstSvc.restore(backup, { connectionString: getTestDbUrl(TEST_DB_B) });

    // Verify data in target
    const { rows } = await dstSvc.query<{ name: string; qty: number }>(
      `SELECT name, qty FROM items ORDER BY name`,
    );
    await dstSvc.close();

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ name: 'apple',  qty: 10 });
    expect(rows[1]).toMatchObject({ name: 'banana', qty: 25 });
    expect(rows[2]).toMatchObject({ name: 'cherry', qty: 5  });
  }, 30_000);

  it('backup size grows with more data', async () => {
    const svc = createDatabaseService({ databaseUrl: getTestDbUrl(TEST_DB_A) });

    const { backup: before } = await svc.backup({ label: 'before' });
    const sizeBefore = before.data.length;

    // Insert 100 more rows
    await svc.query(
      `INSERT INTO items (name, qty) SELECT 'item_' || i, i FROM generate_series(1, 100) AS t(i)`,
    );

    const { backup: after } = await svc.backup({ label: 'after' });
    const sizeAfter = after.data.length;

    await svc.close();
    expect(sizeAfter).toBeGreaterThan(sizeBefore);
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// NEON HTTP SQL
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_NEON_DB)('Neon — HTTP SQL queries', () => {
  let svc: DatabaseService;

  beforeAll(() => { svc = new DatabaseService(); });
  afterAll(async () => { await svc.close(); });

  it('executes a simple query over HTTP', async () => {
    const result = await svc.query<{ val: string }>('SELECT 1::text AS val');
    expect(result.rows[0].val).toBe('1');
  });

  it('isNeon is true', () => {
    expect(svc.isNeon).toBe(true);
  });

  it('handles errors gracefully', async () => {
    await expect(svc.query('SELECT * FROM nonexistent_table_xyz')).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NEON MANAGEMENT API
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_NEON_MGMT)('Neon Management API', () => {
  const mgmt = new NeonManagementClient(NEON_API_KEY, NEON_PROJECT_ID);

  it('fetches the project', async () => {
    const project = await mgmt.getProject();
    expect(project.id).toBe(NEON_PROJECT_ID);
    expect(project.name).toBeTruthy();
    expect(project.regionId).toBeTruthy();
  });

  it('lists existing branches including primary', async () => {
    const branches = await mgmt.listBranches();
    expect(branches.length).toBeGreaterThan(0);
    const primary = branches.find((b) => b.primary);
    expect(primary).toBeDefined();
  });

  it('lists endpoints with neon.tech host', async () => {
    const endpoints = await mgmt.listEndpoints();
    expect(endpoints.length).toBeGreaterThan(0);
    expect(endpoints[0].host).toContain('neon.tech');
  });

  it('throws DatabaseError on invalid API key', async () => {
    const bad = new NeonManagementClient('invalid-key', NEON_PROJECT_ID);
    await expect(bad.getProject()).rejects.toThrow(DatabaseError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NEON BRANCH LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_NEON_MGMT)('Neon branch lifecycle', () => {
  const mgmt = new NeonManagementClient(NEON_API_KEY, NEON_PROJECT_ID);
  let branchId: string | undefined;

  afterAll(async () => {
    if (branchId) await mgmt.deleteBranch(branchId).catch(() => {});
  });

  it('creates a branch', async () => {
    const name = `test-lifecycle-${Date.now()}`;
    const branch = await mgmt.createBranch(name);
    branchId = branch.id;
    expect(branch.name).toBe(name);
    expect(branch.projectId).toBe(NEON_PROJECT_ID);
    expect(branch.primary).toBe(false);
  });

  it('branch appears in list', async () => {
    const branches = await mgmt.listBranches();
    const found = branches.find((b) => b.id === branchId);
    expect(found).toBeDefined();
  });

  it('lists databases on new branch (default database exists)', async () => {
    if (!branchId) return;
    const dbs = await mgmt.listDatabases(branchId);
    expect(dbs.length).toBeGreaterThan(0);
    expect(dbs[0].branchId).toBe(branchId);
  });

  it('deletes the branch', async () => {
    if (!branchId) return;
    await expect(mgmt.deleteBranch(branchId)).resolves.not.toThrow();
    const branches = await mgmt.listBranches();
    expect(branches.find((b) => b.id === branchId)).toBeUndefined();
    branchId = undefined;
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NEON BRANCH BACKUP
// ═══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_NEON_MGMT)('Neon branch backup', () => {
  let svc: DatabaseService;
  const createdBranches: string[] = [];

  beforeAll(() => {
    svc = new DatabaseService({
      databaseUrl: DATABASE_URL,
      apiKey: NEON_API_KEY,
      projectId: NEON_PROJECT_ID,
    });
  });

  afterAll(async () => {
    for (const id of createdBranches) {
      await svc.deleteBranch(id).catch(() => {});
    }
    await svc.close();
  });

  it('creates a branch backup', async () => {
    const result = await svc.backup({ label: `integration-backup-${Date.now()}` });
    createdBranches.push(result.backup.data);

    expect(result.backup.type).toBe('branch');
    expect(result.backup.data).toBeTruthy();
    expect(result.message).toContain('branch backup created');
  });

  it('backup branch appears in branch list', async () => {
    const branches = await svc.listBranches();
    const found = branches.find((b) => createdBranches.includes(b.id));
    expect(found).toBeDefined();
  });

  it('restore from branch backup throws informative error with URI hint', async () => {
    const result = await svc.backup({ label: `restore-test-${Date.now()}` });
    createdBranches.push(result.backup.data);

    await expect(svc.restore(result.backup)).rejects.toThrow('cannot be restored automatically');
    await expect(svc.restore(result.backup)).rejects.toThrow('connection URI');
  });

  it('multiple backups create multiple branches', async () => {
    const before = (await svc.listBranches()).length;
    const r1 = await svc.backup({ label: `multi-1-${Date.now()}` });
    const r2 = await svc.backup({ label: `multi-2-${Date.now()}` });
    createdBranches.push(r1.backup.data, r2.backup.data);

    const after = (await svc.listBranches()).length;
    expect(after).toBe(before + 2);
  });
});
