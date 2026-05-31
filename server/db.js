const Database = require('better-sqlite3')
const path = require('path')
const bcrypt = require('bcryptjs')

const DB_PATH = path.join(__dirname, 'data.db')

let db

function getDb() {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    initTables()
    seedDefaults()
  }
  return db
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      email         TEXT,
      password_hash TEXT NOT NULL,
      avatar_url    TEXT,
      role          TEXT DEFAULT 'user',
      points        INTEGER DEFAULT 0,
      status        TEXT DEFAULT 'active',
      last_login_at TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );
  `)

  const columns = db.prepare('PRAGMA table_info(users)').all()
  const hasInviteCode = columns.some(c => c.name === 'invite_code')
  const hasInvitedBy = columns.some(c => c.name === 'invited_by')
  const hasPhone = columns.some(c => c.name === 'phone')
  const hasDisplayName = columns.some(c => c.name === 'display_name')

  if (!hasInviteCode) {
    db.exec('ALTER TABLE users ADD COLUMN invite_code TEXT')
  }
  if (!hasInvitedBy) {
    db.exec('ALTER TABLE users ADD COLUMN invited_by INTEGER')
  }
  if (!hasPhone) {
    db.exec('ALTER TABLE users ADD COLUMN phone TEXT')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone)')
  }
  if (!hasDisplayName) {
    db.exec('ALTER TABLE users ADD COLUMN display_name TEXT')
  }

  const hasTotalRecharge = columns.some(c => c.name === 'total_recharge_amount')
  if (!hasTotalRecharge) {
    db.exec('ALTER TABLE users ADD COLUMN total_recharge_amount REAL DEFAULT 0')
  }

  db.exec(`

    CREATE TABLE IF NOT EXISTS roles (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT UNIQUE NOT NULL,
      code          TEXT UNIQUE NOT NULL,
      description   TEXT,
      status        INTEGER DEFAULT 1,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      code          TEXT UNIQUE NOT NULL,
      type          TEXT DEFAULT 'menu',
      parent_id     INTEGER REFERENCES permissions(id),
      path          TEXT,
      icon          TEXT,
      sort_order    INTEGER DEFAULT 0,
      status        INTEGER DEFAULT 1,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id       INTEGER REFERENCES roles(id),
      permission_id INTEGER REFERENCES permissions(id),
      UNIQUE(role_id, permission_id)
    );

    CREATE TABLE IF NOT EXISTS redeem_codes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code          TEXT UNIQUE NOT NULL,
      points        INTEGER NOT NULL,
      status        TEXT DEFAULT 'active',
      used_by       INTEGER REFERENCES users(id),
      used_at       TEXT,
      batch_id      TEXT,
      created_by    TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      expires_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS points_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER REFERENCES users(id),
      amount        INTEGER NOT NULL,
      type          TEXT NOT NULL,
      description   TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS points_config (
      key         TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      cost        INTEGER NOT NULL,
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS operation_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER,
      username      TEXT,
      action        TEXT NOT NULL,
      detail        TEXT,
      ip            TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      model         TEXT NOT NULL,
      provider      TEXT NOT NULL,
      apiKey        TEXT NOT NULL,
      isActive      INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS recharge_orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER REFERENCES users(id),
      amount        INTEGER NOT NULL,
      points        INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      voucher_url   TEXT,
      voucher_note  TEXT,
      admin_note    TEXT,
      processed_by  TEXT,
      processed_at  TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS system_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER REFERENCES users(id),
      type          TEXT NOT NULL,
      title         TEXT,
      content       TEXT NOT NULL,
      birth_info    TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
  `)
}

function seedDefaults() {
  const adminCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('admin')

  if (adminCount.count === 0) {
    db.exec(`UPDATE sqlite_sequence SET seq = 101020 WHERE name = 'users'`)
    const hash = bcrypt.hashSync('admin123', 10)
    db.prepare('INSERT INTO users (id, username, phone, display_name, password_hash, role, points, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(101021, '13888888888', '13888888888', '管理员', hash, 'admin', 9999, 'active')
  } else {
    const admin = db.prepare('SELECT id, username, phone, display_name FROM users WHERE role = ?').get('admin')
    if (admin.id < 101021) {
      db.exec(`DELETE FROM users WHERE id = ${admin.id}`)
      db.exec(`DELETE FROM points_log WHERE user_id = ${admin.id}`)
      db.exec(`DELETE FROM operation_log WHERE user_id = ${admin.id}`)
      db.exec(`UPDATE sqlite_sequence SET seq = 101020 WHERE name = 'users'`)
      const hash = bcrypt.hashSync('admin123', 10)
      db.prepare('INSERT INTO users (id, username, phone, display_name, password_hash, role, points, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(101021, '13888888888', '13888888888', '管理员', hash, 'admin', 9999, 'active')
    } else if (!admin.phone || admin.phone !== '13888888888' || !admin.display_name || admin.username !== '13888888888') {
      const hash = bcrypt.hashSync('admin123', 10)
      db.prepare('UPDATE users SET username = ?, phone = ?, display_name = ?, password_hash = ? WHERE id = ?').run('13888888888', '13888888888', '管理员', hash, admin.id)
    }
  }

  const roleCount = db.prepare('SELECT COUNT(*) as count FROM roles').get()
  if (roleCount.count === 0) {
    db.exec(`
      INSERT INTO roles (name, code, description, status) VALUES
      ('系统管理员', 'admin', '拥有所有权限', 1),
      ('普通用户', 'user', '基本使用权限', 1),
      ('VIP用户', 'vip', '高级功能权限', 1)
    `)
  }

  const permCount = db.prepare('SELECT COUNT(*) as count FROM permissions').get()
  if (permCount.count === 0) {
    db.exec(`
      INSERT INTO permissions (name, code, type, parent_id, path, icon, sort_order, status) VALUES
      ('仪表盘', 'dashboard', 'menu', NULL, '/dashboard', 'HomeOutlined', 0, 1),
      ('用户管理', 'user:manage', 'menu', NULL, '/users', 'UserOutlined', 1, 1),
      ('用户列表', 'user:list', 'button', 2, '', '', 1, 1),
      ('用户详情', 'user:detail', 'button', 2, '', '', 2, 1),
      ('创建用户', 'user:create', 'button', 2, '', '', 3, 1),
      ('编辑用户', 'user:edit', 'button', 2, '', '', 4, 1),
      ('删除用户', 'user:delete', 'button', 2, '', '', 5, 1),
      ('重置密码', 'user:reset_pwd', 'button', 2, '', '', 6, 1),
      ('积分管理', 'user:points', 'button', 2, '', '', 7, 1),
      ('查看日志', 'user:logs', 'button', 2, '', '', 8, 1),
      ('角色管理', 'role:manage', 'menu', NULL, '/roles', 'TeamOutlined', 2, 1),
      ('角色列表', 'role:list', 'button', 11, '', '', 1, 1),
      ('创建角色', 'role:create', 'button', 11, '', '', 2, 1),
      ('编辑角色', 'role:edit', 'button', 11, '', '', 3, 1),
      ('删除角色', 'role:delete', 'button', 11, '', '', 4, 1),
      ('分配权限', 'role:assign', 'button', 11, '', '', 5, 1),
      ('API密钥', 'api_key:manage', 'menu', NULL, '/api-key', 'KeyOutlined', 3, 1),
      ('系统配置', 'system:config', 'menu', NULL, '/system-config', 'SettingOutlined', 4, 1),
      ('兑换码', 'redeem:manage', 'menu', NULL, '/redeem-code', 'GiftOutlined', 5, 1),
      ('积分配置', 'points:config', 'menu', NULL, '/points-config', 'DollarOutlined', 6, 1)
    `)

    db.exec(`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT 1, id FROM permissions
    `)
  }

  const configs = [
    { key: 'ai_chart', name: '排盘解读', cost: 160 },
    { key: 'ai_fortune', name: '年度运势', cost: 130 },
    { key: 'ai_kline', name: '人生K线', cost: 200 },
    { key: 'ai_match', name: '双人合盘', cost: 180 },
    { key: 'ai_followup', name: '追问对话', cost: 80 },
  ]
  const updateConfig = db.prepare('UPDATE points_config SET cost = ?, name = ? WHERE key = ?')
  const insertConfig = db.prepare('INSERT OR IGNORE INTO points_config (key, name, cost) VALUES (?, ?, ?)')
  for (const c of configs) {
    insertConfig.run(c.key, c.name, c.cost)
    updateConfig.run(c.cost, c.name, c.key)
  }

  const sysConfigs = [
    { key: 'new_user_points', value: '1000' },
    { key: 'default_provider', value: 'deepseek' },
    { key: 'enable_web_search', value: 'false' },
    { key: 'enable_thinking', value: 'false' },
    { key: 'recharge_wechat_qr', value: '' },
    { key: 'recharge_alipay_qr', value: '' },
    { key: 'recharge_packages', value: JSON.stringify([
      { amount: 3.99, points: 1000, label: '体验包', bonus: 0, limited: true, original_price: 9.9 },
      { amount: 29.9, points: 2000, label: '超值包', bonus: 1000, limited: false, original_price: null },
      { amount: 99, points: 5000, label: '推荐包', bonus: 3000, limited: false, original_price: null },
      { amount: 199, points: 10000, label: '豪华包', bonus: 6000, limited: false, original_price: null },
    ]) },
  ]
  const insertSys = db.prepare('INSERT OR IGNORE INTO system_config (key, value) VALUES (?, ?)')
  for (const s of sysConfigs) {
    insertSys.run(s.key, s.value)
  }

  const apiKeyCount = db.prepare('SELECT COUNT(*) as count FROM api_keys').get()
  if (apiKeyCount.count === 0) {
    const insertKey = db.prepare('INSERT INTO api_keys (model, provider, apiKey, isActive) VALUES (?, ?, ?, ?)')
    insertKey.run('DeepSeek', 'deepseek', 'sk-fabbdc5f98df466d920566ca9373f405', 1)
    insertKey.run('Kimi', 'kimi', 'your-kimi-api-key-here', 0)
    insertKey.run('Gemini', 'gemini', 'your-gemini-api-key-here', 0)
    insertKey.run('Claude', 'claude', 'your-claude-api-key-here', 0)
  }
}

function generateCode(length) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  if (length) {
    return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  }
  const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  return `ZW-${seg()}-${seg()}-${seg()}`
}

module.exports = { getDb, generateCode }
