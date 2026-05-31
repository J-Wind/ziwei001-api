const express = require('express')
const cors = require('cors')
require('dotenv').config()
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const path = require('path')

const { getDb, generateCode } = require('./db')
const { signToken, authRequired, adminRequired } = require('./middleware/auth')

// Zpay 支付配置
const ZPAY_CONFIG = {
  gateway: 'https://zpayz.cn',
  pid: '2026052417473392',
  key: 'M5tRhma7EpzS2Y89tQyT2dWsvaRCxChi',
  cid: '17523',
}

// MD5 签名算法
function generateZpaySign(params) {
  const sortedKeys = Object.keys(params).filter(key => 
    key !== 'sign' && key !== 'sign_type' && params[key] !== '' && params[key] !== undefined && params[key] !== null
  ).sort()

  const signStr = sortedKeys.map(key => `${key}=${params[key]}`).join('&')
  const stringToSign = signStr + ZPAY_CONFIG.key
  
  return crypto.createHash('md5').update(stringToSign).digest('hex')
}

// 验证 Zpay 回调签名
function verifyZpaySign(params) {
  const receivedSign = params.sign
  if (!receivedSign) return false
  
  const calculatedSign = generateZpaySign(params)
  return receivedSign === calculatedSign
}

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))
app.use(express.json())
app.use('/avatars', express.static(path.join(__dirname, '../public/avatars')))



app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.post('/api/fix-admin', (req, res) => {
  const db = getDb()
  const hash = bcrypt.hashSync('admin123', 10)
  const result = db.prepare('UPDATE users SET username = ?, phone = ?, display_name = ?, password_hash = ? WHERE role = ?').run('13888888888', '13888888888', '管理员', hash, 'admin')
  res.json({ success: true, changes: result.changes })
})

// ============================================================
// 公开接口
// ============================================================

app.get('/api/config', (req, res) => {
  const db = getDb()
  const defaultProvider = db.prepare("SELECT value FROM system_config WHERE key = 'default_provider'").get()?.value || 'deepseek'
  const pointsConfigs = db.prepare('SELECT * FROM points_config').all()
  res.json({
    models: [
      { value: 'kimi', label: 'Kimi (月之暗面)' },
      { value: 'gemini', label: 'Gemini (Google)' },
      { value: 'claude', label: 'Claude (Anthropic)' },
      { value: 'deepseek', label: 'DeepSeek' },
    ],
    defaultProvider,
    pointsConfig: pointsConfigs,
  })
})

app.get('/api/points/config', (req, res) => {
  const db = getDb()
  const configs = db.prepare('SELECT * FROM points_config').all()
  res.json(configs)
})

// ============================================================
// 充值接口 (需登录)
// ============================================================

app.get('/api/recharge/config', authRequired, (req, res) => {
  const db = getDb()
  const wechatQR = db.prepare("SELECT value FROM system_config WHERE key = 'recharge_wechat_qr'").get()?.value || ''
  const alipayQR = db.prepare("SELECT value FROM system_config WHERE key = 'recharge_alipay_qr'").get()?.value || ''
  const packagesStr = db.prepare("SELECT value FROM system_config WHERE key = 'recharge_packages'").get()?.value || '[]'
  
  res.json({
    wechatQR,
    alipayQR,
    packages: JSON.parse(packagesStr),
  })
})

app.post('/api/recharge/apply', authRequired, (req, res) => {
  const { amount, points, payment_method, voucher_url, voucher_note } = req.body
  
  if (!amount || !points || !payment_method) {
    return res.status(400).json({ error: '请填写完整信息' })
  }
  
  if (!['wechat', 'alipay'].includes(payment_method)) {
    return res.status(400).json({ error: '支付方式不支持' })
  }
  
  const db = getDb()
  
  // 生成唯一订单号
  const orderNo = 'RC' + Date.now() + Math.random().toString(36).substr(2, 6).toUpperCase()
  
  const result = db.prepare(
    'INSERT INTO recharge_orders (user_id, amount, points, payment_method, voucher_url, voucher_note, order_no) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, amount, points, payment_method, voucher_url || null, voucher_note || null, orderNo)
  
  const order = db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(result.lastInsertRowid)
  
  res.json({ success: true, order })
})

// 订单状态查询
app.get('/api/recharge/order/:order_no', authRequired, (req, res) => {
  const db = getDb()
  const order = db.prepare('SELECT * FROM recharge_orders WHERE order_no = ? AND user_id = ?').get(req.params.order_no, req.user.id)
  
  if (!order) {
    return res.status(404).json({ error: '订单不存在' })
  }
  
  // 获取当前积分
  const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id)
  
  res.json({ order, current_points: user.points })
})

// 查询待处理订单（供手机端调用）
app.get('/api/recharge/pending', (req, res) => {
  const { amount, payment_method, secret } = req.query
  
  if (!amount || !payment_method || !secret) {
    return res.status(400).json({ error: '参数不完整' })
  }
  
  // 验证密钥
  if (secret !== process.env.RECHARGE_SECRET) {
    return res.status(403).json({ error: '密钥错误' })
  }
  
  const db = getDb()
  
  // 查找匹配的待处理订单（金额和支付方式匹配，5分钟内的订单）
  const order = db.prepare(
    "SELECT * FROM recharge_orders WHERE status = 'pending' AND amount = ? AND payment_method = ? AND created_at > datetime('now', '-5 minutes') ORDER BY created_at DESC LIMIT 1"
  ).get(parseFloat(amount), payment_method)
  
  if (!order) {
    return res.json({ order: null })
  }
  
  res.json({ order })
})

// 自动审核回调接口（供手机端调用）
app.post('/api/recharge/callback', async (req, res) => {
  const { order_no, amount, payment_method, transaction_id, secret } = req.body
  
  if (!order_no || !amount || !secret) {
    return res.status(400).json({ error: '参数不完整' })
  }
  
  // 验证密钥
  if (secret !== process.env.RECHARGE_SECRET) {
    return res.status(403).json({ error: '密钥错误' })
  }
  
  const db = getDb()
  const order = db.prepare('SELECT * FROM recharge_orders WHERE order_no = ?').get(order_no)
  
  if (!order) {
    return res.status(404).json({ error: '订单不存在' })
  }
  
  if (order.status !== 'pending') {
    return res.status(400).json({ error: '订单已处理' })
  }
  
  // 验证金额是否匹配
  if (parseFloat(order.amount) !== parseFloat(amount)) {
    return res.status(400).json({ error: '金额不匹配' })
  }
  
  // 验证支付方式是否匹配
  if (order.payment_method !== payment_method) {
    return res.status(400).json({ error: '支付方式不匹配' })
  }
  
  // 自动审核通过
  const transaction = db.transaction(() => {
    db.prepare(
      "UPDATE recharge_orders SET status = 'approved', admin_note = ?, processed_by = 'auto', processed_at = datetime('now'), updated_at = datetime('now'), transaction_id = ? WHERE id = ?"
    ).run('自动审核通过', transaction_id || null, order.id)
    
    db.prepare("UPDATE users SET points = points + ?, updated_at = datetime('now') WHERE id = ?").run(order.points, order.user_id)
    db.prepare('INSERT INTO points_log (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(
      order.user_id, order.points, 'recharge', `充值 ${order.amount} 元获得 ${order.points} 积分（自动审核）`
    )
    db.prepare('INSERT INTO operation_log (user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(
      order.user_id, 'system', 'recharge_auto_approve', 
      JSON.stringify({ order_id: order.id, order_no, amount: order.amount, points: order.points, transaction_id }), 
      req.ip
    )
  })
  
  try {
    transaction()
    const user = db.prepare('SELECT points FROM users WHERE id = ?').get(order.user_id)
    res.json({ success: true, current_points: user.points, message: '充值成功' })
  } catch (err) {
    console.error('Auto approve error:', err)
    res.status(500).json({ error: '自动审核失败' })
  }
})

