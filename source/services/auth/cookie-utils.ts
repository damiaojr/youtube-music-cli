import {existsSync, readFileSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {logger} from '../logger/logger.service.ts';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import type {CookiesFromBrowser} from '../player/ytdl-cookies.ts';

const execFileAsync = promisify(execFile);

/**
 * Parse a Netscape cookies.txt file into a cookie header string.
 * Format: domain, flag, path, secure, expiry, name, value
 */
function parseNetscapeCookies(content: string): string {
	const cookies: string[] = [];
	const lines = content.split('\n');

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}

		const parts = trimmed.split('\t');
		if (parts.length < 7) {
			continue;
		}

		const name = parts[5];
		const value = parts[6];

		cookies.push(`${name}=${value}`);
	}

	return cookies.join('; ');
}

/**
 * Parse a browser cookie file into a cookie header string.
 */
export function parseCookiesFile(filePath: string): string | null {
	try {
		if (!existsSync(filePath)) {
			logger.warn('CookieUtils', `Cookie file not found: ${filePath}`);
			return null;
		}

		const content = readFileSync(filePath, 'utf8');

		// Check if this is a Netscape cookies.txt format
		const lines = content.split('\n');
		for (const line of lines.slice(0, 5)) {
			if (
				line.includes('# Netscape HTTP Cookie File') ||
				line.includes('#HttpOnly_')
			) {
				return parseNetscapeCookies(content);
			}
		}

		// If it's JSON or some other format, try to parse it as a cookie header directly
		if (content.includes('=')) {
			return content.trim();
		}

		logger.warn('CookieUtils', 'Unrecognized cookie file format');
		return null;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn('CookieUtils', `Failed to read cookie file: ${message}`);
		return null;
	}
}

/**
 * Get the Windows path to a Chromium-based browser's cookie database.
 */
function getWindowsBrowserCookieDbPath(
	browser: CookiesFromBrowser,
): string | null {
	if (process.platform !== 'win32') {
		return null;
	}

	const appData = process.env.LOCALAPPDATA;
	if (!appData) return null;

	switch (browser) {
		case 'edge':
			return join(
				appData,
				'Microsoft\\Edge\\User Data\\Default\\Network\\Cookies',
			);
		case 'chrome':
			return join(
				appData,
				'Google\\Chrome\\User Data\\Default\\Network\\Cookies',
			);
		case 'brave':
			return join(
				appData,
				'BraveSoftware\\Brave-Browser\\User Data\\Default\\Network\\Cookies',
			);
		default:
			return null;
	}
}

/**
 * Use Python (if available) to read cookies from a Chromium browser's SQLite
 * database on Windows. This works around yt-dlp's "Could not copy Chrome
 * cookie database" error caused by the browser locking the SQLite file.
 *
 * Python's sqlite3 module can sometimes open locked databases in read-only
 * URI mode, which avoids triggering the copy mechanism entirely.
 */
