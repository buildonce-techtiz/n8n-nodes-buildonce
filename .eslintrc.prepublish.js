module.exports = {
	extends: './.eslintrc.js',
	overrides: [
		{
			files: ['package.json'],
			parserOptions: {
				project: null,
			},
			plugins: ['eslint-plugin-n8n-nodes-base'],
			rules: {
				'n8n-nodes-base/community-package-json-name-still-default': 'error',
			},
		},
	],
};
