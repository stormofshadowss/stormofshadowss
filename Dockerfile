# StormOfShadowss app image. Build context = the project root (see docker-compose.yml).
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so rebuilds are fast when only the code changes.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY db ./db
COPY public ./public

# Where uploaded pictures are kept (mounted from the host in docker-compose.yml). Don't run as root inside the container.
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node
WORKDIR /app/server

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
