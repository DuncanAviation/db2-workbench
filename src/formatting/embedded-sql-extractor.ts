import { HostCodeLexer } from './host-code-lexer.js';
import { HostCodeParser } from './host-code-parser.js';

type Token = HostCodeLexer.Token;
type Statement = HostCodeParser.Statement;

// Finds the SQL in text pasted in from application code - Java, C# or JavaScript/TypeScript that
// builds a query out of string literals - and turns it back into the SQL it builds. The text is read
// as host code first (HostCodeLexer, HostCodeParser), so the host language's own strings, comments
// and statements are understood in its terms, and only then is any of it handed on as SQL.
//
// A query is followed through its variable: "let sql = `...`", "sql += `...`", "sql = sql + ...",
// "sb.append(...)", or a bare concatenation with no variable at all. A concatenated value becomes a
// DB2 named parameter (":customerId"), and one spliced into a quoted SQL literal ("= '" + code + "'")
// replaces the literal. A host "//" comment becomes a "--" comment where it was. Appends under a
// condition are kept, with a "-- if (...)" comment naming the condition; an else branch's appends
// (and every case after a switch's first) are commented out, since including two alternatives would
// usually make the SQL invalid. Every other host statement is dropped, and a plain DB2 statement found
// among the host code is passed through unchanged.
//
// The text counts as host code only when something in it is unmistakably host syntax building SQL:
// "+=" or ".append(" with a SQL string, a template literal, two SQL strings joined with "+", or a
// declaration ("String sql = ..."). DB2 itself joins strings with "||", never "+", so a plain DB2
// script - dynamic SQL built with "||" included - is reported as not host code and left alone.
export class EmbeddedSqlExtractor {
	// A SQL keyword must appear inside one of the strings for them to be SQL at all, which rejects
	// ordinary string building ("Hello " + name). Phrases rather than bare words ("GROUP BY", not
	// "GROUP") so English prose isn't mistaken for SQL; "LIMIT" is left out for the same reason.
	private static readonly SQL_KEYWORD_PATTERN = /\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|JOIN|UNION|VALUES|MERGE|CALL)\b/i;
	// Words that put a declaration's left-hand side in SQL PL rather than host code
	// ("IF x THEN SET v = 'SELECT ...'").
	private static readonly SQL_PL_WORDS = /^(?:SET|THEN|ELSE|DO|BEGIN|DECLARE|IF|WHEN|DEFAULT)$/i;
	private static readonly APPEND_METHODS = /^(?:append|Append|AppendLine|concat)$/;

	static extract(text: string): EmbeddedSqlExtractor.Result {
		let statements = HostCodeParser.parse(HostCodeLexer.lex(text));
		let walker = new StatementWalker(text);
		walker.walk(statements, {conditions: []}, undefined);
		return walker.result();
	}

	static hasSqlKeyword(text: string): boolean {
		return EmbeddedSqlExtractor.SQL_KEYWORD_PATTERN.test(text);
	}

	static isSqlPlWord(word: string): boolean {
		return EmbeddedSqlExtractor.SQL_PL_WORDS.test(word);
	}

	static isAppendMethod(word: string): boolean {
		return EmbeddedSqlExtractor.APPEND_METHODS.test(word);
	}
}

export namespace EmbeddedSqlExtractor {
	export interface Parameter {
		// The host expression the parameter stands for, as written.
		readonly expression: string;
		readonly name: string;
	}

	// A piece of the result in source order: a query rebuilt from host code ("extracted"), or a plain
	// DB2 statement found among the host code, its text unchanged ("sql").
	export interface Segment {
		readonly kind: 'extracted' | 'sql';
		readonly sql: string;
		readonly parameters: Parameter[];
		// The source range the segment came from: every host statement that built the query.
		readonly start: number;
		readonly end: number;
	}

	export interface Result {
		// False when the text isn't host code at all; segments is then empty and the text is SQL as it is.
		readonly hostCode: boolean;
		readonly segments: Segment[];
	}
}

interface Condition {
	readonly label: string;
	readonly id: object;
}

interface WalkContext {
	// The conditions an append is nested under, outermost first.
	readonly conditions: Condition[];
	// Set inside an else branch (or a later switch case): appends there are written as comments.
	readonly alternative?: Condition;
}

interface Operand {
	readonly kind: 'string' | 'template' | 'comment' | 'value';
	readonly tokens: Token[];
}