// ============================================================
// Zpay 在线支付接口
// ============================================================

// 创建 Zpay 支付订单（获取二维码）
app.post('/api/recharge/zpay/create', authRequired, async (req, res) => {
  const { amount, points, type = 'alipay' } = req.body
  
  if (!amount || !points) {
    return res.status(400).json({ error: '请选择充值套餐' })
  }
  
  const db = getDb()
  
  // 生成唯一订单号
  const orderNo = 'ZP' + Date.now() + Math.random().toString(36).substr(2, 6).toUpperCase()
  
  // 创建本地订单记录
  const result = db.prepare(
    'INSERT INTO recharge_orders (user_id, amount, points, payment_method, order_no, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, amount, points, type, orderNo, 'pending')
  
  // 构建 Zpay 支付参数（使用 mapi.php 获取二维码）
  const notifyUrl = `${req.protocol}://${req.get('host')}/api/recharge/zpay/notify`
  const clientIp = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1'
  
  // 检测设备类型（支持手机端跳转）
  const userAgent = req.headers['user-agent'] || ''
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent)
  const device = isMobile ? 'mobile' : 'pc'

  console.log(`设备检测: ${isMobile ? '📱 手机端' : '💻 PC端'} (${device})`)

  const payParams = {
    pid: ZPAY_CONFIG.pid,
    type: type,
    out_trade_no: orderNo,
    notify_url: notifyUrl,
    name: `紫微斗数积分充值-${points}积分`,
    money: amount.toFixed(2),
    clientip: clientIp,
    cid: ZPAY_CONFIG.cid,
    sign_type: 'MD5',
    device: device,
  }
  
  // 生成签名
  payParams.sign = generateZpaySign(payParams)
  
  try {
    // 调用 Zpay mapi.php 接口获取支付信息
    const formData = new URLSearchParams()
    Object.keys(payParams).forEach(key => formData.append(key, payParams[key]))
    
    const response = await fetch(`${ZPAY_CONFIG.gateway}/mapi.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    })
    
    const data = await response.json()
    
    if (data.code === 1 && data.qrcode) {
      res.json({
        success: true,
        orderNo,
        qrcode: data.qrcode,
        img: data.img || null,
        trade_no: data.trade_no,
        message: '订单创建成功',
      })
    } else if (data.code === 1 && data.payurl) {
      res.json({
        success: true,
        orderNo,
        payUrl: data.payurl,
        qrcode: null,
        message: '订单创建成功',
      })
    } else {
      console.error('Zpay API error:', data)
      res.status(400).json({ error: data.msg || '创建支付订单失败' })
    }
  } catch (err) {
    console.error('Zpay request error:', err)
    res.status(500).json({ error: '支付服务暂时不可用，请稍后重试' })
  }
})

// Zpay 异步通知回调（服务器对服务器，无需登录）
app.get('/api/recharge/zpay/notify', (req, res) => {
  console.log('Zpay notify received:', req.query)
  
  const { pid, trade_no, out_trade_no, type, name, money, trade_status, param, sign, sign_type } = req.query
  
  // 验证签名
  if (!verifyZpaySign(req.query)) {
    console.error('Zpay notify sign verification failed')
    return res.status(400).send('sign error')
  }
  
  // 验证商户ID
  if (pid !== ZPAY_CONFIG.pid) {
    console.error('Zpay notify pid mismatch')
    return res.status(400).send('pid error')
  }
  
  // 检查支付状态
  if (trade_status !== 'TRADE_SUCCESS') {
    return res.send('success')
  }
  
  const db = getDb()
  
  // 查找订单
  const order = db.prepare('SELECT * FROM recharge_orders WHERE order_no = ?').get(out_trade_no)
  
  if (!order) {
    console.error('Zpay notify order not found:', out_trade_no)
    return res.send('success')
  }
  
  // 检查订单状态，避免重复处理
  if (order.status === 'approved') {
    return res.send('success')
  }
  
  // 验证金额
  if (parseFloat(order.amount) !== parseFloat(money)) {
    console.error('Zpay notify amount mismatch:', order.amount, money)
    return res.send('success')
  }
  
  // 更新订单状态并增加积分
  const transaction = db.transaction(() => {
    db.prepare(
      "UPDATE recharge_orders SET status = 'approved', trade_no = ?, admin_note = ?, processed_by = 'zpay', processed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(trade_no, `Zpay在线支付成功 - 交易号:${trade_no}`, order.id)
    
    db.prepare("UPDATE users SET points = points + ?, updated_at = datetime('now') WHERE id = ?").run(order.points, order.user_id)
    db.prepare('INSERT INTO points_log (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(
      order.user_id, order.points, 'recharge', `在线充值 ${order.amount} 元获得 ${order.points} 积分`
    )
    db.prepare('INSERT INTO operation_log (user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(
      order.user_id, 'system', 'zpay_payment_success',
      JSON.stringify({ order_id: order.id, order_no: out_trade_no, trade_no, amount: money, points: order.points }),
      req.ip
    )
  })
  
  try {
    transaction()
    console.log('Zpay payment success:', out_trade_no, trade_no)
  } catch (err) {
    console.error('Zpay notify process error:', err)
  }
  
  res.send('success')
})

// Zpay 支付结果查询
app.get('/api/recharge/zpay/query/:order_no', authRequired, async (req, res) => {
  const db = getDb()
  const order = db.prepare('SELECT * FROM recharge_orders WHERE order_no = ? AND user_id = ?').get(req.params.order_no, req.user.id)

  if (!order) {
    return res.status(404).json({ error: '订单不存在' })
  }

  try {
    if (order.status === 'pending') {
      const queryUrl = `${ZPAY_CONFIG.gateway}/api.php?act=order&pid=${ZPAY_CONFIG.pid}&key=${ZPAY_CONFIG.key}&out_trade_no=${order.order_no}`

      const response = await fetch(queryUrl)
      const data = await response.json()

      if (data.code === 1 && data.status === 1) {
        db.prepare('UPDATE recharge_orders SET status = ?, trade_no = ? WHERE id = ?')
          .run('approved', data.trade_no, order.id)

        ensurePointsCredited(db, order)

        return res.json({
          order_no: order.order_no,
          status: 'approved',
          amount: order.amount,
          points: order.points,
          created_at: order.created_at,
          trade_no: data.trade_no,
        })
      }
    }

    if (order.status === 'approved') {
      ensurePointsCredited(db, order)
    }

    res.json({
      order_no: order.order_no,
      status: order.status,
      amount: order.amount,
      points: order.points,
      created_at: order.created_at,
      trade_no: order.trade_no || null,
    })
  } catch (err) {
    console.error('Query Zpay error:', err)
    res.json({
      order_no: order.order_no,
      status: order.status,
      amount: order.amount,
      points: order.points,
      created_at: order.created_at,
      trade_no: order.trade_no || null,
    })
  }
})

function ensurePointsCredited(db, order) {
  const existingLog = db.prepare('SELECT id FROM points_log WHERE type = ? AND description LIKE ?')
    .get('recharge', `%${order.order_no}%`)

  if (!existingLog) {
    console.log('🔴 积分补偿：订单已approved但无积分流水，正在补发 | order_no=%s user_id=%s points=%s',
      order.order_no, order.user_id, order.points)

    const txn = db.transaction(() => {
      db.prepare('INSERT INTO points_log (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(
        order.user_id, order.points, 'recharge',
        `在线充值 ${order.amount} 元获得 ${order.points} 积分${order.processed_by ? `（${order.processed_by}）` : ''}`
      )
      db.prepare("UPDATE users SET points = points + ?, updated_at = datetime('now') WHERE id = ?").run(order.points, order.user_id)
      db.prepare('INSERT INTO operation_log (user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(
        order.user_id, 'system', 'points_compensation',
        JSON.stringify({ order_id: order.id, order_no: order.order_no, amount: order.amount, points: order.points }),
        '127.0.0.1'
      )
    })

    try {
      txn()
      console.log('✅ 积分补偿成功 | order_no=%s 补发积分=%s', order.order_no, order.points)
    } catch (err) {
      console.error('❌ 积分补偿失败:', err)
    }
  }
}

app.get('/api/recharge/history', authRequired, (req, res) => {
  const db = getDb()
  const limit = Math.min(parseInt(req.query.limit) || 20, 100)
  const offset = parseInt(req.query.offset) || 0
  
  const orders = db.prepare(
    'SELECT * FROM recharge_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(req.user.id, limit, offset)
  
  const total = db.prepare('SELECT COUNT(*) as count FROM recharge_orders WHERE user_id = ?').get(req.user.id)
  
  res.json({ orders, total: total.count, limit, offset })
})

// ============================================================
// 管理端充值审核接口 (需 admin 权限)
// ============================================================

app.get('/api/admin/recharge/orders', adminRequired, (req, res) => {
  const db = getDb()
  const status = req.query.status
  const order_no = req.query.order_no
  const user_id = req.query.user_id
  const start_date = req.query.start_date
  const end_date = req.query.end_date
  const limit = Math.min(parseInt(req.query.limit) || 50, 200)
  const offset = parseInt(req.query.offset) || 0

  let query = 'SELECT o.*, u.username FROM recharge_orders o LEFT JOIN users u ON o.user_id = u.id'
  let countQuery = 'SELECT COUNT(*) as count FROM recharge_orders o'
  let params = []
  let countParams = []

  const conditions = []

  if (status && status !== 'all') {
    conditions.push('o.status = ?')
    params.push(status)
    countParams.push(status)
  }

  if (order_no) {
    conditions.push('(o.order_no LIKE ? OR o.trade_no LIKE ?)')
    params.push(`%${order_no}%`, `%${order_no}%`)
    countParams.push(`%${order_no}%`, `%${order_no}%`)
  }

  if (user_id) {
    conditions.push('o.user_id = ?')
    params.push(parseInt(user_id))
    countParams.push(parseInt(user_id))
  }

  if (start_date) {
    conditions.push('o.created_at >= ?')
    params.push(start_date + ' 00:00:00')
    countParams.push(start_date + ' 00:00:00')
  }

  if (end_date) {
    conditions.push('o.created_at <= ?')
    params.push(end_date + ' 23:59:59')
    countParams.push(end_date + ' 23:59:59')
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ')
    countQuery += ' WHERE ' + conditions.join(' AND ')
  }

  query += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const orders = db.prepare(query).all(...params)
  const total = db.prepare(countQuery).get(...countParams)

  let amountSumQuery = 'SELECT COALESCE(SUM(amount), 0) as amount_sum FROM recharge_orders o WHERE o.status = \'approved\''
  let amountSumParams = []

  if (user_id) {
    amountSumQuery += ' AND o.user_id = ?'
    amountSumParams.push(parseInt(user_id))
  }
  if (start_date) {
    amountSumQuery += ' AND o.created_at >= ?'
    amountSumParams.push(start_date + ' 00:00:00')
  }
  if (end_date) {
    amountSumQuery += ' AND o.created_at <= ?'
    amountSumParams.push(end_date + ' 23:59:59')
  }

  const amountSumResult = db.prepare(amountSumQuery).get(...amountSumParams)

  res.json({
    orders,
    total: total.count,
    limit,
    offset,
    amountSum: amountSumResult?.amount_sum || 0,
  })
})

app.post('/api/admin/recharge/audit', adminRequired, (req, res) => {
  const { order_id, action, admin_note } = req.body
  
  if (!order_id || !['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: '参数错误' })
  }
  
  const db = getDb()
  const order = db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(order_id)
  
  if (!order) {
    return res.status(404).json({ error: '订单不存在' })
  }
  
  if (order.status !== 'pending') {
    return res.status(400).json({ error: '订单已处理' })
  }
  
  const updateOrder = db.prepare(
    "UPDATE recharge_orders SET status = ?, admin_note = ?, processed_by = ?, processed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  )
  
  if (action === 'approve') {
    const transaction = db.transaction(() => {
      updateOrder.run('approved', admin_note || null, req.user.username, order_id)
      db.prepare("UPDATE users SET points = points + ?, updated_at = datetime('now') WHERE id = ?").run(order.points, order.user_id)
      db.prepare('INSERT INTO points_log (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(
        order.user_id, order.points, 'recharge', `充值 ${order.amount} 元获得 ${order.points} 积分`
      )
      db.prepare('INSERT INTO operation_log (user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(
        req.user.id, req.user.username, 'recharge_approve', 
        JSON.stringify({ order_id, user_id: order.user_id, amount: order.amount, points: order.points }), 
        req.ip
      )
    })
    
    try {
      transaction()
      const user = db.prepare('SELECT points FROM users WHERE id = ?').get(order.user_id)
      res.json({ success: true, current_points: user.points })
    } catch (err) {
      console.error('Approve error:', err)
      res.status(500).json({ error: '审核失败' })
    }
  } else {
    try {
      updateOrder.run('rejected', admin_note || null, req.user.username, order_id)
      db.prepare('INSERT INTO operation_log (user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(
        req.user.id, req.user.username, 'recharge_reject', 
        JSON.stringify({ order_id, user_id: order.user_id, amount: order.amount }), 
        req.ip
      )
      res.json({ success: true })
    } catch (err) {
      console.error('Reject error:', err)
      res.status(500).json({ error: '审核失败' })
    }
  }
})

app.get('/api/admin/recharge/config', adminRequired, (req, res) => {
  const db = getDb()
  const wechatQR = db.prepare("SELECT value FROM system_config WHERE key = 'recharge_wechat_qr'").get()?.value || ''
  const alipayQR = db.prepare("SELECT value FROM system_config WHERE key = 'recharge_alipay_qr'").get()?.value || ''
  const packagesStr = db.prepare("SELECT value FROM system_config WHERE key = 'recharge_packages'").get()?.value || '[]'

  res.json({
    wechatQR,
    alipayQR,
    packages: JSON.parse(packagesStr),
  })
})

app.put('/api/admin/recharge/config', adminRequired, (req, res) => {
  const db = getDb()
  const { wechatQR, alipayQR, packages } = req.body
  
  const upsert = db.prepare('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)')
  
  if (wechatQR !== undefined) upsert.run('recharge_wechat_qr', wechatQR)
  if (alipayQR !== undefined) upsert.run('recharge_alipay_qr', alipayQR)
  if (packages !== undefined) upsert.run('recharge_packages', JSON.stringify(packages))
  
  res.json({ success: true })
})

// ============================================================
// 认证接口
// ============================================================

app.post('/api/auth/register', (req, res) => {
  const { phone, password, invite_code } = req.body
  if (!phone || !password) {
    return res.status(400).json({ error: '手机号和密码不能为空' })
  }
  const phoneRegex = /^1[3-9]\d{9}$/
  if (!phoneRegex.test(phone)) {
    return res.status(400).json({ error: '请输入正确的11位手机号' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 个字符' })
  }

  const db = getDb()
  const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone)
  if (existing) {
    return res.status(409).json({ error: '该手机号已注册' })
  }

  const passwordHash = bcrypt.hashSync(password, 10)
  const newUserPoints = parseInt(
    db.prepare("SELECT value FROM system_config WHERE key = 'new_user_points'").get()?.value || '300'
  )

  let invitedBy = null
  let inviteBonus = 0
  let inviteRewardPoints = 0

  if (invite_code) {
    const inviter = db.prepare('SELECT id FROM users WHERE invite_code = ?').get(invite_code.toUpperCase())
    if (inviter) {
      invitedBy = inviter.id
      const inviteConfig = db.prepare("SELECT value FROM system_config WHERE key = 'invite_points'").get()
      inviteBonus = parseInt(inviteConfig?.value || '500')
      inviteRewardPoints = inviteBonus
    }
  }

  let newInviteCode = generateCode(6)
  let attempts = 0
  while (db.prepare('SELECT id FROM users WHERE invite_code = ?').get(newInviteCode) && attempts < 10) {
    newInviteCode = generateCode(6)
    attempts++
  }

  const displayName = phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')
  const defaultAvatar = `/avatars/avatar_${Math.floor(Math.random() * 9) + 1}.png`

  const result = db.prepare('INSERT INTO users (username, phone, display_name, password_hash, points, invite_code, invited_by, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    phone, phone, displayName, passwordHash, newUserPoints + inviteBonus, newInviteCode, invitedBy, defaultAvatar
  )
  const user = db.prepare('SELECT id, username, phone, display_name, email, avatar_url, role, points, invite_code, created_at FROM users WHERE id = ?').get(result.lastInsertRowid)

  if (newUserPoints > 0) {
    db.prepare('INSERT INTO points_log (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(
      user.id, newUserPoints, 'register', '新人注册赠送积分'
    )
  }

  if (inviteBonus > 0) {
    db.prepare('INSERT INTO points_log (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(
      user.id, inviteBonus, 'invite', `使用邀请码获得 ${inviteBonus} 积分`
    )
    db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(inviteRewardPoints, invitedBy)
    db.prepare('INSERT INTO points_log (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(
      invitedBy, inviteRewardPoints, 'invite_reward', `邀请新用户 ${phone} 获得 ${inviteRewardPoints} 积分`
    )
  }

  db.prepare('INSERT INTO operation_log (user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(
    user.id, user.username, 'register', JSON.stringify({ phone, invite_code: invite_code || null }), req.ip
  )

  const token = signToken({ id: user.id, username: user.username, role: user.role })
  res.json({ token, user })
})

app.post('/api/auth/login', (req, res) => {
  const { phone, password } = req.body
  if (!phone || !password) {
    return res.status(400).json({ error: '手机号和密码不能为空' })
  }

  const db = getDb()
  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone)
  if (!user) {
    user = db.prepare('SELECT * FROM users WHERE username = ?').get(phone)
  }
  if (!user) {
    return res.status(401).json({ error: '手机号或密码错误' })
  }

  const valid = bcrypt.compareSync(password, user.password_hash)
  if (!valid) {
    return res.status(401).json({ error: '手机号或密码错误' })
  }

  if (user.status === 'disabled') {
    return res.status(403).json({ error: '账号已被禁用，请联系管理员' })
  }

  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id)

  db.prepare('INSERT INTO operation_log (user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(
    user.id, user.username, 'login', null, req.ip
  )

  const token = signToken({ id: user.id, username: user.username, role: user.role })
  const { password_hash, ...safeUser } = user
  res.json({ token, user: safeUser })
})

// ============================================================
// 用户接口 (需登录)
// ============================================================

app.get('/api/user/me', authRequired, (req, res) => {
  const db = getDb()
  const user = db.prepare('SELECT id, username, phone, display_name, email, avatar_url, role, points, invite_code, created_at FROM users WHERE id = ?').get(req.user.id)
  if (!user) return res.status(404).json({ error: '用户不存在' })
  res.json(user)
})

app.put('/api/user/me', authRequired, (req, res) => {
  const { email, avatar_url, display_name } = req.body
  const db = getDb()

  const updates = {}
  if (email !== undefined) updates.email = email
  if (avatar_url !== undefined) updates.avatar_url = avatar_url
  if (display_name !== undefined) updates.display_name = display_name

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: '无更新内容' })
  }

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ')
  const values = [...Object.values(updates), req.user.id]
  db.prepare(`UPDATE users SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`).run(...values)

  const user = db.prepare('SELECT id, username, phone, display_name, email, avatar_url, role, points, invite_code, created_at FROM users WHERE id = ?').get(req.user.id)

  if (display_name !== undefined) {
    db.prepare('INSERT INTO operation_log (user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(
      req.user.id, req.user.username, 'update_display_name', JSON.stringify({ display_name }), req.ip
    )
  }

  res.json(user)
})

app.get('/api/user/points-log', authRequired, (req, res) => {
  const db = getDb()
  const limit = Math.min(parseInt(req.query.limit) || 50, 200)
  const offset = parseInt(req.query.offset) || 0
  const logs = db.prepare('SELECT * FROM points_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(req.user.id, limit, offset)
  const total = db.prepare('SELECT COUNT(*) as count FROM points_log WHERE user_id = ?').get(req.user.id)
  res.json({ logs, total: total.count, limit, offset })
})

app.post('/api/user/history', authRequired, (req, res) => {
  const { type, title, content, birth_info } = req.body
  if (!type || !content) return res.status(400).json({ error: '类型和内容不能为空' })

  const db = getDb()
  const result = db.prepare('INSERT INTO chat_history (user_id, type, title, content, birth_info) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id, type, title || null, content, birth_info ? JSON.stringify(birth_info) : null
  )
  res.json({ success: true, id: result.lastInsertRowid })
})

app.get('/api/user/history', authRequired, (req, res) => {
  const db = getDb()
  const type = req.query.type || ''
  const limit = Math.min(parseInt(req.query.limit) || 50, 200)
  const offset = parseInt(req.query.offset) || 0

  let histories, total
  if (type) {
    histories = db.prepare('SELECT id, type, title, content, birth_info, created_at FROM chat_history WHERE user_id = ? AND type = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(req.user.id, type, limit, offset)
    total = db.prepare('SELECT COUNT(*) as count FROM chat_history WHERE user_id = ? AND type = ?').get(req.user.id, type)
  } else {
    histories = db.prepare('SELECT id, type, title, content, birth_info, created_at FROM chat_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(req.user.id, limit, offset)
    total = db.prepare('SELECT COUNT(*) as count FROM chat_history WHERE user_id = ?').get(req.user.id)
  }

  histories = histories.map(h => ({
    ...h,
    birth_info: h.birth_info ? JSON.parse(h.birth_info) : null,
  }))

  res.json({ histories, total: total.count, limit, offset })
})

app.get('/api/user/history/:id', authRequired, (req, res) => {
  const db = getDb()
  const history = db.prepare('SELECT id, type, title, content, birth_info, created_at FROM chat_history WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id)
  if (!history) return res.status(404).json({ error: '记录不存在' })

  res.json({
    ...history,
    birth_info: history.birth_info ? JSON.parse(history.birth_info) : null,
  })
})

app.delete('/api/user/history/:id', authRequired, (req, res) => {
  const db = getDb()
  const result = db.prepare('DELETE FROM chat_history WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id)
  if (result.changes === 0) return res.status(404).json({ error: '记录不存在' })
  res.json({ success: true })
})

// ============================================================
// 兑换码接口
// ============================================================

app.post('/api/redeem/use', authRequired, (req, res) => {
  const { code } = req.body
  if (!code) return res.status(400).json({ error: '请输入兑换码' })

  const db = getDb()
  const normalized = code.trim().toUpperCase()

  const redeem = db.prepare("SELECT * FROM redeem_codes WHERE code = ?").get(normalized)
  if (!redeem) return res.status(404).json({ error: '兑换码无效' })
  if (redeem.status !== 'active') return res.status(400).json({ error: '该兑换码已被使用或已过期' })
  if (redeem.expires_at && new Date(redeem.expires_at) < new Date()) {
    db.prepare('UPDATE redeem_codes SET status = ? WHERE id = ?').run('expired', redeem.id)
    return res.status(400).json({ error: '该兑换码已过期' })
  }

  const updateRedeem = db.prepare("UPDATE redeem_codes SET status = 'used', used_by = ?, used_at = datetime('now') WHERE id = ?")
  const updateUser = db.prepare("UPDATE users SET points = points + ?, updated_at = datetime('now') WHERE id = ?")
  const insertLog = db.prepare('INSERT INTO points_log (user_id, amount, type, description) VALUES (?, ?, ?, ?)')
  const insertOp = db.prepare('INSERT INTO operation_log (user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)')

  const transaction = db.transaction(() => {
    updateRedeem.run(req.user.id, redeem.id)
    updateUser.run(redeem.points, req.user.id)
    insertLog.run(req.user.id, redeem.points, 'redeem', `兑换码 ${normalized} 获得 ${redeem.points} 积分`)
    insertOp.run(req.user.id, req.user.username, 'redeem', JSON.stringify({ code: normalized, points: redeem.points }), req.ip)
  })

  try {
    transaction()
    const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id)
    res.json({ points_added: redeem.points, current_points: user.points })
  } catch (err) {
    res.status(500).json({ error: '兑换失败，请重试' })
  }
})

// ============================================================
// AI 对话接口 (需登录 + 积分校验)
// ============================================================

function getAiCost(operationKey) {
  const db = getDb()
  const config = db.prepare('SELECT cost FROM points_config WHERE key = ?').get(operationKey)
  return config ? config.cost : 10
}

function deductPoints(userId, amount, operationType, description) {
  const db = getDb()
  const user = db.prepare('SELECT points FROM users WHERE id = ?').get(userId)
  if (!user || user.points < amount) return false

  db.prepare('UPDATE users SET points = points - ?, updated_at = datetime(\'now\') WHERE id = ?').run(amount, userId)
  db.prepare('INSERT INTO points_log (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(userId, -amount, operationType, description)
  return true
}

app.post('/api/ai/chat', authRequired, async (req, res) => {
  try {
    const { provider, messages, config, operation } = req.body
    const db = getDb()

    const operationKey = operation || 'ai_chart'
    const cost = getAiCost(operationKey)
    const costDescription = {
      ai_chart: '排盘解读',
      ai_fortune: '年度运势',
      ai_kline: '人生K线',
      ai_match: '双人合盘',
      ai_followup: '追问对话',
    }[operationKey] || 'AI对话'

    const canPay = deductPoints(req.user.id, cost, operationKey, `${costDescription}消耗积分`)
    if (!canPay) {
      return res.status(402).json({ error: '积分不足', required: cost })
    }

    let apiKey
    const envKeyMap = { kimi: 'KIMI_API_KEY', gemini: 'GEMINI_API_KEY', claude: 'CLAUDE_API_KEY', deepseek: 'DEEPSEEK_API_KEY' }
    const envVal = process.env[envKeyMap[provider]] || ''

    if (envVal && !envVal.includes('your-') && !envVal.includes('xxxxxxxx')) {
      apiKey = envVal
    } else {
      const db = getDb()
      const apiKeyEntry = db.prepare('SELECT * FROM api_keys WHERE provider = ? AND isActive = 1').get(provider)
      apiKey = apiKeyEntry?.apiKey
      if (!apiKey) {
        switch (provider) {
          case 'kimi': apiKey = process.env.KIMI_API_KEY; break
          case 'gemini': apiKey = process.env.GEMINI_API_KEY; break
          case 'claude': apiKey = process.env.CLAUDE_API_KEY; break
          case 'deepseek': apiKey = process.env.DEEPSEEK_API_KEY; break
          default: return res.status(400).json({ error: 'Invalid provider' })
        }
      }
    }

    if (!apiKey || apiKey.includes('your-') || apiKey.includes('xxxxxxxx')) {
      const db = getDb()
      db.prepare('UPDATE users SET points = points + ?, updated_at = datetime(\'now\') WHERE id = ?').run(cost, req.user.id)
      db.prepare('INSERT INTO points_log (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(req.user.id, cost, 'refund', `AI调用失败，退还积分`)
      return res.status(500).json({ error: `API key not configured for ${provider}` })
    }

    let apiUrl, headers, requestBody
    switch (provider) {
      case 'kimi':
        apiUrl = 'https://api.moonshot.cn/v1/chat/completions'
        headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }
        requestBody = { model: config?.model || 'kimi-k2-0905-preview', messages, stream: true }
        break
      case 'gemini': {
        apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${config?.model || 'gemini-3.0-flash'}:streamGenerateContent?key=${apiKey}`
        headers = { 'Content-Type': 'application/json' }
        const contents = messages.filter(m => m.role !== 'system').map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }))
        const sysMsg = messages.find(m => m.role === 'system')
        requestBody = { contents, systemInstruction: sysMsg ? { parts: [{ text: sysMsg.content }] } : undefined }
        break
      }
      case 'claude': {
        apiUrl = 'https://api.anthropic.com/v1/messages'
        headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
        const sys = messages.find(m => m.role === 'system')?.content || ''
        const chatMsgs = messages.filter(m => m.role !== 'system')
        requestBody = { model: config?.model || 'claude-opus-4.5-20251124', system: sys, messages: chatMsgs, stream: true }
        break
      }
      case 'deepseek':
      default:
        apiUrl = 'https://api.deepseek.com/v1/chat/completions'
        headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }
        requestBody = { model: config?.model || 'deepseek-chat', messages, stream: true }
        break
    }

    db.prepare('INSERT INTO operation_log (user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(
      req.user.id, req.user.username, operationKey, JSON.stringify({ provider, cost, model: config?.model }), req.ip
    )

    let aiResponse
    try {
      aiResponse = await fetch(apiUrl, { method: 'POST', headers, body: JSON.stringify(requestBody) })
    } catch (fetchErr) {
      db.prepare('UPDATE users SET points = points + ?, updated_at = datetime(\'now\') WHERE id = ?').run(cost, req.user.id)
      db.prepare('INSERT INTO points_log (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(req.user.id, cost, 'refund', `AI服务不可用，退还积分`)
      return res.status(502).json({ error: 'AI 服务暂时不可用，积分已退还' })
    }

    if (!aiResponse.ok) {
      db.prepare('UPDATE users SET points = points + ?, updated_at = datetime(\'now\') WHERE id = ?').run(cost, req.user.id)
      db.prepare('INSERT INTO points_log (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(req.user.id, cost, 'refund', `AI返回错误，退还积分`)
      let errorMsg = 'AI API request failed'
      try { const errData = await aiResponse.json(); errorMsg = errData.error?.message || errorMsg } catch {}
      return res.status(aiResponse.status).json({ error: errorMsg })
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Points-Remaining', String(
      db.prepare('SELECT points FROM users WHERE id = ?').get(req.user.id)?.points || 0
    ))

    const reader = aiResponse.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
    res.end()

  } catch (error) {
    console.error('AI Chat Error:', error)
    res.status(500).json({ error: error.message })
  }
})

