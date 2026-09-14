import {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class BuildOnceApi implements ICredentialType {
	name = 'buildOnceApi';
	displayName = 'BuildOnce API';
	icon: Icon = 'file:buildonce.png';
	// eslint-disable-next-line n8n-nodes-base/cred-class-field-documentation-url-miscased -- rule only applies to nodes in n8n's own monorepo; its autofix corrupts a valid URL
	documentationUrl = 'https://buildonce.app/docs';
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			default: '',
			typeOptions: {
				password: true,
			},
			description: 'Workspace API key from BuildOnce (Workspace → Settings → API Keys). Starts with "fl_live_".',
		},
		{
			displayName: 'Domain',
			name: 'domain',
			type: 'string',
			default: 'https://api.buildonce.app',
		},
	];

	// Injected into every request made with this credential — including
	// the generic HTTP Request node — as a Bearer token.
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '={{"Bearer " + $credentials.apiKey}}',
			},
		},
	};

	// Used by n8n's "Test" button in the credential editor. /v1/me is the
	// cheapest authenticated read (no workspace param needed — the key is
	// already bound to one workspace).
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials?.domain}}',
			url: '/v1/me',
		},
	};
}
