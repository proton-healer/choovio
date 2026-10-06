# Choovio web app + x402 paid API. Works on Railway, Render, Fly.io or any Docker host.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Listen on all interfaces; the platform sets PORT.
ENV HOST=0.0.0.0
EXPOSE 8787
CMD ["npx", "tsx", "src/server.ts"]
