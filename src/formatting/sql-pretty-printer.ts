import { KeywordTable } from '../utils/keyword-table.js';
import { LineWriter } from './line-writer.js';
import { SelectListWrapper } from './select-list-wrapper.js';
import { SqlTokenizer } from './sql-tokenizer.js';

type SqlToken = SqlTokenizer.SqlToken;
type Line = LineWriter.Line;

// Token-walking pretty-printer. Deliberately does NOT require full grammar validity -- see
// sql-tokenizer.ts for why lexing alone is fault-tolerant in a way a real parse never could be.
// Never throws: formatTokens wraps its own structured formatting attempt in a try/catch and falls
// back to the statement's original text verbatim on anything unexpected, and every structural
// helper below (CTE parsing, clause segmentation) is written to degrade to a flatter rendering
// rather than assume well-formed input -- "an imperfect format beats no format" is the normal
// path here, not an edge case.
//
// Comments and whitespace never reach the structural logic. attachComments turns the raw token
// stream into real tokens only, each carrying the whitespace that preceded it and the comments
// that belong to it (see SqlPrettyPrinter.FormatToken), so clause splitting, CTE parsing and list splitting see
// exactly the tokens they would if the SQL had no comments at all. The comments come back out
// wherever their token is printed, through InlineWriter, which is the one place that knows a line
// comment consumes the rest of its line.
//
// v1 scope: CASE...END, and JOIN...ON/USING conditions, are always rendered inline (no forced
// multi-line WHEN/THEN breaking, no AND/OR-aware breaking on ON) -- WHERE/HAVING is the one place
// AND/OR gets its own per-line treatment, since it's the clause that benefits most in ordinary
// DB2-for-i SQL. CREATE PROCEDURE/PL body control-flow (IF/LOOP/BEGIN...END/DECLARE) is out of
// scope entirely for v1 and passes through via the same default per-segment fallback.
//
// clauseLayout applies uniformly to every clause with a keyword (SELECT/FROM/WHERE/GROUP BY/
// ORDER BY/HAVING/JOIN/INSERT/UPDATE/DELETE/etc., and the WITH...AS CTE header): "expanded" always
// breaks after the keyword, "compact" keeps the keyword and the first line of its content on one
// line, wrapping to further lines (per selectFieldWrapping/expressionMaxWidth) only when needed.
// See renderClauseSegment -- the single place this is decided.
//
// Known ambiguity: a bare WORD immediately followed by "(" is always treated as a function call
// (no space, e.g. "employees(id, name)" in an INSERT's column list) -- nothing at the token level
// distinguishes a table/object name followed by a column list from a scalar function call, and
// resolving that would need real schema knowledge this formatter deliberately doesn't have.
export class SqlPrettyPrinter {
	// Private-use code points standing in for a line break inside a string literal while it's being
	// laid out -- see renderTokenText.
	private static readonly MASKED_CR = '';
	private static readonly MASKED_LF = '';

	static format(sql: string, options: SqlPrettyPrinter.Options, hooks?: SqlPrettyPrinter.Hooks): string {
		return SqlPrettyPrinter.formatTokens(SqlTokenizer.tokenize(sql), options, hooks);
	}

	static formatTokens(tokens: SqlToken[], options: SqlPrettyPrinter.Options, hooks?: SqlPrettyPrinter.Hooks): string {
		try {
			let {significant, orphanComments} = SqlPrettyPrinter.attachComments(tokens, options.removeComments);

			if(significant.length === 0) {
				return SqlPrettyPrinter.renderOrphanComments(orphanComments);
			}

			let indentUnit = LineWriter.indentUnit(options);
			let lastSignificant = significant[significant.length - 1];
			let hasSemicolon = lastSignificant.type === SqlTokenizer.TokenType.PUNCTUATION && lastSignificant.text === ';';
			let body = hasSemicolon ? significant.slice(0, -1) : significant;
			let formatted = LineWriter.render(SqlPrettyPrinter.formatQueryWithUnions(body, 0, options), indentUnit);

			if(hasSemicolon) {
				// Rather than a single fixed style (always glued, or always on its own line), the gap
				// between the last real token and ";" is whatever the user already had -- a space, a
				// newline (with whatever indentation preceded it), or nothing at all.
				let gap = lastSignificant.whitespaceBefore;

				if(SqlPrettyPrinter.endsInLineComment(body[body.length - 1])) {
					// A line comment consumes the rest of its line, so ";" can never share it -- and the
					// source gap after one always starts with the newline that ended it. Exactly one bare
					// "\n" stands in for that one (normalizing a CRLF source's "\r\n", which lexes as two
					// separate WHITESPACE tokens), while any extra blank lines beyond it still come through.
					formatted += '\n';
					gap = gap.replace(/^\r?\n/, '');
				}

				let semicolon = new InlineWriter(0);
				semicolon.token(lastSignificant, ';', false);
				formatted += gap + LineWriter.render(semicolon.lines, indentUnit);
			}

			// Cleanup pass: a recovered gap (blank lines before ";") can carry indentation of its own,
			// and a line with no text (an empty WHERE, say) still gets its level's indent.
			return formatted
				.replace(/[ \t]+$/gm, '')
				.replace(new RegExp(SqlPrettyPrinter.MASKED_CR, 'g'), '\r')
				.replace(new RegExp(SqlPrettyPrinter.MASKED_LF, 'g'), '\n');
		} catch(error) {
			// Last-resort per-statement degradation (defense-in-depth for a genuine bug in the
			// printer, not the expected path for merely unusual SQL -- see class comment): hand back
			// exactly the original text, reconstructed losslessly from every token including
			// whitespace, rather than let an unexpected error lose or corrupt the user's SQL. The
			// output alone can't tell this apart from a real format, so onFallback is how a test sees it.
			hooks?.onFallback?.(error);
			return tokens.map(token => token.text).join('');
		}
	}

