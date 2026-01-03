/**
 * OpencodeBackend - AgentBackend implementation for OpenCode
 * 
 * Implements the Happy CLI AgentBackend interface using the OpencodeClient
 * to communicate with the OpenCode server via HTTP API.
 */

import type {
    AgentBackend,
    AgentMessage,
    AgentMessageHandler,
    SessionId,
    StartSessionResult
} from '@/agent/AgentBackend';
import { OpencodeClient } from './opencodeClient';
import type {
    OpencodeEvent,
    OpencodePart,
    OpencodePermissionMode,
    OpencodeClientConfig
} from './types';
import { logger } from '@/ui/logger';
import { randomUUID } from 'node:crypto';

export interface OpencodeBackendOptions extends OpencodeClientConfig {
    permissionMode?: OpencodePermissionMode;
}

export class OpencodeBackend implements AgentBackend {
    private client: OpencodeClient;
    private messageHandlers: AgentMessageHandler[] = [];
    private happySessionId: string | null = null;
    private opencodeSessionId: string | null = null;
    private permissionMode: OpencodePermissionMode;
    private isRunning: boolean = false;
    private eventSubscriptionActive: boolean = false;

    constructor(options: OpencodeBackendOptions) {
        this.client = new OpencodeClient({
            baseUrl: options.baseUrl,
            model: options.model,
            port: options.port,
            hostname: options.hostname,
            startServer: options.startServer
        });
        this.permissionMode = options.permissionMode || 'default';
    }

    async startSession(initialPrompt?: string): Promise<StartSessionResult> {
        // Connect to OpenCode server
        await this.client.connect();

        // Start event subscription
        this.startEventSubscription();

        // Create OpenCode session
        const session = await this.client.createSession('Happy CLI Session');
        this.opencodeSessionId = session.id;
        this.happySessionId = randomUUID();

        logger.debug('[opencode] Session created:', session.id);

        // Emit starting status
        this.emit({ type: 'status', status: 'starting' });

        if (initialPrompt) {
            try {
                this.isRunning = true;
                const result = await this.client.sendPrompt(session.id, initialPrompt);
                this.processMessageResponse(result.parts);
                this.isRunning = false;
            } catch (error) {
                this.isRunning = false;
                this.emit({
                    type: 'status',
                    status: 'error',
                    detail: error instanceof Error ? error.message : 'Unknown error'
                });
                throw error;
            }
        }

        this.emit({ type: 'status', status: 'idle' });

        return {
            sessionId: this.happySessionId as SessionId
        };
    }

    async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
        if (!this.opencodeSessionId) {
            throw new Error('No OpenCode session active');
        }

        this.emit({ type: 'status', status: 'running' });
        this.isRunning = true;

