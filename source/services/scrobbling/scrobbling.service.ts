// Scrobbling service — supports Last.fm and ListenBrainz
import {createHash} from 'node:crypto';
import {logger} from '../logger/logger.service.ts';
import type {ScrobblingConfig} from '../../types/config.types.ts';

export interface ScrobbleTrackInfo {
	title: string;
	artist: string;
	album?: string;
	duration?: number; // seconds
	timestamp?: number; // unix epoch seconds
}

export interface LastFmSession {
	username: string;
	sessionKey: string;
}

export interface LastFmUserInfo {
	name: string;
	playcount?: number;
	url?: string;
}

export const LASTFM_API_ROOT = 'https://ws.audioscrobbler.com/2.0/';
export const LASTFM_AUTH_URL = 'https://www.last.fm/api/auth/';

/**
 * Builds the 32-character hexadecimal MD5 signature required by Last.fm API.
 * All parameters except 'format', 'callback', and 'api_sig' are sorted alphabetically,
 * concatenated with their values, followed by the shared secret.
 */
export function buildLastfmSignature(
	params: Record<string, string>,
	secret: string,
): string {
	if (!secret) {
		throw new Error('Shared secret is required to sign Last.fm requests');
	}
	const sorted = Object.keys(params)
		.filter(k => k !== 'format' && k !== 'callback' && k !== 'api_sig')
		.sort()
		.map(k => `${k}${params[k]}`)
		.join('');
	return createHash('md5')
		.update(sorted + secret, 'utf8')
		.digest('hex');
}

/**
 * Execute a call to the Last.fm Audioscrobbler 2.0 API.
 */
export async function lastfmCall<T = unknown>(
	method: string,
	params: Record<string, string>,
	secret?: string,
	isPost = true,
): Promise<T> {
	const allParams: Record<string, string> = {
		method,
		...params,
	};
	if (secret) {
		allParams['api_sig'] = buildLastfmSignature(allParams, secret);
	}
	allParams['format'] = 'json';

	let response: Response;
	if (isPost) {
		const body = new URLSearchParams(allParams);
		response = await fetch(LASTFM_API_ROOT, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body,
		});
	} else {
		const query = new URLSearchParams(allParams);
		response = await fetch(`${LASTFM_API_ROOT}?${query.toString()}`, {
			method: 'GET',
		});
	}

	const data = (await response.json().catch(() => null)) as {
		error?: number;
		message?: string;
	} | null;

	if (data && data.error) {
		throw new Error(
			`Last.fm error ${data.error}: ${data.message ?? 'Unknown error'}`,
		);
	}

	if (!response.ok) {
		throw new Error(`Last.fm request failed: HTTP ${response.status}`);
	}

	return data as T;
}

export async function lastfmGetToken(
	apiKey: string,
	secret: string,
): Promise<string> {
	const data = await lastfmCall<{token: string}>(
		'auth.getToken',
		{api_key: apiKey},
		secret,
		false,
	);
	if (!data.token) {
		throw new Error('No token returned from Last.fm');
	}
	return data.token;
}

export function lastfmGetAuthUrl(apiKey: string, token: string): string {
	return `${LASTFM_AUTH_URL}?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`;
}

export async function lastfmGetSession(
	apiKey: string,
	secret: string,
	token: string,
): Promise<LastFmSession> {
	const data = await lastfmCall<{
		session: {name: string; key: string};
	}>('auth.getSession', {api_key: apiKey, token}, secret, true);

	if (!data.session?.key || !data.session?.name) {
		throw new Error('Invalid session response from Last.fm');
	}

	return {
		username: data.session.name,
		sessionKey: data.session.key,
	};
}

export async function lastfmGetUserInfo(
	apiKey: string,
	username: string,
): Promise<LastFmUserInfo> {
	const data = await lastfmCall<{
		user: {name: string; playcount?: string; url?: string};
	}>('user.getInfo', {api_key: apiKey, user: username}, undefined, false);

	return {
		name: data.user.name,
		playcount: data.user.playcount ? Number(data.user.playcount) : undefined,
		url: data.user.url,
	};
}

