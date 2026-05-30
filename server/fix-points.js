const Database = require('better-sqlite3')
const db = new Database('./data.db')

console.log('========== 开始修复充值积分 ==========\n')

// 查找所有已通过但没有积分流水的订单
const unprocessedOrders = db.prepare(`
  SELECT ro.id, ro.user_id, ro.order_no, ro.amount, ro.points, ro.status, ro.trade_no,
         u.username, u.display_name, u.points as current_points
  FROM recharge_orders ro
  LEFT JOIN users u ON u.id = ro.user_id
  WHERE ro.status = 'approved'
    AND ro.id NOT IN (
      SELECT DISTINCT CAST(JSON_EXTRACT(detail, '$.order_id') AS INTEGER) 
      FROM operation_log 
      WHERE action = 'zpay_payment_success'
    )
    AND ro.order_no IS NOT NULL
`).all()

console.log(`发现 ${unprocessedOrders.length} 笔需要修复的订单：\n`)

if (unprocessedOrders.length === 0) {
  console.log('✅ 所有订单都已正确处理，无需修复')
  db.close()
  process.exit(0)
}

let totalFixedPoints = 0

unprocessedOrders.forEach((order, index) => {
  console.log(`${index + 1}. 订单: ${order.order_no}`)
  console.log(`   用户: ${order.display_name || order.username} (ID: ${order.user_id})`)
  console.log(`   金额: ¥${order.amount} → ${order.points}积分`)
  console.log(`   当前积分: ${order.current_points}`)
  
  try {
    // 执行数据库事务
    const transaction = db.transaction(() => {
      // 更新订单的处理时间和交易号
      db.prepare(`
        UPDATE recharge_orders 
        SET processed_at = datetime('now'), 
            trade_no = COALESCE(?, trade_no),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(order.trade_no || `FIXED_${Date.now()}`, order.id)
      
      // 增加用户积分
      db.prepare("UPDATE users SET points = points + ?, updated_at = datetime('now') WHERE id = ?")
        .run(order.points, order.user_id)
      
      // 写入积分流水
      db.prepare(`
        INSERT INTO points_log (user_id, amount, type, description) 
        VALUES (?, ?, ?, ?)
      `).run(
        order.user_id, 
        order.points, 
        'recharge', 
        `在线充值 ${order.amount} 元获得 ${order.points} 积分`
      )
      
      // 写入操作日志
      db.prepare(`
        INSERT INTO operation_log (user_id, username, action, detail, ip) 
        VALUES (?, ?, ?, ?, ?)
      `).run(
        order.user_id,
        'system',
        'fix_recharge_points',
        JSON.stringify({ 
          order_id: order.id, 
          order_no: order.order_no, 
          trade_no: order.trade_no,
          amount: order.amount, 
          points: order.points,
          fixed_at: new Date().toISOString()
        }),
        '127.0.0.1'
      )
    })
    
    transaction()
    
    totalFixedPoints += order.points
    
    console.log(`   ✅ 已修复！增加 ${order.points} 积分\n`)
    
  } catch (err) {
    console.error(`   ❌ 修复失败:`, err.message, '\n')
  }
})

// 验证修复结果
console.log('\n========== 修复结果验证 ==========')
const userAfterFix = db.prepare(`
  SELECT id, username, display_name, points FROM users WHERE id = ?
`).get(unprocessedOrders[0].user_id)

console.log(`\n用户: ${userAfterFix.display_name || userAfterFix.username}`)
console.log(`修复前积分: ${unprocessedOrders[0].current_points}`)
console.log(`修复后积分: ${userAfterFix.points}`)
console.log(`本次增加: +${totalFixedPoints} 积分 ✅`)

// 显示最新的积分流水
console.log('\n最新积分流水记录：')
const latestLogs = db.prepare(`
  SELECT * FROM points_log 
  WHERE user_id = ? AND type = 'recharge'
  ORDER BY created_at DESC 
  LIMIT 5
`).all(unprocessedOrders[0].user_id)

latestLogs.forEach((log, i) => {
  console.log(`  ${i+1}. [${log.created_at}] ${log.amount > 0 ? '+' : ''}${log.amount}积分 - ${log.description}`)
})

db.close()

console.log('\n✅ 修复完成！请刷新个人中心查看最新积分。')