	// Splits the raw token stream into real tokens, each annotated with the whitespace before it and
	// the comments that belong to it:
	// - a comment on the same line as the token before it trails that token ("id -- note");
	// - a comment on its own line leads the token after it, so it's printed above that token --
	//   unless that token is "," or ";", which never start a line of their own, so the comment
	//   trails the token before instead;
	// - comments after the last token trail it.
	// With removeComments, comments are skipped entirely, and the whitespace either side of one
	// merges as if it had never been there.
	private static attachComments(tokens: SqlToken[], removeComments: boolean): {significant: SqlPrettyPrinter.FormatToken[]; orphanComments: SqlPrettyPrinter.Comment[]} {
		let significant: SqlPrettyPrinter.FormatToken[] = [];
		let whitespace = '';
		let pending: SqlPrettyPrinter.Comment[] = [];

		for(let token of tokens) {
			if(token.type === SqlTokenizer.TokenType.WHITESPACE) {
				whitespace += token.text;
				continue;
			}

			if(SqlPrettyPrinter.isComment(token)) {
				if(!removeComments) {
					pending.push({token, newlineBefore: SqlPrettyPrinter.hasNewline(whitespace)});
					whitespace = '';
				}

				continue;
			}

			let previous = significant[significant.length - 1];
			let leadingComments: SqlPrettyPrinter.Comment[] = [];
			let index = 0;

			if(previous) {
				while(index < pending.length && !pending[index].newlineBefore) {
					previous.trailingComments.push(pending[index]);
					index++;
				}
			}

			let ownLine = pending.slice(index);

			if(previous && SqlPrettyPrinter.isTrailingPunctuation(token)) {
				previous.trailingComments.push(...ownLine);
			} else {
				leadingComments = ownLine;
			}

			significant.push({
				...token,
				whitespaceBefore: whitespace,
				newlineBefore: SqlPrettyPrinter.hasNewline(whitespace),
				leadingComments,
				trailingComments: []
			});
			whitespace = '';
			pending = [];
		}

		let last = significant[significant.length - 1];

		if(last) {
			last.trailingComments.push(...pending);
			pending = [];
		}

		return {significant, orphanComments: pending};
	}

	// A statement that is nothing but comments (e.g. a commented-out block between two statements):
	// each comment kept on the line it shared with the one before it, or its own.
	private static renderOrphanComments(comments: SqlPrettyPrinter.Comment[]): string {
		return comments
			.map((comment, index) => {
				let previous = comments[index - 1];
				let separator = !previous ? '' : (comment.newlineBefore || SqlPrettyPrinter.isLineComment(previous.token) ? '\n' : ' ');
				return `${separator}${comment.token.text}`;
			})
			.join('');
	}

	private static isComment(token: SqlToken): boolean {
		return token.type === SqlTokenizer.TokenType.LINE_COMMENT || token.type === SqlTokenizer.TokenType.BLOCK_COMMENT;
	}

	private static isLineComment(token: SqlToken): boolean {
		return token.type === SqlTokenizer.TokenType.LINE_COMMENT;
	}

	private static isTrailingPunctuation(token: SqlToken): boolean {
		return token.type === SqlTokenizer.TokenType.PUNCTUATION && (token.text === ',' || token.text === ';');
	}

	private static hasNewline(whitespace: string): boolean {
		return /[\r\n]/.test(whitespace);
	}

	// True when a line comment is the last thing printed for "token", so nothing may follow it on
	// the same line.
	private static endsInLineComment(token: SqlPrettyPrinter.FormatToken | undefined): boolean {
		let last = token?.trailingComments[token.trailingComments.length - 1];
		return !!last && SqlPrettyPrinter.isLineComment(last.token);
	}

