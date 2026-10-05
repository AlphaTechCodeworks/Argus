# Linux runtime for the TVT native SDK (bin/linux/*.so is x86_64 Linux only)
FROM node:24-bookworm-slim
# openssl: self-signed HTTPS certificate; ffmpeg: decodes recordings for motion search (analysis only, no encoding)
RUN apt-get update && apt-get install -y --no-install-recommends openssl ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Every SDK call runs on a libuv worker thread; some (starting a stream, logging in to an
# unreachable NVR) block for seconds. The default pool of 4 threads starves everything else.
# TZ=UTC: the TVT SDK converts recording/search times with the process time zone (the app
# works in UTC and converts for display itself)
ENV LD_LIBRARY_PATH=/app/bin/linux \
    DATA_DIR=/app/data \
    UV_THREADPOOL_SIZE=64 \
    TZ=UTC
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts && npm install --no-save --ignore-scripts ws@8
COPY . .
RUN npm run build
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "cctv/server.mjs"]
