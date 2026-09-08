import { defineConfig } from "vitest/config";

// This app's opt-in Docker integration test uses Bun's native WebSocket client.
// Run it explicitly with Bun; the normal workspace suite must not start Docker.
export default defineConfig({ test: { include: [] } });
