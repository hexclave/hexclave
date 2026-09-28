FROM node:24-alpine

# Install pnpm
RUN npm install -g pnpm

# Set working directory
WORKDIR /app

# Copy the mock-oauth-server files
COPY apps/mock-oauth-server ./

# Install dependencies
RUN pnpm install

# Set environment variables
ENV PORT=32202

# Start the server
CMD ["pnpm", "start"]