// ============================================================
// 管理后台接口 (需 admin 权限)
// ============================================================

app.get('/api/admin/config', adminRequired, (req, res) => {
  const db = getDb()
  const configs = db.prepare('SELECT * FROM system_config').all()
  const obj = {}
  for (const c of configs) obj[c.key] = c.value

  res.json({
    defaultProvider: obj.default_provider || 'deepseek',
    enableWebSearch: obj.enable_web_search === 'true',
    enableThinking: obj.enable_thinking === 'true',
  })
})

app.put('/api/admin/config', adminRequired, (req, res) => {
  const db = getDb()
  const upsert = db.prepare('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)')
  if (req.body.defaultProvider !== undefined) upsert.run('default_provider', req.body.defaultProvider)
  if (req.body.enableWebSearch !== undefined) upsert.run('enable_web_search', String(req.body.enableWebSearch))
  if (req.body.enableThinking !== undefined) upsert.run('enable_thinking', String(req.body.enableThinking))
  res.json({ success: true })
})

app.get('/api/admin/api-keys', adminRequired, (req, res) => {
  const db = getDb()
  const keys = db.prepare('SELECT * FROM api_keys ORDER BY id').all()
  res.json(keys.map(k => ({ ...k, isActive: !!k.isActive })))
})

app.post('/api/admin/api-keys', adminRequired, (req, res) => {
  const db = getDb()
  const result = db.prepare('INSERT INTO api_keys (model, provider, apiKey, isActive) VALUES (?, ?, ?, 1)').run(
    req.body.model, req.body.provider, req.body.apiKey
  )
  const key = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(result.lastInsertRowid)
  res.json({ success: true, apiKey: { ...key, isActive: !!key.isActive } })
})

