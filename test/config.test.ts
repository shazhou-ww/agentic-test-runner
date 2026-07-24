import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	configPath,
	readConfig,
	writeConfig,
	setConfigValue,
	resolveConfig,
	maskValue,
	initConfig,
} from '../src/config.js';

describe('config', () => {
	let tmpDir: string;
	let tmpConfigPath: string;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'atest-test-'));
		tmpConfigPath = join(tmpDir, 'config.yaml');
		savedEnv = {
			ATEST_CONFIG: process.env.ATEST_CONFIG,
			ATEST_API_KEY: process.env.ATEST_API_KEY,
			ATEST_BASE_URL: process.env.ATEST_BASE_URL,
			ATEST_MODEL: process.env.ATEST_MODEL,
		};
		process.env.ATEST_CONFIG = tmpConfigPath;
		delete process.env.ATEST_API_KEY;
		delete process.env.ATEST_BASE_URL;
		delete process.env.ATEST_MODEL;
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(savedEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('configPath respects ATEST_CONFIG env', () => {
		assert.equal(configPath(), tmpConfigPath);
	});

	it('readConfig returns empty object when file not found', () => {
		assert.deepEqual(readConfig(), {});
	});

	it('writeConfig creates directory and writes file', () => {
		writeConfig({ api_key: 'sk-test', base_url: 'https://api.test.com', model: 'test-model' });
		assert.ok(existsSync(tmpConfigPath));
		const config = readConfig();
		assert.equal(config.api_key, 'sk-test');
		assert.equal(config.base_url, 'https://api.test.com');
		assert.equal(config.model, 'test-model');
	});

	it('setConfigValue sets a value preserving others', () => {
		writeConfig({ api_key: 'sk-test', base_url: 'https://api.test.com', model: 'test-model' });
		setConfigValue('model', 'new-model');
		const config = readConfig();
		assert.equal(config.api_key, 'sk-test');
		assert.equal(config.model, 'new-model');
	});

	it('resolveConfig: CLI flags take priority over env and config', () => {
		writeConfig({ api_key: 'sk-config', base_url: 'https://config.test', model: 'config-model' });
		process.env.ATEST_API_KEY = 'sk-env';
		process.env.ATEST_MODEL = 'env-model';

		const resolved = resolveConfig({ 'api-key': 'sk-cli' });
		assert.equal(resolved.api_key.value, 'sk-cli');
		assert.equal(resolved.api_key.source, 'cli');
		assert.equal(resolved.model.value, 'env-model');
		assert.equal(resolved.model.source, 'env');
		assert.equal(resolved.base_url.value, 'https://config.test');
		assert.equal(resolved.base_url.source, 'config');
	});

	it('resolveConfig: env overrides config file', () => {
		writeConfig({ api_key: 'sk-config', model: 'config-model' });
		process.env.ATEST_API_KEY = 'sk-env';

		const resolved = resolveConfig({});
		assert.equal(resolved.api_key.value, 'sk-env');
		assert.equal(resolved.api_key.source, 'env');
	});

	it('resolveConfig: falls back to config file', () => {
		writeConfig({ api_key: 'sk-config', base_url: 'https://config.test', model: 'config-model' });

		const resolved = resolveConfig({});
		assert.equal(resolved.api_key.value, 'sk-config');
		assert.equal(resolved.api_key.source, 'config');
		assert.equal(resolved.base_url.value, 'https://config.test');
		assert.equal(resolved.base_url.source, 'config');
	});

	it('resolveConfig: default when nothing set', () => {
		const resolved = resolveConfig({});
		assert.equal(resolved.api_key.value, '');
		assert.equal(resolved.api_key.source, 'default');
	});

	it('maskValue masks api_key', () => {
		assert.equal(maskValue('api_key', 'sk-abcd1234'), 'sk-***');
		assert.equal(maskValue('base_url', 'https://api.test.com'), 'https://api.test.com');
	});

	it('initConfig creates file with template', () => {
		assert.ok(initConfig());
		assert.ok(existsSync(tmpConfigPath));
		const config = readConfig();
		assert.equal(config.api_key, '');
		assert.equal(config.base_url, '');
		assert.equal(config.model, '');
	});

	it('initConfig returns false if file exists', () => {
		initConfig();
		assert.ok(!initConfig());
	});
});
