#!/usr/bin/env tsx
/**
 * colorize-logs.ts
 * Simple NDJSON log colorizer and tailer for Nora logs.
 *
 * Features:
 *  - Parses newline-delimited JSON (NDJSON) log files.
 *  - Colorizes output by log level (error/warn/info/debug/verbose).
 *  - Prints a short header per entry and pretty-prints `data` as indented JSON.
 *  - If --path is not provided, searches the current working directory for log files
 *    (*.log, *.ndjson, *.txt). If multiple files are found, prompts the user to select one
 *    (the latest file is selected by default).
 *  - If no files are found in CWD, falls back to %APPDATA%/nora/logs or LOG_PATH from .env.
 *
 * Usage:
 *   node ./scripts/colorize-logs.ts [--path <file>] [--no-follow] [--levels info,debug] [--depth N] [--use-env-log-path] [--show-latest]
 * Examples:
 *   node ./scripts/colorize-logs.ts                                    # tails latest log (CWD first, then appdata)
 *   node ./scripts/colorize-logs.ts --path ./app.log --no-follow
 *   node ./scripts/colorize-logs.ts --levels info,debug
 *   node ./scripts/colorize-logs.ts --use-env-log-path --no-follow     # use LOG_PATH from .env file
 *   node ./scripts/colorize-logs.ts --use-env-log-path --show-latest   # show latest log without file selection
 *
 * Created: 2025-12-09T14:41:55.216Z
 * Migrated to TypeScript: 2025-12-09
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

// Types
type LogLevel = 'error' | 'warn' | 'warning' | 'info' | 'debug' | 'verbose';

interface LogEntry {
	level?: LogLevel | string;
	process?: string;
	message?: string;
	data?: Record<string, unknown>;
	[key: string]: unknown;
}

interface LogFile {
	name: string;
	full: string;
	mtime: number;
	stats?: fs.Stats;
}

interface Colors {
	reset: string;
	red: string;
	yellow: string;
	green: string;
	gray: string;
	cyan: string;
	magenta: string;
	white: string;
	black: string;
}

// Constants
const APPDATA = process.env.APPDATA || process.env.HOME || '.';
const DEFAULT_LOG_DIR = path.join(APPDATA, 'nora', 'logs');
const LOG_FILE_PATTERN = /\.(log|ndjson|txt)$/i;
const TAIL_LINE_COUNT = 100;
const POLL_INTERVAL_MS = 1000;
const DEFAULT_DEPTH = 3;

const colors: Colors = {
	reset: '\x1b[0m',
	red: '\x1b[31m',
	yellow: '\x1b[33m',
	green: '\x1b[32m',
	gray: '\x1b[90m',
	cyan: '\x1b[36m',
	magenta: '\x1b[35m',
	white: '\x1b[37m',
	black: '\x1b[30m',
};

// Additional styling
const styles = {
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	brightGreen: '\x1b[92m',
	brightBlue: '\x1b[94m',
	brightCyan: '\x1b[96m',
	brightYellow: '\x1b[93m',
	brightRed: '\x1b[91m',
	brightMagenta: '\x1b[95m',
	bgGreen: '\x1b[42m',
	bgBlue: '\x1b[44m',
	bgCyan: '\x1b[46m',
	bgRed: '\x1b[41m',
	bgYellow: '\x1b[43m',
};

// CLI argument parsing
const argv = process.argv.slice(2);

function getArg(name: string): string | null {
	const idx = argv.indexOf(name);
	if (idx === -1) return null;
	return argv[idx + 1] || null;
}

const fileArg = getArg('--path') || getArg('-p');
const noFollow = argv.includes('--no-follow') || argv.includes('-n');
const levelsArg = getArg('--levels') || getArg('-l');
const useEnvLogPath = argv.includes('--use-env-log-path');
const showLatest = argv.includes('--show-latest');
const depth =
	parseInt(getArg('--depth') || getArg('-d') || String(DEFAULT_DEPTH), 10) ||
	DEFAULT_DEPTH;
const levelFilter: string[] = levelsArg
	? levelsArg
			.split(',')
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean)
	: [];

function printUsage(): void {
	console.log(
		'Usage: node ./scripts/colorize-logs.ts [--path <file>] [--no-follow] [--levels info,debug] [--depth N] [--use-env-log-path] [--show-latest]'
	);
	process.exit(0);
}

if (argv.includes('--help') || argv.includes('-h')) {
	printUsage();
}

// File discovery
function findLogFilesInDir(dir: string): LogFile[] {
	try {
		if (!fs.existsSync(dir)) return [];

		return fs
			.readdirSync(dir)
			.filter((f) => LOG_FILE_PATTERN.test(f))
			.map((f) => {
				const fullPath = path.join(dir, f);
				const stats = fs.statSync(fullPath);
				return {
					name: f,
					full: fullPath,
					mtime: stats.mtimeMs,
					stats,
				};
			})
			.sort((a, b) => b.mtime - a.mtime);
	} catch (error) {
		return [];
	}
}

function askQuestion(prompt: string): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer);
		});
	});
}

function getFileMetadata(file: LogFile): string {
	if (!file.stats) return '';

	const lines = fs.readFileSync(file.full, 'utf8').split('\n').length - 1; // -1 because last empty line
	const sizeKB = (file.stats.size / 1024).toFixed(2);
	const mtime = new Date(file.stats.mtimeMs).toLocaleString();
	const birthtime = new Date(file.stats.birthtime).toLocaleString();

	return `${styles.brightCyan}Lines:${colors.reset} ${lines} ${styles.dim}|${colors.reset} ${styles.brightCyan}Size:${colors.reset} ${sizeKB}KB ${styles.dim}|${colors.reset} ${styles.brightCyan}Modified:${colors.reset} ${mtime} ${styles.dim}|${colors.reset} ${styles.brightCyan}Created:${colors.reset} ${birthtime}`;
}

async function promptUserToSelect(
	files: LogFile[],
	dir: string
): Promise<string | null> {
	if (!files || files.length === 0) return null;

	console.log(`\n${styles.bold}${styles.brightBlue}📂 Found ${files.length} log file(s) in:${colors.reset} ${styles.brightCyan}${dir}${colors.reset}\n`);
	files.forEach((f, idx) => {
		const isDefault = idx === 0 ? `${styles.brightGreen}(latest - default)${colors.reset}` : '';
		const metadata = getFileMetadata(f);
		console.log(`  ${styles.brightYellow}${idx + 1}${colors.reset}) ${styles.bold}${f.name}${colors.reset} ${isDefault}`);
		console.log(`     ${metadata}`);
	});

	const answer = await askQuestion(
		`\n${styles.brightBlue}Select file${colors.reset} ${styles.dim}[${styles.brightGreen}1${styles.dim}]${colors.reset} (press ${styles.brightGreen}Enter${colors.reset} for default): `
	);
	let choice = 1;

	if (answer && answer.trim()) {
		const n = parseInt(answer.trim(), 10);
		if (!Number.isNaN(n) && n >= 1 && n <= files.length) {
			choice = n;
		} else {
			console.log(`${styles.brightRed}✗ Invalid selection${colors.reset}, using default 1.`);
			choice = 1;
		}
	}

	return files[choice - 1].full;
}

async function pickFileInteractive(): Promise<string | null> {
	// 1) If path provided, use it
	if (fileArg) {
		console.log(`${styles.brightCyan}✓ Using explicit path:${colors.reset} ${styles.bold}${fileArg}${colors.reset}`);
		return path.resolve(fileArg);
	}

	// 2) Check if --use-env-log-path flag is set and LOG_PATH exists in environment
	if (useEnvLogPath && process.env.LOG_PATH) {
		console.log(`${styles.brightCyan}✓ Using LOG_PATH from .env:${colors.reset} ${styles.bold}${process.env.LOG_PATH}${colors.reset}`);
		const envLogDir = process.env.LOG_PATH;
		const envFiles = findLogFilesInDir(envLogDir);
		
		if (envFiles.length === 0) {
			console.error(`${styles.brightRed}✗ No log files found in ${envLogDir}${colors.reset}`);
			return null;
		}

		// If --show-latest flag is set, skip file selection and use the latest file
		if (showLatest) {
			const latestFile = envFiles[0];
			console.log(`\n${styles.brightGreen}✓ Skipping file selection due to ${styles.bold}--show-latest${styles.brightGreen} flag${colors.reset}`);
			console.log(`${styles.brightBlue}📄 Using latest log file:${colors.reset} ${styles.bold}${latestFile.name}${colors.reset}`);
			console.log(`${getFileMetadata(latestFile)}\n`);
			return latestFile.full;
		}

		if (envFiles.length === 1) return envFiles[0].full;
		if (envFiles.length > 1) return await promptUserToSelect(envFiles, envLogDir);
	}

	// 3) Search current working directory
	console.log(`${styles.brightBlue}🔍 Searching for logs in current directory:${colors.reset} ${styles.bold}${process.cwd()}${colors.reset}`);
	const cwd = process.cwd();
	const cwdFiles = findLogFilesInDir(cwd);
	
	if (cwdFiles.length > 0) {
		if (showLatest) {
			const latestFile = cwdFiles[0];
			console.log(`\n${styles.brightGreen}✓ Skipping file selection due to ${styles.bold}--show-latest${styles.brightGreen} flag${colors.reset}`);
			console.log(`${styles.brightBlue}📄 Using latest log file:${colors.reset} ${styles.bold}${latestFile.name}${colors.reset}`);
			console.log(`${getFileMetadata(latestFile)}\n`);
			return latestFile.full;
		}
		if (cwdFiles.length === 1) return cwdFiles[0].full;
		if (cwdFiles.length > 1) return await promptUserToSelect(cwdFiles, cwd);
	}

	// 4) Fallback to default appdata log directory
	console.log(`${styles.brightBlue}🔍 Searching for logs in default directory:${colors.reset} ${styles.bold}${DEFAULT_LOG_DIR}${colors.reset}`);
	const appFiles = findLogFilesInDir(DEFAULT_LOG_DIR);
	
	if (appFiles.length > 0) {
		if (showLatest) {
			const latestFile = appFiles[0];
			console.log(`\n${styles.brightGreen}✓ Skipping file selection due to ${styles.bold}--show-latest${styles.brightGreen} flag${colors.reset}`);
			console.log(`${styles.brightBlue}📄 Using latest log file:${colors.reset} ${styles.bold}${latestFile.name}${colors.reset}`);
			console.log(`${getFileMetadata(latestFile)}\n`);
			return latestFile.full;
		}
		if (appFiles.length === 1) return appFiles[0].full;
		if (appFiles.length > 1) return await promptUserToSelect(appFiles, DEFAULT_LOG_DIR);
	}

	return null;
}

// Colorization
function colorForLevel(level?: string): string {
	if (!level) return colors.white;

	switch (level.toLowerCase()) {
		case 'error':
			return colors.red;
		case 'warn':
		case 'warning':
			return colors.yellow;
		case 'info':
			return colors.green;
		case 'debug':
			return colors.gray;
		case 'verbose':
			return colors.cyan;
		default:
			return colors.white;
	}
}

function highlightJSON(json: string): string {
	let highlighted = json;

	// First, handle brackets and structural characters with dim color
	highlighted = highlighted.replace(/([{}[\],])/g, `${styles.brightYellow}$1${colors.reset}`);

	// Apply key coloring (quoted strings followed by colon) - need to escape the dim colons
	highlighted = highlighted.replace(/"([^"\\]|\\.)*"\s*:/g, (match) => {
        const key = match.match(/"([^"\\]|\\.)*"/)?.[0] || '';
        return `${styles.brightRed}${key}${colors.reset}${styles.dim}:${colors.reset}`;
    });

	// Apply string value coloring (quoted strings not preceded by opening quote + colon pattern)
	highlighted = highlighted.replace(/:\s*"([^"\\]|\\.)*"/g, (match) => {
		const colonPart = match.match(/^:\s*/)?.[0] || ': ';
		const stringPart = match.substring(colonPart.length);
		return `${styles.dim}:${colors.reset} ${styles.brightGreen}${stringPart}${colors.reset}`;
	});

	// Apply number coloring (only standalone numbers after colons)
	highlighted = highlighted.replace(/:\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g, (match, num) => {
		return `${styles.brightYellow}:${colors.reset} ${styles.brightYellow}${num}${colors.reset}`;
	});

	// Apply boolean coloring
	highlighted = highlighted.replace(/:\s*(true|false)\b/g, (match, bool) => {
		return `${styles.brightBlue}:${colors.reset} ${styles.brightYellow}${bool}${colors.reset}`;
	});

	// Apply null coloring
	highlighted = highlighted.replace(/:\s*(null)\b/g, (match, nullVal) => {
		return `${styles.brightBlue}:${colors.reset} ${styles.brightRed}${nullVal}${colors.reset}`;
	});

	return highlighted;
}

