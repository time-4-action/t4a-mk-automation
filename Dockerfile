# Use official Node.js LTS image
FROM node:24-alpine

# Set working directory
WORKDIR /usr/src/app

ENV ENV_FILE_PATH=/data/.env
ENV CRON_FILE_PATH=/data/cron.json
ENV DB_FILE_PATH=/data/patrik.db
ENV PUBLIC_DATA_FILE_PATH=/data/public
ENV NODE_ENV=production

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy only the public folder
COPY public ./public

# Copy your main server file (index.js)
COPY index.js .

# Copy source files
COPY src/ ./src/

COPY cron.js .
COPY config/ ./config/


# Expose the port
EXPOSE 3000

# Start the server
CMD ["node", "index.js"]
