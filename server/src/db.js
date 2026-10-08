import mysql from 'mysql2/promise';

export function createPool(cfg) {
  const pool = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: cfg.db.database,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
    decimalNumbers: true, // DECIMAL columns come back as numbers, not strings
    dateStrings: true,    // DATE/DATETIME come back as 'YYYY-MM-DD…' strings, never timezone-shifted Dates
    timezone: 'Z',
  });
  // Everything runs in UTC so dates mean the same wherever the server lives.
  pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));
  return pool;
}

// Run fn inside a transaction; commit if it returns, roll back if it throws.
//
// READ COMMITTED means every read sees the latest committed data (never a stale
// snapshot taken before we got the lock). Together with the rule "lock the
// joiner's row first" this is what keeps two things touching one person's
// money from double-spending. If the database still picks us as a deadlock
// victim, the whole transaction is simply run again.
export async function withTx(pool, fn, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      try { await conn.rollback(); } catch { /* ignore */ }
      if (err && err.code === 'ER_LOCK_DEADLOCK' && attempt < attempts) continue;
      throw err;
    } finally {
      conn.release();
    }
  }
}
