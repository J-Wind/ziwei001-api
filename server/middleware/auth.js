const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET || 'ziwei-know-secret-key-change-in-production'
const JWT_EXPIRES_IN = '7d'

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET)
}

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '请先登录' })
  }
  try {
    const token = authHeader.split(' ')[1]
    const decoded = verifyToken(token)
    req.user = decoded
    next()
  } catch (err) {
    return res.status(401).json({ error: '登录已过期，请重新登录' })
  }
}

function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: '需要管理员权限' })
    }
    next()
  })
}

module.exports = { signToken, verifyToken, authRequired, adminRequired, JWT_SECRET }
