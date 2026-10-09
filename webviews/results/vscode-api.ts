import type { ResultsOutboundMessage } from '../../src/webview-messages/results-messages.js';
import type { VsCodeApi } from '../shared/vscode-api';
import { getVsCodeApi } from '../shared/vscode-api';

export const resultsVsCodeApi: VsCodeApi<ResultsOutboundMessage> = getVsCodeApi<ResultsOutboundMessage>();