app.put('/api/admin/api-keys/:id', adminRequired, (req, res) => {
  const db = getDb()
  const { model, provider, apiKey } = req.body
  db.prepare("UPDATE api_keys SET model = ?, provider = ?, apiKey = ?, updated_at = datetime('now') WHERE id = ?").run(model, provider, apiKey, req.params.id)
  const key = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(req.params.id)
  if (!key) return res.status(404).json({ error: 'Not found' })
  res.json({ success: true, apiKey: { ...key, isActive: !!key.isActive } })
})

app.delete('/api/admin/api-keys/:id', adminRequired, (req, res) => {
  const db = getDb()
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

app.patch('/api/admin/api-keys/:id/status', adminRequired, (req, res) => {
  const db = getDb()
  db.prepare("UPDATE api_keys SET isActive = ?, updated_at = datetime('now') WHERE id = ?").run(req.body.isActive ? 1 : 0, req.params.id)
  const key = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(req.params.id)
  if (!key) return res.status(404).json({ error: 'Not found' })
  res.json({ success: true, apiKey: { ...key, isActive: !!key.isActive } })
})

app.get('/api/admin/redeem-codes', adminRequired, (req, res) => {
  const db = getDb()
  const status = req.query.status
  let codes
  if (status && status !== 'all') {
    codes = db.prepare('SELECT * FROM redeem_codes WHERE status = ? ORDER BY created_at DESC').all(status)
  } else {
    codes = db.prepare('SELECT * FROM redeem_codes ORDER BY created_at DESC').all()
  }
  const total = db.prepare('SELECT COUNT(*) as count FROM redeem_codes').get()
  res.json({ codes, total: total.count })
})

app.post('/api/admin/redeem-codes', adminRequired, (req, res) => {
  const { count = 1, points = 100, expires_at } = req.body
  const batchId = `BATCH-${Date.now()}`
  const db = getDb()
  const insert = db.prepare('INSERT INTO redeem_codes (code, points, batch_id, created_by, expires_at) VALUES (?, ?, ?, ?, ?)')
  const codes = []

  const transaction = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const code = generateCode()
      insert.run(code, points, batchId, req.user.username, expires_at || null)
      codes.push(code)
    }
  })

  try {
    transaction()
    res.json({ success: true, codes, batchId, points, count })
  } catch (err) {
    res.status(500).json({ error: '生成失败，请重试' })
  }
})