async function extractBrowserCookiesViaPython(
	browser: CookiesFromBrowser,
): Promise<string | null> {
	const dbPath = getWindowsBrowserCookieDbPath(browser);
	if (!dbPath || !existsSync(dbPath)) {
		logger.warn(
			'CookieUtils',
			`Could not locate ${browser} cookie database at ${dbPath ?? 'unknown'}`,
		);
		return null;
	}

	// Python script that reads cookies from the SQLite database and outputs
	// them in Netscape cookies.txt format.
	// Uses mode=ro (read-only URI) which can sometimes open files that are
	// locked for writing by another process.
	const pythonScript = `
import sqlite3
import sys
import os

db_path = sys.argv[1]
# Try read-only mode first
try:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
except Exception:
    # Fallback: try to copy the file while it's locked (will fail on Windows)
    import shutil
    tmp_path = db_path + ".tmp_" + str(os.getpid())
    try:
        shutil.copy2(db_path, tmp_path)
        conn = sqlite3.connect(tmp_path)
    except Exception as e:
        print(f"ERROR:{e}", file=sys.stderr)
        sys.exit(1)

cursor = conn.cursor()
cursor.execute("""
    SELECT name, value, host_key, path, is_secure, expires_utc
    FROM cookies
    WHERE host_key LIKE '%youtube%' OR host_key LIKE '%google%'
""")

for name, value, host_key, path, is_secure, expires_utc in cursor.fetchall():
    # Convert Windows FILETIME to Unix timestamp
    if expires_utc and expires_utc > 0:
        unix_ts = (expires_utc - 116444736000000000) // 1000000
    else:
        unix_ts = 0
    secure = 'TRUE' if is_secure else 'FALSE'
    # Netscape cookies.txt format: domain, flag, path, secure, expiry, name, value
    print(f"{host_key}\\tTRUE\\t{path}\\t{secure}\\t{unix_ts}\\t{name}\\t{value}")

conn.close()
# Clean up temp file if created
tmp_path = db_path + ".tmp_" + str(os.getpid())
if os.path.exists(tmp_path):
    try:
        os.unlink(tmp_path)
    except Exception:
        pass
`.trim();

	// Determine the Python executable
	const pythonExe =
		process.platform === 'win32'
			? process.env.PY_PYTHON || 'python'
			: 'python3';

	try {
		const {stdout, stderr} = await execFileAsync(
			pythonExe,
			['-c', pythonScript, dbPath],
			{timeout: 15000},
		);

		if (stderr && stderr.includes('ERROR:')) {
			logger.warn(
				'CookieUtils',
				`Python SQLite read failed: ${stderr.split('ERROR:')[1]?.trim() ?? 'unknown error'}`,
			);
			return null;
		}

		if (stdout) {
			return stdout;
		}

		return null;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn('CookieUtils', `Python cookie extraction failed: ${message}`);
		return null;
	}
}

/**
 * Use yt-dlp to extract cookies from a browser.
 * yt-dlp supports: chrome, firefox, edge, brave, opera, vivaldi, safari, chromium
 * Returns a Netscape cookies.txt content or null.
 */
async function extractBrowserCookiesViaYtdlp(
	browser: CookiesFromBrowser,
): Promise<string | null> {
	try {
		// Use yt-dlp to extract cookies from browser to a temp file
		// yt-dlp supports: chrome, firefox, edge, brave, opera, vivaldi, safari, chromium
		const tmpFile = join(
			tmpdir(),
			`ymc-yt-cookies-${browser}-${Date.now()}.txt`,
		);

		// Try with --cookies-from-browser first
		const {stderr} = await execFileAsync(
			'yt-dlp',
			[
				'--cookies-from-browser',
				browser,
				'--cookies',
				tmpFile,
				'--skip-download',
				'--no-warnings',
				'https://www.youtube.com', // Dummy URL to just extract cookies
			],
			{timeout: 15000},
		);

		// If yt-dlp succeeded, read the cookie file
		if (existsSync(tmpFile)) {
			const content = readFileSync(tmpFile, 'utf8');
			// Clean up
			try {
				unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}
			return content;
		}

		// If yt-dlp failed, try to parse stderr for useful info
		if (stderr && !stderr.includes('WARNING')) {
			logger.warn('CookieUtils', `yt-dlp stderr: ${stderr.slice(0, 200)}`);
		}

		return null;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(
			'CookieUtils',
			`yt-dlp cookie extraction failed for ${browser}: ${message}`,
		);
		return null;
	}
}

/**
 * Directly extract YouTube cookies from Firefox profile SQLite databases.
 * Uses WAL-safe file copying so it works even while Firefox is running.
 */
