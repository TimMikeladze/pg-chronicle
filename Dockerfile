# Use official Bun image, pinned to a minor version for reproducible builds
# (a mutable :latest can silently change Bun/OpenSSL/glibc under a running deploy).
FROM oven/bun:1.3 AS base
WORKDIR /app

# Install dependencies into temp directory
# This will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# Copy node_modules from temp directory
# Then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

# Build the application
RUN bun run build

# Copy production dependencies and source code into final image
FROM base AS release
COPY --from=install /temp/dev/node_modules node_modules
COPY --from=prerelease /app/dist ./dist
COPY --from=prerelease /app/package.json .

# Expose the health/API port
EXPOSE 8080

# Drop root — the oven/bun image ships an unprivileged `bun` user (uid 1000).
# Port 8080 is >1024 so a non-root process can bind it.
USER bun

# Run the app. dist/main.js is the runnable bootstrap that binds the HTTP
# port and wires history/archiver from env (dist/server.js only exports
# createServer and starts nothing).
CMD ["bun", "run", "dist/main.js"]
