FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# 先复制 package.json，然后安装依赖（确保在 Linux 环境编译原生模块）
COPY server/package*.json ./
RUN npm install --production --unsafe-perm

# 再复制源代码
COPY server/ ./server/
COPY public/ ./public/

# 创建数据目录
RUN mkdir -p /app/data && chmod -R 777 /app/data

EXPOSE 3001

# 监听所有网络接口
CMD ["node", "server/index.js"]
