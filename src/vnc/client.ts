// src/vnc/client.ts
import { VncClient } from '@computernewb/nodejs-rfb';
import { VncConfig, CoordinateValidation } from '../types.js';

export class VncConnectionManager {
  private config: VncConfig;

  constructor(config: VncConfig) {
    this.config = config;
  }

  // Execute a callback with a fresh VNC connection that waits for full framebuffer
  async executeWithConnection<T>(callback: (client: VncClient) => Promise<T>): Promise<T> {
    const client = await this.createConnection();
    try {
      const result = await callback(client);
      return result;
    } finally {
      this.disconnect(client);
    }
  }

  private async createConnection(): Promise<VncClient> {
    return new Promise((resolve, reject) => {
      const vncClient = new VncClient({
        debug: false,
        encodings: [
          VncClient.consts.encodings.raw, // Try raw encoding first for problematic servers
          VncClient.consts.encodings.copyRect
          // Do NOT offer hextile: nodejs-rfb 0.4.2's hextile decoder misses an `await`
          // on the 4th byte read of 32bpp raw tiles. When a tile straddles a TCP chunk
          // boundary with 1 byte left, the next read runs past the buffer end and throws
          // RangeError [ERR_OUT_OF_RANGE] as an unhandled rejection (seen with TigerVNC,
          // which strongly prefers hextile when it is advertised).
          // Removed zrle as it seems to cause "Invalid subencoding" errors on some servers
        ]
      });

      let hasReceivedInitialFramebuffer = false;

      // Every MCP tool call opens a fresh connection and waits for the initial
      // frame, so this timeout effectively bounds each tool call.
      const timeout = this.config.timeout ?? 30000;
      const timeoutId = setTimeout(() => {
        reject(new Error(`VNC connection timeout (${timeout}ms)`));
      }, timeout);

      vncClient.on('connected', () => {
        console.error(`Connected to VNC server at ${this.config.host}:${this.config.port}`);
      });

      vncClient.on('authenticated', () => {
        // NOTE: nodejs-rfb emits 'authenticated' before ServerInit is processed,
        // so clientWidth/clientHeight are not known yet at this point.
        console.error('VNC authenticated, waiting for initial framebuffer...');
      });

      vncClient.on('frameUpdated', () => {
        if (!hasReceivedInitialFramebuffer) {
          hasReceivedInitialFramebuffer = true;
          const screenWidth = vncClient.clientWidth || 0;
          const screenHeight = vncClient.clientHeight || 0;
          console.error(`Received initial framebuffer, screen: ${screenWidth}x${screenHeight}, connection ready`);
          clearTimeout(timeoutId);
          if (!screenWidth || !screenHeight) {
            reject(new Error(`VNC server reported invalid screen size: ${screenWidth}x${screenHeight}`));
            return;
          }
          resolve(vncClient);
        }
      });

      vncClient.on('error', (error) => {
        console.error(`VNC connection error: ${error.message}`);
        clearTimeout(timeoutId);
        reject(new Error(`VNC connection error: ${error.message}`));
      });

      // Handle VNC disconnections
      vncClient.on('disconnect', (reason) => {
        console.error(`VNC disconnected: ${reason}`);
      });

      const connectionOptions = {
        host: this.config.host,
        port: this.config.port,
        path: null,
        auth: this.config.password ? { password: this.config.password } : undefined
      };

      vncClient.connect(connectionOptions);
    });
  }

  private disconnect(client: VncClient): void {
    try {
      client.disconnect();
    } catch (error) {
      console.error('Error disconnecting VNC client:', error);
    }
  }

  public validateCoordinates(client: VncClient, x: number, y: number): CoordinateValidation {
    const screenWidth = client.clientWidth || 0;
    const screenHeight = client.clientHeight || 0;
    
    if (screenWidth === 0 || screenHeight === 0) {
      return { valid: true }; // Allow if dimensions not yet known
    }
    
    if (x < 0 || x >= screenWidth || y < 0 || y >= screenHeight) {
      return {
        valid: false,
        error: `Coordinates (${x}, ${y}) are outside screen bounds (0, 0) to (${screenWidth - 1}, ${screenHeight - 1})`
      };
    }
    
    return { valid: true };
  }
}
