FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js request-ip.js request-path.js ./
COPY public ./public
COPY config ./config

ENV NODE_ENV=production
USER node
CMD ["node", "server.js"]