	private static formatQueryWithUnions(tokens: SqlPrettyPrinter.FormatToken[], indentLevel: number, options: SqlPrettyPrinter.Options): Line[] {
		let blocks = SqlPrettyPrinter.splitByStarters(tokens, ['UNION ALL', 'UNION', 'INTERSECT', 'EXCEPT']);

		return blocks.flatMap(block => {
			let body = SqlPrettyPrinter.formatQueryBlock(block.contentTokens, indentLevel, options);

			if(block.keywordTokens.length === 0) {
				return body;
			}

			return [...SqlPrettyPrinter.renderKeywords(block.keywordTokens, indentLevel, options).lines, ...body];
		});
	}

	// Formats one query block (no top-level UNION/INTERSECT/EXCEPT of its own): an optional leading
	// WITH CTE list, followed by ordinary clause segments (SELECT/FROM/WHERE/... or INSERT/UPDATE/
	// DELETE's own clauses).
	private static formatQueryBlock(tokens: SqlPrettyPrinter.FormatToken[], indentLevel: number, options: SqlPrettyPrinter.Options): Line[] {
		let cte = tokens.length > 0 && tokens[0].type === SqlTokenizer.TokenType.WORD
			&& tokens[0].text.toUpperCase() === 'WITH' && KeywordTable.isWithCte(tokens, 0)
			? SqlPrettyPrinter.tryParseCteList(tokens, indentLevel, options)
			: undefined;

		let remainder = cte?.rest ?? tokens;
		let segments = SqlPrettyPrinter.splitByStarters(remainder, KeywordTable.CLAUSE_STARTER_PHRASES, SqlPrettyPrinter.isolationClauseCheck);
		let body = segments.flatMap(segment => SqlPrettyPrinter.renderSegment(segment, indentLevel, options));
		return cte ? [...cte.lines, ...body] : body;
	}

	// Detects a DB2 isolation clause ("... WITH UR") as its own 2-token clause starter at scan time
	// -- the only starter that can't be expressed as a fixed phrase, since it depends on
	// KeywordTable.isWithCte's lookahead (a CTE named e.g. "ur" must NOT match here).
	private static isolationClauseCheck(tokens: SqlToken[], i: number): number {
		if(tokens[i]?.type !== SqlTokenizer.TokenType.WORD || tokens[i].text.toUpperCase() !== 'WITH') {
			return 0;
		}

		return KeywordTable.isWithCte(tokens, i) ? 0 : 2;
	}

	// Attempts to parse a leading "WITH [RECURSIVE] name [(cols)] AS (...), ..." list, formatting
	// each CTE body recursively. Returns undefined (rather than throwing) on anything that doesn't
	// look like a well-formed CTE declaration partway through -- the caller then falls back to
	// letting the WITH/name/body tokens flow through ordinary segmentation as inline content, which
	// still produces valid, if unstyled, output instead of losing the main query that follows.
	private static tryParseCteList(tokens: SqlPrettyPrinter.FormatToken[], indentLevel: number, options: SqlPrettyPrinter.Options): {lines: Line[]; rest: SqlPrettyPrinter.FormatToken[]} | undefined {
		try {
			// Every CTE header line ("name AS (") is built at indentLevel+1, like any clause's content.
			// But under "compact" layout the first one is glued onto "WITH" (see renderClauseSegment),
			// which makes "WITH name AS (" visually start at indentLevel, not indentLevel+1 -- so the
			// body/closing-paren indentation (nested *inside* that opening line, unlike the header
			// itself) needs to be measured from whichever level the opening will actually end up at:
			// indentLevel+1 for "expanded" (the header keeps its own line, unglued), or indentLevel for
			// "compact" (the header glues onto "WITH" itself, unless a line comment ends "WITH").
			let i = 1;
			let recursiveToken = tokens[i]?.text.toUpperCase() === 'RECURSIVE' ? tokens[i] : undefined;

			if(recursiveToken) {
				i++;
			}

			let withHeader = SqlPrettyPrinter.renderKeywords(recursiveToken ? [tokens[0], recursiveToken] : [tokens[0]], indentLevel, options);
			let openLevel = options.clauseLayout === 'compact' && !withHeader.endsLine ? indentLevel : indentLevel + 1;
			let cteLines: Line[] = [];

			while(true) {
				let nameToken = tokens[i];

				if(!nameToken || nameToken.type === SqlTokenizer.TokenType.PUNCTUATION) {
					return undefined;
				}

				// nameToken.text is never case-transformed -- it's the CTE's own name (an identifier
				// the user chose), not a keyword, even though it sits in "keyword position" here.
				let header = new InlineWriter(indentLevel + 1);
				header.token(nameToken, nameToken.text, false);
				i++;

				if(tokens[i]?.text === '(') {
					let close = SqlPrettyPrinter.findMatchingParen(tokens, i);

					if(close === -1) {
						return undefined;
					}

					header.token(tokens[i], '(', true);
					SqlPrettyPrinter.renderInto(header, tokens.slice(i + 1, close), indentLevel + 1, options);
					header.token(tokens[close], ')', false);
					i = close + 1;
				}

				if(tokens[i]?.text.toUpperCase() !== 'AS' || tokens[i + 1]?.text !== '(') {
					return undefined;
				}

				let bodyOpen = i + 1;
				let bodyClose = SqlPrettyPrinter.findMatchingParen(tokens, bodyOpen);

				if(bodyClose === -1) {
					return undefined;
				}

				header.token(tokens[i], SqlPrettyPrinter.applyCase(tokens[i].text, options.keywordCase), true);
				header.token(tokens[bodyOpen], '(', true);

				let body = SqlPrettyPrinter.formatQueryWithUnions(tokens.slice(bodyOpen + 1, bodyClose), openLevel + 1, options);
				let closing = new InlineWriter(openLevel);
				closing.token(tokens[bodyClose], ')', false);
				i = bodyClose + 1;

				let hasNext = tokens[i]?.text === ',';

				if(hasNext) {
					closing.token(tokens[i], ',', false);
					i++;
				}

				cteLines.push(...header.lines, ...body, ...closing.lines);

				if(!hasNext) {
					break;
				}
			}

			return {lines: SqlPrettyPrinter.renderClauseSegment(withHeader, cteLines, options), rest: tokens.slice(i)};
		} catch {
			return undefined;
		}
	}

