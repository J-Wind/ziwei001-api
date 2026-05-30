const Database = require('better-sqlite3')
const db = new Database('./data.db')

console.log('═══════════════════════════════════════')
console.log('       🔍 充值全流程测试报告')
console.log('═══════════════════════════════════════\n')

// 1. 用户信息
console.log('【1】📊 用户信息')
console.log('─'.repeat(50))
const users = db.prepare(`
  SELECT id, username, display_name, points, updated_at 
  FROM users 
  WHERE id IN (101029, 101021, 101025)
`).all()

users.forEach(user => {
  console.log(`\n  👤 ${user.display_name || user.username}`)
  console.log(`     ID: ${user.id}`)
  console.log(`     💎 当前积分: ${user.points}`)
  console.log(`     🕐 更新时间: ${user.updated_at}`)
})

// 2. 充值订单统计
console.log('\n\n【2】📋 充值订单状态分布')
console.log('─'.repeat(50))
const statusStats = db.prepare(`
  SELECT status, COUNT(*) as count, SUM(points) as total_points
  FROM recharge_orders
  GROUP BY status
`).all()

statusStats.forEach(stat => {
  const label = stat.status === 'approved' ? '✅ 已通过' :
                stat.status === 'pending' ? '⏳ 待审核' : `❓ ${stat.status}`
  console.log(`  ${label}: ${stat.count}笔 (共${stat.total_points}积分)`)
})

// 3. 最近10笔订单详情
console.log('\n\n【3】📝 最近10笔充值订单')
console.log('─'.repeat(50))
const recentOrders = db.prepare(`
  SELECT 
    ro.id,
    ro.user_id,
    ro.order_no,
    ro.amount,
    ro.points,
    ro.status,
    ro.trade_no,
    ro.created_at,
    ro.processed_at,
    u.display_name as user_name
  FROM recharge_orders ro
  LEFT JOIN users u ON u.id = ro.user_id
  ORDER BY ro.created_at DESC
  LIMIT 10
`).all()

recentOrders.forEach((order, index) => {
  const statusIcon = order.status === 'approved' ? '✅' :
                     order.status === 'pending' ? '⏳' : '❌'
  const processed = order.processed_at ? '已处理' : '未处理'
  
  console.log(`\n  ${index + 1}. ${statusIcon} [${order.created_at}]`)
  console.log(`     用户: ${order.user_name || '未知'} (${order.user_id})`)
  console.log(`     订单: ${(order.order_no || '无').slice(0, 20)}...`)
  console.log(`     金额: ¥${order.amount} → ${order.points}积分`)
  console.log(`     状态: ${order.status} | 处理: ${processed}`)
  if (order.trade_no) {
    console.log(`     交易号: ${order.trade_no.slice(-8)}`)
  }
})

// 4. 积分流水记录（最近15条）
console.log('\n\n【4】💰 积分流水记录（最近15条）')
console.log('─'.repeat(50))
const pointLogs = db.prepare(`
  SELECT 
    pl.id,
    pl.user_id,
    pl.amount,
    pl.type,
    pl.description,
    pl.created_at,
    u.display_name as user_name
  FROM points_log pl
  LEFT JOIN users u ON u.id = pl.user_id
  ORDER BY pl.created_at DESC
  LIMIT 15
`).all()

if (pointLogs.length === 0) {
  console.log('  ⚠️ 没有积分流水记录')
} else {
  pointLogs.forEach((log, index) => {
    const typeIcon = log.amount > 0 ? '📈' : '📉'
    const amountColor = log.amount > 0 ? '+' : ''
    
    console.log(`  ${index + 1}. ${typeIcon} [${log.created_at}] ${log.user_name || '未知'}`)
    console.log(`      ${amountColor}${log.amount}积分 - ${log.type}: ${log.description}`)
  })
}

// 5. 数据一致性验证
console.log('\n\n【5】✅ 数据一致性验证')
console.log('─'.repeat(50))

const totalApprovedPoints = db.prepare("SELECT COALESCE(SUM(points), 0) as total FROM recharge_orders WHERE status = 'approved'").get().total
const totalRechargeLogPoints = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM points_log WHERE type = 'recharge'").get().total
const allUserPoints = db.prepare("SELECT COALESCE(SUM(points), 0) as total FROM users").get().total

console.log(`\n  📊 统计数据：`)
console.log(`     已通过订单总积分: ${totalApprovedPoints}`)
console.log(`     充值流水总变动:   ${totalRechargeLogPoints}`)
console.log(`     所有用户积分总和: ${allUserPoints}`)

if (totalApprovedPoints === totalRechargeLogPoints && totalRechargeLogPoints > 0) {
  console.log(`\n  ✅ 数据一致！订单与流水匹配`)
} else if (totalRechargeLogPoints < totalApprovedPoints) {
  console.log(`\n  ⚠️ 数据不一致！缺少 ${totalApprovedPoints - totalRechargeLogPoints} 积分流水`)
  console.log('     可能原因：部分订单的积分更新失败')
} else {
  console.log(`\n  ✅ 数据正常`)
}

// 6. 待处理订单警告
console.log('\n\n【6】⚠️ 待处理的订单')
console.log('─'.repeat(50))
const pendingCount = db.prepare("SELECT COUNT(*) as count FROM recharge_orders WHERE status = 'pending'").get().count

if (pendingCount > 0) {
  console.log(`  有 ${pendingCount} 笔订单处于"待审核"状态`)
  console.log('  这些订单可能是：')
  console.log('  • 用户已支付但Zpay尚未回调')
  console.log('  • 支付宝扫码后取消支付')
  
  const pendingList = db.prepare(`
    SELECT order_no, amount, points, created_at 
    FROM recharge_orders 
    WHERE status = 'pending'
    ORDER BY created_at DESC
    LIMIT 5
  `).all()
  
  console.log('\n  待审核列表：')
  pendingList.forEach(order => {
    console.log(`    - ${order.order_no?.slice(0, 25)}... | ¥${order.amount} → ${order.points}积分 | ${order.created_at}`)
  })
} else {
  console.log('  ✅ 没有待审核的订单')
}

db.close()

console.log('\n\n═══════════════════════════════════════')
console.log('       🎯 测试准备完成，可以开始测试')
console.log('═══════════════════════════════════════\n')
