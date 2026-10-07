FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.js config-values.js request-ip.js request-path.js session-admission.js session-lifetime.js ./
COPY public ./public
COPY config ./config

ENV NODE_ENV=production
USER node
CMD ["node", "server.js"]
