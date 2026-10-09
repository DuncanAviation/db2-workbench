import { Table, TableBody, TableCell, TableHead, TableRow } from '@mui/material';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';

interface Props {
	driverErrors: DbErrorUtils.DbErrorDetail[];
}

// The one Code/State/Message rendering of a raw driver error chain, shared by the results History tab
// and the connection editor's Test Connection result so IBM's full multi-part error detail isn't
// collapsed down to a single message string in either place.
export function DbErrorTable({ driverErrors }: Props) {
	if (driverErrors.length === 0) {
		return null;
	}

	return (
		<Table size="small">
			<TableHead>
				<TableRow>
					<TableCell>Code</TableCell>
					<TableCell>State</TableCell>
					<TableCell>Message</TableCell>
				</TableRow>
			</TableHead>
			<TableBody>
				{driverErrors.map((error, index) => (
					<TableRow key={index}>
						<TableCell>{error.code}</TableCell>
						<TableCell>{error.state}</TableCell>
						<TableCell>{error.message}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
