FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js config-values.js request-ip.js request-path.js session-admission.js session-lifetime.js ./
COPY public ./public
COPY config ./config

ENV NODE_ENV=production
USER node
CMD ["node", "server.js"]
