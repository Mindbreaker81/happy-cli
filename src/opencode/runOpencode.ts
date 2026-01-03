/**
 * OpenCode CLI Entry Point
 * 
 * This module provides the main entry point for running the OpenCode agent
 * through Happy CLI. It manages the agent lifecycle, session state, and
 * communication with the Happy server and mobile app.
 * 
 * OpenCode uses a server-based approach with HTTP API and SSE events.
 */

import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { resolve } from 'node:path';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { AgentState, Metadata } from '@/api/types';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { stopCaffeinate } from '@/utils/caffeinate';

import { OpencodeBackend } from './opencodeBackend';
import { OpencodeClient } from './opencodeClient';
import type { OpencodeMode, OpencodePermissionMode, OpencodeMessagePayload } from './types';
import { 
    DEFAULT_OPENCODE_PORT, 
    DEFAULT_OPENCODE_MODEL, 
    OPENCODE_MODEL_ENV,
    CHANGE_TITLE_INSTRUCTION 
} from './constants';
import { 
    readOpencodeLocalConfig, 
    isOpencodeAuthenticated, 
    determineOpencodeModel,
    getConfiguredProviders 
} from './utils/config';
import { GeminiDisplay } from '@/ui/ink/GeminiDisplay';
import type { AgentMessage } from '@/agent/AgentBackend';

/**
 * Main entry point for the opencode command with ink UI
 */
