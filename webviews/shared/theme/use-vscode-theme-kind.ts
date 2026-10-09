import { useEffect, useState } from 'react';

export type VsCodeThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

function readThemeKind(): VsCodeThemeKind {
	const classList = document.body.classList;

	if (classList.contains('vscode-high-contrast-light')) {
		return 'high-contrast-light';
	}
	if (classList.contains('vscode-high-contrast')) {
		return 'high-contrast';
	}
	if (classList.contains('vscode-light')) {
		return 'light';
	}
	return 'dark';
}

export function useVsCodeThemeKind(): VsCodeThemeKind {
	const [themeKind, setThemeKind] = useState(readThemeKind);

	useEffect(() => {
		const observer = new MutationObserver(() => {
			setThemeKind(readThemeKind());
		});

		observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

		return () => observer.disconnect();
	}, []);

	return themeKind;
}
