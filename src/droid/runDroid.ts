/**
 * Droid CLI Entry Point
 * 
 * This module provides the main entry point for running the Factory Droid agent
 * through Happy CLI. It manages the agent lifecycle, session state, and
 * communication with the Happy server and mobile app.
 * 
 * Droid uses a CLI wrapper approach (droid exec) instead of SDK/protocol
 * because droid exec is specifically designed for automation and headless use.
 */

import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { join, resolve } from 'node:path';

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

import { DroidBackend } from './droidBackend';
import { DroidClient } from './droidClient';
import type { DroidMode, DroidPermissionMode, DroidMessagePayload } from './types';
import { permissionModeToAutoLevel } from './types';
import { FACTORY_API_KEY_ENV, DEFAULT_DROID_MODEL, DROID_MODEL_ENV, CHANGE_TITLE_INSTRUCTION } from './constants';
import { GeminiDisplay } from '@/ui/ink/GeminiDisplay'; // Reuse Gemini display for now
import type { AgentMessage } from '@/agent/AgentBackend';

/**
 * Main entry point for the droid command with ink UI
 */
export async function runDroid(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
    //
    // Verify Droid CLI is available
    //

    const isAvailable = await DroidClient.isAvailable();
    if (!isAvailable) {
        console.error('Error: Droid CLI not found.');
        console.error('Please install it first:');
        console.error('  curl -fsSL https://app.factory.ai/cli | sh');
        console.error('');
        console.error('Or via npm:');
        console.error('  npm install -g @factory/cli');
        process.exit(1);
    }

    //
    // Verify API key
    //

    const apiKey = process.env[FACTORY_API_KEY_ENV] || '';
    if (!apiKey) {
        console.error('Error: FACTORY_API_KEY not set.');
        console.error('');
        console.error('Get your API key at: https://app.factory.ai/settings/api-keys');
        console.error('Then set it with:');
        console.error(`  export ${FACTORY_API_KEY_ENV}="your-key-here"`);
        process.exit(1);
    }

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
        flavor: 'droid'
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

    const messageQueue = new MessageQueue2<DroidMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
    }));

    // Track current overrides
    let currentPermissionMode: DroidPermissionMode = 'default';
    let currentModel: string | undefined = process.env[DROID_MODEL_ENV] || undefined;

    session.onUserMessage((message) => {
        // Resolve permission mode
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const validModes: DroidPermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
            if (validModes.includes(message.meta.permissionMode as DroidPermissionMode)) {
                messagePermissionMode = message.meta.permissionMode as DroidPermissionMode;
                currentPermissionMode = messagePermissionMode;
                droidBackend.setPermissionMode(messagePermissionMode);
                logger.debug(`[Droid] Permission mode updated to: ${currentPermissionMode}`);
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
                droidBackend.setModel(messageModel);
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

        const mode: DroidMode = {
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
                'Droid is waiting for your command',
                { sessionId: session.sessionId }
            );
        } catch (pushError) {
            logger.debug('[Droid] Failed to send ready push', pushError);
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
        logger.debug('[Droid] Abort requested');
        
        session.sendCodexMessage({
            type: 'turn_aborted',
            id: randomUUID(),
        });
        
        try {
            messageQueue.reset();
            await droidBackend.cancel(response.id);
            logger.debug('[Droid] Abort completed');
        } catch (error) {
            logger.debug('[Droid] Error during abort:', error);
        }
    }

    const handleKillSession = async () => {
        logger.debug('[Droid] Kill session requested');
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
            await droidBackend.dispose();

            logger.debug('[Droid] Session termination complete');
            process.exit(0);
        } catch (error) {
            logger.debug('[Droid] Error during session termination:', error);
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

    let displayedModel: string | undefined = currentModel || DEFAULT_DROID_MODEL;

    if (hasTTY) {
        console.clear();
        const DisplayComponent = () => {
            return React.createElement(GeminiDisplay, {
                messageBuffer,
                logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
                currentModel: displayedModel || DEFAULT_DROID_MODEL,
                onExit: async () => {
                    logger.debug('[Droid]: Exiting via Ctrl-C');
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
    // Start Happy MCP server and create Droid backend
    //

    const happyServer = await startHappyServer(session);
    
    // Create Droid backend
    const droidBackend = new DroidBackend({
        apiKey,
        defaultModel: currentModel || DEFAULT_DROID_MODEL,
        cwd: process.cwd(),
        permissionMode: currentPermissionMode
    });

    // Set up message handler
    droidBackend.onMessage((msg: AgentMessage) => {
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
                logger.debug(`[Droid] Status: ${msg.status}${msg.detail ? ` - ${msg.detail}` : ''}`);
                
                if (msg.status === 'running') {
                    thinking = true;
                    session.keepAlive(thinking, 'remote');
                    session.sendCodexMessage({ type: 'task_started', id: randomUUID() });
                    messageBuffer.addMessage('Thinking...', 'system');
                } else if (msg.status === 'idle' || msg.status === 'stopped') {
                    thinking = false;
                    session.keepAlive(thinking, 'remote');
                    
                    if (isResponseInProgress && accumulatedResponse.trim()) {
                        const messagePayload: DroidMessagePayload = {
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
                logger.debug(`[Droid] Tool call: ${msg.toolName}`);
                messageBuffer.addMessage(`Using tool: ${msg.toolName}`, 'system');
                break;

            case 'tool-result':
                logger.debug(`[Droid] Tool result: ${msg.toolName}`);
                break;

            case 'fs-edit':
                logger.debug(`[Droid] File edit: ${msg.description}`);
                messageBuffer.addMessage(`📝 ${msg.description}`, 'system');
                break;

            case 'terminal-output':
                logger.debug(`[Droid] Terminal output`);
                break;
        }
    });

    //
    // Main message processing loop
    //

    logger.debug('[Droid] Starting message processing loop');
    
    // Initial ready signal
    emitReadyIfIdle();

    while (!shouldExit) {
        const item = await messageQueue.waitForMessagesAndGetAsString();
        if (!item) {
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
        }

        const { message: prompt, mode } = item;
        logger.debug(`[Droid] Processing prompt (${prompt.length} chars), mode:`, mode.permissionMode);

        // Reset accumulator for new prompt
        accumulatedResponse = '';
        isResponseInProgress = false;

        try {
            // Send prompt to Droid
            await droidBackend.sendPrompt(response.id, prompt);
        } catch (error) {
            logger.debug('[Droid] Error sending prompt:', error);
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

    await droidBackend.dispose();
    happyServer.stop();
    stopCaffeinate();
}