app.delete('/api/admin/redeem-codes/:id', adminRequired, (req, res) => {
  const db = getDb()
  const code = db.prepare('SELECT * FROM redeem_codes WHERE id = ?').get(req.params.id)
  if (!code) return res.status(404).json({ error: '兑换码不存在' })
  if (code.status !== 'active') return res.status(400).json({ error: '只能删除未使用的兑换码' })
  db.prepare('DELETE FROM redeem_codes WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

app.get('/api/points-config', (req, res) => {
  const db = getDb()
  const newUserPoints = db.prepare("SELECT value FROM system_config WHERE key = 'new_user_points'").get()
  const invitePoints = db.prepare("SELECT value FROM system_config WHERE key = 'invite_points'").get()
  res.json({ newUserPoints: parseInt(newUserPoints?.value || '1000'), invitePoints: parseInt(invitePoints?.value || '500') })
})

app.get('/api/admin/points-config', adminRequired, (req, res) => {
  const db = getDb()
  const configs = db.prepare('SELECT * FROM points_config ORDER BY key').all()
  const newUserPoints = db.prepare("SELECT value FROM system_config WHERE key = 'new_user_points'").get()
  const invitePoints = db.prepare("SELECT value FROM system_config WHERE key = 'invite_points'").get()
  res.json({ configs, newUserPoints: parseInt(newUserPoints?.value || '50'), invitePoints: parseInt(invitePoints?.value || '500') })
})

app.put('/api/admin/points-config', adminRequired, (req, res) => {
  const db = getDb()
  const { configs, newUserPoints, invitePoints } = req.body

  if (configs && Array.isArray(configs)) {
    const update = db.prepare("UPDATE points_config SET cost = ?, name = ?, updated_at = datetime('now') WHERE key = ?")
    const transaction = db.transaction(() => {
      for (const c of configs) {
        update.run(c.cost, c.name, c.key)
      }
    })
    transaction()
  }

  if (newUserPoints !== undefined) {
    db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('new_user_points', ?)").run(String(newUserPoints))
  }

  if (invitePoints !== undefined) {
    db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('invite_points', ?)").run(String(invitePoints))
  }

  res.json({ success: true })
})

app.get('/api/admin/users', adminRequired, (req, res) => {
  const db = getDb()
  const search = req.query.search || ''
  const limit = Math.min(parseInt(req.query.limit) || 50, 200)
  const offset = parseInt(req.query.offset) || 0

  let users, total
  if (search) {
    users = db.prepare("SELECT id, username, phone, display_name, email, avatar_url, role, points, status, created_at, updated_at, last_login_at, invite_code, invited_by FROM users WHERE username LIKE ? OR phone LIKE ? OR display_name LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(`%${search}%`, `%${search}%`, `%${search}%`, limit, offset)
    total = db.prepare("SELECT COUNT(*) as count FROM users WHERE username LIKE ? OR phone LIKE ? OR display_name LIKE ?").get(`%${search}%`, `%${search}%`, `%${search}%`)
  } else {
    users = db.prepare('SELECT id, username, phone, display_name, email, avatar_url, role, points, status, created_at, updated_at, last_login_at, invite_code, invited_by FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset)
    total = db.prepare('SELECT COUNT(*) as count FROM users').get()
  }

  res.json({ users, total: total.count, limit, offset })
})

app.post('/api/admin/users/:id/points', adminRequired, (req, res) => {
  const { amount, reason } = req.body
  if (!amount || amount === 0) return res.status(400).json({ error: '积分数量不能为0' })

  const db = getDb()
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
  if (!user) return res.status(404).json({ error: '用户不存在' })

  db.prepare('UPDATE users SET points = points + ?, updated_at = datetime(\'now\') WHERE id = ?').run(amount, user.id)
  db.prepare('INSERT INTO points_log (user_id, amount, type, description) VALUES (?, ?, ?, ?)').run(
    user.id, amount, 'admin_grant', reason || '管理员操作'
  )
  db.prepare('INSERT INTO operation_log (user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(
    user.id, user.username, 'admin_points', JSON.stringify({ amount, reason }), req.ip
  )

  const updated = db.prepare('SELECT id, username, points FROM users WHERE id = ?').get(user.id)
  res.json({ success: true, user: updated })
})

app.get('/api/admin/stats', adminRequired, (req, res) => {
  const db = getDb()
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('user')
  const totalApiCalls = db.prepare("SELECT COUNT(*) as count FROM operation_log WHERE action IN ('ai_chart','ai_fortune','ai_kline','ai_match','ai_followup')").get()
  const activeModels = db.prepare('SELECT COUNT(*) as count FROM api_keys WHERE isActive = 1').get()
  const totalCodes = db.prepare("SELECT COUNT(*) as count FROM redeem_codes WHERE status = 'active'").get()
  res.json({
    apiCalls: totalApiCalls.count,
    userCount: userCount.count,
    activeModels: activeModels.count,
    activeCodes: totalCodes.count,
    systemStatus: '运行正常',
  })
})

// ============================================================
// 增强版用户管理 (需 admin 权限)
// ============================================================

app.post('/api/admin/users', adminRequired, (req, res) => {
  const { username, password, email, role, points } = req.body
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' })
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度 2-20 个字符' })
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 个字符' })

  const db = getDb()
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (existing) return res.status(409).json({ error: '用户名已存在' })

  const passwordHash = bcrypt.hashSync(password, 10)
  const userRole = role || 'user'
  const userPoints = points !== undefined ? points : parseInt(db.prepare("SELECT value FROM system_config WHERE key = 'new_user_points'").get()?.value || '50')
  const defaultAvatar = `/avatars/avatar_${Math.floor(Math.random() * 9) + 1}.png`

  const result = db.prepare('INSERT INTO users (username, password_hash, email, role, points, status, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    username, passwordHash, email || null, userRole, userPoints, 'active', defaultAvatar
  )

  const user = db.prepare('SELECT id, username, email, avatar_url, role, points, status, created_at FROM users WHERE id = ?').get(result.lastInsertRowid)
  res.json({ success: true, user })
})

app.put('/api/admin/users/:id', adminRequired, (req, res) => {
  const { username, email, role, points, status } = req.body
  const db = getDb()
  const userId = parseInt(req.params.id)

  const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, userId)
  if (username && existing) return res.status(409).json({ error: '用户名已被使用' })

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
  if (!user) return res.status(404).json({ error: '用户不存在' })

  const updates = {}
  if (username !== undefined) updates.username = username
  if (email !== undefined) updates.email = email
  if (role !== undefined) updates.role = role
  if (points !== undefined) updates.points = points
  if (status !== undefined) updates.status = status

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: '无更新内容' })

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ')
  const values = [...Object.values(updates), userId]
  db.prepare(`UPDATE users SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`).run(...values)

  const updated = db.prepare('SELECT id, username, email, avatar_url, role, points, status, created_at, updated_at, last_login_at FROM users WHERE id = ?').get(userId)
  res.json({ success: true, user: updated })
})

app.post('/api/admin/users/:id/reset-password', adminRequired, (req, res) => {
  const { newPassword } = req.body
  const db = getDb()
  const userId = parseInt(req.params.id)

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
  if (!user) return res.status(404).json({ error: '用户不存在' })
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: '密码至少 6 个字符' })

  const hash = bcrypt.hashSync(newPassword, 10)
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, userId)

  db.prepare('INSERT INTO operation_log (user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id, req.user.username, 'admin_reset_password', JSON.stringify({ target_user_id: userId, target_username: user.username }), req.ip
  )

  res.json({ success: true, message: '密码已重置' })
})

