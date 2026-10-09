import type { ConnectionEditorOutboundMessage } from '../../src/webview-messages/connection-editor-messages.js';
import type { VsCodeApi } from '../shared/vscode-api';
import { getVsCodeApi } from '../shared/vscode-api';

export const connectionEditorVsCodeApi: VsCodeApi<ConnectionEditorOutboundMessage> = getVsCodeApi<ConnectionEditorOutboundMessage>();
