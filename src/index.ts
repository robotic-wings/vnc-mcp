#!/usr/bin/env node
// src/index.ts
import 'dotenv/config'; // 加载 .env 文件中的环境变量
import { VncMcpServer } from './server.js';
import { VncConfig } from './types.js';

process.on('uncaughtException', (error) => {
  if (error.message?.includes('invalid distance too far back') || 
      (error as any).code === 'Z_DATA_ERROR') {
    console.error('VNC compression error detected:', error.message);
    return;
  }
  
  console.error('Uncaught exception:', error);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

const timeout = parseInt(process.env.VNC_TIMEOUT || '');

const config: VncConfig = {
  host: process.env.VNC_HOST || 'localhost',
  port: parseInt(process.env.VNC_PORT || '5900'),
  password: process.env.VNC_PASSWORD,
  timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined
};

const server = new VncMcpServer(config);

// Transport: stdio (default) or HTTP
// Enable HTTP via: MCP_TRANSPORT=http, or pass --http / http as CLI arg
// HTTP port: MCP_PORT env var or --port <n> (default: 3000)
const args = process.argv.slice(2);
const useHttp = process.env.MCP_TRANSPORT === 'http' || args.includes('--http') || args.includes('http');

if (useHttp) {
  const portArgIndex = args.findIndex((a) => a === '--port');
  const port = parseInt(
    (portArgIndex !== -1 && args[portArgIndex + 1]) || process.env.MCP_PORT || '3000'
  );
  server.runHttp(port).catch(console.error);
} else {
  server.run().catch(console.error);
}