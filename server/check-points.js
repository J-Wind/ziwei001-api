const Database = require('better-sqlite3')
const db = new Database('./data.db')

console.log('========== 充值积分诊断报告 ==========\n')

// 1. 查询所有已通过的充值订单
console.log('【1】已通过（approved）的充值订单：')
const approvedOrders = db.prepare(`
  SELECT id, user_id, order_no, amount, points, status, trade_no, created_at, processed_at
  FROM recharge_orders 
  WHERE status = 'approved' 
  ORDER BY created_at DESC 
  LIMIT 10
`).all()

if (approvedOrders.length === 0) {
  console.log('  ⚠️ 没有已通过的订单')
} else {
  console.log(`  共 ${approvedOrders.length} 笔：\n`)
  approvedOrders.forEach((order, index) => {
    console.log(`  ${index + 1}. 订单号: ${order.order_no}`)
    console.log(`     用户ID: ${order.user_id}`)
    console.log(`     金额: ¥${order.amount} → ${order.points} 积分`)
    console.log(`     状态: ${order.status}`)
    console.log(`     交易号: ${order.trade_no || '无'}`)
    console.log(`     创建时间: ${order.created_at}`)
    console.log(`     处理时间: ${order.processed_at || '未处理'}\n`)
  })
}

// 2. 查询用户当前积分
console.log('\n【2】用户积分情况：')
const users = db.prepare(`
  SELECT id, username, display_name, points, created_at 
  FROM users 
  WHERE id IN (SELECT DISTINCT user_id FROM recharge_orders WHERE status = 'approved')
`).all()

users.forEach(user => {
  console.log(`  用户: ${user.display_name || user.username} (ID: ${user.id})`)
  console.log(`  当前积分: ${user.points}\n`)
})

// 3. 检查积分流水记录
console.log('\n【3】充值相关的积分流水记录：')
const pointsLogs = db.prepare(`
  SELECT pl.id, pl.user_id, pl.amount, pl.type, pl.description, pl.created_at,
         u.display_name, u.username
  FROM points_log pl
  LEFT JOIN users u ON u.id = pl.user_id
  WHERE pl.type = 'recharge'
  ORDER BY pl.created_at DESC
  LIMIT 15
`).all()

if (pointsLogs.length === 0) {
  console.log('  ⚠️ 没有充值类型的积分流水记录！这是问题所在！')
} else {
  console.log(`  共 ${pointsLogs.length} 条记录：\n`)
  pointsLogs.forEach((log, index) => {
    console.log(`  ${index + 1}. [${log.created_at}] ${log.display_name || log.username}`)
    console.log(`     变动: ${log.amount > 0 ? '+' : ''}${log.amount} 积分`)
    console.log(`     描述: ${log.description}\n`)
  })
}

// 4. 对比分析：应该增加的积分 vs 实际增加的积分
console.log('\n========== 问题诊断 ==========')
const totalApprovedPoints = db.prepare("SELECT COALESCE(SUM(points), 0) as total FROM recharge_orders WHERE status = 'approved'").get().total
const totalRechargeLogPoints = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM points_log WHERE type = 'recharge'").get().total

console.log(`\n已通过订单总积分: ${totalApprovedPoints} 积分`)
console.log(`积分流水总变动:   ${totalRechargeLogPoints} 积分`)

if (totalApprovedPoints > 0 && totalRechargeLogPoints === 0) {
  console.log('\n❌ 发现问题：订单显示"已通过"，但积分流水表没有记录！')
  console.log('可能原因：')
  console.log('1. Zpay回调成功更新了订单状态，但积分更新失败')
  console.log('2. 数据库事务执行时出错')
  console.log('3. 手动审核通过了但没有执行积分更新逻辑')
}

// 5. 检查最近的待审核订单
console.log('\n\n【4】待审核订单（pending）：')
const pendingOrders = db.prepare(`
  SELECT id, user_id, order_no, amount, points, status, created_at
  FROM recharge_orders 
  WHERE status = 'pending'
  ORDER BY created_at DESC
  LIMIT 5
`).all()

if (pendingOrders.length > 0) {
  pendingOrders.forEach(order => {
    console.log(`  - ${order.order_no}: ¥${order.amount} → ${order.points}积分 (${order.created_at})`)
  })
} else {
  console.log('  ✅ 没有待审核的订单')
}

db.close()