	// Generic depth-aware scanner: splits "tokens" into segments wherever one of "phrases" (or
	// "extraCheck", for a starter that can't be expressed as a fixed phrase -- see
	// isolationClauseCheck) matches at paren-depth 0. Leading content before the first match (if
	// any) becomes a segment with an empty keyword, so malformed input that never matches any
	// starter at all still comes back as one plain content segment instead of being dropped.
	private static splitByStarters(tokens: SqlPrettyPrinter.FormatToken[], phrases: string[], extraCheck?: (tokens: SqlToken[], i: number) => number): SqlPrettyPrinter.Segment[] {
		let segments: SqlPrettyPrinter.Segment[] = [];
		let depth = 0;
		let keywordTokens: SqlPrettyPrinter.FormatToken[] = [];
		let contentTokens: SqlPrettyPrinter.FormatToken[] = [];
		let started = false;

		let flush = () => {
			if(started || contentTokens.length > 0) {
				segments.push({
					keyword: keywordTokens.map(token => token.text.toUpperCase()).join(' '),
					keywordTokens,
					contentTokens
				});
			}

			contentTokens = [];
		};

		let i = 0;

		while(i < tokens.length) {
			let token = tokens[i];

			if(token.type === SqlTokenizer.TokenType.PUNCTUATION) {
				if(token.text === '(') {
					depth++;
				} else if(token.text === ')') {
					depth = Math.max(0, depth - 1);
				}
			}

			if(depth === 0) {
				let matchLength = extraCheck?.(tokens, i) || KeywordTable.matchKeywordPhrase(tokens, i, phrases);

				if(matchLength > 0) {
					flush();
					keywordTokens = tokens.slice(i, i + matchLength);
					started = true;
					i += matchLength;
					continue;
				}
			}

			contentTokens.push(token);
			i++;
		}

		flush();
		return segments;
	}

