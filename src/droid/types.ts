/**
 * Droid Types
 * 
 * Type definitions for Factory Droid CLI integration.
 * These types represent the JSON structures returned by `droid exec`.
 */

/**
 * Output format options for droid exec
 */
export type DroidOutputFormat = 'text' | 'json' | 'stream-json' | 'stream-jsonrpc';

/**
 * Autonomy levels for droid operations
 * - default: Read-only reconnaissance
 * - low: Safe edits (create/edit files, formatters)
 * - medium: Local development (install deps, build, test, git commit)
 * - high: CI/CD & orchestration (git push, deploy)
 */
export type DroidAutoLevel = 'low' | 'medium' | 'high';

/**
 * Permission mode for tool approval (mapped from Happy's permission modes)
 */
export type DroidPermissionMode = 'default' | 'read-only' | 'safe-yolo' | 'yolo';

/**
 * Options for droid exec command
 */
export interface DroidExecOptions {
    outputFormat?: DroidOutputFormat;
    inputFormat?: 'stream-jsonrpc';
    auto?: DroidAutoLevel;
    sessionId?: string;
    model?: string;
    cwd?: string;
    useSpec?: boolean;
    specModel?: string;
    enabledTools?: string[];
    file?: string;
}

/**
 * Result from droid exec with JSON output
 */
export interface DroidResult {
    type: 'result' | 'error';
    subtype?: string;
    is_error: boolean;
    duration_ms: number;
    num_turns: number;
    result: string;
    session_id: string;
}

/**
 * System initialization event from stream-json
 */
export interface DroidSystemEvent {
    type: 'system';
    subtype: 'init';
    cwd: string;
    session_id: string;
    tools: string[];
    model: string;
}

/**
 * Message event from stream-json
 */
export interface DroidMessageEvent {
    type: 'message';
    role: 'user' | 'assistant';
    id: string;
    text: string;
    timestamp: number;
    session_id: string;
}

/**
 * Tool call event from stream-json
 */
export interface DroidToolCallEvent {
    type: 'tool_call';
    id: string;
    messageId: string;
    toolId: string;
    toolName: string;
    parameters: Record<string, unknown>;
    timestamp: number;
    session_id: string;
}

/**
 * Tool result event from stream-json
 */
export interface DroidToolResultEvent {
    type: 'tool_result';
    id: string;
    messageId: string;
    toolId: string;
    isError: boolean;
    value: string;
    timestamp: number;
    session_id: string;
}

/**
 * Completion event from stream-json
 */
export interface DroidCompletionEvent {
    type: 'completion';
    finalText: string;
    numTurns: number;
    durationMs: number;
    session_id: string;
    timestamp: number;
}

/**
 * Union type for all stream events
 */
export type DroidStreamEvent = 
    | DroidSystemEvent 
    | DroidMessageEvent 
    | DroidToolCallEvent 
    | DroidToolResultEvent 
    | DroidCompletionEvent;

/**
 * Mode configuration for Droid messages
 */
export interface DroidMode {
    permissionMode: DroidPermissionMode;
    model?: string;
    originalUserMessage?: string;
}

/**
 * Droid message payload for sending messages to mobile app
 */
export interface DroidMessagePayload {
    type: 'message';
    message: string;
    id: string;
    options?: string[];
}

/**
 * Map Happy permission modes to Droid autonomy levels
 */
export function permissionModeToAutoLevel(mode: DroidPermissionMode): DroidAutoLevel | undefined {
    switch (mode) {
        case 'default':
        case 'read-only':
            return undefined; // Default read-only mode
        case 'safe-yolo':
            return 'low';
        case 'yolo':
            return 'high';
        default:
            return undefined;
    }
}
