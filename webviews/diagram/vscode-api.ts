import type { DiagramOutboundMessage } from '../../src/webview-messages/diagram-messages.js';
import type { VsCodeApi } from '../shared/vscode-api';
import { getVsCodeApi } from '../shared/vscode-api';

export const diagramVsCodeApi: VsCodeApi<DiagramOutboundMessage> = getVsCodeApi<DiagramOutboundMessage>();
