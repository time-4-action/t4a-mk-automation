# Use official Node.js LTS image
FROM node:24-alpine

# Links the GHCR package to this repository, so the workflow's GITHUB_TOKEN can push and pull it.
LABEL org.opencontainers.image.source=https://github.com/time-4-action/t4a-mk-automation

# Set working directory
WORKDIR /usr/src/app

ENV ENV_FILE_PATH=/data/.env
ENV CRON_FILE_PATH=/data/cron.json
ENV DB_FILE_PATH=/data/patrik.db
ENV PUBLIC_DATA_FILE_PATH=/data/public
ENV NODE_ENV=production

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copy only the public folder
COPY public ./public

# Copy your main server file (index.js)
COPY index.js .

# Copy source files
COPY src/ ./src/

COPY cron.js .
COPY config/ ./config/

# The commit this image was built from. CI passes it; after a deploy the server
# checks the container reports it as APP_VERSION. Last, so it doesn't bust the cache above.
ARG GIT_SHA=unknown
ENV APP_VERSION=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA

# Expose the port
EXPOSE 3000

# Start the server
CMD ["node", "index.js"]
