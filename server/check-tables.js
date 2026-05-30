const Database = require('better-sqlite3')
const db = new Database('./data.db')

console.log('═══════════════════════════════════════')
console.log('    🔍 数据库表结构一致性检查')
console.log('═══════════════════════════════════════\n')

// 检查所有表
console.log('【1】📋 数据库中的所有表：')
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
tables.forEach(table => {
  console.log(`  ✅ ${table.name}`)
})

// 检查 point_transactions 表
console.log('\n\n【2】🔍 检查 point_transactions 表：')
try {
  const ptCount = db.prepare("SELECT COUNT(*) as count FROM point_transactions").get().count
  console.log(`  📊 记录数: ${ptCount}`)
  
  if (ptCount > 0) {
    const ptSample = db.prepare("SELECT * FROM point_transactions LIMIT 5").all()
    console.log('\n  最近记录：')
    ptSample.forEach(record => {
      console.log(`    - ${record.user_id} | ${record.points}积分 | ${record.type} | ${record.description}`)
    })
  }
} catch (err) {
  console.log(`  ❌ 表不存在或查询失败: ${err.message}`)
}

// 检查 points_log 表
console.log('\n\n【3】🔍 检查 points_log 表：')
try {
  const plCount = db.prepare("SELECT COUNT(*) as count FROM points_log").get().count
  console.log(`  📊 记录数: ${plCount}`)
  
  if (plCount > 0) {
    const plSample = db.prepare("SELECT * FROM points_log LIMIT 5").all()
    console.log('\n  最近记录：')
    plSample.forEach(record => {
      console.log(`    - ${record.user_id} | ${record.amount}积分 | ${record.type} | ${record.description}`)
    })
  }
} catch (err) {
  console.log(`  ❌ 表不存在或查询失败: ${err.message}`)
}

// 对比两个表的充值记录
console.log('\n\n【4】⚠️ 充值记录对比：')
let ptRecharge, plRecharge

try {
  ptRecharge = db.prepare("SELECT COUNT(*) as count FROM point_transactions WHERE ref_type='recharge'").get().count
  console.log(`  point_transactions 充值记录: ${ptRecharge} 条`)
} catch (e) {
  ptRecharge = 0
  console.log(`  point_transactions 无充值记录`)
}

try {
  plRecharge = db.prepare("SELECT COUNT(*) as count FROM points_log WHERE type='recharge'").get().count
  console.log(`  points_log 充值记录: ${plRecharge} 条`)
} catch (e) {
  plRecharge = 0
  console.log(`  points_log 无充值记录`)
}

if (ptRecharge !== plRecharge) {
  console.log(`\n  ❌ 发现不一致！`)
  console.log(`     后端代码使用 point_transactions 表`)
  console.log(`     前端显示使用 points_log 表`)
  console.log(`     这就是积分不显示的根本原因！`)
}

db.close()

console.log('\n\n═══════════════════════════════════════')
console.log('       🔧 需要统一使用 points_log 表')
console.log('═══════════════════════════════════════\n')
