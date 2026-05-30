FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --production

COPY . .
COPY ../public ./public

RUN mkdir -p /app/data && chmod -R 777 /app/data

EXPOSE 3001

CMD ["node", "index.js"]