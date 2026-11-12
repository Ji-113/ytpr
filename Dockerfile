FROM node:22-slim

# yt-dlp（YouTube 解析用の EJS スクリプト込み）を入れる。JS ランタイムはこのイメージの Node を使う
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default]" \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production \
    YTDLP_JS_RUNTIME=node

EXPOSE 3000
CMD ["node", "server.js"]
