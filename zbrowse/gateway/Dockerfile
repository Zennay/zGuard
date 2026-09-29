FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public
COPY config ./config

ENV NODE_ENV=production
USER node
CMD ["node", "server.js"]
