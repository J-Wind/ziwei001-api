FROM node:18-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY server/package*.json ./
RUN npm install --production

COPY server/ ./server/
COPY public/ ./public/

RUN mkdir -p /app/data && chmod -R 777 /app/data

EXPOSE 3001

CMD ["node", "server/index.js"]