export async function runOpencode(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
    //
    // Verify OpenCode CLI is available
    //

    const isAvailable = await OpencodeClient.isAvailable();
    if (!isAvailable) {
        console.error('Error: OpenCode CLI not found.');
        console.error('Please install it first:');
        console.error('  curl -fsSL https://opencode.ai/install | bash');
        console.error('');
        console.error('Or via npm:');
        console.error('  npm install -g opencode');
        process.exit(1);
    }

    //
    // Verify authentication - OpenCode uses ~/.local/share/opencode/auth.json
    //

    const opencodeConfig = readOpencodeLocalConfig();
    if (!isOpencodeAuthenticated()) {
        console.error('Error: OpenCode not authenticated.');
        console.error('');
        console.error('Please configure a provider first by running:');
        console.error('  opencode auth login');
        console.error('');
        console.error('Or set provider API keys as environment variables:');
        console.error('  export ANTHROPIC_API_KEY="your-key"');
        console.error('  export OPENAI_API_KEY="your-key"');
        process.exit(1);
    }

    // Log configured providers
    const providers = getConfiguredProviders();
    logger.debug(`[OpenCode] Authenticated with providers: ${providers.join(', ')}`);

    // Determine model to use
    const initialModel = determineOpencodeModel(undefined, opencodeConfig);
    logger.debug(`[OpenCode] Using model: ${initialModel}`);

    //
    // Define session
    //

    const sessionTag = randomUUID();
    const api = await ApiClient.create(opts.credentials);

    //
    // Machine
    //

    const settings = await readSettings();
    const machineId = settings?.machineId;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings. Please run 'happy auth login' first.`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    //
    // Create session
    //

    const state: AgentState = {
        controlledByUser: false,
    };
    const metadata: Metadata = {
        path: process.cwd(),
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: opts.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: opts.startedBy || 'terminal',
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'opencode'
    };
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    const session = api.sessionSyncClient(response);

    // Report to daemon
    try {
        logger.debug(`[START] Reporting session ${response.id} to daemon`);
        const result = await notifyDaemonSessionStarted(response.id, metadata);
        if (result.error) {
            logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
        } else {
            logger.debug(`[START] Reported session ${response.id} to daemon`);
        }
    } catch (error) {
        logger.debug('[START] Failed to report to daemon (may not be running):', error);
    }

    //
    // Message queue for handling incoming messages
    //

    const messageQueue = new MessageQueue2<OpencodeMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
    }));

    // Track current overrides (using initialModel from config)
    let currentPermissionMode: OpencodePermissionMode = 'default';
    let currentModel: string | undefined = initialModel;

    session.onUserMessage((message) => {
        // Resolve permission mode
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const validModes: OpencodePermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
            if (validModes.includes(message.meta.permissionMode as OpencodePermissionMode)) {
                messagePermissionMode = message.meta.permissionMode as OpencodePermissionMode;
                currentPermissionMode = messagePermissionMode;
                opencodeBackend.setPermissionMode(messagePermissionMode);
                logger.debug(`[OpenCode] Permission mode updated to: ${currentPermissionMode}`);
            }
        }

        // Resolve model
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            if (message.meta.model === null) {
                messageModel = undefined;
                currentModel = undefined;
            } else if (message.meta.model) {
                messageModel = message.meta.model;
                currentModel = messageModel;
                opencodeBackend.setModel(messageModel);
                messageBuffer.addMessage(`Model changed to: ${messageModel}`, 'system');
            }
        }

        // Build the full prompt
        const originalUserMessage = message.content.text;
        let fullPrompt = originalUserMessage;

        // Add title instruction for first message
        if (isFirstMessage && message.meta?.appendSystemPrompt) {
            fullPrompt = message.meta.appendSystemPrompt + '\n\n' + originalUserMessage + '\n\n' + CHANGE_TITLE_INSTRUCTION;
            isFirstMessage = false;
        }

        const mode: OpencodeMode = {
            permissionMode: messagePermissionMode,
            model: messageModel,
            originalUserMessage,
        };
        messageQueue.push(fullPrompt, mode);
    });

    let thinking = false;
    session.keepAlive(thinking, 'remote');
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    let isFirstMessage = true;

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
        try {
            api.push().sendToAllDevices(
                "It's ready!",
                'OpenCode is waiting for your command',
                { sessionId: session.sessionId }
            );
        } catch (pushError) {
            logger.debug('[OpenCode] Failed to send ready push', pushError);
        }
    };

    const emitReadyIfIdle = (): boolean => {
        if (shouldExit) return false;
        if (thinking) return false;
        if (isResponseInProgress) return false;
        if (messageQueue.size() > 0) return false;
        sendReady();
        return true;
    };

    //
    // Abort handling
    //

    let shouldExit = false;
    let isResponseInProgress = false;
    let accumulatedResponse = '';

    async function handleAbort() {
        logger.debug('[OpenCode] Abort requested');

        session.sendCodexMessage({
            type: 'turn_aborted',
            id: randomUUID(),
        });

        try {
            messageQueue.reset();
            await opencodeBackend.cancel(response.id);
            logger.debug('[OpenCode] Abort completed');
        } catch (error) {
            logger.debug('[OpenCode] Error during abort:', error);
        }
    }

    const handleKillSession = async () => {
        logger.debug('[OpenCode] Kill session requested');
        await handleAbort();

        try {
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));

                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            clearInterval(keepAliveInterval);
            stopCaffeinate();
            happyServer.stop();
            await opencodeBackend.dispose();

            logger.debug('[OpenCode] Session termination complete');
            process.exit(0);
        } catch (error) {
            logger.debug('[OpenCode] Error during session termination:', error);
            process.exit(1);
        }
    };

    session.rpcHandlerManager.registerHandler('abort', handleAbort);
    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    //
    // Initialize Ink UI
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: ReturnType<typeof render> | null = null;

    let displayedModel: string | undefined = currentModel || DEFAULT_OPENCODE_MODEL;

    if (hasTTY) {
        console.clear();
        const DisplayComponent = () => {
            return React.createElement(GeminiDisplay, {
                messageBuffer,
                logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
                currentModel: displayedModel || DEFAULT_OPENCODE_MODEL,
                agentName: 'OpenCode',
                onExit: async () => {
                    logger.debug('[OpenCode]: Exiting via Ctrl-C');
                    shouldExit = true;
                    await handleAbort();
                }
            });
        };

        inkInstance = render(React.createElement(DisplayComponent), {
            exitOnCtrlC: false,
            patchConsole: false
        });

        messageBuffer.addMessage(`[MODEL:${displayedModel}]`, 'system');
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding('utf8');
    }

    //
    // Start Happy MCP server and create OpenCode backend
    //

    const happyServer = await startHappyServer(session);

    // Create OpenCode backend - start its own server
    const opencodeBackend = new OpencodeBackend({
        model: currentModel || DEFAULT_OPENCODE_MODEL,
        port: DEFAULT_OPENCODE_PORT + 1, // Avoid conflict with default
        startServer: true,
        permissionMode: currentPermissionMode
    });

    // Set up message handler
    opencodeBackend.onMessage((msg: AgentMessage) => {
        switch (msg.type) {
            case 'model-output':
                if (msg.textDelta || msg.fullText) {
                    const text = msg.fullText || msg.textDelta || '';
                    if (!isResponseInProgress) {
                        messageBuffer.removeLastMessage('system');
                        messageBuffer.addMessage(text, 'assistant');
                        isResponseInProgress = true;
                    } else {
                        messageBuffer.updateLastMessage(text, 'assistant');
                    }
                    accumulatedResponse += (msg.textDelta || '');
                }
                break;

            case 'status':
                logger.debug(`[OpenCode] Status: ${msg.status}${msg.detail ? ` - ${msg.detail}` : ''}`);

                if (msg.status === 'running') {
                    thinking = true;
                    session.keepAlive(thinking, 'remote');
                    session.sendCodexMessage({ type: 'task_started', id: randomUUID() });
                    messageBuffer.addMessage('Thinking...', 'system');
                } else if (msg.status === 'idle' || msg.status === 'stopped') {
                    thinking = false;
                    session.keepAlive(thinking, 'remote');

                    if (isResponseInProgress && accumulatedResponse.trim()) {
                        const messagePayload: OpencodeMessagePayload = {
                            type: 'message',
                            message: accumulatedResponse,
                            id: randomUUID(),
                        };
                        session.sendCodexMessage(messagePayload);
                        session.sendCodexMessage({ type: 'task_complete', id: randomUUID() });
                        accumulatedResponse = '';
                        isResponseInProgress = false;
                    }
                } else if (msg.status === 'error') {
                    thinking = false;
                    session.keepAlive(thinking, 'remote');
                    session.sendCodexMessage({ type: 'turn_aborted', id: randomUUID() });

                    const errorMessage = msg.detail || 'Unknown error';
                    messageBuffer.addMessage(`Error: ${errorMessage}`, 'status');
                    session.sendCodexMessage({
                        type: 'message',
                        message: `Error: ${errorMessage}`,
                        id: randomUUID(),
                    });

                    accumulatedResponse = '';
                    isResponseInProgress = false;
                }
                break;

            case 'tool-call':
                logger.debug(`[OpenCode] Tool call: ${msg.toolName}`);
                messageBuffer.addMessage(`Using tool: ${msg.toolName}`, 'system');
                break;

            case 'tool-result':
                logger.debug(`[OpenCode] Tool result: ${msg.toolName}`);
                break;

            case 'fs-edit':
                logger.debug(`[OpenCode] File edit: ${msg.description}`);
                messageBuffer.addMessage(`📝 ${msg.description}`, 'system');
                break;

            case 'terminal-output':
                logger.debug(`[OpenCode] Terminal output`);
                break;

            case 'permission-request':
                logger.debug(`[OpenCode] Permission request: ${msg.reason}`);
                // Auto-approve based on permission mode
                if (currentPermissionMode === 'yolo' || currentPermissionMode === 'safe-yolo') {
                    opencodeBackend.respondToPermission(msg.id, true);
                } else {
                    messageBuffer.addMessage(`⚠️ Permission requested: ${msg.reason}`, 'system');
                    // Forward to mobile app
                    session.sendCodexMessage({
                        type: 'permission-request' as any,
                        id: msg.id,
                        reason: msg.reason,
                        payload: msg.payload
                    });
                }
                break;
        }
    });

    //
    // Main message processing loop
    //

    logger.debug('[OpenCode] Starting message processing loop');

    // Initial ready signal
    emitReadyIfIdle();

    while (!shouldExit) {
        const item = await messageQueue.waitForMessagesAndGetAsString();
        if (!item) {
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
        }

        const { message: prompt, mode } = item;
        logger.debug(`[OpenCode] Processing prompt (${prompt.length} chars), mode:`, mode.permissionMode);

        // Reset accumulator for new prompt
        accumulatedResponse = '';
        isResponseInProgress = false;

        try {
            // Send prompt to OpenCode
            await opencodeBackend.sendPrompt(response.id, prompt);
        } catch (error) {
            logger.debug('[OpenCode] Error sending prompt:', error);
            messageBuffer.addMessage(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`, 'status');
        } finally {
            emitReadyIfIdle();
        }
    }

    //
    // Cleanup
    //

    clearInterval(keepAliveInterval);

    if (inkInstance) {
        inkInstance.unmount();
    }

    await opencodeBackend.dispose();
    happyServer.stop();
    stopCaffeinate();
}
