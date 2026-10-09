import { expect } from 'chai';
import { SqlPrettyPrinter } from './sql-pretty-printer.js';
import { SqlTokenizer } from './sql-tokenizer.js';

// Properties every format must have, whatever the SQL and options -- checked over a corpus of
// statements (the inputs sql-pretty-printer.spec.ts uses, plus a few shapes it doesn't) crossed with
// the options that change structure. The example-based spec pins down what a format looks like; this
// catches what no example thought to ask about:
// - idempotence: formatting formatted SQL changes nothing, so Format Document is safe to run twice
//   and a layout that moves on a second pass (a stray comma line, a drifting comment) shows up;
// - no lost or reordered tokens: the output's non-whitespace tokens are the input's, less comments
//   when removeComments is on -- which is what catches a token dropped, or pulled onto a line
//   comment's line and so commented out;
// - no fallback: the printer never gives up and hands back the original text.

const CORPUS: string[] = [
	'select id, name from employees e where e.active = 1 and e.dept_id = 3 order by e.name',
	'select e.id, d.name from employees e join departments d on e.dept_id = d.id where e.active = 1',
	'select dept_id, count(*) from employees group by dept_id having count(*) > 5',
	'select x.id from (select id from employees where active = 1) x',
	'select (select max(x) from other) as m from employees',
	'with recent as (select id, name from employees where active = 1) select id, name from recent order by name',
	'with a as (select id from t1), b as (select a.id from a) select b.id from b',
	'with data as (\n  select 1\n)-- note\nselect * from data',
	'with data as (\n  select 1\n)\n-- note\nselect * from data',
	'with data as (-- note\n  select 1\n) select * from data',
	'with data as (\n  -- note\n  select 1\n) select * from data',
	'with a as (\n  select 1\n)-- note\n, b as (\n  select 2\n) select a.x from a, b',
	'select id from a where x = 1 union select id from b where y = 2',
	'select id from employees where active = 1 with ur',
	'select e.id, d.name from employees e, departments d where e.dept_id = d.id',
	'select coalesce(a, b, c) as long_column_name_here from t',
	'select id from t for update',
	'select Id from Employees where Active = 1',
	'select id from employees where id=1 and salary>=1000',
	'select -5 from t',
	'select * from t left join u on t.id = u.id',
	'select * from e where e.status = \'ACTIVE\' and e.hireDate > \'2020-01-01\' or e.id = 1',
	'select a from t group by a having count(*) > 1 and max(b) < 5',
	'select * from t where a = 1 and b in (select b from u)',
	'select id from t;',
	'select id from t ;',
	'select id from t\n\t;',
	'select id from employees where id = :custId',
	'select id from employees where id = ?',
	'select id -- trailing note\nfrom employees',
	'select id /* inline note */ from t',
	'select *\nfrom appuser --test\n;',
	'select *\nfrom appuser --test\n\n\n;',
	'select *\nfrom appuser /*test*/\n;',
	'select *\r\nfrom appuser --\r\n;',
	'select rcid, email -- trailing note\nfrom appuser',
	'select rcid, rcdsts, usrtype, fnam, lnam, mnam, prfnam, email -- trailing note\nfrom appuser',
	'select a --one\n, b --two\n, c\nfrom t',
	'select a --one\n, b, c, d\nfrom t',
	'select a, --one\nb\nfrom t',
	'select id\n-- note\nfrom t',
	'select id from a join b where a.id = 1',
	'select id from employees where (a = 1 and b = 2 group by dept_id',
	'select from from where (((',
	'delete from employees where id = 1',
	'select id, first_name, last_name, department_id, hire_date, salary, manager_id from employees',
	'select id, name from employees e join departments d on e.dept_id = d.id where e.active = 1 and e.dept_id = 3',
	'select column1 --comment1\n\t, column2 --comment1\nfrom table',
	'insert into employees (id, name) values (1, \'a\')',
	'update employees set active = 0, name = \'x\' where id = 1',
	'select case when e.status = \'A\' then \'Active\' else \'Inactive\' end as statusDescription, count(*) as count from employees e',
	'select a from t where a = 1 and b in (select b from u where c = 2 and d = 3) or e = 4',
	'select id from t order by id desc fetch first 10 rows only',
	'select \'line one  \nline two\' as text from t',
	'select /* a block\n   comment */ id from t',
	'-- header comment\nselect a from t',
	'select -- columns\n\ta, b\nfrom t',
	'select a from t\nwhere a = 1\n-- before and\nand b = 2',
	'select x from (\n\t-- inner\n\tselect x from t\n\t-- end of inner\n) d',
	'select x from ( -- derived\n\tselect x from t\n) d',
	'with -- ctes\ndata as (select 1 from t) select * from data',
	'with data (a, -- first\n\tb) as (select 1, 2 from t) select * from data',
	'select coalesce(a, -- first choice\n\tb) from t',
	'select a, from t',
	'select a, , b from t',
	'select a from t; -- after',
	'select a\n-- before the comma\n, b from t',
	'select a from t\n-- before the semicolon\n;',
	'select distinct -- unique\n\ta from t group -- grouping\nby a',
	'/* one */ /* two */\nselect a from t',
	'with data as ( -- CTE for billed hours\n\tselect hours, empId\n\tfrom billed\n)\nselect e.id, e.name, e.hireDate, d.deptName, e.status, count(*) as count\nfrom employees e\njoin departments d on d.id = e.deptId\njoin billed b on b.empId = e.id\nwhere e.status = \'ACTIVE\'\n\tand e.hireDate > \'2020-01-01\'\ngroup by e.id, e.name, e.hireDate, d.deptName, e.status\nhaving count(*) > 0\nand count(*) < 10\norder by e.name;'
];