	private static renderSegment(segment: SqlPrettyPrinter.Segment, indentLevel: number, options: SqlPrettyPrinter.Options): Line[] {
		let content = segment.contentTokens;

		switch(segment.keyword) {
			case 'SELECT': {
				let {modifier, rest} = SqlPrettyPrinter.stripLeadingModifier(content, ['DISTINCT', 'ALL']);
				let header = SqlPrettyPrinter.renderKeywords(modifier ? [...segment.keywordTokens, modifier] : segment.keywordTokens, indentLevel, options);
				let block = SqlPrettyPrinter.renderList(rest, options.selectFieldWrapping, header, indentLevel, options);
				return SqlPrettyPrinter.renderClauseSegment(header, block, options);
			}

			case 'FROM': {
				let header = SqlPrettyPrinter.renderKeywords(segment.keywordTokens, indentLevel, options);
				let block = SqlPrettyPrinter.renderList(content, 'oneColumnPerLine', undefined, indentLevel, options);
				return SqlPrettyPrinter.renderClauseSegment(header, block, options);
			}

			case 'GROUP BY':
			case 'ORDER BY': {
				let header = SqlPrettyPrinter.renderKeywords(segment.keywordTokens, indentLevel, options);
				let block = SqlPrettyPrinter.renderList(content, 'wrapToWidth', header, indentLevel, options);
				return SqlPrettyPrinter.renderClauseSegment(header, block, options);
			}

			case 'WHERE':
			case 'HAVING': {
				let header = SqlPrettyPrinter.renderKeywords(segment.keywordTokens, indentLevel, options);
				let clauses = SqlPrettyPrinter.splitByLogicalOperator(content);
				// An AND/OR line lines up with the line the first condition starts on -- the WHERE line
				// itself under "compact", its own line one level in under "expanded" -- and indentWhere
				// pushes it one level deeper than that.
				let operatorLevel = (options.clauseLayout === 'compact' ? indentLevel : indentLevel + 1) + (options.indentWhere ? 1 : 0);
				let block = clauses.flatMap((clause, index) => SqlPrettyPrinter.renderInline(clause, index === 0 ? indentLevel + 1 : operatorLevel, options));
				return SqlPrettyPrinter.renderClauseSegment(header, block, options);
			}

			default: {
				// JOIN (and every variant -- LEFT JOIN, INNER JOIN, etc., see KeywordTable.TABLE_KEYWORDS)
				// is otherwise a sibling segment of FROM at the same indent level; indentJoins shifts
				// just this segment one level deeper so it visually nests under the FROM it modifies.
				let level = segment.keyword.endsWith('JOIN') && options.indentJoins ? indentLevel + 1 : indentLevel;

				if(segment.keywordTokens.length === 0) {
					return SqlPrettyPrinter.renderInline(content, level, options);
				}

				let header = SqlPrettyPrinter.renderKeywords(segment.keywordTokens, level, options);
				let block = content.length === 0 ? [] : SqlPrettyPrinter.renderInline(content, level + 1, options);
				return SqlPrettyPrinter.renderClauseSegment(header, block, options);
			}
		}
	}

	// A clause's keyword tokens ("SELECT DISTINCT", "LEFT JOIN", "WITH RECURSIVE") as one header at
	// "level", with their comments: ones above the keyword on lines of their own, and a trailing one
	// after it -- which, if it's a line comment, means the clause's content can't share the header's
	// line (see renderClauseSegment).
	private static renderKeywords(tokens: SqlPrettyPrinter.FormatToken[], level: number, options: SqlPrettyPrinter.Options): SqlPrettyPrinter.Header {
		let writer = new InlineWriter(level);
		tokens.forEach((token, index) => writer.token(token, SqlPrettyPrinter.applyCase(token.text, options.keywordCase), index > 0));
		return {
			lines: writer.lines,
			keywordWidth: tokens.map(token => token.text).join(' ').length,
			endsLine: writer.endsLine
		};
	}

	// A comma-delimited clause body (SELECT list, FROM list, GROUP BY/ORDER BY), laid out by
	// SelectListWrapper. "header" is given when the list's first line may be glued to it (see
	// firstLineExtraWidth).
	private static renderList(tokens: SqlPrettyPrinter.FormatToken[], mode: SelectListWrapper.Options<SqlPrettyPrinter.FormatToken>['mode'], header: SqlPrettyPrinter.Header | undefined, indentLevel: number, options: SqlPrettyPrinter.Options): Line[] {
		let itemLevel = indentLevel + 1;

		return SelectListWrapper.emitDelimitedList(SelectListWrapper.splitTopLevelItems(tokens), {
			mode,
			maxWidth: options.expressionMaxWidth,
			baseIndentLevel: itemLevel,
			indentColumns: LineWriter.indentColumns(options),
			renderItem: item => ({
				lines: SqlPrettyPrinter.renderInline(item, itemLevel, options),
				endsLine: SqlPrettyPrinter.endsInLineComment(item[item.length - 1])
			}),
			renderDelimiter: delimiter => {
				let writer = new InlineWriter(itemLevel);
				writer.token(delimiter, ',', false);
				return {lines: writer.lines, endsLine: writer.endsLine};
			},
			firstLineExtraWidth: header ? SqlPrettyPrinter.firstLineExtraWidth(header, options) : undefined
		});
	}

	// How many extra columns a delimited list's first line will consume once glued to "header"
	// under clauseLayout: "compact" -- the header keywords plus the one space renderClauseSegment
	// glues them with, less the one indent unit gluing strips (the header line sits a level
	// shallower than the block's own lines). 0 whenever the block starts its own fresh line instead
	// ("expanded", or a header ending in a line comment), since the header then contributes nothing
	// to its width budget.
	private static firstLineExtraWidth(header: SqlPrettyPrinter.Header, options: SqlPrettyPrinter.Options): number {
		return options.clauseLayout === 'compact' && !header.endsLine ? header.keywordWidth + 1 - LineWriter.indentColumns(options) : 0;
	}