app.delete('/api/admin/users/:id', adminRequired, (req, res) => {
  const db = getDb()
  const userId = parseInt(req.params.id)

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
  if (!user) return res.status(404).json({ error: '用户不存在' })
  if (user.role === 'admin') return res.status(403).json({ error: '不能删除管理员账号' })

  db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  db.prepare('DELETE FROM points_log WHERE user_id = ?').run(userId)
  db.prepare('DELETE FROM operation_log WHERE user_id = ?').run(userId)

  res.json({ success: true })
})

app.get('/api/admin/users/:id/detail', adminRequired, (req, res) => {
  const db = getDb()
  const userId = parseInt(req.params.id)

  const user = db.prepare(`
    SELECT id, username, email, avatar_url, role, points, status, created_at, updated_at, last_login_at, total_recharge_amount
    FROM users WHERE id = ?
  `).get(userId)
  if (!user) return res.status(404).json({ error: '用户不存在' })

  const consumeCount = db.prepare(`
    SELECT COUNT(*) as count, SUM(ABS(amount)) as total
    FROM points_log WHERE user_id = ? AND amount < 0
  `).get(userId)

  const rechargeCount = db.prepare(`
    SELECT COUNT(*) as count, SUM(amount) as total
    FROM points_log WHERE user_id = ? AND amount > 0 AND type = 'redeem'
  `).get(userId)

  const rechargeOrderStats = db.prepare(`
    SELECT COUNT(*) as order_count, COALESCE(SUM(amount), 0) as order_total_amount
    FROM recharge_orders WHERE user_id = ? AND status = 'approved'
  `).get(userId)

  const recentLogs = db.prepare(`
    SELECT * FROM points_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(userId)

  const recentOperations = db.prepare(`
    SELECT * FROM operation_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(userId)

  res.json({
    user,
    stats: {
      consumeCount: consumeCount?.count || 0,
      consumeTotal: consumeCount?.total || 0,
      rechargeCount: rechargeCount?.count || 0,
      rechargeTotal: rechargeCount?.total || 0,
      rechargeOrderCount: rechargeOrderStats?.order_count || 0,
      rechargeOrderTotalAmount: rechargeOrderStats?.order_total_amount || 0,
    },
    pointsLog: recentLogs,
    operationLog: recentOperations,
  })
})

// ============================================================
// 角色管理 (需 admin 权限)
// ============================================================

app.get('/api/admin/roles', adminRequired, (req, res) => {
  const db = getDb()
  const roles = db.prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM users WHERE role = r.code) as user_count,
      (SELECT COUNT(*) FROM role_permissions WHERE role_id = r.id) as perm_count
    FROM roles r ORDER BY r.id
  `).all()
  res.json({ roles })
})

app.post('/api/admin/roles', adminRequired, (req, res) => {
  const { name, code, description } = req.body
  if (!name || !code) return res.status(400).json({ error: '名称和编码不能为空' })

  const db = getDb()
  try {
    const result = db.prepare('INSERT INTO roles (name, code, description) VALUES (?, ?, ?)').run(name, code, description || '')
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(result.lastInsertRowid)
    res.json({ success: true, role })
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: '角色编码已存在' })
    res.status(500).json({ error: '创建失败' })
  }
})

app.put('/api/admin/roles/:id', adminRequired, (req, res) => {
  const { name, code, description, status } = req.body
  const db = getDb()
  const roleId = parseInt(req.params.id)

  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId)
  if (!role) return res.status(404).json({ error: '角色不存在' })
  if (role.code === 'admin') return res.status(403).json({ error: '不能修改系统管理员角色' })

  try {
    db.prepare("UPDATE roles SET name = ?, code = ?, description = ?, status = ?, updated_at = datetime('now') WHERE id = ?").run(name, code, description, status, roleId)
    const updated = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId)
    res.json({ success: true, role: updated })
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: '角色编码已存在' })
    res.status(500).json({ error: '更新失败' })
  }
})

app.delete('/api/admin/roles/:id', adminRequired, (req, res) => {
  const db = getDb()
  const roleId = parseInt(req.params.id)

  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId)
  if (!role) return res.status(404).json({ error: '角色不存在' })
  if (role.code === 'admin') return res.status(403).json({ error: '不能删除系统管理员角色' })

  const userCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get(role.code)
  if (userCount.count > 0) return res.status(400).json({ error: '该角色下还有用户，无法删除' })

  db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId)
  db.prepare('DELETE FROM roles WHERE id = ?').run(roleId)
  res.json({ success: true })
})

app.get('/api/admin/roles/:id/permissions', adminRequired, (req, res) => {
  const db = getDb()
  const roleId = parseInt(req.params.id)
  const permissions = db.prepare(`
    SELECT p.* FROM permissions p
    JOIN role_permissions rp ON p.id = rp.permission_id
    WHERE rp.role_id = ?
    ORDER BY p.sort_order
  `).all(roleId)
  res.json({ permissions })
})

app.put('/api/admin/roles/:id/permissions', adminRequired, (req, res) => {
  const { permission_ids } = req.body
  const db = getDb()
  const roleId = parseInt(req.params.id)

  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId)
  if (!role) return res.status(404).json({ error: '角色不存在' })
  if (role.code === 'admin') return res.status(403).json({ error: '不能修改系统管理员角色权限' })

  db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId)

  if (permission_ids && permission_ids.length > 0) {
    const insert = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)')
    const transaction = db.transaction(() => {
      for (const pid of permission_ids) {
        insert.run(roleId, pid)
      }
    })
    transaction()
  }

  res.json({ success: true })
})

app.get('/api/admin/permissions', adminRequired, (req, res) => {
  const db = getDb()
  const permissions = db.prepare('SELECT * FROM permissions WHERE status = 1 ORDER BY sort_order').all()
  res.json({ permissions })
})

// ============================================================
// 启动
// ============================================================

getDb()

app.listen(PORT, '0.0.0.0', () => {
  console.log(`紫微卜运后端运行在 http://0.0.0.0:${PORT}`)
  console.log(`数据库: SQLite (data.db)`)
})
