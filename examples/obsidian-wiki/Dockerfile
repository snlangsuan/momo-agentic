# App image for the obsidian-wiki example. Build context is the repo root
# (see docker-compose.yml: context: ../..).
FROM oven/bun:1.2

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy the source + examples.
COPY . .

# Default: connect to the bridged wiki MCP and run a query.
CMD ["bun", "run", "examples/obsidian-wiki/index.ts"]
