/**
 * OpenCode Constants
 * 
 * Configuration constants for OpenCode integration.
 */

/**
 * Default OpenCode server port
 */
export const DEFAULT_OPENCODE_PORT = 4096;

/**
 * Default hostname for OpenCode server
 */
export const DEFAULT_OPENCODE_HOSTNAME = '127.0.0.1';

/**
 * Default OpenCode model (Anthropic Claude)
 */
export const DEFAULT_OPENCODE_MODEL = 'anthropic/claude-3-5-sonnet-20241022';

/**
 * Environment variable for OpenCode model override
 */
export const OPENCODE_MODEL_ENV = 'OPENCODE_MODEL';

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
 * OpenCode built-in tools
 */
export const OPENCODE_TOOLS = [
    'bash',
    'edit',
    'write',
    'read',
    'grep',
    'glob',
    'list'
] as const;

export type OpencodeToolName = typeof OPENCODE_TOOLS[number];

/**
 * Popular OpenCode providers
 */
export const OPENCODE_PROVIDERS = [
    'anthropic',
    'openai',
    'google',
    'mistral',
    'groq',
    'together',
    'fireworks',
    'openrouter'
] as const;

export type OpencodeProviderName = typeof OPENCODE_PROVIDERS[number];
