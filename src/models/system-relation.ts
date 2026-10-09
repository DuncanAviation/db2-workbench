// Anything a query can select from and get columns back: a table or a view today, a table function
// later. Only the fields every kind shares - the ones content assist and table-name resolution need -
// so a consumer that cares about one kind's own detail still reads SystemTable/SystemView directly.
// `schema`/`name` are the short system names, the same form SystemTable and SystemView use.
export interface SystemRelation {
	schema: string;
	name: string;
	description: string;
	kind: SystemRelation.Kind;
}

export namespace SystemRelation {
	export type Kind = 'table' | 'view';
}
