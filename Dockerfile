FROM node:22-slim

WORKDIR /app

# Install build deps for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --production=false

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Copy gog binary
# NOTE: Credentials are NOT copied into the image. Mount them at runtime:
# docker run -v ./service-account.json:/app/service-account.json:ro opengravity
COPY gog-bin/ ./gog-bin/
RUN chmod +x ./gog-bin/gog.exe 2>/dev/null || chmod +x ./gog-bin/gog 2>/dev/null || true

# Build TypeScript
RUN npx tsc

# Remove dev dependencies
RUN npm prune --production

# Expose webhook port
EXPOSE 3000

# Start bot
CMD ["node", "dist/index.js"]
