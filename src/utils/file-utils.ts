import * as vscode from 'vscode';

export class FileUtils {
	static async read(options: FileUtils.ReadOptions): Promise<string> {
		if(options?.uri == null || options.paths == null) {
			throw new Error('Reading a file needs a uri and paths');
		}
		
		let htmlPath = vscode.Uri.joinPath(options.uri, ...options.paths);
		return (await vscode.workspace.fs.readFile(htmlPath)).toString();
	}
}

export namespace FileUtils {
	export interface ReadOptions {
		uri: vscode.Uri;
		paths: string[];
	}
}