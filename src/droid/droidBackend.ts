/**
 * DroidBackend - AgentBackend implementation for Factory Droid
 * 
 * Implements the Happy CLI AgentBackend interface using the DroidClient
 * to communicate with the Droid CLI via subprocess.
 */

import type { 
    AgentBackend, 
    AgentMessage, 
    AgentMessageHandler,
    SessionId,
    StartSessionResult 
} from '@/agent/AgentBackend';
import { DroidClient, DroidClientOptions } from './droidClient';
import type { 
    DroidStreamEvent, 
    DroidAutoLevel,
    DroidPermissionMode,
    DroidExecOptions 
} from './types';
import { permissionModeToAutoLevel } from './types';
import { logger } from '@/ui/logger';
import { randomUUID } from 'node:crypto';

export interface DroidBackendOptions extends DroidClientOptions {
    auto?: DroidAutoLevel;
    permissionMode?: DroidPermissionMode;
}

export class DroidBackend implements AgentBackend {
    private client: DroidClient;
    private messageHandlers: AgentMessageHandler[] = [];
    private currentSessionId: string | null = null;
    private droidSessionId: string | null = null; // Droid's internal session ID
    private auto: DroidAutoLevel | undefined;
    private permissionMode: DroidPermissionMode;
    private isRunning: boolean = false;

    constructor(options: DroidBackendOptions) {
        this.client = new DroidClient({
            apiKey: options.apiKey,
            defaultModel: options.defaultModel,
            cwd: options.cwd
        });
        this.permissionMode = options.permissionMode || 'default';
        this.auto = options.auto || permissionModeToAutoLevel(this.permissionMode);
    }

    async startSession(initialPrompt?: string): Promise<StartSessionResult> {
        // Generate Happy session ID
        const happySessionId = randomUUID();
        this.currentSessionId = happySessionId;

        // Emit starting status
        this.emit({ type: 'status', status: 'starting' });

        if (!initialPrompt) {
            this.emit({ type: 'status', status: 'idle' });
            return {
                sessionId: happySessionId as SessionId
            };
        }

        try {
            this.isRunning = true;
            
            // Use streaming for real-time updates
            await this.client.execStream(
                initialPrompt,
                (event) => this.handleStreamEvent(event),
                { auto: this.auto }
            );

            this.isRunning = false;
            this.emit({ type: 'status', status: 'idle' });

            return {
                sessionId: happySessionId as SessionId
            };
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

    async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
        // Emit status
        this.emit({ type: 'status', status: 'running' });
        this.isRunning = true;

        const options: DroidExecOptions = {
            auto: this.auto
        };

        // Continue Droid session if we have one
        if (this.droidSessionId) {
            options.sessionId = this.droidSessionId;
        }

        try {
            await this.client.execStream(
                prompt,
                (event) => this.handleStreamEvent(event),
                options
            );

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
        const cancelled = this.client.cancel();
        if (cancelled) {
            this.isRunning = false;
            this.emit({ type: 'status', status: 'stopped' });
        }
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
        // Droid handles permissions via autonomy levels, not per-request
        // This is a no-op for CLI wrapper approach
        logger.debug('[droid] Permission response (handled via --auto level):', requestId, approved);
    }

    async dispose(): Promise<void> {
        this.client.cancel();
        this.messageHandlers = [];
        this.currentSessionId = null;
        this.droidSessionId = null;
        this.isRunning = false;
    }

    /**
     * Set permission mode and update autonomy level
     */
    setPermissionMode(mode: DroidPermissionMode): void {
        this.permissionMode = mode;
        this.auto = permissionModeToAutoLevel(mode);
        logger.debug('[droid] Permission mode set to:', mode, '-> auto:', this.auto);
    }

    /**
     * Set autonomy level directly
     */
    setAutoLevel(level: DroidAutoLevel | undefined): void {
        this.auto = level;
    }

    /**
     * Get current autonomy level
     */
    getAutoLevel(): DroidAutoLevel | undefined {
        return this.auto;
    }

    /**
     * Get Droid's session ID (for session continuation)
     */
    getDroidSessionId(): string | null {
        return this.droidSessionId;
    }

    /**
     * Get current permission mode
     */
    getPermissionMode(): DroidPermissionMode {
        return this.permissionMode;
    }

    /**
     * Check if currently running
     */
    getIsRunning(): boolean {
        return this.isRunning;
    }

    /**
     * Update default model
     */
    setModel(model: string): void {
        this.client.setDefaultModel(model);
    }

    /**
     * Get current model
     */
    getModel(): string {
        return this.client.getDefaultModel();
    }

    /**
     * Handle stream events and convert to AgentMessages
     */
    private handleStreamEvent(event: DroidStreamEvent): void {
        switch (event.type) {
            case 'system':
                // Store Droid's session ID for continuation
                this.droidSessionId = event.session_id;
                
                this.emit({
                    type: 'event',
                    name: 'system-init',
                    payload: {
                        sessionId: event.session_id,
                        tools: event.tools,
                        model: event.model,
                        cwd: event.cwd
                    }
                });
                
                logger.debug('[droid] Session initialized:', event.session_id);
                break;

            case 'message':
                if (event.role === 'assistant') {
                    this.emit({
                        type: 'model-output',
                        textDelta: event.text,
                        fullText: event.text
                    });
                }
                break;

            case 'tool_call':
                this.emit({
                    type: 'tool-call',
                    toolName: event.toolName,
                    args: event.parameters,
                    callId: event.id
                });
                break;

            case 'tool_result':
                this.emit({
                    type: 'tool-result',
                    toolName: event.toolId,
                    result: event.value,
                    callId: event.id
                });
                
                // Emit file edit for write operations
                if (event.toolId === 'Write' || event.toolId === 'Edit' || event.toolId === 'ApplyPatch' || event.toolId === 'MultiEdit') {
                    this.emit({
                        type: 'fs-edit',
                        description: `File modified by ${event.toolId}`,
                        diff: typeof event.value === 'string' ? event.value : undefined
                    });
                }
                
                // Emit terminal output for Execute
                if (event.toolId === 'Execute') {
                    this.emit({
                        type: 'terminal-output',
                        data: typeof event.value === 'string' ? event.value : JSON.stringify(event.value)
                    });
                }
                break;

            case 'completion':
                // Emit final text
                if (event.finalText) {
                    this.emit({
                        type: 'model-output',
                        fullText: event.finalText
                    });
                }
                
                // Emit token count info
                this.emit({
                    type: 'token-count',
                    numTurns: event.numTurns,
                    durationMs: event.durationMs
                });
                
                logger.debug('[droid] Completion:', event.numTurns, 'turns,', event.durationMs, 'ms');
                break;
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
                logger.debug('[droid] Handler error:', e);
            }
        }
    }
}