function processLine(line: string): void {
	if (!line || !line.trim()) return;

	let obj: LogEntry | null = null;
	try {
		obj = JSON.parse(line) as LogEntry;
	} catch (error) {
		console.log(colors.magenta + line + colors.reset);
		return;
	}

	const level = (obj.level || 'info').toString();

	if (levelFilter.length && !levelFilter.includes(level.toLowerCase())) {
		return;
	}

	const proc = obj.process || '-';
	const msg = obj.message || '';

	const now = new Date();
	const pad = (n: number): string => String(n).padStart(2, '0');
	const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;

	// Color-coded level badges
	let levelColor = colorForLevel(level);
	let levelBadge = '';
	
	switch (level.toLowerCase()) {
		case 'error':
			levelBadge = `${styles.bgRed}${styles.bold} ERROR ${colors.reset}`;
			break;
		case 'warn':
		case 'warning':
			levelBadge = `${styles.bgYellow}${colors.black}${styles.bold}   WARN   ${colors.reset}`;
			break;
		case 'info':
			levelBadge = `${styles.bgGreen}${colors.black}${styles.bold}  INFO   ${colors.reset}`;
			break;
		case 'debug':
			levelBadge = `${styles.bgCyan}${colors.black}${styles.bold}  DEBUG  ${colors.reset}`;
			break;
		case 'verbose':
			levelBadge = `${styles.bgBlue}${styles.bold} VERBOSE ${colors.reset}`;
			break;
		default:
			levelBadge = `${styles.dim}${level.toUpperCase().padEnd(7)}${colors.reset}`;
	}

	const procBadge = `${styles.dim}[${colors.reset}${styles.brightMagenta}${proc}${colors.reset}${styles.dim}]${colors.reset}`;
	const timestampStr = `${styles.dim}[${colors.reset}${styles.brightCyan}${timestamp}${colors.reset}${styles.dim}]${colors.reset}`;

	const header = `${timestampStr} ${procBadge} ${levelBadge} ${msg}`;
	console.log(header);

	if (obj.data && Object.keys(obj.data).length > 0) {
		const pretty = JSON.stringify(obj.data, null, 2);
		const highlighted = highlightJSON(pretty);
		for (const l of highlighted.split(/\r?\n/)) {
			console.log('  ' + l);
		}
	}
}

