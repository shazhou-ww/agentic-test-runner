/**
 * atest — Global LLM configuration (config file + env + CLI flags)
 *
 * Priority: CLI flags > env vars > config file > defaults
 * Config file: ~/.config/atest/config.yaml (override with ATEST_CONFIG)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parse, stringify } from 'yaml';
import type { RunOptions } from './types.js';

/** Config file keys */
const CONFIG_KEYS = ['api_key', 'base_url', 'model'] as const;

/** Resolve config file path (env override: ATEST_CONFIG) */
export function configPath(): string {
	return process.env.ATEST_CONFIG ?? join(homedir(), '.config', 'atest', 'config.yaml');
}

/** Read config file. Returns empty object if missing or invalid. */
export function readConfig(): Record<string, string> {
	const p = configPath();
	if (!existsSync(p)) return {};
	try {
		const raw = readFileSync(p, 'utf-8');
		return parse(raw) ?? {};
	} catch {
		return {};
	}
}

/** Write config object to file (creates directory). */
export function writeConfig(config: Record<string, string>): void {
	const p = configPath();
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, stringify(config));
}

/** Set a single value, preserving others. Creates file if needed. */
export function setConfigValue(key: string, value: string): void {
	const config = readConfig();
	config[key] = value;
	writeConfig(config);
}

// ── Resolution (CLI > env > config > default) ──────────────────

export interface ResolvedEntry {
	value: string;
	source: 'cli' | 'env' | 'config' | 'default';
}

export interface ResolvedConfig {
	api_key: ResolvedEntry;
	base_url: ResolvedEntry;
	model: ResolvedEntry;
}

function resolveEntry(
	cliVal: string | undefined,
	envVar: string,
	configVal: string | undefined,
): ResolvedEntry {
	if (cliVal) return { value: cliVal, source: 'cli' };
	if (process.env[envVar]) return { value: process.env[envVar]!, source: 'env' };
	if (configVal) return { value: configVal, source: 'config' };
	return { value: '', source: 'default' };
}

/** Resolve effective config with source tracking. */
export function resolveConfig(opts: Partial<RunOptions>): ResolvedConfig {
	const fileConfig = readConfig();
	return {
		api_key: resolveEntry(opts['api-key'], 'ATEST_API_KEY', fileConfig.api_key),
		base_url: resolveEntry(opts['base-url'], 'ATEST_BASE_URL', fileConfig.base_url),
		model: resolveEntry(opts.model, 'ATEST_MODEL', fileConfig.model),
	};
}

// ── Display ─────────────────────────────────────────────────────

/** Mask sensitive values: sk-abcd1234 → sk-*** */
export function maskValue(key: string, value: string): string {
	if (key === 'api_key' && value) {
		return `${value.slice(0, 3)}***`;
	}
	return value;
}

/** Print effective config with sources (for `atest config`). */
export function printEffectiveConfig(opts: Partial<RunOptions>): void {
	const resolved = resolveConfig(opts);
	const p = configPath();

	console.log('Effective configuration:\n');
	for (const key of CONFIG_KEYS) {
		const entry = resolved[key];
		const display = maskValue(key, entry.value);
		const shown = entry.value ? display : '(not set)';
		console.log(`  ${key.padEnd(10)} ${shown}   (source: ${entry.source})`);
	}
	console.log(`\n  config file: ${p}`);
	if (!existsSync(p)) {
		console.log('  (not created — run: atest config init)');
	}
}

// ── Init ────────────────────────────────────────────────────────

/** Create config file with empty template. Returns false if already exists. */
export function initConfig(): boolean {
	const p = configPath();
	if (existsSync(p)) return false;
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(
		p,
		[
			'api_key: ""   # LLM API key',
			'base_url: ""  # LLM API endpoint',
			'model: ""     # LLM model name',
			'',
		].join('\n'),
	);
	return true;
}
