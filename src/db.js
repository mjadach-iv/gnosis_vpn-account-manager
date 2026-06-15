// MySQL access: bootstrap the database + schema, version/migrate, and the
// account queries used by the CLI.

import mysql from 'mysql2/promise';

const SCHEMA_VERSION = 1;

// Connect with no database selected, create it if missing, then return a pool
// bound to it. Runs migrations before handing the pool back.
export async function connect(mysqlConfig) {
  const { host, user, password, database } = mysqlConfig;

  // 1. Try to ensure the database exists (connect without selecting one).
  //    On shared hosting the account often lacks CREATE DATABASE privilege and
  //    the database is pre-provisioned — tolerate that and proceed to step 2.
  try {
    const admin = await mysql.createConnection({ host, user, password });
    try {
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
    } finally {
      await admin.end();
    }
  } catch {
    // Either we can't connect without a database, or we lack CREATE privilege.
    // Assume the database already exists and let the pool connection surface
    // any real error.
  }

  // 2. Open a pool on the database.
  const pool = mysql.createPool({
    host,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 4,
  });

  await migrate(pool);
  return pool;
}

// Create tables if needed and apply forward migration steps based on db_version.
async function migrate(pool) {
  // `common` holds key/value config including the schema version.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS common (
      name VARCHAR(2000),
      variable VARCHAR(2000)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255),
      address VARCHAR(42),
      safe VARCHAR(42),
      network VARCHAR(32),
      blokli_url VARCHAR(255),
      time_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      id_blob LONGTEXT,
      pass_blob LONGTEXT,
      safe_blob LONGTEXT,
      UNIQUE KEY uq_address (address)
    )
  `);

  let version = await getVersion(pool);
  if (version === null) {
    // Fresh schema => seed at the current version.
    await pool.query(`INSERT INTO common (name, variable) VALUES ('db_version', ?)`, [
      String(SCHEMA_VERSION),
    ]);
    version = SCHEMA_VERSION;
  }

  // Forward migration steps go here as the schema evolves, e.g.:
  // if (version < 2) { await pool.query(...); version = 2; await setVersion(pool, 2); }
}

async function getVersion(pool) {
  const [rows] = await pool.query(`SELECT variable FROM common WHERE name = 'db_version' LIMIT 1`);
  return rows.length ? Number(rows[0].variable) : null;
}

// eslint-disable-next-line no-unused-vars -- reserved for future migration steps
async function setVersion(pool, version) {
  await pool.query(`UPDATE common SET variable = ? WHERE name = 'db_version'`, [String(version)]);
}

// --- Account queries -------------------------------------------------------

export async function listAccounts(pool) {
  const [rows] = await pool.query(
    `SELECT id, name, address, safe, network, blokli_url, time_added
       FROM accounts ORDER BY id`,
  );
  return rows;
}

export async function countAccounts(pool) {
  const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM accounts`);
  return Number(rows[0]?.n ?? 0);
}

export async function getAccountById(pool, id) {
  const [rows] = await pool.query(`SELECT * FROM accounts WHERE id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

export async function findByAddress(pool, address) {
  const [rows] = await pool.query(`SELECT * FROM accounts WHERE address = ? LIMIT 1`, [address]);
  return rows[0] || null;
}

// Delete an account by id. Returns true if a row was removed.
export async function deleteAccount(pool, id) {
  const [res] = await pool.query(`DELETE FROM accounts WHERE id = ?`, [id]);
  return res.affectedRows > 0;
}

// Update mutable fields of an existing account row. Only keys present in
// `fields` (and on the allowlist) are written. Returns true if a row changed.
export async function updateAccount(pool, id, fields) {
  const allowed = ['name', 'safe', 'network', 'blokli_url', 'safe_blob'];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(fields[key]);
    }
  }
  if (!sets.length) return false;
  vals.push(id);
  const [res] = await pool.query(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, vals);
  return res.affectedRows > 0;
}

// Insert a new account. Returns the inserted row id.
export async function insertAccount(pool, account) {
  const { name, address, safe, network, blokli_url, id_blob, pass_blob, safe_blob } = account;
  const [result] = await pool.query(
    `INSERT INTO accounts (name, address, safe, network, blokli_url, id_blob, pass_blob, safe_blob)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, address, safe, network, blokli_url, id_blob, pass_blob, safe_blob],
  );
  return result.insertId;
}
