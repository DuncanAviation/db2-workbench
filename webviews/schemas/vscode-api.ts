import type { SchemasOutboundMessage } from '../../src/webview-messages/schemas-messages.js';
import type { VsCodeApi } from '../shared/vscode-api';
import { getVsCodeApi } from '../shared/vscode-api';

export const schemasVsCodeApi: VsCodeApi<SchemasOutboundMessage> = getVsCodeApi<SchemasOutboundMessage>();
