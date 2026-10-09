import { ConnectionSchema } from '../models/connection-schema.js';
import { JobDetails } from './job-details.js';

export interface ConnectionInfo {
	jobDetails: JobDetails;
	workerJobDetails: JobDetails;
	schemas: ConnectionSchema[];
}