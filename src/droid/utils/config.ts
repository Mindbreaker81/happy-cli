/**
 * Droid Configuration Utilities
 * 
 * Utilities for reading Droid CLI configuration files,
 * including authentication tokens from ~/.factory/auth.json.
 * 
 * Similar to how Gemini reads from ~/.gemini/oauth_creds.json,
 * Droid CLI stores OAuth tokens in ~/.factory/auth.json after login.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '@/ui/logger';
import { DROID_MODEL_ENV, DEFAULT_DROID_MODEL } from '../constants';

/**
 * Result of reading Droid local configuration
 */
export interface DroidLocalConfig {
    accessToken: string | null;
    refreshToken: string | null;
    model: string | null;
}

/**
 * Try to read Droid config from local Factory CLI config files.
 * Droid CLI stores OAuth tokens in ~/.factory/auth.json after 'droid' login.
 */
export function readDroidLocalConfig(): DroidLocalConfig {
    let accessToken: string | null = null;
    let refreshToken: string | null = null;
    let model: string | null = null;

    // Read auth from ~/.factory/auth.json
    const authPath = join(homedir(), '.factory', 'auth.json');
    if (existsSync(authPath)) {
        try {
            const authConfig = JSON.parse(readFileSync(authPath, 'utf-8'));
            
            if (authConfig.access_token && typeof authConfig.access_token === 'string') {
                accessToken = authConfig.access_token;
                logger.debug(`[Droid] Found access_token in ${authPath}`);
            }
            
            if (authConfig.refresh_token && typeof authConfig.refresh_token === 'string') {
                refreshToken = authConfig.refresh_token;
                logger.debug(`[Droid] Found refresh_token in ${authPath}`);
            }
        } catch (error) {
            logger.debug(`[Droid] Failed to read auth from ${authPath}:`, error);
        }
    }

    // Read settings from ~/.factory/settings.json
    const settingsPath = join(homedir(), '.factory', 'settings.json');
    if (existsSync(settingsPath)) {
        try {
            const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
            
            if (settings.model && typeof settings.model === 'string') {
                model = settings.model;
                logger.debug(`[Droid] Found model in ${settingsPath}: ${model}`);
            }
        } catch (error) {
            logger.debug(`[Droid] Failed to read settings from ${settingsPath}:`, error);
        }
    }

    // Read config from ~/.factory/config.json for custom models
    const configPath = join(homedir(), '.factory', 'config.json');
    if (existsSync(configPath)) {
        try {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'));
            
            // Check for custom models if no model set yet
            if (!model && config.custom_models && Array.isArray(config.custom_models) && config.custom_models.length > 0) {
                // Could default to first custom model, but leave as null for default behavior
                logger.debug(`[Droid] Found ${config.custom_models.length} custom models in ${configPath}`);
            }
        } catch (error) {
            logger.debug(`[Droid] Failed to read config from ${configPath}:`, error);
        }
    }

    return { accessToken, refreshToken, model };
}

/**
 * Check if Droid CLI is authenticated (has valid auth.json)
 */
export function isDroidAuthenticated(): boolean {
    const config = readDroidLocalConfig();
    return !!config.accessToken;
}

/**
 * Determine the model to use based on priority:
 * 1. Explicit model parameter (if provided)
 * 2. Environment variable (DROID_MODEL)
 * 3. Local config file
 * 4. Default model
 */
export function determineDroidModel(
    explicitModel: string | null | undefined,
    localConfig: DroidLocalConfig
): string {
    if (explicitModel !== undefined && explicitModel !== null) {
        return explicitModel;
    }
    
    const envModel = process.env[DROID_MODEL_ENV];
    if (envModel) {
        logger.debug(`[Droid] Using model from ${DROID_MODEL_ENV}: ${envModel}`);
        return envModel;
    }
    
    if (localConfig.model) {
        logger.debug(`[Droid] Using model from local config: ${localConfig.model}`);
        return localConfig.model;
    }
    
    logger.debug(`[Droid] Using default model: ${DEFAULT_DROID_MODEL}`);
    return DEFAULT_DROID_MODEL;
}

/**
 * Get the initial model value for UI display
 */
export function getInitialDroidModel(): string {
    const localConfig = readDroidLocalConfig();
    return process.env[DROID_MODEL_ENV] || localConfig.model || DEFAULT_DROID_MODEL;
}
