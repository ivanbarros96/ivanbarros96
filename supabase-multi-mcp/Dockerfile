FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production MCP_TRANSPORT=http PORT=3000 PROJECTS_FILE=/app/config/projects.json

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "--import", "tsx", "src/index.ts"]
