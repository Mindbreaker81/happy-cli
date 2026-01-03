/**
 * Droid Constants
 * 
 * Configuration constants for Factory Droid CLI integration.
 */

/**
 * Environment variable name for Factory API key
 */
export const FACTORY_API_KEY_ENV = 'FACTORY_API_KEY';

/**
 * Default Droid model to use
 */
export const DEFAULT_DROID_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * Environment variable name for Droid model override
 */
export const DROID_MODEL_ENV = 'DROID_MODEL';

/**
 * Instruction to add to prompts for generating session title
 */
export const CHANGE_TITLE_INSTRUCTION = `

IMPORTANT: After completing your response, if this is the beginning of a conversation, 
please add exactly this XML tag at the end with a 2-5 word summary title:
<change_title>Brief Task Summary</change_title>

This title should describe what the user is asking for in 2-5 words.
Only include this tag once, at the very end of your response.`;

/**
 * Available Droid models (as of 2026)
 */
export const DROID_MODELS = [
    'claude-opus-4-5-20251101',
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5-20251001',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex',
    'gpt-5.1',
    'gpt-5.2',
    'gemini-3-pro-preview',
    'gemini-3-flash-preview',
    'glm-4.6'
] as const;

export type DroidModelId = typeof DROID_MODELS[number];
