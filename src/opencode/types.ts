/**
 * OpenCode Types
 * 
 * Type definitions for OpenCode SDK integration.
 * Based on OpenCode's OpenAPI 3.1 specification.
 */

/**
 * Permission mode for tool approval (mapped from Happy's permission modes)
 */
export type OpencodePermissionMode = 'default' | 'read-only' | 'safe-yolo' | 'yolo';

/**
 * OpenCode session
 */
export interface OpencodeSession {
    id: string;
    title?: string;
    createdAt: string;
    updatedAt: string;
    parentID?: string;
    share?: {
        id: string;
        url: string;
    };
}

/**
 * OpenCode message
 */
export interface OpencodeMessage {
    id: string;
    sessionId: string;
    role: 'user' | 'assistant';
    createdAt: string;
}

/**
 * OpenCode message part types
 */
export type OpencodePartType = 'text' | 'tool_call' | 'tool_result' | 'image' | 'file';

/**
 * OpenCode message part
 */
export interface OpencodePart {
    type: OpencodePartType;
    text?: string;
    toolName?: string;
    toolCallId?: string;
    args?: Record<string, unknown>;
    result?: unknown;
    isError?: boolean;
    path?: string;
    mimeType?: string;
    data?: string;
}

/**
 * OpenCode model specification
 */
export interface OpencodeModel {
    providerID: string;
    modelID: string;
}

/**
 * OpenCode prompt request body
 */
export interface OpencodePromptRequest {
    model?: OpencodeModel;
    agent?: string;
    noReply?: boolean;
    system?: string;
    tools?: string[];
    parts: OpencodePart[];
}

/**
 * OpenCode message response
 */
export interface OpencodeMessageResponse {
    info: OpencodeMessage;
    parts: OpencodePart[];
}

/**
 * OpenCode server health response
 */
export interface OpencodeHealthResponse {
    healthy: boolean;
    version: string;
}

/**
 * OpenCode provider info
 */
export interface OpencodeProvider {
    id: string;
    name: string;
    models: OpencodeModelInfo[];
}

/**
 * OpenCode model info
 */
export interface OpencodeModelInfo {
    id: string;
    name: string;
    contextLength?: number;
    pricing?: {
        input: number;
        output: number;
    };
}

/**
 * OpenCode event from SSE stream
 */
export interface OpencodeEvent {
    type: string;
    properties: Record<string, unknown>;
}

/**
 * OpenCode session status
 */
export type OpencodeSessionStatus = 'idle' | 'running' | 'error';

/**
 * OpenCode config
 */
export interface OpencodeConfig {
    model?: string;
    provider?: string;
    theme?: string;
    [key: string]: unknown;
}

/**
 * Mode configuration for OpenCode messages
 */
export interface OpencodeMode {
    permissionMode: OpencodePermissionMode;
    model?: string;
    originalUserMessage?: string;
}

/**
 * OpenCode message payload for sending messages to mobile app
 */
export interface OpencodeMessagePayload {
    type: 'message';
    message: string;
    id: string;
    options?: string[];
}

/**
 * OpenCode client configuration
 */
export interface OpencodeClientConfig {
    baseUrl?: string;
    model?: string;
    providerID?: string;
    modelID?: string;
    startServer?: boolean;
    port?: number;
    hostname?: string;
}

/**
 * OpenCode tool definition
 */
export interface OpencodeTool {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
}

/**
 * OpenCode permission request
 */
export interface OpencodePermissionRequest {
    id: string;
    type: string;
    tool?: string;
    reason?: string;
    details?: Record<string, unknown>;
}

/**
 * Parse model string into provider and model IDs
 */
export function parseModelString(model: string): OpencodeModel | null {
    const parts = model.split('/');
    if (parts.length !== 2) {
        return null;
    }
    return {
        providerID: parts[0],
        modelID: parts[1]
    };
}

/**
 * Format model object as string
 */
export function formatModelString(model: OpencodeModel): string {
    return `${model.providerID}/${model.modelID}`;
}