const BASE: SqlPrettyPrinter.Options = {
	tabWidth: 4,
	useTabs: true,
	keywordCase: 'preserve',
	denseOperators: false,
	removeComments: false,
	expressionMaxWidth: 60,
	selectFieldWrapping: 'wrapToWidth',
	clauseLayout: 'compact',
	indentJoins: false,
	indentWhere: false
};

// Every combination of the options that change structure, rather than all of them: the others
// (tab width, max width) change only how far something is indented or where a list wraps.
function optionMatrix(): SqlPrettyPrinter.Options[] {
	let matrix: SqlPrettyPrinter.Options[] = [];

	for(let clauseLayout of ['compact', 'expanded'] as const) {
		for(let selectFieldWrapping of ['wrapToWidth', 'oneColumnPerLine'] as const) {
			for(let removeComments of [false, true]) {
				for(let indented of [false, true]) {
					for(let keywordCase of ['preserve', 'upper'] as const) {
						matrix.push({
							...BASE,
							clauseLayout,
							selectFieldWrapping,
							removeComments,
							keywordCase,
							indentJoins: indented,
							indentWhere: indented,
							useTabs: !indented,
							denseOperators: indented
						});
					}
				}
			}
		}
	}

	return matrix;
}

function describeOptions(options: SqlPrettyPrinter.Options): string {
	return `${options.clauseLayout}/${options.selectFieldWrapping}/removeComments=${options.removeComments}/`
		+ `indent=${options.indentJoins}/keywordCase=${options.keywordCase}`;
}

function isComment(token: SqlTokenizer.SqlToken): boolean {
	return token.type === SqlTokenizer.TokenType.LINE_COMMENT || token.type === SqlTokenizer.TokenType.BLOCK_COMMENT;
}

// The token sequence a format must preserve. A comment's own line endings and trailing whitespace
// may legitimately change (the printer normalizes both), so comments are compared with those
// removed; a keyword's case may too unless keywordCase is "preserve". Everything else, strings
// included, must survive exactly.
function significantTokens(tokens: SqlTokenizer.SqlToken[], options: SqlPrettyPrinter.Options): string[] {
	return tokens
		.filter(token => token.type !== SqlTokenizer.TokenType.WHITESPACE)
		.filter(token => !(options.removeComments && isComment(token)))
		.map(token => {
			if(isComment(token)) {
				return token.text.replace(/[ \t]*\r?\n/g, '\n').trimEnd();
			}

			return token.type === SqlTokenizer.TokenType.WORD && options.keywordCase !== 'preserve' ? token.text.toUpperCase() : token.text;
		});
}

function formatOrFail(tokens: SqlTokenizer.SqlToken[], options: SqlPrettyPrinter.Options): string {
	return SqlPrettyPrinter.formatTokens(tokens, options, {
		onFallback: error => {
			throw new Error(`formatting fell back to the original text: ${error instanceof Error ? error.stack : String(error)}`);
		}
	});
}

describe('SqlPrettyPrinter invariants', () => {
	for(let options of optionMatrix()) {
		describe(describeOptions(options), () => {
			for(let sql of CORPUS) {
				it(JSON.stringify(sql), () => {
					let inputTokens = SqlTokenizer.tokenize(sql);
					let formatted = formatOrFail(inputTokens, options);
					let formattedTokens = SqlTokenizer.tokenize(formatted);

					expect(significantTokens(formattedTokens, options), 'tokens lost or reordered').to.deep.equal(significantTokens(inputTokens, options));
					expect(formatOrFail(formattedTokens, options), 'formatting the output again changed it').to.equal(formatted);
				});
			}
		});
	}
});
