// YouTube Music account login/logout view
import {Box, Text} from 'ink';
import {useTheme} from '../../hooks/useTheme.ts';
import {useNavigation} from '../../hooks/useNavigation.ts';
import {useKeyBinding} from '../../hooks/useKeyboard.ts';
import {resolveKeybinding} from '../../utils/keybinding-resolver.ts';
import {useState, useCallback, useEffect, useRef} from 'react';
import {
	COOKIE_LOGIN_HINT,
	getAuthService,
	OAUTH_UNSUPPORTED_MESSAGE,
} from '../../services/auth/auth.service.ts';

type LoginState = 'idle' | 'pending' | 'authenticating' | 'success' | 'error';

export default function LoginView() {
	const {theme} = useTheme();
	const {dispatch} = useNavigation();
	const authService = getAuthService();
	const [status, setStatus] = useState(() => authService.getStatus());

	const [loginState, setLoginState] = useState<LoginState>('idle');
	const [progress, setProgress] = useState('Select an authentication method');
	const [deviceCode, setDeviceCode] = useState<{
		verificationUrl: string;
		userCode: string;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showCookieFallback, setShowCookieFallback] = useState(false);
	const loginInitiated = useRef(false);

	useKeyBinding(resolveKeybinding('BACK'), () => {
		dispatch({category: 'GO_BACK'});
	});

	const handleSignOut = useCallback(async () => {
		await authService.signOut();
		setStatus(authService.getStatus());
		setLoginState('idle');
		setError(null);
		setDeviceCode(null);
		loginInitiated.current = false;
	}, [authService]);

	const handleImportFirefox = useCallback(async () => {
		setLoginState('pending');
		setProgress('Importing YouTube cookies from Firefox...');
		setError(null);
		setShowCookieFallback(false);
		const result = await authService.signInFromBrowser('firefox');
		if (result.success) {
			setStatus(authService.getStatus());
			setLoginState('success');
		} else {
			setLoginState('error');
			setError(result.error ?? 'Failed to extract Firefox cookies');
			setShowCookieFallback(true);
		}
	}, [authService]);

	const handleImportChrome = useCallback(async () => {
		setLoginState('pending');
		setProgress('Importing YouTube cookies from Chrome...');
		setError(null);
		setShowCookieFallback(false);
		const result = await authService.signInFromBrowser('chrome');
		if (result.success) {
			setStatus(authService.getStatus());
			setLoginState('success');
		} else {
			setLoginState('error');
			setError(result.error ?? 'Failed to extract Chrome cookies');
			setShowCookieFallback(true);
		}
	}, [authService]);

	const handleDeviceCodeLogin = useCallback(async () => {
		setLoginState('pending');
		setProgress('Starting YouTube client...');
		setError(null);
		setShowCookieFallback(false);
		setDeviceCode(null);

		const result = await authService.signIn({
			onProgress: message => {
				setProgress(message);
			},
			onDeviceCode: info => {
				setDeviceCode(info);
				setLoginState('authenticating');
			},
		});

		if (result.success) {
			setStatus(authService.getStatus());
			setLoginState('success');
			return;
		}

		setLoginState('error');
		setError(result.error ?? 'Login failed');
		setShowCookieFallback(true);
	}, [authService]);

	// Shortcuts
	useKeyBinding(['x', 'X'], () => {
		if (status.loggedIn) {
			void handleSignOut();
		}
	});

	useKeyBinding(['f', 'F'], () => {
		if (loginState !== 'pending' && loginState !== 'authenticating') {
			void handleImportFirefox();
		}
	});

	useKeyBinding(['c', 'C'], () => {
		if (loginState !== 'pending' && loginState !== 'authenticating') {
			void handleImportChrome();
		}
	});

	useKeyBinding(['d', 'D'], () => {
		if (
			!status.loggedIn &&
			loginState !== 'pending' &&
			loginState !== 'authenticating'
		) {
			void handleDeviceCodeLogin();
		}
	});

	useKeyBinding(['r', 'R'], () => {
		if (loginState === 'error' || showCookieFallback) {
			setLoginState('idle');
			setError(null);
			setShowCookieFallback(false);
			void handleImportFirefox();
		}
	});

	// If not logged in, attempt automatic Firefox cookie import once
	useEffect(() => {
		if (status.loggedIn || loginInitiated.current) {
			return;
		}

		loginInitiated.current = true;
		queueMicrotask(() => {
			void handleImportFirefox();
		});
	}, [handleImportFirefox, status.loggedIn]);

	return (
		<Box flexDirection="column" paddingX={1} paddingY={1}>
			<Box marginBottom={1}>
				<Text color={theme.colors.primary} bold>
					Account
				</Text>
			</Box>

			{status.loggedIn ? (
				<Box flexDirection="column" gap={1}>
					<Box>
						<Text color={theme.colors.text}>
							Signed in as:{' '}
							<Text bold color={theme.colors.primary}>
								{status.accountName ?? 'YouTube account'}
							</Text>
						</Text>
					</Box>
					{status.method === 'cookie' ? (
						<Box flexDirection="column">
							<Text color="green">
								✓ Using cookie-based authentication (Library & Liked Music
								active)
							</Text>
						</Box>
					) : (
						<Box flexDirection="column" gap={1}>
							{OAUTH_UNSUPPORTED_MESSAGE.split('\n').map(line => (
								<Text key={line} color="yellow">
									{line}
								</Text>
							))}
							<Box marginTop={1}>
								<Text color={theme.colors.accent} bold>
									Press F to switch to Firefox cookies
								</Text>
							</Box>
						</Box>
					)}
					<Box marginTop={1}>
						<Text color={theme.colors.dim}>
							Press{' '}
							<Text bold color="red">
								X
							</Text>{' '}
							to sign out, or Esc to go back
						</Text>
					</Box>
				</Box>
			) : loginState === 'authenticating' && deviceCode ? (
				<Box flexDirection="column" gap={1}>
					<Box>
						<Text color={theme.colors.text}>
							Open{' '}
							<Text bold color={theme.colors.primary}>
								{deviceCode.verificationUrl}
							</Text>{' '}
							in your browser
						</Text>
					</Box>
					<Box>
						<Text color={theme.colors.text}>Enter this code:</Text>
					</Box>
					<Box
						justifyContent="center"
						borderStyle="round"
						borderColor={theme.colors.primary}
						paddingX={2}
						paddingY={1}
					>
						<Text color={theme.colors.primary} bold>
							{deviceCode.userCode}
						</Text>
					</Box>
					<Box marginTop={1}>
						<Text color={theme.colors.dim}>Waiting for authorization...</Text>
					</Box>
				</Box>
			) : loginState === 'success' ? (
				<Box flexDirection="column" gap={1}>
					<Box>
						<Text color="green" bold>
							✓ Successfully signed in with cookies!
						</Text>
					</Box>
					<Box>
						<Text color={theme.colors.dim}>Press Esc to continue</Text>
					</Box>
				</Box>
			) : loginState === 'error' ? (
				<Box flexDirection="column" gap={1}>
					<Box>
						<Text color="red" bold>
							✗ Sign-in failed
						</Text>
					</Box>
					{error && (
						<Box>
							<Text color={theme.colors.dim}>{error}</Text>
						</Box>
					)}
					{showCookieFallback && (
						<Box flexDirection="column" gap={1} marginTop={1}>
							{COOKIE_LOGIN_HINT.split('\n').map(line => (
								<Box key={line}>
									<Text color={theme.colors.text}>{line}</Text>
								</Box>
							))}
						</Box>
					)}
					<Box marginTop={1}>
						<Text color={theme.colors.dim}>
							Press{' '}
							<Text bold color={theme.colors.primary}>
								F
							</Text>{' '}
							for Firefox,{' '}
							<Text bold color={theme.colors.primary}>
								C
							</Text>{' '}
							for Chrome,{' '}
							<Text bold color={theme.colors.primary}>
								D
							</Text>{' '}
							for TV Device Code, Esc to go back
						</Text>
					</Box>
				</Box>
			) : (
				<Box flexDirection="column" gap={1}>
					<Text color={theme.colors.dim}>{progress}</Text>
					<Box marginTop={1}>
						<Text color={theme.colors.dim}>
							Press{' '}
							<Text bold color={theme.colors.primary}>
								F
							</Text>{' '}
							to import from Firefox,{' '}
							<Text bold color={theme.colors.primary}>
								C
							</Text>{' '}
							for Chrome,{' '}
							<Text bold color={theme.colors.primary}>
								D
							</Text>{' '}
							for TV Code
						</Text>
					</Box>
				</Box>
			)}

			<Box marginTop={1}>
				<Text color={theme.colors.dim}>Esc to go back</Text>
			</Box>
		</Box>
	);
}
