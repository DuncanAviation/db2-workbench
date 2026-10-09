import { Stack } from '@mui/material';
import type { SchemasRoutineDetail, SchemasRoutineParam, SchemasSystemRoutine } from '../../../src/webview-messages/schemas-messages';
import { Loading } from '../../shared/components/loading';
import { SqlErrorDisplay } from '../../shared/components/sql-error-display';
import type { FieldGroup } from './field-groups';
import { FieldGroups } from './field-groups';
import { routineNoun, useRoutineDetail, useRoutineParams } from './routine-data';

interface Props {
	routine: SchemasSystemRoutine;
}

function describeFunctionType(functionType: string | undefined): string {
	switch(functionType) {
		case 'S': return 'Scalar';
		case 'T': return 'Table';
		case 'C': return 'Aggregate';
		default: return functionType ?? '';
	}
}

// SYSROUTINES.FUNCTION_ORIGIN - how the function came to exist.
function describeOrigin(origin: string | undefined): string {
	switch(origin) {
		case 'E': return 'External';
		case 'Q': return 'SQL';
		case 'U': return 'Sourced';
		case 'S': return 'System generated';
		case 'B': return 'Built-in';
		default: return origin ?? '';
	}
}

// `DECIMAL(11, 2)`, `VARCHAR(40)`, `INTEGER` - the type as a CREATE FUNCTION would spell it.
export function describeDataType(param: Pick<SchemasRoutineParam, 'dataType' | 'length' | 'precision' | 'scale'>): string {
	if (param.precision) {
		return `${param.dataType}(${param.precision}, ${param.scale ?? 0})`;
	}

	return /CHAR|BINARY|GRAPHIC/i.test(param.dataType) && param.length ? `${param.dataType}(${param.length})` : param.dataType;
}

// What a scalar function returns: its result after casting (row type 'C'), which DB2 reports for every
// scalar function, else its result before casting ('R').
function describeReturns(routine: SchemasSystemRoutine, params: SchemasRoutineParam[] | null): string {
	if (routine.functionType === 'T') {
		return 'Table';
	}

	let result = params?.find(param => param.rowType === 'C') ?? params?.find(param => param.rowType === 'R');
	return result ? describeDataType(result) : '';
}

function formatDate(value: string | undefined): string {
	return value ? new Date(value).toLocaleString() : '';
}

// Only the fields a routine of this kind has: a function's type, return, origin and null-input
// behavior; a procedure's parameter-mode counts and result sets.
function buildGroups(routine: SchemasSystemRoutine, detail: SchemasRoutineDetail | undefined, params: SchemasRoutineParam[] | null): FieldGroup[] {
	let isProcedure = routine.routineType === 'PROCEDURE';
	let functionOnly = (fields: FieldGroup['fields']) => isProcedure ? [] : fields;

	return [
		{
			title: 'General',
			fields: [
				{ label: 'Schema', value: routine.schema },
				{ label: 'Name', value: routine.name },
				{ label: 'Specific Name', value: routine.specificName },
				{ label: 'SQL Schema', value: routine.sqlSchema },
				...functionOnly([
					{ label: 'Type', value: describeFunctionType(routine.functionType) },
					{ label: 'Returns', value: describeReturns(routine, params) }
				]),
				{ label: 'Description', value: routine.description },
				{ label: 'Definer', value: detail?.definer ?? '' }
			]
		},
		...(isProcedure ? [{
			title: 'Parameters',
			fields: [
				{ label: 'In', value: String(detail?.inParms ?? '') },
				{ label: 'Out', value: String(detail?.outParms ?? '') },
				{ label: 'In/Out', value: String(detail?.inoutParms ?? '') },
				{ label: 'Result Sets', value: String(detail?.resultSets ?? '') }
			]
		}] : []),
		{
			title: 'Behavior',
			fields: [
				...functionOnly([{ label: 'Origin', value: describeOrigin(routine.functionOrigin) }]),
				{ label: 'Body', value: routine.body },
				{ label: 'Language', value: routine.language },
				{ label: 'External Name', value: detail?.externalName ?? '' },
				{ label: 'Parameter Style', value: detail?.parameterStyle ?? '' },
				{ label: 'Deterministic', value: detail?.deterministic ?? '' },
				{ label: 'SQL Data Access', value: detail?.sqlDataAccess ?? '' },
				...functionOnly([{ label: 'Called On Null Input', value: detail?.nullCall ?? '' }]),
			]
		},
		{
			title: 'Dates',
			fields: [
				{ label: 'Created', value: formatDate(detail?.created) },
				{ label: 'Last Altered', value: formatDate(detail?.lastAltered) }
			]
		}
	];
}

// Same layout as the view Info tab. What the tree already carries shows at once; the rest of the row
// (and the return type, which lives in SYSPARMS) fills in when it arrives.
export function RoutineInfoTab({ routine }: Props) {
	let target = { schema: routine.schema, specificName: routine.specificName };
	let detail = useRoutineDetail(target);
	let params = useRoutineParams(target);

	if (detail.error) {
		return (
			<Stack sx={{ p: 2 }}>
				<SqlErrorDisplay error={detail.error} label={`Failed to load the ${routineNoun(routine)}`} />
			</Stack>
		);
	}

	if (!detail.value) {
		return <Loading message={`Loading ${routineNoun(routine)}...`} />;
	}

	return <FieldGroups groups={buildGroups(routine, detail.value.detail, params.value)} />;
}
