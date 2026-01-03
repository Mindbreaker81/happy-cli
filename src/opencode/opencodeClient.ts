/**
 * OpencodeClient - Client for OpenCode server HTTP API
 * 
 * This module provides a client for interacting with the OpenCode server
 * via its REST API. OpenCode exposes an OpenAPI 3.1 spec at /doc.
 * 
 * The client can either:
 * 1. Start its own OpenCode server instance
 * 2. Connect to an existing OpenCode server
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type {
    OpencodeSession,
    OpencodeMessageResponse,
    OpencodeHealthResponse,
    OpencodeEvent,
    OpencodePromptRequest,
    OpencodePart,
    OpencodeModel,
    OpencodeClientConfig
} from './types';
import { parseModelString } from './types';
import { 
    DEFAULT_OPENCODE_PORT, 
    DEFAULT_OPENCODE_HOSTNAME,
    DEFAULT_OPENCODE_MODEL 
} from './constants';
import { logger } from '@/ui/logger';

export class OpencodeClient extends EventEmitter {
    private config: OpencodeClientConfig;
    private baseUrl: string;
    private serverProcess: ChildProcess | null = null;
    private eventSource: EventSource | null = null;
    private abortController: AbortController | null = null;

    constructor(config: OpencodeClientConfig = {}) {
        super();
        this.config = {
            port: config.port || DEFAULT_OPENCODE_PORT,
            hostname: config.hostname || DEFAULT_OPENCODE_HOSTNAME,
            model: config.model || DEFAULT_OPENCODE_MODEL,
            ...config
        };
        this.baseUrl = config.baseUrl || `http://${this.config.hostname}:${this.config.port}`;
    }

    /**
     * Connect to OpenCode - either start server or connect to existing
     */
    async connect(): Promise<void> {
        if (this.config.startServer) {
            await this.startServer();
        }
        
        // Verify connection
        const health = await this.health();
        if (!health.healthy) {
            throw new Error('OpenCode server is not healthy');
        }
        
        logger.debug('[opencode] Connected to server:', this.baseUrl, 'version:', health.version);
    }

    /**
     * Start OpenCode server as subprocess
     */
    private async startServer(): Promise<void> {
        logger.debug('[opencode] Starting server on port', this.config.port);
        
        return new Promise((resolve, reject) => {
            const args = [
                'serve',
                '--port', String(this.config.port),
                '--hostname', this.config.hostname || DEFAULT_OPENCODE_HOSTNAME
            ];

            this.serverProcess = spawn('opencode', args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: false
            });

            let started = false;
            const timeout = setTimeout(() => {
                if (!started) {
                    reject(new Error('OpenCode server startup timeout'));
                }
            }, 30000);

            this.serverProcess.stdout?.on('data', (data) => {
                const output = data.toString();
                logger.debug('[opencode] server stdout:', output.trim());
                
                // Check if server is ready
                if (output.includes('listening') || output.includes('started')) {
                    started = true;
                    clearTimeout(timeout);
                    // Give it a moment to fully initialize
                    setTimeout(() => resolve(), 500);
                }
            });

            this.serverProcess.stderr?.on('data', (data) => {
                logger.debug('[opencode] server stderr:', data.toString().trim());
            });

            this.serverProcess.on('error', (err) => {
                clearTimeout(timeout);
                reject(new Error(`Failed to start OpenCode server: ${err.message}`));
            });

            this.serverProcess.on('close', (code) => {
                if (!started) {
                    clearTimeout(timeout);
                    reject(new Error(`OpenCode server exited with code ${code}`));
                }
            });

            // Also try polling health endpoint
            const pollHealth = async () => {
                for (let i = 0; i < 30; i++) {
                    try {
                        const health = await this.health();
                        if (health.healthy) {
                            started = true;
                            clearTimeout(timeout);
                            resolve();
                            return;
                        }
                    } catch {
                        // Server not ready yet
                    }
                    await new Promise(r => setTimeout(r, 1000));
                }
            };
            
            // Start polling after a short delay
            setTimeout(pollHealth, 1000);
        });
    }

    /**
     * Check server health
     */
    async health(): Promise<OpencodeHealthResponse> {
        const response = await fetch(`${this.baseUrl}/global/health`);
        if (!response.ok) {
            throw new Error(`Health check failed: ${response.status}`);
        }
        return response.json() as Promise<OpencodeHealthResponse>;
    }

    /**
     * Create a new session
     */
    async createSession(title?: string): Promise<OpencodeSession> {
        const response = await fetch(`${this.baseUrl}/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        });
        
        if (!response.ok) {
            throw new Error(`Failed to create session: ${response.status}`);
        }
        
        return response.json() as Promise<OpencodeSession>;
    }

    /**
     * Get session by ID
     */
    async getSession(id: string): Promise<OpencodeSession> {
        const response = await fetch(`${this.baseUrl}/session/${id}`);
        if (!response.ok) {
            throw new Error(`Failed to get session: ${response.status}`);
        }
        return response.json() as Promise<OpencodeSession>;
    }

    /**
     * List all sessions
     */
    async listSessions(): Promise<OpencodeSession[]> {
        const response = await fetch(`${this.baseUrl}/session`);
        if (!response.ok) {
            throw new Error(`Failed to list sessions: ${response.status}`);
        }
        return response.json() as Promise<OpencodeSession[]>;
    }

    /**
     * Delete a session
     */
    async deleteSession(id: string): Promise<boolean> {
        const response = await fetch(`${this.baseUrl}/session/${id}`, {
            method: 'DELETE'
        });
        return response.ok;
    }

    /**
     * Get messages for a session
     */
    async getMessages(sessionId: string): Promise<OpencodeMessageResponse[]> {
        const response = await fetch(`${this.baseUrl}/session/${sessionId}/message`);
        if (!response.ok) {
            throw new Error(`Failed to get messages: ${response.status}`);
        }
        return response.json() as Promise<OpencodeMessageResponse[]>;
    }

    /**
     * Send a prompt and wait for response
     */
    async sendPrompt(
        sessionId: string,
        text: string,
        options?: { model?: string; noReply?: boolean; system?: string }
    ): Promise<OpencodeMessageResponse> {
        const body: OpencodePromptRequest = {
            parts: [{ type: 'text', text }]
        };

        // Set model
        const modelStr = options?.model || this.config.model;
        if (modelStr) {
            const model = parseModelString(modelStr);
            if (model) {
                body.model = model;
            }
        }

        if (options?.noReply) {
            body.noReply = true;
        }

        if (options?.system) {
            body.system = options.system;
        }

        const response = await fetch(`${this.baseUrl}/session/${sessionId}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to send prompt: ${response.status} - ${errorText}`);
        }

        return response.json() as Promise<OpencodeMessageResponse>;
    }

    /**
     * Send a prompt asynchronously (don't wait for response)
     */
    async sendPromptAsync(sessionId: string, text: string): Promise<void> {
        const body: OpencodePromptRequest = {
            parts: [{ type: 'text', text }]
        };

        const modelStr = this.config.model;
        if (modelStr) {
            const model = parseModelString(modelStr);
            if (model) {
                body.model = model;
            }
        }

        const response = await fetch(`${this.baseUrl}/session/${sessionId}/prompt_async`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            throw new Error(`Failed to send async prompt: ${response.status}`);
        }
    }

    /**
     * Abort a running session
     */
    async abortSession(sessionId: string): Promise<boolean> {
        const response = await fetch(`${this.baseUrl}/session/${sessionId}/abort`, {
            method: 'POST'
        });
        return response.ok;
    }

    /**
     * Respond to a permission request
     */
    async respondToPermission(
        sessionId: string,
        permissionId: string,
        allow: boolean,
        remember?: boolean
    ): Promise<boolean> {
        const response = await fetch(
            `${this.baseUrl}/session/${sessionId}/permissions/${permissionId}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    response: allow ? 'allow' : 'deny',
                    remember
                })
            }
        );
        return response.ok;
    }

    /**
     * Subscribe to server events via SSE
     */
    async subscribeToEvents(onEvent: (event: OpencodeEvent) => void): Promise<void> {
        this.abortController = new AbortController();
        
        try {
            const response = await fetch(`${this.baseUrl}/event`, {
                signal: this.abortController.signal,
                headers: {
                    'Accept': 'text/event-stream'
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to subscribe to events: ${response.status}`);
            }

            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error('No response body');
            }

            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            onEvent(data as OpencodeEvent);
                        } catch {
                            // Ignore parse errors
                        }
                    }
                }
            }
        } catch (error) {
            if ((error as Error).name !== 'AbortError') {
                throw error;
            }
        }
    }

    /**
     * Unsubscribe from events
     */
    unsubscribeFromEvents(): void {
        this.abortController?.abort();
        this.abortController = null;
    }

    /**
     * Get server URL
     */
    getServerUrl(): string {
        return this.baseUrl;
    }

    /**
     * Update model configuration
     */
    setModel(model: string): void {
        this.config.model = model;
    }

    /**
     * Get current model
     */
    getModel(): string {
        return this.config.model || DEFAULT_OPENCODE_MODEL;
    }

    /**
     * Disconnect and cleanup
     */
    async disconnect(): Promise<void> {
        this.unsubscribeFromEvents();
        
        if (this.serverProcess) {
            logger.debug('[opencode] Stopping server');
            this.serverProcess.kill('SIGTERM');
            this.serverProcess = null;
        }
    }

    /**
     * Check if OpenCode CLI is available
     */
    static async isAvailable(): Promise<boolean> {
        return new Promise((resolve) => {
            const proc = spawn('opencode', ['--version'], {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            proc.on('close', (code) => resolve(code === 0));
            proc.on('error', () => resolve(false));
            
            setTimeout(() => {
                proc.kill();
                resolve(false);
            }, 5000);
        });
    }

    /**
     * Get OpenCode CLI version
     */
    static async getVersion(): Promise<string | null> {
        return new Promise((resolve) => {
            const proc = spawn('opencode', ['--version'], {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            let stdout = '';
            proc.stdout?.on('data', (data) => {
                stdout += data.toString();
            });
            
            proc.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    resolve(null);
                }
            });
            proc.on('error', () => resolve(null));
        });
    }
}
