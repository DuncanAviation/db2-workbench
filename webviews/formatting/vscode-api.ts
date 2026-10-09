import type { FormattingEditorMessage } from '../../src/webview-messages/formatting-editor-messages.js';
import type { VsCodeApi } from '../shared/vscode-api';
import { getVsCodeApi } from '../shared/vscode-api';

export const formattingEditorVsCodeApi: VsCodeApi<FormattingEditorMessage> = getVsCodeApi<FormattingEditorMessage>();
