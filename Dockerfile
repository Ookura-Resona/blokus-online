# 角斗士棋 · 生产镜像
#
# 零依赖项目：没有 npm install 这一步，直接把源码拷进去就能跑。
# 这也意味着镜像很小、构建很快、没有依赖供应链风险。
#
#   docker build -t blokus .
#   docker run -p 3000:3000 blokus
#
# 想连 Caddy 一起起（自动 HTTPS）：docker compose up -d

FROM node:22-alpine

# 只 COPY 运行期真正需要的东西（见 .dockerignore）
WORKDIR /app

COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

EXPOSE 3000

# 用镜像自带的非 root 用户跑。
# 应用运行期不写任何文件（房间状态都在内存里），所以只读文件系统也没问题。
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
