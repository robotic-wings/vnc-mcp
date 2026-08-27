// src/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { VncConnectionManager } from './vnc/client.js';
import { VncConfig } from './types.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
import { 
  handleClick, 
  handleMoveMouse, 
  handleKeyPress, 
  handleTypeText, 
  handleTypeMultiline, 
  handleScreenshot 
} from './tools/index.js';

export class VncMcpServer {
  private server: Server;
  private vncManager: VncConnectionManager;

  constructor(config: VncConfig) {
    this.vncManager = new VncConnectionManager(config);
    this.server = this.createMcpServer();
  }

  private createMcpServer(): Server {
    const server = new Server(
      {
        name: 'vnc-control-server',
        version: packageJson.version,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupTools(server);
    return server;
  }

  private setupTools(server: Server) {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'vnc_click',
            description: 'Click at specified coordinates',
            inputSchema: {
              type: 'object',
              properties: {
                x: { type: 'number', description: 'X coordinate' },
                y: { type: 'number', description: 'Y coordinate' },
                button: { type: 'string', description: 'Mouse button', enum: ['left', 'right', 'middle'], default: 'left' },
                double: { type: 'boolean', description: 'Double-click instead of single click', default: false }
              },
              required: ['x', 'y']
            }
          },
          {
            name: 'vnc_move_mouse',
            description: 'Move mouse to specified coordinates',
            inputSchema: {
              type: 'object',
              properties: {
                x: { type: 'number', description: 'X coordinate' },
                y: { type: 'number', description: 'Y coordinate' }
              },
              required: ['x', 'y']
            }
          },
          {
            name: 'vnc_key_press',
            description: 'Press a key or key combination',
            inputSchema: {
              type: 'object',
              properties: {
                key: { 
                  type: 'string', 
                  description: 'Key to press. Single keys: "a", "Enter", "F1". Combinations: "Ctrl+c", "Alt+F4", "Ctrl+Alt+Delete", "Shift+Tab"'
                }
              },
              required: ['key']
            }
          },
          {
            name: 'vnc_type_text',
            description: 'Type text string',
            inputSchema: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Single line of text to type' },
                enter: { type: 'boolean', description: 'Press Enter after typing text', default: false }
              },
              required: ['text']
            }
          },
          {
            name: 'vnc_type_multiline',
            description: 'Type multiple lines of text, separated by newlines',
            inputSchema: {
              type: 'object',
              properties: {
                lines: { type: 'array', items: { type: 'string' }, description: 'Array of lines to type' }
              },
              required: ['lines']
            }
          },
          {
            name: 'vnc_screenshot',
            description: 'Take a screenshot of the current screen',
            inputSchema: {
              type: 'object',
              properties: {
                delay: { 
                  type: 'number', 
                  description: 'Delay in milliseconds before taking screenshot (useful for waiting for processes to complete)',
                  minimum: 0,
                  maximum: 300000,
                  default: 0
                }
              }
            }
          }
        ]
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'vnc_click':
            return await handleClick(this.vncManager, args as any);
          case 'vnc_move_mouse':
            return await handleMoveMouse(this.vncManager, args as any);
          case 'vnc_key_press':
            return await handleKeyPress(this.vncManager, args as any);
          case 'vnc_type_text':
            return await handleTypeText(this.vncManager, args as any);
          case 'vnc_type_multiline':
            return await handleTypeMultiline(this.vncManager, args as any);
          case 'vnc_screenshot':
            return await handleScreenshot(this.vncManager, args as any);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        } as any;
      }
    });
  }

  async run() {
    try {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error(`mcp-vnc ${packageJson.version} started!`);
    } catch (error) {
      console.error('Failed to start mcp-vnc: ', error);
      process.exit(1);
    }
  }

  async runHttp(port: number) {
    // Session management: each MCP session gets its own Server + transport,
    // all sessions share the same VNC connection manager.
    const transports: Record<string, StreamableHTTPServerTransport> = {};

    const readBody = (req: IncomingMessage): Promise<unknown> =>
      new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () => {
          try {
            resolve(data ? JSON.parse(data) : undefined);
          } catch (e) {
            reject(e);
          }
        });
        req.on('error', reject);
      });

    const httpServer = createHttpServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found. Use /mcp endpoint.' }));
        return;
      }

      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
          transport = transports[sessionId];
        } else if (!sessionId && req.method === 'POST') {
          const body = await readBody(req);
          if (!isInitializeRequest(body)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Bad Request: first request must be an initialize request' },
              id: null,
            }));
            return;
          }

          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              transports[newSessionId] = transport;
            },
          });

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports[sid]) {
              delete transports[sid];
            }
          };

          // New MCP server instance for this session, sharing the VNC manager
          const sessionServer = this.createMcpServer();
          await sessionServer.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: invalid or missing session ID' },
            id: null,
          }));
          return;
        }

        const body = req.method === 'POST' ? await readBody(req) : undefined;
        await transport.handleRequest(req, res, body);
      } catch (error) {
        console.error('Error handling MCP HTTP request:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }));
        }
      }
    });

    await new Promise<void>((resolve) => httpServer.listen(port, resolve));
    console.error(`mcp-vnc ${packageJson.version} HTTP server listening on http://0.0.0.0:${port}/mcp`);
  }
}
