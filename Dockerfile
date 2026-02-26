FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npx tsc && npm prune --omit=dev

# SQLite data stored in /data (mount a persistent volume here)
RUN mkdir -p /data

ENV NODE_ENV=production
ENV DB_PATH=/data/farid.db

EXPOSE 3000

CMD ["node", "dist/index.js"]
