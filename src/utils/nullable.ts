// A value that may be absent. Deliberately just undefined, not null as well -- the codebase's
// optional values are undefined, and null only ever arrives from outside (a driver's row, parsed
// JSON), where the checks accept it separately.
export type Nullable<T> = T | undefined;
