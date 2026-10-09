import { Extension } from '../../extension.js';
import { ConnectionConfig } from '../../models/connection-config.js';
import { Nullable } from '../../utils/nullable.js';
import { StringUtils } from '../../utils/string-utils.js';
import { DbDriver } from './db-driver.js';
import { FakeDriver } from './fake/fake-driver.js';
import { SAMPLE_DATABASE } from './fake/fixtures/sample-database.js';
import { OdbcDriver } from './odbc/odbc-driver.js';

/**
 * The registry of available DbDriver implementations, and the only place a concrete driver is chosen
 * for a connection. Nothing else constructs a driver: a caller with a ConnectionConfig in hand asks
 * get(config), so adding a driver means registering it here rather than touching call sites.
 *
 * Selection order, most specific first:
 * 1. The DB2_WORKBENCH_DRIVER environment variable, so a test or CI run can force every connection
 *    onto the fake driver without editing the user's settings.
 * 2. ConnectionConfig.driver.
 * 3. The ODBC driver, which is what every existing connection (with no `driver` set) means.
 */
export class DbDrivers {
	static readonly DRIVER_ENVIRONMENT_VARIABLE = 'DB2_WORKBENCH_DRIVER';

	private _drivers: Nullable<Map<string, DbDriver>>;

	constructor(private extension: Extension) { }

	private get drivers(): Map<string, DbDriver> {
		if(!this._drivers) {
			let drivers = new Map<string, DbDriver>();
			let odbcDriver = new OdbcDriver();
			drivers.set(odbcDriver.id, odbcDriver);

			// The fake driver is only registered when a run explicitly asks for it, so a normal session
			// can never reach canned data by accident - and register() still lets a test install its own
			// fixture over this default one.
			if(StringUtils.equalsIgnoreCase(StringUtils.default(process.env[DbDrivers.DRIVER_ENVIRONMENT_VARIABLE], () => ''), FakeDriver.ID)) {
				let fakeDriver = new FakeDriver({ database: SAMPLE_DATABASE });
				drivers.set(fakeDriver.id, fakeDriver);
			}

			this._drivers = drivers;
		}

		return this._drivers;
	}

	/** Adds (or replaces) a driver. Used by tests to install the fake driver. */
	register(driver: DbDriver): void {
		this.drivers.set(driver.id, driver);
	}

	get default(): DbDriver {
		return <DbDriver>this.drivers.get(OdbcDriver.ID);
	}

	/**
	 * The driver for a connection. An id that names no registered driver falls back to the default
	 * rather than failing to connect at all - a mistyped setting shouldn't leave the user with an
	 * extension that can't open anything, and the connection attempt itself will report a real error
	 * if the fallback can't serve it.
	 */
	get(config: Nullable<ConnectionConfig>): DbDriver {
		let forcedId = process.env[DbDrivers.DRIVER_ENVIRONMENT_VARIABLE]?.trim();

		if(StringUtils.isNotBlank(forcedId)) {
			let forced = this.drivers.get(<string>forcedId);

			// No fallback here, unlike a mistyped setting below: a test or CI run that asked for the
			// fake driver and silently got ODBC instead would try to reach a real database, and the
			// failure would look like anything but the wrong driver.
			if(!forced) {
				throw new Error(`${DbDrivers.DRIVER_ENVIRONMENT_VARIABLE} names "${forcedId}", which is not a registered driver`);
			}

			return forced;
		}

		return this.drivers.get(StringUtils.default(config?.driver, () => OdbcDriver.ID)) ?? this.default;
	}

	/** The ConnectOptions a driver needs to open `config`, with the password already resolved. */
	static toConnectOptions(config: ConnectionConfig, password: string, driver: DbDriver): DbDriver.ConnectOptions {
		return {
			host: config.host,
			userName: config.userName,
			password: password,
			connectionString: StringUtils.default(config.connectionString, () => driver.defaultConnectionString)
		};
	}
}
