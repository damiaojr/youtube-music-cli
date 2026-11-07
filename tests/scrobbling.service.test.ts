import {expect, test, afterEach} from 'bun:test';
import {
	buildLastfmSignature,
	lastfmGetAuthUrl,
	lastfmGetToken,
	lastfmGetSession,
	lastfmGetUserInfo,
	lastfmUpdateNowPlaying,
	lastfmScrobble,
	lastfmLove,
	lastfmUnlove,
	ScrobblingService,
} from '../source/services/scrobbling/scrobbling.service.ts';
import {createHash} from 'node:crypto';

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test('buildLastfmSignature computes correct MD5 hex digest with sorted parameters', () => {
	const params = {
		method: 'track.scrobble',
		track: 'Bohemian Rhapsody',
		artist: 'Queen',
		timestamp: '1600000000',
		api_key: 'testkey',
		sk: 'testsession',
		format: 'json', // Should be excluded from signature
		callback: 'cb', // Should be excluded from signature
	};
	const secret = 'mysecret';

	// Alphabetical order: api_key, artist, method, sk, timestamp, track
	const expectedString =
		'api_keytestkey' +
		'artistQueen' +
		'methodtrack.scrobble' +
		'sktestsession' +
		'timestamp1600000000' +
		'trackBohemian Rhapsody' +
		secret;

	const expectedHash = createHash('md5')
		.update(expectedString, 'utf8')
		.digest('hex');

	const sig = buildLastfmSignature(params, secret);
	expect(sig).toBe(expectedHash);
});

test('buildLastfmSignature throws if secret is empty', () => {
	expect(() => buildLastfmSignature({track: 'Test'}, '')).toThrow(
		'Shared secret is required to sign Last.fm requests',
	);
});

test('lastfmGetAuthUrl formats URL correctly', () => {
	const url = lastfmGetAuthUrl('my-api-key', 'token123');
	expect(url).toBe(
		'https://www.last.fm/api/auth/?api_key=my-api-key&token=token123',
	);
});

test('lastfmGetToken calls auth.getToken and returns token', async () => {
	let requestedUrl = '';
	globalThis.fetch = (async (input: unknown) => {
		requestedUrl = String(input);
		return new Response(JSON.stringify({token: 'req-token-xyz'}), {
			status: 200,
			headers: {'Content-Type': 'application/json'},
		});
	}) as unknown as typeof fetch;

	const token = await lastfmGetToken('key123', 'sec456');
	expect(token).toBe('req-token-xyz');
	expect(requestedUrl).toContain('method=auth.getToken');
	expect(requestedUrl).toContain('api_key=key123');
	expect(requestedUrl).toContain('api_sig=');
});

test('lastfmGetSession calls auth.getSession and returns session info', async () => {
	let postedBody: string | null = null;
	globalThis.fetch = (async (_input: unknown, init?: {body?: unknown}) => {
		postedBody = String(init?.body);
		return new Response(
			JSON.stringify({
				session: {
					name: 'lastfmuser',
					key: 'sesskey999',
					subscriber: 0,
				},
			}),
			{
				status: 200,
				headers: {'Content-Type': 'application/json'},
			},
		);
	}) as unknown as typeof fetch;

	const session = await lastfmGetSession('key123', 'sec456', 'token789');
	expect(session.username).toBe('lastfmuser');
	expect(session.sessionKey).toBe('sesskey999');

	const parsed = new URLSearchParams(postedBody!);
	expect(parsed.get('method')).toBe('auth.getSession');
	expect(parsed.get('token')).toBe('token789');
	expect(parsed.get('api_key')).toBe('key123');
	expect(parsed.get('api_sig')).toBeTruthy();
});

test('lastfmGetUserInfo fetches user profile info', async () => {
	globalThis.fetch = (async () => {
		return new Response(
			JSON.stringify({
				user: {
					name: 'musiclover',
					playcount: '42500',
					url: 'https://www.last.fm/user/musiclover',
				},
			}),
			{
				status: 200,
				headers: {'Content-Type': 'application/json'},
			},
		);
	}) as unknown as typeof fetch;

	const info = await lastfmGetUserInfo('key123', 'musiclover');
	expect(info.name).toBe('musiclover');
	expect(info.playcount).toBe(42500);
	expect(info.url).toBe('https://www.last.fm/user/musiclover');
});