        try {
            const result = await this.client.sendPrompt(this.opencodeSessionId, prompt);
            this.processMessageResponse(result.parts);
            this.isRunning = false;
            this.emit({ type: 'status', status: 'idle' });
        } catch (error) {
            this.isRunning = false;
            this.emit({
                type: 'status',
                status: 'error',
                detail: error instanceof Error ? error.message : 'Unknown error'
            });
            throw error;
        }
    }

    async cancel(sessionId: SessionId): Promise<void> {
        if (this.opencodeSessionId) {
            await this.client.abortSession(this.opencodeSessionId);
        }
        this.isRunning = false;
        this.emit({ type: 'status', status: 'stopped' });
    }

    onMessage(handler: AgentMessageHandler): void {
        this.messageHandlers.push(handler);
    }

    offMessage(handler: AgentMessageHandler): void {
        const index = this.messageHandlers.indexOf(handler);
        if (index !== -1) {
            this.messageHandlers.splice(index, 1);
        }
    }

    async respondToPermission(requestId: string, approved: boolean): Promise<void> {
        if (!this.opencodeSessionId) {
            logger.debug('[opencode] No session for permission response');
            return;
        }

        await this.client.respondToPermission(
            this.opencodeSessionId,
            requestId,
            approved
        );
    }

    async dispose(): Promise<void> {
        this.eventSubscriptionActive = false;
        this.client.unsubscribeFromEvents();
        await this.client.disconnect();
        this.messageHandlers = [];
        this.happySessionId = null;
        this.opencodeSessionId = null;
        this.isRunning = false;
    }

    /**
     * Set permission mode
     */
    setPermissionMode(mode: OpencodePermissionMode): void {
        this.permissionMode = mode;
        logger.debug('[opencode] Permission mode set to:', mode);
    }

    /**
     * Get current permission mode
     */
    getPermissionMode(): OpencodePermissionMode {
        return this.permissionMode;
    }

    /**
     * Update model
     */
    setModel(model: string): void {
        this.client.setModel(model);
    }

    /**
     * Get current model
     */
    getModel(): string {
        return this.client.getModel();
    }

    /**
     * Check if currently running
     */
    getIsRunning(): boolean {
        return this.isRunning;
    }

    /**
     * Get OpenCode session ID
     */
    getOpencodeSessionId(): string | null {
        return this.opencodeSessionId;
    }

    /**
     * Start SSE event subscription
     */
    private startEventSubscription(): void {
        if (this.eventSubscriptionActive) return;
        
        this.eventSubscriptionActive = true;
        
        this.client.subscribeToEvents((event) => {
            this.handleEvent(event);
        }).catch(err => {
            if (this.eventSubscriptionActive) {
                logger.debug('[opencode] Event subscription error:', err);
            }
        });
    }

    /**
     * Handle SSE event from OpenCode server
     */
    private handleEvent(event: OpencodeEvent): void {
        logger.debug('[opencode] Event:', event.type);

        switch (event.type) {
            case 'message.created':
            case 'message.updated':
            case 'message.delta':
                // Handle streaming text
                if (event.properties.content) {
                    this.emit({
                        type: 'model-output',
                        textDelta: event.properties.content as string
                    });
                }
                break;

            case 'tool.called':
            case 'tool.start':
                this.emit({
                    type: 'tool-call',
                    toolName: event.properties.name as string || event.properties.tool as string || 'unknown',
                    args: (event.properties.arguments || event.properties.args || {}) as Record<string, unknown>,
                    callId: event.properties.id as string || randomUUID()
                });
                break;

            case 'tool.result':
            case 'tool.end':
                const toolName = event.properties.name as string || event.properties.tool as string || 'unknown';
                const result = event.properties.result;
                
                this.emit({
                    type: 'tool-result',
                    toolName,
                    result,
                    callId: event.properties.id as string || ''
                });

                // Emit file edit for write/edit operations
                if (toolName === 'write' || toolName === 'edit') {
                    this.emit({
                        type: 'fs-edit',
                        description: `File modified by ${toolName}`,
                        path: event.properties.path as string,
                        diff: typeof result === 'string' ? result : undefined
                    });
                }

                // Emit terminal output for bash
                if (toolName === 'bash') {
                    this.emit({
                        type: 'terminal-output',
                        data: typeof result === 'string' ? result : JSON.stringify(result)
                    });
                }
                break;

            case 'permission.requested':
            case 'permission.required':
                this.emit({
                    type: 'permission-request',
                    id: event.properties.id as string,
                    reason: event.properties.reason as string || event.properties.message as string || 'Permission required',
                    payload: event.properties
                });
                break;

            case 'session.status':
                const status = event.properties.status as string;
                if (status === 'running') {
                    this.isRunning = true;
                    this.emit({ type: 'status', status: 'running' });
                } else if (status === 'idle' || status === 'completed') {
                    this.isRunning = false;
                    this.emit({ type: 'status', status: 'idle' });
                } else if (status === 'error') {
                    this.isRunning = false;
                    this.emit({
                        type: 'status',
                        status: 'error',
                        detail: event.properties.message as string
                    });
                }
                break;

            case 'error':
                this.emit({
                    type: 'status',
                    status: 'error',
                    detail: event.properties.message as string || 'Unknown error'
                });
                break;
        }
    }

    /**
     * Process message response parts
     */
    private processMessageResponse(parts: OpencodePart[]): void {
        for (const part of parts) {
            switch (part.type) {
                case 'text':
                    if (part.text) {
                        this.emit({
                            type: 'model-output',
                            fullText: part.text
                        });
                    }
                    break;

                case 'tool_call':
                    this.emit({
                        type: 'tool-call',
                        toolName: part.toolName || 'unknown',
                        args: part.args || {},
                        callId: part.toolCallId || randomUUID()
                    });
                    break;

                case 'tool_result':
                    const toolName = part.toolName || 'unknown';
                    
                    this.emit({
                        type: 'tool-result',
                        toolName,
                        result: part.result,
                        callId: part.toolCallId || ''
                    });

                    // Emit file edit for write/edit operations
                    if (toolName === 'write' || toolName === 'edit') {
                        this.emit({
                            type: 'fs-edit',
                            description: `File modified by ${toolName}`,
                            diff: typeof part.result === 'string' ? part.result : undefined
                        });
                    }

                    // Emit terminal output for bash
                    if (toolName === 'bash') {
                        this.emit({
                            type: 'terminal-output',
                            data: typeof part.result === 'string' ? part.result : JSON.stringify(part.result)
                        });
                    }
                    break;
            }
        }
    }

    /**
     * Emit message to all handlers
     */
    private emit(message: AgentMessage): void {
        for (const handler of this.messageHandlers) {
            try {
                handler(message);
            } catch (e) {
                logger.debug('[opencode] Handler error:', e);
            }
        }
    }
}
