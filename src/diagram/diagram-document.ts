import * as vscode from 'vscode';
import { DiagramModel } from '../webview-messages/diagram-messages.js';
import { diagramModelToXml, xmlToDiagramModel } from './diagram-xml.js';
import { DiagramModelEdit, moveSchema, moveTable, moveTables, removeSchema, removeTable, removeTables, resizeSchema } from './diagram-model-editor.js';
import { addTables, rearrangeTables, ResolvedForeignKey, ResolvedTable, SyncResultTable, syncTables, updateTables } from './diagram-add-tables.js';

// The thin vscode.CustomDocument wrapper around the pure model/edit logic in diagram-xml.ts and
// diagram-model-editor.ts - deliberately kept small, since (unlike those two) it isn't practical to unit
// test directly (it depends on vscode.Uri/vscode.workspace.fs). Every edit method here follows the same
// shape: apply the pure edit immediately, fire onDidChangeContent so every open webview for this document
// re-renders, and fire onDidChangeDocument with undo/redo closures so VS Code's own Ctrl+Z stack and dirty
// indicator work for free.
export class DiagramDocument implements vscode.CustomDocument {
	private readonly _onDidChangeDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<DiagramDocument>>();
	readonly onDidChangeDocument = this._onDidChangeDocument.event;

	private readonly _onDidChangeContent = new vscode.EventEmitter<void>();
	readonly onDidChangeContent = this._onDidChangeContent.event;

	private readonly _onDidDispose = new vscode.EventEmitter<void>();
	readonly onDidDispose = this._onDidDispose.event;

	// The most recent hot-exit backup, if any - deleted once a real save succeeds, so backups don't pile
	// up in the extension's storage directory across a normal edit/save session.
	private _backup?: vscode.CustomDocumentBackup;

	private constructor(readonly uri: vscode.Uri, private _model: DiagramModel, private columnLabels: () => string[]) {}

	// columnLabels is a supplier, not a value: it decides what each column cell's visible label says in
	// the saved XML (see diagram-xml.ts), the user can change the setting behind it at any time, and this
	// document outlives any single save - so it's read at save time rather than captured here.
	static async create(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext, columnLabels: () => string[]): Promise<DiagramDocument> {
		return new DiagramDocument(uri, await DiagramDocument.readModel(uri, openContext), columnLabels);
	}