async function extractFirefoxCookiesViaPython(): Promise<string | null> {
	const pythonScript = `
import sqlite3, os, shutil, tempfile

home = os.path.expanduser('~')
candidates = [
    os.path.join(home, '.config', 'mozilla', 'firefox'),
    os.path.join(home, '.mozilla', 'firefox'),
    os.path.join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'),
    os.path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
    os.path.join(home, 'Library', 'Application Support', 'Firefox', 'Profiles'),
    os.path.join(os.environ.get('APPDATA', ''), 'Mozilla', 'Firefox', 'Profiles') if os.environ.get('APPDATA') else ''
]

candidates = [c for c in candidates if c and os.path.isdir(c)]
found_cookies = None

for base in candidates:
    try:
        entries = os.listdir(base)
    except Exception:
        continue
    for profile in entries:
        profile_path = os.path.join(base, profile)
        db_path = os.path.join(profile_path, 'cookies.sqlite')
        if not os.path.isfile(db_path):
            continue
        try:
            with tempfile.TemporaryDirectory() as tmp:
                for f in ['cookies.sqlite', 'cookies.sqlite-wal', 'cookies.sqlite-shm']:
                    src = os.path.join(profile_path, f)
                    if os.path.exists(src):
                        shutil.copy2(src, os.path.join(tmp, f))
                conn = sqlite3.connect(os.path.join(tmp, 'cookies.sqlite'))
                cur = conn.cursor()
                cur.execute("SELECT host, path, isSecure, expiry, name, value FROM moz_cookies WHERE host LIKE '%youtube%' OR host LIKE '%google%'")
                rows = cur.fetchall()
                conn.close()
                names = {r[4] for r in rows}
                if any(k in names for k in ['SAPISID', 'SID', 'SSID', 'HSID', 'LOGIN_INFO']):
                    lines = ['# Netscape HTTP Cookie File']
                    for host, path, is_sec, exp, name, val in rows:
                        sec_str = 'TRUE' if is_sec else 'FALSE'
                        lines.append(f"{host}\\tTRUE\\t{path}\\t{sec_str}\\t{exp}\\t{name}\\t{val}")
                    found_cookies = '\\n'.join(lines)
                    break
        except Exception:
            pass
    if found_cookies:
        break

if found_cookies:
    print(found_cookies)
`.trim();

	const pythonExe =
		process.platform === 'win32'
			? process.env.PY_PYTHON || 'python'
			: 'python3';

	try {
		const {stdout} = await execFileAsync(pythonExe, ['-c', pythonScript], {
			timeout: 15000,
		});
		if (stdout && stdout.trim()) {
			return stdout.trim();
		}
	} catch (err) {
		logger.debug('CookieUtils', 'Firefox python extraction failed', {
			error: err instanceof Error ? err.message : String(err),
		});
	}
	return null;
}

/**
 * Parse browser cookies from a browser's cookie storage.
 * Uses yt-dlp as the primary method, with a Python SQLite fallback on Windows
 * when yt-dlp fails due to browser file locks.
 *
 * @returns The cookie header string, or null if extraction failed.
 *          On Windows with browser lock issues, returns a special error indicator.
 */
export async function parseBrowserCookies(
	browser: CookiesFromBrowser,
): Promise<string | null> {
	// Supported browsers for yt-dlp
	const supportedBrowsers: CookiesFromBrowser[] = [
		'chrome',
		'firefox',
		'edge',
		'brave',
	];

	if (!supportedBrowsers.includes(browser)) {
		logger.warn(
			'CookieUtils',
			`Browser '${browser}' not supported for cookie extraction`,
		);
		return null;
	}

	// For Firefox, try direct profile database extraction first (avoids needing yt-dlp)
	if (browser === 'firefox') {
		const direct = await extractFirefoxCookiesViaPython();
		if (direct) {
			const result = parseNetscapeCookies(direct);
			if (result) {
				return result;
			}
		}
	}

	// Use yt-dlp to extract cookies from the browser
	const cookieContent = await extractBrowserCookiesViaYtdlp(browser);
	if (cookieContent) {
		const result = parseNetscapeCookies(cookieContent);
		if (result) {
			return result;
		}
	}

	// On Windows, try Python SQLite fallback when yt-dlp fails with the
	// "Could not copy Chrome cookie database" error
	if (process.platform === 'win32') {
		logger.info(
			'CookieUtils',
			`yt-dlp failed for ${browser}, trying Python SQLite fallback...`,
		);
		const fallbackContent = await extractBrowserCookiesViaPython(browser);
		if (fallbackContent) {
			const result = parseNetscapeCookies(fallbackContent);
			if (result) {
				return result;
			}
		}
	}

	logger.warn(
		'CookieUtils',
		`Failed to extract cookies from ${browser}. On Windows, the browser may have a lock on its cookie database. ` +
			`Try closing your browser completely, or use \`ymc login --cookies-file <path-to-cookies.txt>\`.`,
	);
	return null;
}