	// Shared by every clause that has a keyword + a content block rendered as if on lines of its
	// own one level in (the "expanded" shape) -- either stacks header and block as-is (expanded),
	// or continues the header's line with the block's first line (compact), which then takes the
	// header's level. This one routine covers SELECT/FROM/GROUP BY/ORDER BY/WHERE/HAVING/JOIN/
	// INSERT/UPDATE/DELETE/etc. and the WITH...AS CTE header uniformly -- the single place
	// clauseLayout is actually applied. A header ending in a line comment always stacks, since
	// nothing can follow the comment on its line.
	private static renderClauseSegment(header: SqlPrettyPrinter.Header, block: Line[], options: SqlPrettyPrinter.Options): Line[] {
		if(options.clauseLayout === 'expanded' || header.endsLine) {
			return [...header.lines, ...block];
		}

		return LineWriter.join(header.lines, block, ' ');
	}

	private static splitByLogicalOperator(tokens: SqlPrettyPrinter.FormatToken[]): SqlPrettyPrinter.FormatToken[][] {
		let chunks: SqlPrettyPrinter.FormatToken[][] = [];
		let current: SqlPrettyPrinter.FormatToken[] = [];
		let depth = 0;

		for(let token of tokens) {
			if(token.type === SqlTokenizer.TokenType.PUNCTUATION) {
				if(token.text === '(') {
					depth++;
				} else if(token.text === ')') {
					depth = Math.max(0, depth - 1);
				}
			}

			let isLogicalOperator = depth === 0 && token.type === SqlTokenizer.TokenType.WORD
				&& (token.text.toUpperCase() === 'AND' || token.text.toUpperCase() === 'OR');

			if(isLogicalOperator) {
				if(current.length > 0) {
					chunks.push(current);
				}

				current = [token];
				continue;
			}

			current.push(token);
		}

		if(current.length > 0) {
			chunks.push(current);
		}

		return chunks.length > 0 ? chunks : [[]];
	}

	private static stripLeadingModifier(tokens: SqlPrettyPrinter.FormatToken[], modifiers: string[]): {modifier?: SqlPrettyPrinter.FormatToken; rest: SqlPrettyPrinter.FormatToken[]} {
		let first = tokens[0];

		if(first?.type === SqlTokenizer.TokenType.WORD && modifiers.includes(first.text.toUpperCase())) {
			return {modifier: first, rest: tokens.slice(1)};
		}

		return {rest: tokens};
	}

	// Renders a flat (non-clause-segmented) expression: a SELECT-list item, a WHERE/ON condition, a
	// function-call argument list, a VALUES/SET list, etc. Recurses into formatQueryWithUnions
	// whenever it encounters a parenthesized derived table/scalar subquery, so a query nested
	// anywhere in an expression gets the same full clause-based formatting as a top-level statement
	// -- the recursive block is spliced in as however many extra output lines it needs; everything
	// else here stays on one line, apart from the breaks a comment needs.
	private static renderInline(tokens: SqlPrettyPrinter.FormatToken[], indentLevel: number, options: SqlPrettyPrinter.Options): Line[] {
		let writer = new InlineWriter(indentLevel);
		SqlPrettyPrinter.renderInto(writer, tokens, indentLevel, options);
		return writer.lines;
	}

	// renderInline's body, writing into a caller's writer instead -- for a caller that goes on to
	// print more on the same line (a CTE header's column list, then "AS ("), so a line comment
	// inside still breaks before whatever comes next.
	private static renderInto(writer: InlineWriter, tokens: SqlPrettyPrinter.FormatToken[], indentLevel: number, options: SqlPrettyPrinter.Options): void {
		let i = 0;

		while(i < tokens.length) {
			let token = tokens[i];

			if(token.type === SqlTokenizer.TokenType.PUNCTUATION && token.text === '(') {
				let close = SqlPrettyPrinter.findMatchingParen(tokens, i);
				let inner = close !== -1 ? tokens.slice(i + 1, close) : [];

				if(close !== -1 && SqlPrettyPrinter.startsSubquery(inner)) {
					writer.token(token, '(', SqlPrettyPrinter.needsSpaceBefore(tokens, i, options));
					writer.block(SqlPrettyPrinter.formatQueryWithUnions(inner, indentLevel + 1, options));
					writer.token(tokens[close], ')', false);
					i = close + 1;
					continue;
				}
			}

			writer.token(token, SqlPrettyPrinter.renderTokenText(token, options), SqlPrettyPrinter.needsSpaceBefore(tokens, i, options));
			i++;
		}
	}