// Main execution
async function main(): Promise<void> {
	const filePath = await pickFileInteractive();

	if (!filePath) {
		console.error('No log file found (use --path).');
		process.exit(1);
	}

	if (noFollow) {
		// Read file once and exit
		const rl = readline.createInterface({
			input: fs.createReadStream(filePath, { encoding: 'utf8' }),
			crlfDelay: Infinity,
		});

		rl.on('line', processLine);
		rl.on('close', () => process.exit(0));
		return;
	}

	// Tail-like behavior: print last 100 lines then poll for new data
	let buffer = '';

	try {
		const content = fs.readFileSync(filePath, 'utf8');
		const lines = content.split(/\r?\n/).filter(Boolean);
		const start = Math.max(0, lines.length - TAIL_LINE_COUNT);
		for (const line of lines.slice(start)) {
			processLine(line);
		}
	} catch (error) {
		const err = error as Error;
		console.error('Could not read file:', err.message);
		process.exit(1);
	}

	let lastSize = (() => {
		try {
			return fs.statSync(filePath).size;
		} catch (error) {
			return 0;
		}
	})();

	const pollInterval = setInterval(() => {
		fs.stat(filePath, (err, stats) => {
			if (err) return;

			if (stats.size > lastSize) {
				// File has grown, read new data
				const stream = fs.createReadStream(filePath, {
					start: lastSize,
					end: stats.size - 1,
					encoding: 'utf8',
				});

				stream.on('data', (chunk: string | Buffer) => {
					const content = typeof chunk === 'string' ? chunk : chunk.toString();
					buffer += content;
					const parts = buffer.split(/\r?\n/);
					buffer = parts.pop() || ''; // Keep leftover incomplete line

					for (const part of parts) {
						processLine(part);
					}
				});

				stream.on('end', () => {
					lastSize = stats.size;
				});
			} else if (stats.size < lastSize) {
				// File was rotated/truncated
				lastSize = stats.size;
			}
		});
	}, POLL_INTERVAL_MS);

	process.on('SIGINT', () => {
		console.log('\nExiting');
		clearInterval(pollInterval);
		process.exit(0);
	});
}

main().catch((error) => {
	console.error('Unexpected error:', error);
	process.exit(1);
});
