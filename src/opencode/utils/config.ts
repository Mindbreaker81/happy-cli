/**
 * OpenCode Configuration Utilities
 * 
 * Utilities for reading OpenCode CLI configuration files,
 * including authentication from ~/.local/share/opencode/auth.json.
 * 
 * OpenCode stores provider API keys in its auth.json file after
 * running `opencode auth login` or configuring providers.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '@/ui/logger';
import { OPENCODE_MODEL_ENV, DEFAULT_OPENCODE_MODEL } from '../constants';

/**
 * OpenCode auth provider entry
 */
export interface OpencodeAuthProvider {
    type: 'api' | 'oauth';
    key?: string;
    token?: string;
}

/**
 * OpenCode auth.json structure
 */
export interface OpencodeAuthConfig {
    [providerId: string]: OpencodeAuthProvider;
}

/**
 * Result of reading OpenCode local configuration
 */
export interface OpencodeLocalConfig {
    providers: OpencodeAuthConfig;
    model: string | null;
    hasAuth: boolean;
}

/**
 * Get the OpenCode data directory path
 * OpenCode uses XDG_DATA_HOME or defaults to ~/.local/share/opencode
 */
function getOpencodeDataDir(): string {
    const xdgDataHome = process.env.XDG_DATA_HOME;
    if (xdgDataHome) {
        return join(xdgDataHome, 'opencode');
    }
    return join(homedir(), '.local', 'share', 'opencode');
}

/**
 * Get the OpenCode config directory path
 * OpenCode uses XDG_CONFIG_HOME or defaults to ~/.config/opencode
 */
function getOpencodeConfigDir(): string {
    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    if (xdgConfigHome) {
        return join(xdgConfigHome, 'opencode');
    }
    return join(homedir(), '.config', 'opencode');
}

/**
 * Try to read OpenCode config from local files.
 * OpenCode stores auth in ~/.local/share/opencode/auth.json
 */
export function readOpencodeLocalConfig(): OpencodeLocalConfig {
    let providers: OpencodeAuthConfig = {};
    let model: string | null = null;
    let hasAuth = false;

    // Read auth from ~/.local/share/opencode/auth.json
    const dataDir = getOpencodeDataDir();
    const authPath = join(dataDir, 'auth.json');
    
    if (existsSync(authPath)) {
        try {
            const authConfig = JSON.parse(readFileSync(authPath, 'utf-8')) as OpencodeAuthConfig;
            providers = authConfig;
            
            // Check if any provider has valid auth
            hasAuth = Object.values(authConfig).some(
                provider => provider.key || provider.token
            );
            
            if (hasAuth) {
                logger.debug(`[OpenCode] Found auth in ${authPath} with ${Object.keys(authConfig).length} provider(s)`);
            }
        } catch (error) {
            logger.debug(`[OpenCode] Failed to read auth from ${authPath}:`, error);
        }
    }

    // Also check legacy ~/.opencode/auth.json
    const legacyAuthPath = join(homedir(), '.opencode', 'auth.json');
    if (!hasAuth && existsSync(legacyAuthPath)) {
        try {
            const authConfig = JSON.parse(readFileSync(legacyAuthPath, 'utf-8')) as OpencodeAuthConfig;
            providers = authConfig;
            hasAuth = Object.values(authConfig).some(
                provider => provider.key || provider.token
            );
            
            if (hasAuth) {
                logger.debug(`[OpenCode] Found auth in legacy path ${legacyAuthPath}`);
            }
        } catch (error) {
            logger.debug(`[OpenCode] Failed to read legacy auth:`, error);
        }
    }

    // Read settings from config directory
    const configDir = getOpencodeConfigDir();
    const settingsPath = join(configDir, 'settings.json');
    
    if (existsSync(settingsPath)) {
        try {
            const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
            
            if (settings.model && typeof settings.model === 'string') {
                model = settings.model;
                logger.debug(`[OpenCode] Found model in settings: ${model}`);
            }
        } catch (error) {
            logger.debug(`[OpenCode] Failed to read settings:`, error);
        }
    }

    return { providers, model, hasAuth };
}

/**
 * Check if OpenCode has any configured providers
 */
export function isOpencodeAuthenticated(): boolean {
    const config = readOpencodeLocalConfig();
    return config.hasAuth;
}

/**
 * Get list of configured provider names
 */
export function getConfiguredProviders(): string[] {
    const config = readOpencodeLocalConfig();
    return Object.keys(config.providers).filter(
        id => config.providers[id].key || config.providers[id].token
    );
}

/**
 * Determine the model to use based on priority:
 * 1. Explicit model parameter (if provided)
 * 2. Environment variable (OPENCODE_MODEL)
 * 3. Local config file
 * 4. Default model
 */
export function determineOpencodeModel(
    explicitModel: string | null | undefined,
    localConfig: OpencodeLocalConfig
): string {
    if (explicitModel !== undefined && explicitModel !== null) {
        return explicitModel;
    }
    
    const envModel = process.env[OPENCODE_MODEL_ENV];
    if (envModel) {
        logger.debug(`[OpenCode] Using model from ${OPENCODE_MODEL_ENV}: ${envModel}`);
        return envModel;
    }
    
    if (localConfig.model) {
        logger.debug(`[OpenCode] Using model from local config: ${localConfig.model}`);
        return localConfig.model;
    }
    
    logger.debug(`[OpenCode] Using default model: ${DEFAULT_OPENCODE_MODEL}`);
    return DEFAULT_OPENCODE_MODEL;
}

/**
 * Get the initial model value for UI display
 */
export function getInitialOpencodeModel(): string {
    const localConfig = readOpencodeLocalConfig();
    return process.env[OPENCODE_MODEL_ENV] || localConfig.model || DEFAULT_OPENCODE_MODEL;
}
