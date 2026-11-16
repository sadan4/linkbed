FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_PATH=/app/data/cards.sqlite
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir data && chown node:node data
COPY --chown=node:node server.mjs metadata.mjs render.mjs ./
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