	private static startsSubquery(inner: SqlToken[]): boolean {
		let first = inner[0];

		if(!first || first.type !== SqlTokenizer.TokenType.WORD) {
			return false;
		}

		let text = first.text.toUpperCase();
		return text === 'SELECT' || (text === 'WITH' && KeywordTable.isWithCte(inner, 0));
	}

	private static findMatchingParen(tokens: SqlToken[], openIndex: number): number {
		let depth = 0;

		for(let i = openIndex; i < tokens.length; i++) {
			let token = tokens[i];

			if(token.type === SqlTokenizer.TokenType.PUNCTUATION) {
				if(token.text === '(') {
					depth++;
				} else if(token.text === ')') {
					depth--;

					if(depth === 0) {
						return i;
					}
				}
			}
		}

		return -1;
	}

	private static renderTokenText(token: SqlToken, options: SqlPrettyPrinter.Options): string {
		if(token.type === SqlTokenizer.TokenType.WORD && KeywordTable.LOGICAL_KEYWORDS.includes(token.text.toUpperCase())) {
			return SqlPrettyPrinter.applyCase(token.text, options.keywordCase);
		}

		// A line break inside a string or delimited identifier is part of its value, not layout --
		// masked until formatTokens is done, so neither the trailing-whitespace cleanup nor any
		// multi-line-block handling along the way ever touches what is inside it.
		if(token.type === SqlTokenizer.TokenType.STRING || token.type === SqlTokenizer.TokenType.QUOTED_IDENTIFIER) {
			return token.text.replace(/\r/g, SqlPrettyPrinter.MASKED_CR).replace(/\n/g, SqlPrettyPrinter.MASKED_LF);
		}

		return token.text;
	}

	private static applyCase(text: string, mode: SqlPrettyPrinter.Options['keywordCase']): string {
		if(mode === 'upper') {
			return text.toUpperCase();
		}

		if(mode === 'lower') {
			return text.toLowerCase();
		}

		return text;
	}

	// A token is "term boundary"-like when it can stand as one side of an infix operator: a real
	// (non-keyword) identifier, a literal, or a closing paren -- used to tell an infix operator
	// ("a = b") apart from a prefix/unary one ("SELECT -5", "col IN (-5)") for denseOperators.
	private static isTermBoundary(token?: SqlToken): boolean {
		if(!token) {
			return false;
		}

		if(token.type === SqlTokenizer.TokenType.WORD) {
			return !KeywordTable.LOGICAL_KEYWORDS.includes(token.text.toUpperCase());
		}

		return token.type === SqlTokenizer.TokenType.QUOTED_IDENTIFIER
			|| token.type === SqlTokenizer.TokenType.STRING
			|| token.type === SqlTokenizer.TokenType.NUMBER
			|| token.text === ')';
	}

	private static isInfixOperator(tokens: SqlToken[], i: number): boolean {
		let token = tokens[i];
		return !!token && token.type === SqlTokenizer.TokenType.OPERATOR
			&& SqlPrettyPrinter.isTermBoundary(tokens[i - 1])
			&& !!tokens[i + 1];
	}

	private static needsSpaceBefore(tokens: SqlToken[], i: number, options: SqlPrettyPrinter.Options): boolean {
		if(i === 0) {
			return false;
		}

		let prev = tokens[i - 1];
		let token = tokens[i];

		if(token.text === '.' || prev.text === '.') {
			return false;
		}

		if(prev.text === '(' || token.text === ')' || token.text === ',' || token.text === ';') {
			return false;
		}

		if(prev.type === SqlTokenizer.TokenType.PARAM_MARKER) {
			return false;
		}

		if(token.text === '(' && prev.type === SqlTokenizer.TokenType.WORD && !KeywordTable.LOGICAL_KEYWORDS.includes(prev.text.toUpperCase())) {
			return false;
		}

		// A prefix/unary operator ("-5", not "a - b") always glues to its operand -- unlike infix
		// spacing, that's not conditional on denseOperators at all; "SELECT - 5" would look wrong
		// even with denseOperators off.
		if(prev.type === SqlTokenizer.TokenType.OPERATOR && !SqlPrettyPrinter.isInfixOperator(tokens, i - 1)) {
			return false;
		}

		if(!options.denseOperators) {
			return true;
		}

		// "=?" re-lexes as one operator (the lexer's operator characters include "?"), so an operator
		// next to a positional marker keeps its spaces -- both of them, so "id = ?" reads evenly --
		// and formats the same way twice.
		let isQuestionMarker = (candidate?: SqlToken) => candidate?.type === SqlTokenizer.TokenType.PARAM_MARKER && candidate.text.startsWith('?');

		if(prev.type === SqlTokenizer.TokenType.OPERATOR && isQuestionMarker(token)) {
			return true;
		}

		if(token.type === SqlTokenizer.TokenType.OPERATOR && isQuestionMarker(tokens[i + 1])) {
			return true;
		}

		return !SqlPrettyPrinter.isInfixOperator(tokens, i) && !SqlPrettyPrinter.isInfixOperator(tokens, i - 1);
	}
}