	// A hot-exit backup wins over everything else - it IS the unsaved state VS Code is restoring. Then an
	// untitled document's initial contents, if VS Code handed any over (it does when the untitled document
	// was opened from existing bytes rather than created empty). Otherwise the file on disk.
	//
	// An untitled diagram with neither is simply a new, empty one: "New Diagram" writes nothing anywhere,
	// so there is no file to read and reading one would throw.
	private static async readModel(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<DiagramModel> {
		if(openContext.backupId) {
			return DiagramDocument.readModelFrom(vscode.Uri.parse(openContext.backupId));
		}

		if(uri.scheme === 'untitled') {
			return openContext.untitledDocumentData
				? xmlToDiagramModel(Buffer.from(openContext.untitledDocumentData).toString('utf8'))
				: DiagramDocument.blankModel();
		}

		return DiagramDocument.readModelFrom(uri);
	}

	private static async readModelFrom(uri: vscode.Uri): Promise<DiagramModel> {
		let bytes = await vscode.workspace.fs.readFile(uri);
		return xmlToDiagramModel(Buffer.from(bytes).toString('utf8'));
	}

	private static blankModel(): DiagramModel {
		return {schemas: [], tables: [], relationships: []};
	}

	get model(): DiagramModel {
		return this._model;
	}

	dispose(): void {
		this._onDidDispose.fire();
		this._onDidChangeDocument.dispose();
		this._onDidChangeContent.dispose();
		this._onDidDispose.dispose();
	}

	moveTable(tableId: string, position: {x: number; y: number}): void {
		this.applyEdit(moveTable(this._model, tableId, position));
	}

	// The multi-select drag path (ctrl+click several tables, drag any one of them) - one edit for the
	// whole batch. See moveTables' own comment for why single moveTable messages can't cover this case.
	moveTables(moves: {tableId: string; position: {x: number; y: number}}[]): void {
		this.applyEdit(moveTables(this._model, moves));
	}

	resizeSchema(schemaId: string, bounds: {x: number; y: number; width: number; height: number}): void {
		this.applyEdit(resizeSchema(this._model, schemaId, bounds));
	}

	moveSchema(schemaId: string, position: {x: number; y: number}): void {
		this.applyEdit(moveSchema(this._model, schemaId, position));
	}

	removeTable(tableId: string): void {
		this.applyEdit(removeTable(this._model, tableId));
	}

	// Right-click "Remove" with 2+ tables selected - one edit for the whole selection. See removeTables'
	// own comment in diagram-model-editor.ts.
	removeTables(tableIds: string[]): void {
		this.applyEdit(removeTables(this._model, tableIds));
	}

	removeSchema(schemaId: string): void {
		this.applyEdit(removeSchema(this._model, schemaId));
	}

	// A whole batch is one edit, so a single Ctrl+Z removes everything an "Add to Diagram" brought in
	// (tables, any schema group created for them, their relationships, and the schema-bound growth)
	// rather than unwinding it a table at a time.
	//
	// existingForeignKeys is the keys declared by the tables ALREADY here - without them, relationships
	// pointing at a newly added table (rather than out of one) don't get drawn; see addTables' own doc.
	async addTables(tables: ResolvedTable[], existingForeignKeys: ReadonlyMap<string, ResolvedForeignKey[]>): Promise<void> {
		this.applyEdit(await addTables(this._model, tables, existingForeignKeys));
	}

	// "Rearrange Tables" from the diagram's own menu - relays out everything already here. See
	// rearrangeTables' own doc comment for why this, not a pinned add, is where a genuinely good layout
	// actually comes from.
	async rearrangeTables(): Promise<void> {
		this.applyEdit(await rearrangeTables(this._model));
	}

	// Refreshes tables already on the diagram against a fresh resolve (live DB2 data reconciled with
	// whatever's currently imported for this connection) - see updateTables' own comment for what this
	// does and doesn't touch. Called after every successful connect and after every import, so a table's
	// Imported/Enhanced status and its imported-sourced columns/relationships stay current without the
	// user having to remove and re-add it.
	updateTables(tables: ResolvedTable[]): void {
		this.applyEdit(updateTables(this._model, tables));
	}

	// "Sync with Database" (see DiagramEditorProvider.handleSyncDiagram) - the one edit method whose
	// caller needs to know WHAT changed, not just whether it did, since Sync always reports a result
	// (unlike every other edit here, which is silent when there's nothing to do) and lists the affected
	// tables in a summary dialog when there's anything to show. See syncTables' own comment for what
	// orphanTableIds/removeTableIds mean.
	syncTables(tables: ResolvedTable[], orphanTableIds: string[], removeTableIds: string[], reconcileRelationshipsFor: string[] = []): SyncResultTable[] {
		let result = syncTables(this._model, tables, orphanTableIds, removeTableIds, reconcileRelationshipsFor);
		this.applyEdit(result.edit);
		return result.changedTables;
	}

	// Shared by every edit method above: fire onDidChangeContent (so every open webview re-renders) and
	// onDidChangeDocument (so VS Code's own Ctrl+Z stack and dirty indicator work), wrapping the edit's
	// own undo/redo so each also re-fires onDidChangeContent when invoked.
	private applyEdit(edit: DiagramModelEdit | undefined): void {
		if(!edit) {
			return;
		}

		this._onDidChangeContent.fire();

		this._onDidChangeDocument.fire({
			document: this,
			label: edit.label,
			undo: () => {
				edit.undo();
				this._onDidChangeContent.fire();
			},
			redo: () => {
				edit.redo();
				this._onDidChangeContent.fire();
			}
		});
	}

	async save(destination: vscode.Uri): Promise<void> {
		let xml = diagramModelToXml(this._model, this.columnLabels());
		await vscode.workspace.fs.writeFile(destination, Buffer.from(xml, 'utf8'));

		if(this._backup) {
			this._backup.delete();
			this._backup = undefined;
		}
	}

	// Reverting an untitled diagram goes back to empty rather than to a file: there is nothing on disk to
	// re-read, and this is also the path VS Code takes when the user discards a never-saved document.
	async revert(): Promise<void> {
		this._model = this.uri.scheme === 'untitled' ? DiagramDocument.blankModel() : await DiagramDocument.readModelFrom(this.uri);
		this._onDidChangeContent.fire();
	}

	async backup(destination: vscode.Uri): Promise<vscode.CustomDocumentBackup> {
		await this.save(destination);

		let backup: vscode.CustomDocumentBackup = {
			id: destination.toString(),
			delete: () => {
				void vscode.workspace.fs.delete(destination);
			}
		};

		this._backup = backup;
		return backup;
	}
}
