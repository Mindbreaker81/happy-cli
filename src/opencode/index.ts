/**
 * OpenCode Module Exports
 * 
 * Public API for the OpenCode integration.
 */

export { OpencodeClient } from './opencodeClient';
export { OpencodeBackend } from './opencodeBackend';
export { runOpencode } from './runOpencode';

export type {
    OpencodeSession,
    OpencodeMessage,
    OpencodeMessageResponse,
    OpencodeEvent,
    OpencodeMode,
    OpencodePermissionMode,
    OpencodeClientConfig,
    OpencodePromptRequest,
    OpencodePart,
    OpencodeModel,
    OpencodeConfig
} from './types';

export {
    DEFAULT_OPENCODE_PORT,
    DEFAULT_OPENCODE_HOSTNAME,
    DEFAULT_OPENCODE_MODEL,
    OPENCODE_MODEL_ENV,
    OPENCODE_TOOLS,
    OPENCODE_PROVIDERS
} from './constants';
