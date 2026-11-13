FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 3000
# Web app + background worker in one container. Override with `npm run start` / `npm run worker` to split them.
CMD ["node", "scripts/start-all.mjs"]
