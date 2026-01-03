/**
 * DroidClient - Wrapper for Factory Droid CLI exec command
 * 
 * This module provides a programmatic interface to the Droid CLI
 * using child_process to execute `droid exec` commands.
 * 
 * Droid exec is specifically designed for headless/automation use cases,
 * supporting JSON output and streaming for real-time events.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { 
    DroidExecOptions, 
    DroidResult, 
    DroidStreamEvent,
    DroidAutoLevel 
} from './types';
import { logger } from '@/ui/logger';
import { FACTORY_API_KEY_ENV, DEFAULT_DROID_MODEL } from './constants';

export interface DroidClientOptions {
    apiKey: string;
    defaultModel?: string;
    cwd?: string;
}

export class DroidClient extends EventEmitter {
    private apiKey: string;
    private defaultModel: string;
    private defaultCwd: string;
    private currentProcess: ChildProcess | null = null;

    constructor(options: DroidClientOptions) {
        super();
        this.apiKey = options.apiKey;
        this.defaultModel = options.defaultModel || DEFAULT_DROID_MODEL;
        this.defaultCwd = options.cwd || process.cwd();
    }

    /**
     * Execute a prompt using droid exec with JSON output
     */
    async exec(prompt: string, options: DroidExecOptions = {}): Promise<DroidResult> {
        const args = this.buildArgs(prompt, { ...options, outputFormat: 'json' });
        
        logger.debug('[droid] Executing:', 'droid', args.join(' '));

        return new Promise((resolve, reject) => {
            const droid = spawn('droid', args, {
                env: { ...process.env, [FACTORY_API_KEY_ENV]: this.apiKey },
                cwd: options.cwd || this.defaultCwd
            });

            let stdout = '';
            let stderr = '';

            droid.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            droid.stderr.on('data', (data) => {
                stderr += data.toString();
                logger.debug('[droid] stderr:', data.toString().trim());
            });

            droid.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`Droid exited with code ${code}: ${stderr || 'Unknown error'}`));
                    return;
                }

                try {
                    const result = JSON.parse(stdout) as DroidResult;
                    resolve(result);
                } catch (e) {
                    // Fallback for non-JSON output
                    resolve({
                        type: 'result',
                        is_error: false,
                        duration_ms: 0,
                        num_turns: 1,
                        result: stdout,
                        session_id: ''
                    });
                }
            });

            droid.on('error', (err) => {
                reject(new Error(`Failed to spawn droid: ${err.message}`));
            });
        });
    }

    /**
     * Execute with streaming JSON output for real-time events
     */
    async execStream(
        prompt: string, 
        onEvent: (event: DroidStreamEvent) => void,
        options: DroidExecOptions = {}
    ): Promise<string> {
        const args = this.buildArgs(prompt, { ...options, outputFormat: 'stream-json' });
        
        logger.debug('[droid] Streaming:', 'droid', args.join(' '));

        return new Promise((resolve, reject) => {
            const droid = spawn('droid', args, {
                env: { ...process.env, [FACTORY_API_KEY_ENV]: this.apiKey },
                cwd: options.cwd || this.defaultCwd
            });

            this.currentProcess = droid;
            let finalText = '';
            let buffer = '';
            let stderr = '';

            droid.stdout.on('data', (data) => {
                buffer += data.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep incomplete line in buffer

                for (const line of lines) {
                    if (!line.trim()) continue;
                    
                    try {
                        const event = JSON.parse(line) as DroidStreamEvent;
                        onEvent(event);
                        
                        if (event.type === 'completion') {
                            finalText = event.finalText;
                        }
                    } catch (e) {
                        logger.debug('[droid] Failed to parse event:', line.substring(0, 100));
                    }
                }
            });

            droid.stderr.on('data', (data) => {
                stderr += data.toString();
                logger.debug('[droid] stderr:', data.toString().trim());
            });

            droid.on('close', (code) => {
                this.currentProcess = null;
                
                // Process any remaining buffer
                if (buffer.trim()) {
                    try {
                        const event = JSON.parse(buffer) as DroidStreamEvent;
                        onEvent(event);
                        if (event.type === 'completion') {
                            finalText = event.finalText;
                        }
                    } catch (e) {
                        // Ignore parse errors for incomplete data
                    }
                }
                
                if (code !== 0) {
                    reject(new Error(`Droid stream exited with code ${code}: ${stderr || 'Unknown error'}`));
                } else {
                    resolve(finalText);
                }
            });

            droid.on('error', (err) => {
                this.currentProcess = null;
                reject(new Error(`Failed to spawn droid: ${err.message}`));
            });
        });
    }

    /**
     * Cancel current execution
     */
    cancel(): boolean {
        if (this.currentProcess) {
            logger.debug('[droid] Cancelling current process');
            this.currentProcess.kill('SIGTERM');
            this.currentProcess = null;
            return true;
        }
        return false;
    }

    /**
     * Build command line arguments for droid exec
     */
    private buildArgs(prompt: string, options: DroidExecOptions): string[] {
        const args = ['exec'];

        // Output format
        args.push('-o', options.outputFormat || 'json');

        // Input format (for stream-jsonrpc)
        if (options.inputFormat) {
            args.push('--input-format', options.inputFormat);
        }

        // Autonomy level
        if (options.auto) {
            args.push('--auto', options.auto);
        }

        // Session continuation
        if (options.sessionId) {
            args.push('-s', options.sessionId);
        }

        // Model selection
        const model = options.model || this.defaultModel;
        args.push('-m', model);

        // Spec mode
        if (options.useSpec) {
            args.push('--use-spec');
            if (options.specModel) {
                args.push('--spec-model', options.specModel);
            }
        }

        // Enabled tools
        if (options.enabledTools?.length) {
            args.push('--enabled-tools', options.enabledTools.join(','));
        }

        // Read prompt from file
        if (options.file) {
            args.push('-f', options.file);
        } else {
            // Prompt (must be last)
            args.push(prompt);
        }

        return args;
    }

    /**
     * Check if Droid CLI is available in PATH
     */
    static async isAvailable(): Promise<boolean> {
        return new Promise((resolve) => {
            const droid = spawn('droid', ['--version'], {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            droid.on('close', (code) => resolve(code === 0));
            droid.on('error', () => resolve(false));
            
            // Timeout after 5 seconds
            setTimeout(() => {
                droid.kill();
                resolve(false);
            }, 5000);
        });
    }

    /**
     * Get Droid CLI version
     */
    static async getVersion(): Promise<string | null> {
        return new Promise((resolve) => {
            const droid = spawn('droid', ['--version'], {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            let stdout = '';
            droid.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            
            droid.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    resolve(null);
                }
            });
            droid.on('error', () => resolve(null));
        });
    }

    /**
     * Get available tools from Droid
     */
    async getAvailableTools(): Promise<string[]> {
        return new Promise((resolve) => {
            const droid = spawn('droid', ['exec', '--list-tools'], {
                env: { ...process.env, [FACTORY_API_KEY_ENV]: this.apiKey },
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            droid.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            droid.on('close', (code) => {
                if (code !== 0) {
                    resolve([]);
                    return;
                }
                
                // Parse tool list from output
                const tools = stdout.split('\n')
                    .map(line => line.trim())
                    .filter(line => line.length > 0 && !line.startsWith('#'));
                resolve(tools);
            });

            droid.on('error', () => resolve([]));
        });
    }

    /**
     * Get current session ID (if any)
     */
    getCurrentSessionId(): string | null {
        // Session ID is managed by the backend, not the client
        return null;
    }

    /**
     * Update default model
     */
    setDefaultModel(model: string): void {
        this.defaultModel = model;
    }

    /**
     * Get default model
     */
    getDefaultModel(): string {
        return this.defaultModel;
    }
}