export async function lastfmUpdateNowPlaying(
	track: ScrobbleTrackInfo,
	apiKey: string,
	sessionKey: string,
	secret: string,
): Promise<void> {
	const params: Record<string, string> = {
		artist: track.artist,
		track: track.title,
		api_key: apiKey,
		sk: sessionKey,
	};
	if (track.album) {
		params['album'] = track.album;
	}
	if (track.duration && track.duration > 0) {
		params['duration'] = String(Math.floor(track.duration));
	}

	await lastfmCall('track.updateNowPlaying', params, secret, true);
	logger.info('ScrobblingService', 'Last.fm now playing updated', {
		title: track.title,
		artist: track.artist,
	});
}

export async function lastfmScrobble(
	track: ScrobbleTrackInfo,
	apiKey: string,
	sessionKey: string,
	secret: string,
): Promise<void> {
	const timestamp = track.timestamp ?? Math.floor(Date.now() / 1000);
	const params: Record<string, string> = {
		artist: track.artist,
		track: track.title,
		timestamp: String(timestamp),
		api_key: apiKey,
		sk: sessionKey,
	};
	if (track.album) {
		params['album'] = track.album;
	}
	if (track.duration && track.duration > 0) {
		params['duration'] = String(Math.floor(track.duration));
	}

	await lastfmCall('track.scrobble', params, secret, true);
	logger.info('ScrobblingService', 'Last.fm scrobble successful', {
		title: track.title,
		artist: track.artist,
	});
}

export async function lastfmLove(
	track: {artist: string; title: string},
	apiKey: string,
	sessionKey: string,
	secret: string,
): Promise<void> {
	const params: Record<string, string> = {
		artist: track.artist,
		track: track.title,
		api_key: apiKey,
		sk: sessionKey,
	};
	await lastfmCall('track.love', params, secret, true);
}

export async function lastfmUnlove(
	track: {artist: string; title: string},
	apiKey: string,
	sessionKey: string,
	secret: string,
): Promise<void> {
	const params: Record<string, string> = {
		artist: track.artist,
		track: track.title,
		api_key: apiKey,
		sk: sessionKey,
	};
	await lastfmCall('track.unlove', params, secret, true);
}

// ---------- ListenBrainz ----------

