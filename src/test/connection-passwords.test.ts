import * as assert from 'assert';
import { DbDriverConnection } from '../database/drivers/db-driver.js';
import { FakeDriver } from '../database/drivers/fake/fake-driver.js';
import { OdbcDriver } from '../database/drivers/odbc/odbc-driver.js';
import { extension } from '../extension.js';
import { Nullable } from '../utils/nullable.js';
import type { ConnectionEditorOutboundMessage } from '../webview-messages/connection-editor-messages.js';
import { TestSupport } from './test-support.js';

/**
 * The stored password's lifetime: it survives until a connect proves it wrong, or until Set Password
 * replaces it. A failure that isn't a refused sign-on - an unreachable host, most often - must leave
 * a password the user saved on purpose where it is.
 *
 * Test mode answers the connect prompt from the environment rather than from secret storage (see
 * DbConnections.getPassword), so these tests read and write the stored secret directly.
 */
suite('Connection passwords', () => {
	const STORED = 'stored-password';

	/** A fake driver whose every connect fails, counting the attempts. Like the fake driver itself, it
	 * can't say whether a failure was a refused sign-on. */
	class FailingDriver extends FakeDriver {
		connectAttempts = 0;

		constructor() {
			super({ database: TestSupport.DATABASE });
		}

		override async connect(): Promise<DbDriverConnection> {
			this.connectAttempts++;
			throw new Error('Unable to connect');
		}
	}

	/** A failing driver that classifies every failure one way. */
	class ClassifyingDriver extends FailingDriver {
		constructor(private signOnRefused: boolean) {
			super();
		}

		isAuthenticationError(): boolean {
			return this.signOnRefused;
		}
	}

	function storedPassword(): Promise<Nullable<string>> {
		return extension.secrets.get(TestSupport.CONNECTION);
	}

	async function openSession(key: string): Promise<void> {
		try {
			await extension.connections.getConnectionInfo({ key: key, configId: TestSupport.CONFIG_ID });
		} finally {
			await TestSupport.closeSessions(key);
		}
	}

	suiteSetup(async () => {
		await TestSupport.activate();
	});

	setup(async () => {
		await extension.secrets.store({ ...TestSupport.CONNECTION, password: STORED });
	});

	teardown(async () => {
		TestSupport.restoreDriver();
		await extension.secrets.delete(TestSupport.CONNECTION);
	});

	suite('a failed connect', () => {
		test('keeps the password, and stops retrying, when the host was never reached', async () => {
			let driver = new ClassifyingDriver(false);
			extension.drivers.register(driver);

			await openSession('test://password-unreachable');

			assert.strictEqual(await storedPassword(), STORED);
			assert.strictEqual(driver.connectAttempts, 1, 'retyping a password can\'t fix an unreachable host, so it must not be asked for again');
		});

		test('deletes the password, and asks again, when the host refused the sign-on', async () => {
			let driver = new ClassifyingDriver(true);
			extension.drivers.register(driver);

			await openSession('test://password-refused');

			assert.strictEqual(await storedPassword(), undefined);
			assert.ok(driver.connectAttempts > 1, `expected a retry after a refused sign-on, got ${driver.connectAttempts} attempt(s)`);
		});

		test('deletes the password when the driver can\'t tell why it failed', async () => {
			let driver = new FailingDriver();
			extension.drivers.register(driver);

			await openSession('test://password-unclassified');

			assert.strictEqual(await storedPassword(), undefined);
		});
	});

	// Driven through the provider's own webview message handler, the one the editor's Set Password
	// button posts to. The input box is answered by replacing promptForPassword on the instance.
	suite('Set Password', () => {
		let originalPrompt: unknown;

		function provider(): any {
			return extension.connectionEditorProvider;
		}

		function answerPrompt(answer: Nullable<string>) {
			provider().promptForPassword = async () => answer;
		}

		async function setPassword() {
			let message: ConnectionEditorOutboundMessage = { command: 'setPassword', host: TestSupport.CONNECTION.host, userName: TestSupport.CONNECTION.userName };
			await provider().handleWebviewMessage(message);
		}

		setup(() => {
			originalPrompt = provider().promptForPassword;
		});

		teardown(() => {
			provider().promptForPassword = originalPrompt;
		});

		test('replaces the stored password with the one entered', async () => {
			answerPrompt('new-password');

			await setPassword();

			assert.strictEqual(await storedPassword(), 'new-password');
		});

		test('leaves the stored password alone when the prompt is cancelled', async () => {
			answerPrompt(undefined);

			await setPassword();

			assert.strictEqual(await storedPassword(), STORED);
		});
	});

	// The IBM i Access driver reports a refused sign-on and an unreachable host with the same SQLSTATE,
	// 08001, so the message is what tells them apart.
	suite('ODBC sign-on failures', () => {
		const driver = new OdbcDriver();

		function odbcError(state: string, message: string): Error {
			return Object.assign(new Error(message), { driverErrors: [{ state, code: -1, message }] });
		}

		test('a wrong password is a sign-on failure', () => {
			let error = odbcError('08001', '[IBM][System i Access ODBC Driver]Communication link failure. comm rc=8002 - CWBSY0002 - Password for user TESTUSER on system PRODHOST is not correct');
			assert.strictEqual(driver.isAuthenticationError(error), true);
		});

		test('an expired password is a sign-on failure', () => {
			let error = odbcError('08001', '[IBM][System i Access ODBC Driver]Communication link failure. comm rc=8003 - CWBSY0003 - Password for user TESTUSER on system PRODHOST is expired');
			assert.strictEqual(driver.isAuthenticationError(error), true);
		});

		test('the standard invalid-authorization state is a sign-on failure', () => {
			assert.strictEqual(driver.isAuthenticationError(odbcError('28000', 'Invalid authorization specification')), true);
		});

		test('an unreachable host is not', () => {
			let error = odbcError('08001', '[IBM][System i Access ODBC Driver]Communication link failure. comm rc=10060 - CWBCO1048 - A firewall blockage or time-out may have occurred when trying to connect to the IBM i system');
			assert.strictEqual(driver.isAuthenticationError(error), false);
		});
	});
});