// Builds one run of output -- typically a line, though comments and subqueries can make it several
// -- printing each token together with its comments (see SqlPrettyPrinter.FormatToken). A line
// comment consumes the rest of its line, so whatever follows one must start a new line; the break
// is held back until something actually follows, so a run never ends in a dangling one and a
// caller can tell from endsLine whether it may append more on the same line.
class InlineWriter {
	private readonly finished: Line[] = [];
	private current = '';
	private pendingBreak = false;

	// "level" is the level of the first line, and of every line this writer breaks onto.
	constructor(private readonly level: number) {}

	get lines(): Line[] {
		return this.current.length > 0 || this.finished.length === 0
			? [...this.finished, {level: this.level, text: this.current}]
			: [...this.finished];
	}

	get endsLine(): boolean {
		return this.pendingBreak;
	}

	// Prints "text" for "token": its leading comments first (each on a line of its own, as it was
	// in the source), then the text -- after a space when spaceBefore asks for one -- then its
	// trailing comments.
	token(token: SqlPrettyPrinter.FormatToken, text: string, spaceBefore: boolean): void {
		for(let comment of token.leadingComments) {
			this.separate(comment.newlineBefore ? 'break' : 'space');
			this.current += comment.token.text;
			this.pendingBreak = comment.token.type === SqlTokenizer.TokenType.LINE_COMMENT;
		}

		if(token.leadingComments.length > 0) {
			this.separate(token.newlineBefore ? 'break' : 'space');
		} else {
			this.separate(spaceBefore ? 'space' : 'none');
		}

		this.current += text;

		for(let comment of token.trailingComments) {
			this.separate(comment.newlineBefore ? 'break' : 'space');
			this.current += comment.token.text;
			this.pendingBreak = comment.token.type === SqlTokenizer.TokenType.LINE_COMMENT;
		}
	}

	// Splices in already formatted lines (a subquery) below the current one; whatever follows them
	// (its ")", and any comment above that) starts a new line at this writer's level.
	block(lines: Line[]): void {
		this.finished.push({level: this.level, text: this.current}, ...lines);
		this.current = '';
		this.pendingBreak = false;
	}

	// Separates what's already on the current line from what comes next. Nothing goes at the start
	// of a line -- including the first one, which the caller places -- and a waiting line-comment
	// break overrides whatever was asked for.
	private separate(separator: 'break' | 'space' | 'none'): void {
		if(this.current.length === 0) {
			this.pendingBreak = false;
			return;
		}

		if(this.pendingBreak || separator === 'break') {
			this.finished.push({level: this.level, text: this.current});
			this.current = '';
		} else if(separator === 'space') {
			this.current += ' ';
		}

		this.pendingBreak = false;
	}
}

export namespace SqlPrettyPrinter {
	export interface Options {
		tabWidth: number;
		useTabs: boolean;
		keywordCase: 'upper' | 'lower' | 'preserve';
		denseOperators: boolean;
		removeComments: boolean;
		expressionMaxWidth: number;
		selectFieldWrapping: 'oneColumnPerLine' | 'wrapToWidth';
		clauseLayout: 'expanded' | 'compact';
		indentJoins: boolean;
		indentWhere: boolean;
	}

	export interface Hooks {
		// Called with the error when formatting fails and the original text is returned instead.
		onFallback?: (error: unknown) => void;
	}

	export interface Comment {
		readonly token: SqlTokenizer.SqlToken;
		// Whether the comment started a new line in the source.
		readonly newlineBefore: boolean;
	}

	// A real (non-whitespace, non-comment) token, carrying what attachComments took out of the
	// stream around it.
	export interface FormatToken extends SqlTokenizer.SqlToken {
		// The whitespace directly before this token in the source (after any comment before it).
		readonly whitespaceBefore: string;
		readonly newlineBefore: boolean;
		// Comments on their own lines above this token.
		readonly leadingComments: Comment[];
		// Comments after this token: on its line, or -- before a "," or ";", or at the very end --
		// on lines of their own below it.
		readonly trailingComments: Comment[];
	}

	export interface Segment {
		readonly keyword: string;
		readonly keywordTokens: FormatToken[];
		readonly contentTokens: FormatToken[];
	}

	export interface Header {
		// The rendered keywords, comments included.
		readonly lines: LineWriter.Line[];
		// The keywords alone, as one line -- what a width budget counts.
		readonly keywordWidth: number;
		// The header ends in a line comment, so its content can't share its line.
		readonly endsLine: boolean;
	}
}
