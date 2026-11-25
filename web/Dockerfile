FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

EXPOSE 3000
ENV HOSTNAME=0.0.0.0 PORT=3000 OUTPUT_DIR=/data/output
CMD ["bun", "run", "start"]