test('lastfmUpdateNowPlaying posts track.updateNowPlaying with duration and album', async () => {
	let postedBody: string | null = null;
	globalThis.fetch = (async (_input: unknown, init?: {body?: unknown}) => {
		postedBody = String(init?.body);
		return new Response(JSON.stringify({nowplaying: {status: 'ok'}}), {
			status: 200,
			headers: {'Content-Type': 'application/json'},
		});
	}) as unknown as typeof fetch;

	await lastfmUpdateNowPlaying(
		{
			title: 'Karma Police',
			artist: 'Radiohead',
			album: 'OK Computer',
			duration: 261.5,
		},
		'key123',
		'sesskey999',
		'sec456',
	);

	const parsed = new URLSearchParams(postedBody!);
	expect(parsed.get('method')).toBe('track.updateNowPlaying');
	expect(parsed.get('artist')).toBe('Radiohead');
	expect(parsed.get('track')).toBe('Karma Police');
	expect(parsed.get('album')).toBe('OK Computer');
	expect(parsed.get('duration')).toBe('261');
	expect(parsed.get('sk')).toBe('sesskey999');
	expect(parsed.get('api_sig')).toBeTruthy();
});

test('lastfmScrobble posts track.scrobble with timestamp', async () => {
	let postedBody: string | null = null;
	globalThis.fetch = (async (_input: unknown, init?: {body?: unknown}) => {
		postedBody = String(init?.body);
		return new Response(JSON.stringify({scrobbles: {'@attr': {accepted: 1}}}), {
			status: 200,
			headers: {'Content-Type': 'application/json'},
		});
	}) as unknown as typeof fetch;

	await lastfmScrobble(
		{
			title: 'No Surprises',
			artist: 'Radiohead',
			album: 'OK Computer',
			duration: 228,
			timestamp: 1600000000,
		},
		'key123',
		'sesskey999',
		'sec456',
	);

	const parsed = new URLSearchParams(postedBody!);
	expect(parsed.get('method')).toBe('track.scrobble');
	expect(parsed.get('artist')).toBe('Radiohead');
	expect(parsed.get('track')).toBe('No Surprises');
	expect(parsed.get('timestamp')).toBe('1600000000');
	expect(parsed.get('album')).toBe('OK Computer');
	expect(parsed.get('duration')).toBe('228');
	expect(parsed.get('api_sig')).toBeTruthy();
});

test('lastfmLove and lastfmUnlove post correct methods', async () => {
	const methodsCalled: string[] = [];
	globalThis.fetch = (async (_input: unknown, init?: {body?: unknown}) => {
		const parsed = new URLSearchParams(String(init?.body));
		methodsCalled.push(parsed.get('method') ?? '');
		return new Response(JSON.stringify({status: 'ok'}), {
			status: 200,
			headers: {'Content-Type': 'application/json'},
		});
	}) as unknown as typeof fetch;

	await lastfmLove(
		{title: 'Paranoid Android', artist: 'Radiohead'},
		'key123',
		'sesskey999',
		'sec456',
	);
	await lastfmUnlove(
		{title: 'Paranoid Android', artist: 'Radiohead'},
		'key123',
		'sesskey999',
		'sec456',
	);

	expect(methodsCalled).toEqual(['track.love', 'track.unlove']);
});

test('ScrobblingService handles configuration, short-track filtering, and scrobble dispatch', async () => {
	const service = new ScrobblingService();
	expect(service.isLastFmConfigured).toBe(false);
	expect(service.isLastFmEnabled).toBe(false);

	service.configure({
		lastfm: {
			apiKey: 'k1',
			apiSecret: 's1',
			sessionKey: 'sk1',
			username: 'tester',
			enabled: true,
		},
	});

	expect(service.isLastFmConfigured).toBe(true);
	expect(service.isLastFmEnabled).toBe(true);
	expect(service.lastFmUsername).toBe('tester');

	const calls: string[] = [];
	globalThis.fetch = (async (_input: unknown, init?: {body?: unknown}) => {
		const parsed = new URLSearchParams(String(init?.body));
		calls.push(parsed.get('method') ?? '');
		return new Response(JSON.stringify({status: 'ok'}), {
			status: 200,
			headers: {'Content-Type': 'application/json'},
		});
	}) as unknown as typeof fetch;

	// Short track (< 30 seconds) should be ignored
	await service.scrobble({
		title: 'Short Intro',
		artist: 'Artist',
		duration: 15,
	});
	expect(calls.length).toBe(0);

	// Valid track should scrobble
	await service.scrobble({
		title: 'Full Track',
		artist: 'Artist',
		duration: 180,
	});
	expect(calls).toEqual(['track.scrobble']);

	// Now playing call
	await service.updateNowPlaying({
		title: 'Full Track',
		artist: 'Artist',
		duration: 180,
	});
	expect(calls).toEqual(['track.scrobble', 'track.updateNowPlaying']);
});