async function listenbrainzScrobble(
	title: string,
	artist: string,
	listenedAt: number,
	token: string,
): Promise<void> {
	const payload = {
		listen_type: 'single',
		payload: [
			{
				listened_at: listenedAt,
				track_metadata: {
					artist_name: artist,
					track_name: title,
				},
			},
		],
	};

	const response = await fetch(
		'https://api.listenbrainz.org/1/submit-listens',
		{
			method: 'POST',
			headers: {
				Authorization: `Token ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
		},
	);

	if (!response.ok) {
		throw new Error(`ListenBrainz scrobble failed: HTTP ${response.status}`);
	}

	logger.info('ScrobblingService', 'ListenBrainz scrobble successful', {
		title,
		artist,
	});
}

// ---------- Main service ----------

export class ScrobblingService {
	private lastfmApiKey?: string;
	private lastfmApiSecret?: string;
	private lastfmSessionKey?: string;
	private lastfmUsername?: string;
	private lastfmEnabled = false;
	private lastfmScrobbleNowPlaying = true;
	private listenbrainzToken?: string;
	private listenbrainzEnabled = false;

	configure(config: ScrobblingConfig): void {
		this.lastfmApiKey = config.lastfm?.apiKey || process.env['LASTFM_API_KEY'];
		this.lastfmApiSecret =
			config.lastfm?.apiSecret || process.env['LASTFM_API_SECRET'];
		this.lastfmSessionKey = config.lastfm?.sessionKey;
		this.lastfmUsername = config.lastfm?.username;
		this.lastfmEnabled =
			config.lastfm?.enabled ??
			Boolean(
				(this.lastfmApiKey || process.env['LASTFM_API_KEY']) &&
				this.lastfmSessionKey,
			);
		this.lastfmScrobbleNowPlaying = config.lastfm?.scrobbleNowPlaying ?? true;

		this.listenbrainzToken = config.listenbrainz?.token;
		this.listenbrainzEnabled =
			config.listenbrainz?.enabled ?? Boolean(this.listenbrainzToken);
	}

	get isLastFmConfigured(): boolean {
		return Boolean(
			this.lastfmApiKey && this.lastfmApiSecret && this.lastfmSessionKey,
		);
	}

	get isLastFmEnabled(): boolean {
		return Boolean(this.lastfmEnabled && this.isLastFmConfigured);
	}

	get lastFmUsername(): string | undefined {
		return this.lastfmUsername;
	}

	get isListenBrainzEnabled(): boolean {
		return Boolean(this.listenbrainzEnabled && this.listenbrainzToken);
	}

	get isEnabled(): boolean {
		return this.isLastFmEnabled || this.isListenBrainzEnabled;
	}

	async updateNowPlaying(track: ScrobbleTrackInfo): Promise<void> {
		if (!this.isLastFmEnabled || !this.lastfmScrobbleNowPlaying) return;
		if (!this.lastfmApiKey || !this.lastfmSessionKey || !this.lastfmApiSecret) {
			return;
		}

		try {
			await lastfmUpdateNowPlaying(
				track,
				this.lastfmApiKey,
				this.lastfmSessionKey,
				this.lastfmApiSecret,
			);
		} catch (error) {
			logger.warn('ScrobblingService', 'Last.fm updateNowPlaying failed', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async scrobble(track: ScrobbleTrackInfo): Promise<void> {
		if (!this.isEnabled) return;
		if (track.duration && track.duration < 30) {
			logger.debug('ScrobblingService', 'Skipping short track (<30s)', {
				title: track.title,
				duration: track.duration,
			});
			return;
		}

		const timestamp = track.timestamp ?? Math.floor(Date.now() / 1000);
		const tasks: Array<Promise<void>> = [];

		if (
			this.isLastFmEnabled &&
			this.lastfmApiKey &&
			this.lastfmSessionKey &&
			this.lastfmApiSecret
		) {
			tasks.push(
				lastfmScrobble(
					track,
					this.lastfmApiKey,
					this.lastfmSessionKey,
					this.lastfmApiSecret,
				).catch(error => {
					logger.error('ScrobblingService', 'Last.fm scrobble failed', {
						error: error instanceof Error ? error.message : String(error),
					});
				}),
			);
		}

		if (this.isListenBrainzEnabled && this.listenbrainzToken) {
			tasks.push(
				listenbrainzScrobble(
					track.title,
					track.artist,
					timestamp,
					this.listenbrainzToken,
				).catch(error => {
					logger.error('ScrobblingService', 'ListenBrainz scrobble failed', {
						error: error instanceof Error ? error.message : String(error),
					});
				}),
			);
		}

		await Promise.all(tasks);
	}

	async love(track: {artist: string; title: string}): Promise<void> {
		if (
			!this.isLastFmEnabled ||
			!this.lastfmApiKey ||
			!this.lastfmSessionKey ||
			!this.lastfmApiSecret
		) {
			return;
		}
		try {
			await lastfmLove(
				track,
				this.lastfmApiKey,
				this.lastfmSessionKey,
				this.lastfmApiSecret,
			);
			logger.info('ScrobblingService', 'Last.fm track loved', track);
		} catch (error) {
			logger.warn('ScrobblingService', 'Last.fm track love failed', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async unlove(track: {artist: string; title: string}): Promise<void> {
		if (
			!this.isLastFmEnabled ||
			!this.lastfmApiKey ||
			!this.lastfmSessionKey ||
			!this.lastfmApiSecret
		) {
			return;
		}
		try {
			await lastfmUnlove(
				track,
				this.lastfmApiKey,
				this.lastfmSessionKey,
				this.lastfmApiSecret,
			);
			logger.info('ScrobblingService', 'Last.fm track unloved', track);
		} catch (error) {
			logger.warn('ScrobblingService', 'Last.fm track unlove failed', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

let instance: ScrobblingService | null = null;
export const getScrobblingService = (): ScrobblingService => {
	if (!instance) instance = new ScrobblingService();
	return instance;
};