// The SQL text of one query as it is put together, tracking whether it currently ends inside an
// open '...' literal so a value spliced into one can replace it.
class QueryText {
	text = '';
	private inString = false;
	private closeAfterParameter = false;

	constructor(private readonly nameFor: (expression: string) => string) {}

	literal(literal: string): void {
		if(literal.length === 0) {
			return;
		}

		if(this.closeAfterParameter) {
			this.closeAfterParameter = false;

			// "= '" + code + "'": the literal closes right after the value, so the value replaced it.
			if(literal.startsWith(`'`) && !literal.startsWith(`''`)) {
				literal = literal.substring(1);
			} else {
				// "LIKE '%" + name + "%'": the value sat inside the literal, which now carries on.
				this.text += ` || '`;
				this.inString = true;
			}
		}

		this.text += literal;

		if(((literal.match(/'/g)?.length ?? 0) % 2) === 1) {
			this.inString = !this.inString;
		}
	}

	parameter(expression: string): void {
		let name = this.nameFor(expression);

		if(name.length === 0) {
			return;
		}

		if(this.closeAfterParameter) {
			this.text += ` || :${name}`;
			return;
		}

		if(this.inString) {
			if(this.text.endsWith(`'`) && !this.text.endsWith(`''`)) {
				this.text = this.text.slice(0, -1);
			} else {
				this.text += `' || `;
			}

			this.inString = false;
			this.closeAfterParameter = true;
		}

		this.text += `:${name}`;
	}

	// A comment on a line of its own, as it was between host statements.
	comment(text: string): void {
		if(this.text.length > 0 && !this.text.endsWith('\n')) {
			this.text += '\n';
		}

		this.text += `-- ${text}\n`;
	}

	// A comment from the concatenation itself: a "//" comment ends its line, a block comment stays inline.
	hostComment(token: Token): void {
		if(token.type === 'blockComment') {
			this.text += ` ${token.text} `;
			return;
		}

		let text = token.text.replace(/^(?:\/\/|--)/, '').trimEnd();
		this.text += ` --${text}\n`;
	}
}

class Query {
	readonly parameters: EmbeddedSqlExtractor.Parameter[] = [];
	readonly body: QueryText;
	hasSql = false;
	hostEvidence = false;
	start = Number.MAX_SAFE_INTEGER;
	end = 0;
	private readonly announced = new Set<object>();
	private readonly alternativesStarted = new Set<object>();

	constructor() {
		this.body = new QueryText(expression => this.nameFor(expression));
	}

	cover(start: number, end: number): void {
		this.start = Math.min(this.start, start);
		this.end = Math.max(this.end, end);
	}

	// Writes one appended piece under "context": after a comment for each condition not yet named, or,
	// in an alternative branch, as a comment of its own.
	emit(context: WalkContext, build: (target: QueryText) => void): void {
		let alternative = context.alternative;

		if(alternative) {
			let scratch = this.newText();
			build(scratch);
			let text = scratch.text.replace(/\s+/g, ' ').trim();

			if(text.length > 0) {
				let first = !this.alternativesStarted.has(alternative.id);
				this.alternativesStarted.add(alternative.id);
				this.body.comment(first ? `${alternative.label}: ${text}` : text);
			}

			return;
		}

		for(let condition of context.conditions) {
			if(!this.announced.has(condition.id)) {
				this.announced.add(condition.id);
				this.body.comment(condition.label);
			}
		}

		build(this.body);
	}

	// A separate run of text that names its parameters the same way this query does.
	newText(): QueryText {
		return new QueryText(expression => this.nameFor(expression));
	}

	private nameFor(expression: string): string {
		let trimmed = expression.trim();

		if(trimmed.length === 0) {
			return '';
		}

		let existing = this.parameters.find(parameter => parameter.expression === trimmed);

		if(existing) {
			return existing.name;
		}

		let base = Query.baseName(trimmed);
		let name = base;
		let suffix = 2;

		while(this.parameters.some(parameter => parameter.name === name)) {
			name = `${base}${suffix++}`;
		}

		this.parameters.push({expression: trimmed, name});
		return name;
	}

	// A bare identifier names itself; "a.b", "getFoo()" and "isFoo()" are named after their last
	// member ("getCustomerId()" -> "customerId"); anything else (a ternary, an index, arithmetic) is a
	// generic "param", numbered when there's more than one.
	private static baseName(expression: string): string {
		if(/^[A-Za-z_$][\w$]*$/.test(expression)) {
			return expression;
		}

		let methodCall = expression.match(/(?:^|\.)([A-Za-z_$][\w$]*)\(\s*\)$/);

		if(methodCall) {
			let accessor = methodCall[1].match(/^(?:get|is)([A-Z]\w*)$/);
			return accessor ? accessor[1].charAt(0).toLowerCase() + accessor[1].slice(1) : methodCall[1];
		}

		let propertyAccess = expression.match(/\.([A-Za-z_$][\w$]*)$/);
		return propertyAccess ? propertyAccess[1] : 'param';
	}
}

class StatementWalker {
	private readonly queries: Query[] = [];
	private readonly sqlStatements: HostCodeParser.Sql[] = [];
	// The query each host variable currently holds ("sql", "this.sql", "sb").
	private readonly variables = new Map<string, Query>();
	// Comments between host statements, waiting for the query the next statement appends to.
	private pendingComments: Token[] = [];

	constructor(private readonly text: string) {}

	result(): EmbeddedSqlExtractor.Result {
		let sqlQueries = this.queries.filter(query => query.hasSql);

		if(!sqlQueries.some(query => query.hostEvidence)) {
			return {hostCode: false, segments: []};
		}

		let segments: EmbeddedSqlExtractor.Segment[] = [
			...sqlQueries.map(query => ({
				kind: 'extracted' as const,
				sql: query.body.text.trim(),
				parameters: query.parameters,
				start: query.start,
				end: query.end
			})),
			...this.sqlStatements.map(statement => ({
				kind: 'sql' as const,
				sql: this.text.substring(statement.start, statement.end),
				parameters: [],
				start: statement.start,
				end: statement.end
			}))
		];

		return {hostCode: true, segments: segments.sort((a, b) => a.start - b.start)};
	}

	// "outer" is the top-level statement being walked, whose range a query built inside it covers.
	walk(statements: Statement[], context: WalkContext, outer: Statement | undefined): void {
		for(let statement of statements) {
			let top = outer ?? statement;

			switch(statement.kind) {
				case 'comment':
					this.pendingComments.push(statement.token);
					break;
				case 'block':
					this.walk(statement.body, context, top);
					break;
				case 'sql':
					this.pendingComments = [];
					this.sqlStatements.push(statement);
					break;
				case 'control':
					this.walkControl(statement, context, top);
					break;
				case 'simple':
					if(!this.walkSimple(statement.tokens, context, top)) {
						this.pendingComments = [];
					}

					break;
			}
		}
	}

	private walkControl(statement: HostCodeParser.Control, context: WalkContext, top: Statement): void {
		let header = statement.header.replace(/\s+/g, ' ').trim();
		let keyword = statement.keyword;

		if(keyword === 'if') {
			this.walk(statement.body, this.within(context, `if ${header}`), top);

			if(statement.elseBody) {
				let elseIf = statement.elseBody.length === 1 && statement.elseBody[0].kind === 'control' && statement.elseBody[0].keyword === 'if'
					? statement.elseBody[0]
					: undefined;

				if(elseIf) {
					// The else-if's own condition, and anything after it, are alternatives to the first branch.
					let elseIfLabel = `else if ${elseIf.header.replace(/\s+/g, ' ').trim()}`;
					this.walk(elseIf.body, this.alternative(context, elseIfLabel), top);

					if(elseIf.elseBody) {
						this.walk(elseIf.elseBody, this.alternative(context, 'else'), top);
					}
				} else {
					this.walk(statement.elseBody, this.alternative(context, 'else'), top);
				}
			}

			return;
		}

		if(keyword === 'switch') {
			this.walkSwitch(statement, context, top);
			return;
		}

		if(keyword === 'else' || keyword === 'catch') {
			this.walk(statement.body, this.alternative(context, `${keyword} ${header}`.trim()), top);
			return;
		}

		// Loops show their header; try/finally/using and the like only group statements.
		let isLoop = ['for', 'foreach', 'while', 'do'].includes(keyword);
		let label = keyword === 'do' ? `do ... while ${header}` : `${keyword} ${header}`;
		this.walk(statement.body, isLoop ? this.within(context, label) : context, top);
	}

	// A switch's first case is kept and each later one is an alternative, the same as if/else.
	private walkSwitch(statement: HostCodeParser.Control, context: WalkContext, top: Statement): void {
		let caseContext: WalkContext = context;
		let cases = 0;

		for(let child of statement.body) {
			if(child.kind === 'simple') {
				let label = StatementWalker.caseLabel(child.tokens);

				if(label) {
					cases++;
					let caseText = label.text.replace(/\s+/g, ' ').trim();
					caseContext = cases === 1 ? this.within(context, `switch ${statement.header.replace(/\s+/g, ' ').trim()} ${caseText}`) : this.alternative(context, caseText);

					if(!this.walkSimple(label.rest, caseContext, top)) {
						this.pendingComments = [];
					}

					continue;
				}
			}

			this.walk([child], caseContext, top);
		}
	}

	private within(context: WalkContext, label: string): WalkContext {
		return context.alternative ? context : {conditions: [...context.conditions, {label, id: {}}]};
	}

	private alternative(context: WalkContext, label: string): WalkContext {
		return context.alternative ? context : {conditions: context.conditions, alternative: {label, id: {}}};
	}

	// Interprets one simple statement; true when it appended to a query.
	private walkSimple(tokens: Token[], context: WalkContext, top: Statement): boolean {
		let significant = tokens.filter(token => token.type !== 'whitespace');
		let assignment = StatementWalker.findTopLevel(significant, token => token.type === 'punctuation' && (token.text === '=' || token.text === '+='));

		if(assignment !== -1) {
			return this.walkAssignment(significant.slice(0, assignment), significant[assignment].text, significant.slice(assignment + 1), context, top);
		}

		let appendCall = StatementWalker.parseAppendCalls(significant);

		if(appendCall) {
			let query = this.queryFor(appendCall.target);
			let appended = false;

			for(let argument of appendCall.arguments) {
				appended = this.append(query, StatementWalker.operands(argument), context, top, 'append') || appended;
			}

			if(appended && query.hasSql) {
				query.hostEvidence = true;
			}

			return appended;
		}

		return this.walkExpressionStatement(significant, context, top);
	}

	private walkAssignment(left: Token[], operator: string, right: Token[], context: WalkContext, top: Statement): boolean {
		let target = StatementWalker.assignmentTarget(left);

		if(!target) {
			return false;
		}

		let operands = StatementWalker.operands(right);

		if(operator === '+=') {
			let targetQuery = this.queryFor(target);
			let compoundAppended = this.append(targetQuery, operands, context, top, 'append');

			if(compoundAppended && operands.some(operand => operand.kind === 'string' || operand.kind === 'template')) {
				targetQuery.hostEvidence = true;
			}

			return compoundAppended;
		}

		// "sql = sql + ...", or "full = sql + ..." carrying an existing query on under a new name.
		let first = operands[0];
		let firstName = first?.kind === 'value' ? StatementWalker.lvalueText(first.tokens) : undefined;
		let continued = firstName != null ? this.variables.get(firstName) : undefined;

		if(continued && operands.length > 1) {
			this.variables.set(target, continued);
			let continuedAppended = this.append(continued, operands.slice(1), context, top, 'append');

			if(continuedAppended) {
				continued.hostEvidence = true;
			}

			return continuedAppended;
		}

		// "rows = await db.query(`...`, params)": the SQL is an argument, not the assigned value.
		if(!operands.some(operand => operand.kind === 'string' || operand.kind === 'template')) {
			return this.walkExpressionStatement(right, context, top);
		}

		let query = this.newQuery(target);
		let appended = this.append(query, operands, context, top, 'new');

		if(StatementWalker.isDeclaration(left) || StatementWalker.joinsStrings(operands)) {
			query.hostEvidence = true;
		}

		return appended;
	}

	// A statement that is no assignment and no append call: "return ...", a call such as
	// "db.query(`...`, params)", or a bare concatenation. The SQL is the expression around the first
	// string holding a SQL keyword.
	private walkExpressionStatement(significant: Token[], context: WalkContext, top: Statement): boolean {
		let expression = StatementWalker.sqlExpression(significant);

		if(!expression) {
			return false;
		}

		let operands = StatementWalker.operands(expression);
		let firstName = operands[0]?.kind === 'value' ? StatementWalker.lvalueText(operands[0].tokens) : undefined;
		let continued = firstName != null ? this.variables.get(firstName) : undefined;

		if(continued && operands.length > 1) {
			return this.append(continued, operands.slice(1), context, top, 'append');
		}

		let query = this.newQuery(undefined);
		let appended = this.append(query, operands, context, top, 'new');

		if(StatementWalker.joinsStrings(operands)) {
			query.hostEvidence = true;
		}

		return appended;
	}

	// Appends "operands" to "query"; true when anything was appended. A new query ("new") skips the
	// values ahead of its first string - "base + ' ORDER BY ' + col" can't show what "base" holds.
	private append(query: Query, operands: Operand[], context: WalkContext, top: Statement, mode: 'new' | 'append'): boolean {
		let firstString = operands.findIndex(operand => operand.kind === 'string' || operand.kind === 'template');
		let relevant = mode === 'new' && firstString > 0 ? operands.slice(firstString) : operands;

		if(relevant.length === 0) {
			return false;
		}

		for(let operand of relevant) {
			if(operand.kind === 'template') {
				let token = operand.tokens[0];

				if(EmbeddedSqlExtractor.hasSqlKeyword(token.value ?? '')) {
					query.hasSql = true;
					query.hostEvidence = true;
				}
			} else if(operand.kind === 'string') {
				let token = operand.tokens[0];

				if(EmbeddedSqlExtractor.hasSqlKeyword(token.value ?? '')) {
					query.hasSql = true;

					// No DB2 string looks like a C# verbatim string or a Java text block.
					if(/^(?:@"|""")/.test(token.text)) {
						query.hostEvidence = true;
					}
				}
			}
		}

		query.cover(top.start, top.end);

		for(let comment of this.pendingComments) {
			query.cover(comment.start, comment.end);
			query.emit({conditions: []}, body => body.comment(StatementWalker.commentText(comment)));
		}

		this.pendingComments = [];
		query.emit(context, body => StatementWalker.render(body, relevant, context, query));
		return true;
	}

	private static render(body: QueryText, operands: Operand[], context: WalkContext, query: Query): void {
		for(let operand of operands) {
			switch(operand.kind) {
				case 'string':
					body.literal(operand.tokens[0].value ?? '');
					break;
				case 'template':
					for(let segment of operand.tokens[0].segments ?? []) {
						if(segment.kind === 'literal') {
							body.literal(segment.text);
						} else {
							body.parameter(segment.text);
						}
					}

					break;
				case 'comment':
					body.hostComment(operand.tokens[0]);
					break;
				case 'value':
					StatementWalker.renderValue(body, operand.tokens, context, query);
					break;
			}
		}
	}

	// A value concatenated into the SQL: a number stays as it is, a parenthesized concatenation is
	// rendered in place, a "cond ? '...' : '...'" choosing between SQL strings keeps its first branch
	// (the other as a comment), and anything else is a parameter.
	private static renderValue(body: QueryText, tokens: Token[], context: WalkContext, query: Query): void {
		let significant = tokens.filter(token => !HostCodeLexer.isTrivia(token));

		if(significant.length === 1 && significant[0].type === 'number') {
			body.literal(significant[0].text);
			return;
		}

		let original = significant;

		while(significant[0]?.text === '(' && StatementWalker.findClosing(significant, 0) === significant.length - 1) {
			significant = significant.slice(1, -1);
		}

		if(significant !== original) {
			let inner = StatementWalker.operands(significant);

			if(inner.some(operand => operand.kind === 'string' || operand.kind === 'template')) {
				StatementWalker.render(body, inner, context, query);
				return;
			}
		}

		let question = StatementWalker.findTopLevel(significant, token => token.text === '?');
		let colon = question === -1 ? -1 : StatementWalker.findTopLevel(significant, (token, index) => index > question && token.text === ':');

		if(question !== -1 && colon !== -1) {
			let whenTrue = StatementWalker.operands(significant.slice(question + 1, colon));
			let whenFalse = StatementWalker.operands(significant.slice(colon + 1));
			let isSqlBranch = (branch: Operand[]) => branch.some(operand => operand.kind === 'string' || operand.kind === 'template');

			if(isSqlBranch(whenTrue) || isSqlBranch(whenFalse)) {
				body.comment(`if (${StatementWalker.sourceText(significant.slice(0, question))})`);
				StatementWalker.render(body, whenTrue, context, query);
				let scratch = query.newText();
				StatementWalker.render(scratch, whenFalse, context, query);
				let alternative = scratch.text.replace(/\s+/g, ' ').trim();
				body.comment(alternative.length > 0 ? `else: ${alternative}` : 'else: (nothing)');
				return;
			}
		}

		body.parameter(StatementWalker.sourceText(tokens));
	}

	private queryFor(target: string): Query {
		return this.variables.get(target) ?? this.newQuery(target);
	}

	private newQuery(target: string | undefined): Query {
		let query = new Query();
		this.queries.push(query);

		if(target != null) {
			this.variables.set(target, query);
		}

		return query;
	}

	private static commentText(token: Token): string {
		if(token.type === 'blockComment') {
			return token.text.replace(/^\/\*+|\*+\/$/g, '').replace(/\s+/g, ' ').trim();
		}

		return token.text.replace(/^(?:\/\/+|--)/, '').trim();
	}

	// "sql", "this.sql", "query.text": the variable an assignment's left-hand side names, after any
	// type or "let"/"const"/"var", and before any TypeScript ": string" annotation.
	private static assignmentTarget(left: Token[]): string | undefined {
		let significant = left.filter(token => !HostCodeLexer.isTrivia(token));
		let colon = StatementWalker.findTopLevel(significant, token => token.text === ':');
		let name = colon === -1 ? significant : significant.slice(0, colon);
		let chain: string[] = [];

		for(let i = name.length - 1; i >= 0; i--) {
			let token = name[i];

			if(token.type === 'word' && (chain.length === 0 || chain[0] === '.')) {
				chain.unshift(token.text);
			} else if(token.text === '.' && chain.length > 0 && chain[0] !== '.') {
				chain.unshift('.');
			} else {
				break;
			}
		}

		return chain.length > 0 && chain[0] !== '.' ? chain.join('') : undefined;
	}

	// Whether an assignment's left-hand side declares the variable: "String sql", "let sql",
	// "const sql: string", "var sb" - but not SQL PL's "IF x THEN SET v".
	private static isDeclaration(left: Token[]): boolean {
		let words = left.filter(token => token.type === 'word');

		if(words.length < 2 || words.some(word => EmbeddedSqlExtractor.isSqlPlWord(word.text))) {
			return false;
		}

		return left.every(token => HostCodeLexer.isTrivia(token) || token.type === 'word' || ['.', ':', '<', '>', '[', ']', ',', '?'].includes(token.text));
	}

	private static lvalueText(tokens: Token[]): string | undefined {
		let significant = tokens.filter(token => !HostCodeLexer.isTrivia(token));
		let isChain = significant.length > 0 && significant.every((token, index) => index % 2 === 0 ? token.type === 'word' : token.text === '.');
		return isChain && significant.length % 2 === 1 ? significant.map(token => token.text).join('') : undefined;
	}

	// Two string pieces joined by "+": DB2 joins strings with "||", so this is host code.
	private static joinsStrings(operands: Operand[]): boolean {
		return operands.filter(operand => operand.kind === 'string' || operand.kind === 'template').length > 1;
	}

	// "sb.append(a).append(b)" (and C#'s Append/AppendLine): the builder's name and each call's argument.
	private static parseAppendCalls(significant: Token[]): {target: string; arguments: Token[][]} | undefined {
		let tokens = significant.filter(token => !HostCodeLexer.isComment(token));
		let i = 0;
		let target: string[] = [];

		while(i < tokens.length && tokens[i].type === 'word' && !(tokens[i + 1]?.text === '(' && EmbeddedSqlExtractor.isAppendMethod(tokens[i].text))) {
			target.push(tokens[i].text);

			if(tokens[i + 1]?.text !== '.') {
				return undefined;
			}

			target.push('.');
			i += 2;
		}

		if(target.length === 0) {
			return undefined;
		}

		target.pop();
		let calls: Token[][] = [];

		while(i < tokens.length && tokens[i].type === 'word' && EmbeddedSqlExtractor.isAppendMethod(tokens[i].text) && tokens[i + 1]?.text === '(') {
			let close = StatementWalker.findClosing(tokens, i + 1);

			if(close === -1) {
				close = tokens.length;
			}

			calls.push(tokens.slice(i + 2, close));
			i = close + 1;

			if(tokens[i]?.text !== '.') {
				break;
			}

			i++;
		}

		// Comments are dropped from the arguments above; the tokens between calls carry none worth keeping.
		return calls.length > 0 && i >= tokens.length ? {target: target.join(''), arguments: calls} : undefined;
	}

	// The expression around the first string holding a SQL keyword: the whole statement, or the
	// argument (between "(", "," and ")") it sits in, after a leading "return"/"await"/"yield".
	private static sqlExpression(significant: Token[]): Token[] | undefined {
		let index = significant.findIndex(token => HostCodeLexer.isString(token) && EmbeddedSqlExtractor.hasSqlKeyword(token.value ?? ''));

		if(index === -1) {
			return undefined;
		}

		let start = index;
		let depth = 0;

		while(start > 0) {
			let token = significant[start - 1];

			if(token.text === ')' || token.text === ']' || token.text === '}') {
				depth++;
			} else if(token.text === '(' || token.text === '[' || token.text === '{') {
				if(depth === 0) {
					break;
				}

				depth--;
			} else if(depth === 0 && (token.text === ',' || token.text === '=>' || token.text === 'return' || token.text === 'await' || token.text === 'yield')) {
				break;
			}

			start--;
		}

		let end = index;
		depth = 0;

		while(end < significant.length - 1) {
			let token = significant[end + 1];

			if(token.text === '(' || token.text === '[' || token.text === '{') {
				depth++;
			} else if(token.text === ')' || token.text === ']' || token.text === '}') {
				if(depth === 0) {
					break;
				}

				depth--;
			} else if(depth === 0 && token.text === ',') {
				break;
			}

			end++;
		}

		return significant.slice(start, end + 1);
	}

	// Splits an expression on its top-level "+" into strings, comments, and the values between them.
	private static operands(tokens: Token[]): Operand[] {
		let operands: Operand[] = [];
		let current: Token[] = [];
		let depth = 0;

		let flush = () => {
			let significant = current.filter(token => !HostCodeLexer.isTrivia(token));

			if(significant.length === 1 && HostCodeLexer.isString(significant[0])) {
				operands.push({kind: significant[0].type === 'template' ? 'template' : 'string', tokens: significant});
			} else if(significant.length > 0) {
				operands.push({kind: 'value', tokens: current});
			}

			current = [];
		};

		for(let token of tokens) {
			if(token.type === 'punctuation') {
				if(token.text === '(' || token.text === '[' || token.text === '{') {
					depth++;
				} else if(token.text === ')' || token.text === ']' || token.text === '}') {
					depth = Math.max(0, depth - 1);
				} else if(token.text === '+' && depth === 0) {
					flush();
					continue;
				}
			}

			if(depth === 0 && HostCodeLexer.isComment(token)) {
				flush();
				operands.push({kind: 'comment', tokens: [token]});
				continue;
			}

			current.push(token);
		}

		flush();
		return operands;
	}

	private static caseLabel(tokens: Token[]): {text: string; rest: Token[]} | undefined {
		let significant = tokens.filter(token => token.type !== 'whitespace');
		let first = significant[0];

		if(first?.type !== 'word' || (first.text !== 'case' && first.text !== 'default')) {
			return undefined;
		}

		let colon = StatementWalker.findTopLevel(significant, token => token.text === ':');

		if(colon === -1) {
			return undefined;
		}

		return {text: significant.slice(0, colon).map(token => token.text).join(' '), rest: significant.slice(colon + 1)};
	}

	private static findTopLevel(tokens: Token[], test: (token: Token, index: number) => boolean): number {
		let depth = 0;

		for(let i = 0; i < tokens.length; i++) {
			let token = tokens[i];

			if(token.type === 'punctuation') {
				if(token.text === '(' || token.text === '[' || token.text === '{') {
					depth++;
					continue;
				}

				if(token.text === ')' || token.text === ']' || token.text === '}') {
					depth = Math.max(0, depth - 1);
					continue;
				}
			}

			if(depth === 0 && test(token, i)) {
				return i;
			}
		}

		return -1;
	}

	private static findClosing(tokens: Token[], open: number): number {
		let depth = 0;

		for(let i = open; i < tokens.length; i++) {
			if(tokens[i].text === '(') {
				depth++;
			} else if(tokens[i].text === ')') {
				depth--;

				if(depth === 0) {
					return i;
				}
			}
		}

		return -1;
	}

	private static sourceText(tokens: Token[]): string {
		let text = '';
		let previous: Token | undefined;

		for(let token of tokens.filter(candidate => !HostCodeLexer.isComment(candidate))) {
			text += previous && token.start > previous.end ? ` ${token.text}` : token.text;
			previous = token;
		}

		return text.replace(/\s+/g, ' ').trim();
	}
}
