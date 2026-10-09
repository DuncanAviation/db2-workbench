import eslint from '@eslint/js';
import essecurity from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';
import typescriptEslint from 'typescript-eslint';
import checkFile from 'eslint-plugin-check-file';
import reactHooks from 'eslint-plugin-react-hooks';

const FILE_NAME_GLOB = '+([a-z_])*([a-z0-9.])*(-+([a-z0-9.]))';

const sharedRules = {
	'@stylistic/brace-style': [
		'error',
		'1tbs'
	],
	'@stylistic/indent': ['error', 'tab'],
	'@stylistic/member-delimiter-style': 'error',
	'@stylistic/no-multi-spaces': 'off',
	'@stylistic/no-trailing-spaces': [
		'error',
		{
			ignoreComments: true,
			skipBlankLines: true
		}
	],
	'@stylistic/quotes': [
		'error',
		'single',
		{
			'allowTemplateLiterals': 'always'
		}
	],
	'@stylistic/space-before-blocks': 'error',
	'@stylistic/space-infix-ops': 'error',
	'@stylistic/space-unary-ops': 'error',
	'@stylistic/type-annotation-spacing': 'error',
	'@typescript-eslint/consistent-type-definitions': 'error',
	'@typescript-eslint/no-empty-object-type': 'off',
	'@typescript-eslint/no-explicit-any': 'off',
	'@typescript-eslint/no-floating-promises': 'error',
	'@typescript-eslint/no-inferrable-types': 'off',
	'@typescript-eslint/no-namespace': 'off',
	'@typescript-eslint/no-non-null-assertion': 'error',
	'@typescript-eslint/no-shadow': [
		'error',
		{
			'hoist': 'all'
		}
	],
	'@typescript-eslint/no-unused-expressions': 'off',
	'@typescript-eslint/no-unused-vars': [
		'warn',
		{
			'argsIgnorePattern': '^_',
			'varsIgnorePattern': '^_',
			'caughtErrorsIgnorePattern': '^_'
		}
	],
	'@typescript-eslint/prefer-function-type': 'error',
	'@typescript-eslint/unified-signatures': 'error',
	'check-file/filename-naming-convention': [
		'error',
		{
			'**/*.{jsx,tsx}': FILE_NAME_GLOB,
			'**/*.{js,ts}': FILE_NAME_GLOB,
		},
	],
	'check-file/folder-naming-convention': [
		'error',
		{
			'src/*': 'KEBAB_CASE',
			'webviews/*': 'KEBAB_CASE'
		},
	],
	'curly': 'error',
	'eqeqeq': [
		'error',
		'smart'
	],
	'new-parens': 'error',
	'no-caller': 'error',
	'no-empty': 'off',
	'no-eval': 'error',
	'no-restricted-imports': 'error',
	'no-shadow': 'off', //Turned off because it's overriden by @typescript-eslint
	'no-throw-literal': 'error',
	'no-undef-init': 'error',
	'no-unused-labels': 'error',
	'no-useless-escape': 'off',
	'prefer-const': 'off',
	'radix': 'error',
	'security/detect-child-process': 'off',
	'security/detect-non-literal-fs-filename': 'off',
	'security/detect-non-literal-regexp': 'off',
	'security/detect-object-injection': 'off',
	'semi': 'error',
	'semi-spacing': 'error',
};

export default [{
	files: ['src/**/*.ts'],
	plugins: {
		'@typescript-eslint': typescriptEslint.plugin,
		'@stylistic': stylistic,
		'check-file': checkFile,
	},
	languageOptions: {
		parser: typescriptEslint.parser,
		parserOptions: {
			project: './tsconfig.json',
			tsconfigRootDir: import.meta.dirname,
		},
		ecmaVersion: 2022,
		sourceType: 'module',
	},
	rules: sharedRules,
}, {
	files: ['webviews/**/*.{ts,tsx}'],
	plugins: {
		'@typescript-eslint': typescriptEslint.plugin,
		'@stylistic': stylistic,
		'check-file': checkFile,
		'react-hooks': reactHooks,
	},
	languageOptions: {
		parser: typescriptEslint.parser,
		parserOptions: {
			project: './webviews/tsconfig.json',
			tsconfigRootDir: import.meta.dirname,
			ecmaFeatures: { jsx: true },
		},
		ecmaVersion: 2022,
		sourceType: 'module',
	},
	rules: {
		...sharedRules,
		'react-hooks/rules-of-hooks': 'error',
		'react-hooks/exhaustive-deps': 'warn',
	},
}];
