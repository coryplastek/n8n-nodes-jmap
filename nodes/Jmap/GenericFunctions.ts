import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	IPollFunctions,
	IDataObject,
	JsonObject,
	IHttpRequestMethods,
	IHttpRequestOptions,
	INodeExecutionData,
	IBinaryData,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export interface IJmapSession {
	accounts: { [key: string]: IJmapAccount };
	primaryAccounts: { [key: string]: string };
	username: string;
	apiUrl: string;
	downloadUrl: string;
	uploadUrl: string;
	eventSourceUrl: string;
	state: string;
	capabilities: { [key: string]: IDataObject };
}

export interface IJmapAccount {
	name: string;
	isPersonal: boolean;
	isReadOnly: boolean;
	accountCapabilities: { [key: string]: IDataObject };
}

export interface IJmapRequest {
	using: string[];
	methodCalls: [string, IDataObject, string][];
}

export interface IJmapResponse {
	methodResponses: [string, IDataObject, string][];
	sessionState: string;
}

// Standard JMAP capabilities
export const JMAP_CAPABILITIES = {
	CORE: 'urn:ietf:params:jmap:core',
	MAIL: 'urn:ietf:params:jmap:mail',
	SUBMISSION: 'urn:ietf:params:jmap:submission',
	VACATION_RESPONSE: 'urn:ietf:params:jmap:vacationresponse',
	JAMES_SHARES: 'urn:apache:james:params:jmap:mail:shares',
	JAMES_QUOTA: 'urn:apache:james:params:jmap:mail:quota',
};

/**
 * Cache for JMAP session to avoid repeated discovery calls.
 * Cache is keyed by server URL + auth type to handle multiple credentials.
 * Cache is cleared at the start of each n8n execution/poll cycle.
 */
let sessionCache: Map<string, IJmapSession> = new Map();

/**
 * Clear the session cache.
 * Should be called at the start of each execution or poll cycle.
 */
export function clearSessionCache(): void {
	sessionCache.clear();
}

/**
 * Generate a cache key for the session based on server URL and auth type.
 */
function getSessionCacheKey(serverUrl: string, authType: string): string {
	return `${serverUrl}::${authType}`;
}

/**
 * Get the authentication type from node parameters
 */
function getAuthType(context: IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions): string {
	try {
		return context.getNodeParameter('authentication', 0) as string;
	} catch {
		return 'jmapOAuth2Api'; // Default to OAuth2
	}
}

/**
 * Get JMAP server URL based on credential type
 */
async function getServerUrl(
	context: IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions,
): Promise<string> {
	const authType = getAuthType(context);

	if (authType === 'jmapOAuth2Api') {
		const credentials = await context.getCredentials('jmapOAuth2Api');
		return (credentials.jmapServerUrl as string).replace(/\/$/, '');
	} else {
		const credentials = await context.getCredentials('jmapApi');
		return (credentials.serverUrl as string).replace(/\/$/, '');
	}
}

/**
 * Make an authenticated HTTP request to any URL.
 * This is the low-level function that handles auth headers.
 *
 * @param context - The n8n execution context
 * @param method - HTTP method (GET, POST, etc.)
 * @param url - Full URL to request
 * @param body - Optional request body
 */
async function makeAuthenticatedRequest(
	context: IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions,
	method: IHttpRequestMethods,
	url: string,
	body?: IDataObject,
): Promise<IDataObject> {
	const authType = getAuthType(context);

	const baseOptions: IHttpRequestOptions = {
		method,
		url,
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body,
		json: true,
		returnFullResponse: false,
	};

	if (authType === 'jmapOAuth2Api') {
		const response = await context.helpers.httpRequestWithAuthentication.call(
			context,
			'jmapOAuth2Api',
			baseOptions,
		);
		return response as IDataObject;
	} else {
		// Handle Basic Auth or Bearer Token
		const credentials = await context.getCredentials('jmapApi');
		const authMethod = (credentials.authMethod as string) || 'basicAuth';

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		};

		if (authMethod === 'basicAuth') {
			const authString = Buffer.from(
				`${credentials.email as string}:${credentials.password as string}`,
			).toString('base64');
			headers.Authorization = `Basic ${authString}`;
		} else if (authMethod === 'bearerToken') {
			headers.Authorization = `Bearer ${credentials.accessToken as string}`;
		}

		const options: IHttpRequestOptions = {
			...baseOptions,
			headers,
		};

		const response = await context.helpers.httpRequest(options);
		return response as IDataObject;
	}
}

/**
 * Get JMAP session from the server using proper RFC 8620 discovery.
 *
 * Discovery flow:
 * 1. Check cache for existing session
 * 2. Try /.well-known/jmap (follows redirects per RFC)
 * 3. Fallback to /jmap/session (Fastmail pattern)
 * 4. Fallback to /session (original pattern)
 * 5. Cache successful session for subsequent calls
 *
 * @returns The JMAP session object containing apiUrl, accounts, etc.
 * @throws NodeApiError if session discovery fails
 */
export async function getJmapSession(
	this: IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions,
): Promise<IJmapSession> {
	const authType = getAuthType(this);
	const serverUrl = await getServerUrl(this);
	const cacheKey = getSessionCacheKey(serverUrl, authType);

	// Return cached session if available
	const cached = sessionCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	// Normalize base URL (remove trailing slash)
	const baseUrl = serverUrl.replace(/\/$/, '');

	// URLs to try for session discovery, in order of preference
	const sessionUrls = [
		`${baseUrl}/.well-known/jmap`, // RFC 8620 standard
		`${baseUrl}/jmap/session`, // Fastmail pattern
		`${baseUrl}/session`, // Simple pattern
	];

	let lastError: Error | null = null;

	for (const sessionUrl of sessionUrls) {
		try {
			const response = await makeAuthenticatedRequest(this, 'GET', sessionUrl, undefined);

			// Validate it's a proper JMAP session response
			const session = response as unknown as IJmapSession;

			if (session.apiUrl && session.accounts) {
				// Valid session - cache and return
				sessionCache.set(cacheKey, session);
				return session;
			}

			// Response didn't look like a valid session, try next URL
			lastError = new Error(
				`Invalid session response from ${sessionUrl}: missing apiUrl or accounts`,
			);
		} catch (error) {
			lastError = error as Error;
			// Continue to next URL
		}
	}

	// All URLs failed
	const errorMessage = lastError ? lastError.message : 'Unknown error';
	throw new NodeApiError(this.getNode(), { message: errorMessage } as JsonObject, {
		message:
			`Failed to discover JMAP session. Tried: ${sessionUrls.join(', ')}. ` +
			`Please ensure your JMAP Server URL points to a JMAP-compliant server. ` +
			`For Fastmail, use: https://api.fastmail.com`,
	});
}

/**
 * Make a JMAP API request using the apiUrl from the session.
 *
 * This is the main function for making JMAP method calls (Email/get, Mailbox/query, etc.)
 * It automatically discovers the correct API endpoint via getJmapSession().
 *
 * @param methodCalls - Array of JMAP method calls
 * @param using - Array of capability URNs to use
 * @returns The JMAP response with methodResponses
 */
export async function jmapApiRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions,
	methodCalls: [string, IDataObject, string][],
	using: string[] = [JMAP_CAPABILITIES.CORE, JMAP_CAPABILITIES.MAIL],
): Promise<IJmapResponse> {
	// Get session to obtain the correct apiUrl
	const session = await getJmapSession.call(this);

	const body: IJmapRequest = {
		using,
		methodCalls,
	};

	try {
		// POST to the session's apiUrl, NOT to the configured serverUrl
		const response = await makeAuthenticatedRequest(
			this,
			'POST',
			session.apiUrl, // <-- This is the key fix!
			body as unknown as IDataObject,
		);
		return response as unknown as IJmapResponse;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject, {
			message: `JMAP API request failed. API URL: ${session.apiUrl}`,
		});
	}
}

/**
 * @deprecated Use makeAuthenticatedRequest() or jmapApiRequest() instead.
 * This function is kept for backwards compatibility but should not be used in new code.
 * It builds URLs from serverUrl instead of using session.apiUrl.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _makeJmapRequest(
	context: IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body?: IDataObject,
): Promise<IDataObject> {
	const authType = getAuthType(context);
	const serverUrl = await getServerUrl(context);
	const url = endpoint.startsWith('http') ? endpoint : `${serverUrl}${endpoint}`;

	if (authType === 'jmapOAuth2Api') {
		// Use n8n's built-in OAuth2 authentication
		const response = await context.helpers.httpRequestWithAuthentication.call(
			context,
			'jmapOAuth2Api',
			{
				method,
				url,
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				body,
				json: true,
			} as IHttpRequestOptions,
		);
		return response as IDataObject;
	} else {
		// Use Basic Auth or Bearer Token
		const credentials = await context.getCredentials('jmapApi');
		const authMethod = (credentials.authMethod as string) || 'basicAuth';

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		};

		if (authMethod === 'basicAuth') {
			const authString = Buffer.from(
				`${credentials.email as string}:${credentials.password as string}`,
			).toString('base64');
			headers.Authorization = `Basic ${authString}`;
		} else if (authMethod === 'bearerToken') {
			headers.Authorization = `Bearer ${credentials.accessToken as string}`;
		}

		const options: IHttpRequestOptions = {
			method,
			url,
			headers,
			body,
			json: true,
		};

		const response = await context.helpers.httpRequest(options);
		return response as IDataObject;
	}
}

/**
 * Get the primary account ID for mail
 */
export async function getPrimaryAccountId(
	this: IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions,
): Promise<string> {
	const session = await getJmapSession.call(this);
	const mailCapability = JMAP_CAPABILITIES.MAIL;

	if (session.primaryAccounts && session.primaryAccounts[mailCapability]) {
		return session.primaryAccounts[mailCapability];
	}

	const accountIds = Object.keys(session.accounts);
	if (accountIds.length > 0) {
		return accountIds[0];
	}

	throw new Error('No JMAP account found');
}

/**
 * Get all mailboxes for an account
 */
export async function getMailboxes(
	this: IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions,
	accountId: string,
): Promise<IDataObject[]> {
	const response = await jmapApiRequest.call(this, [['Mailbox/get', { accountId }, 'c1']]);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Mailbox/get') {
		return (methodResponse[1] as IDataObject).list as IDataObject[];
	}

	throw new Error('Failed to get mailboxes');
}

/**
 * Find a mailbox by name
 */
export async function findMailboxByName(
	this: IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions,
	accountId: string,
	name: string,
): Promise<IDataObject | undefined> {
	const mailboxes = await getMailboxes.call(this, accountId);
	return mailboxes.find((mb) => mb.name === name);
}

/**
 * Find a mailbox by role
 */
export async function findMailboxByRole(
	this: IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions,
	accountId: string,
	role: string,
): Promise<IDataObject | undefined> {
	const mailboxes = await getMailboxes.call(this, accountId);
	return mailboxes.find((mb) => mb.role === role);
}

/**
 * Query emails with filters
 */
export async function queryEmails(
	this: IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions,
	accountId: string,
	filter: IDataObject = {},
	sort: IDataObject[] = [{ property: 'receivedAt', isAscending: false }],
	limit: number = 50,
	position: number = 0,
): Promise<{ ids: string[]; total: number }> {
	const response = await jmapApiRequest.call(this, [
		['Email/query', { accountId, filter, sort, limit, position }, 'c1'],
	]);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Email/query') {
		const result = methodResponse[1] as IDataObject;
		return {
			ids: result.ids as string[],
			total: result.total as number,
		};
	}

	throw new Error('Failed to query emails');
}

/**
 * Get emails by IDs
 */
export async function getEmails(
	this: IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions,
	accountId: string,
	ids: string[],
	properties: string[] = [
		'id',
		'blobId',
		'threadId',
		'mailboxIds',
		'keywords',
		'size',
		'receivedAt',
		'from',
		'to',
		'cc',
		'bcc',
		'replyTo',
		'subject',
		'sentAt',
		'hasAttachment',
		'preview',
		'bodyStructure',
		'bodyValues',
		'textBody',
		'htmlBody',
		'attachments',
	],
	fetchTextBodyValues: boolean = true,
	fetchHTMLBodyValues: boolean = true,
): Promise<IDataObject[]> {
	const response = await jmapApiRequest.call(this, [
		[
			'Email/get',
			{
				accountId,
				ids,
				properties,
				fetchTextBodyValues,
				fetchHTMLBodyValues,
				maxBodyValueBytes: 1048576,
			},
			'c1',
		],
	]);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Email/get') {
		return (methodResponse[1] as IDataObject).list as IDataObject[];
	}

	throw new Error('Failed to get emails');
}

/**
 * Create and send an email
 */
export async function sendEmail(
	this: IExecuteFunctions,
	accountId: string,
	email: IDataObject,
	identityId: string,
): Promise<IDataObject> {
	const draftsMailbox = await findMailboxByRole.call(this, accountId, 'drafts');
	if (!draftsMailbox) {
		throw new Error('Drafts mailbox not found');
	}

	const emailCreate = {
		...email,
		mailboxIds: { [draftsMailbox.id as string]: true },
		keywords: { $draft: true },
	};

	const response = await jmapApiRequest.call(
		this,
		[
			['Email/set', { accountId, create: { draft: emailCreate } }, 'c1'],
			[
				'EmailSubmission/set',
				{
					accountId,
					create: { send: { emailId: '#draft', identityId } },
					onSuccessDestroyEmail: ['#send'],
				},
				'c2',
			],
		],
		[JMAP_CAPABILITIES.CORE, JMAP_CAPABILITIES.MAIL, JMAP_CAPABILITIES.SUBMISSION],
	);

	for (const methodResponse of response.methodResponses) {
		if (methodResponse[0] === 'error') {
			throw new Error(`JMAP error: ${JSON.stringify(methodResponse[1])}`);
		}
	}

	return response.methodResponses[1][1] as IDataObject;
}

/**
 * Create a draft email
 */
export async function createDraft(
	this: IExecuteFunctions,
	accountId: string,
	email: IDataObject,
): Promise<IDataObject> {
	const draftsMailbox = await findMailboxByRole.call(this, accountId, 'drafts');
	if (!draftsMailbox) {
		throw new Error('Drafts mailbox not found');
	}

	const emailCreate = {
		...email,
		mailboxIds: { [draftsMailbox.id as string]: true },
		keywords: { $draft: true },
	};

	const response = await jmapApiRequest.call(this, [
		['Email/set', { accountId, create: { draft: emailCreate } }, 'c1'],
	]);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'error') {
		throw new Error(`JMAP error: ${JSON.stringify(methodResponse[1])}`);
	}

	if (methodResponse[0] === 'Email/set') {
		const result = methodResponse[1] as IDataObject;
		const created = result.created as IDataObject;
		if (created && created.draft) {
			return created.draft as IDataObject;
		}
	}

	return methodResponse[1] as IDataObject;
}

/**
 * Get identities
 */
export async function getIdentities(
	this: IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions,
	accountId: string,
): Promise<IDataObject[]> {
	const response = await jmapApiRequest.call(
		this,
		[['Identity/get', { accountId }, 'c1']],
		[JMAP_CAPABILITIES.CORE, JMAP_CAPABILITIES.SUBMISSION],
	);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Identity/get') {
		return (methodResponse[1] as IDataObject).list as IDataObject[];
	}

	throw new Error('Failed to get identities');
}

/**
 * Update email keywords
 */
export async function updateEmailKeywords(
	this: IExecuteFunctions,
	accountId: string,
	emailId: string,
	keywords: IDataObject,
): Promise<IDataObject> {
	const response = await jmapApiRequest.call(this, [
		['Email/set', { accountId, update: { [emailId]: { keywords } } }, 'c1'],
	]);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Email/set') {
		return methodResponse[1] as IDataObject;
	}

	throw new Error('Failed to update email');
}

/**
 * Move email to a different mailbox
 */
export async function moveEmail(
	this: IExecuteFunctions,
	accountId: string,
	emailId: string,
	targetMailboxId: string,
): Promise<IDataObject> {
	const response = await jmapApiRequest.call(this, [
		[
			'Email/set',
			{
				accountId,
				update: { [emailId]: { mailboxIds: { [targetMailboxId]: true } } },
			},
			'c1',
		],
	]);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Email/set') {
		return methodResponse[1] as IDataObject;
	}

	throw new Error('Failed to move email');
}

/**
 * Add a label (mailbox) to an email
 */
export async function addLabel(
	this: IExecuteFunctions,
	accountId: string,
	emailId: string,
	mailboxId: string,
): Promise<IDataObject> {
	const response = await jmapApiRequest.call(this, [
		[
			'Email/set',
			{
				accountId,
				update: { [emailId]: { [`mailboxIds/${mailboxId}`]: true } },
			},
			'c1',
		],
	]);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Email/set') {
		return methodResponse[1] as IDataObject;
	}

	throw new Error('Failed to add label');
}

/**
 * Remove a label (mailbox) from an email
 */
export async function removeLabel(
	this: IExecuteFunctions,
	accountId: string,
	emailId: string,
	mailboxId: string,
): Promise<IDataObject> {
	const response = await jmapApiRequest.call(this, [
		[
			'Email/set',
			{
				accountId,
				update: { [emailId]: { [`mailboxIds/${mailboxId}`]: null } },
			},
			'c1',
		],
	]);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Email/set') {
		return methodResponse[1] as IDataObject;
	}

	throw new Error('Failed to remove label');
}

/**
 * Get labels (mailboxes) for an email with their names
 */
export async function getLabels(
	this: IExecuteFunctions,
	accountId: string,
	emailId: string,
): Promise<IDataObject[]> {
	const emails = await getEmails.call(this, accountId, [emailId], ['id', 'mailboxIds']);

	if (emails.length === 0) {
		throw new Error('Email not found');
	}

	const email = emails[0];
	const mailboxIds = email.mailboxIds as IDataObject;

	if (!mailboxIds || Object.keys(mailboxIds).length === 0) {
		return [];
	}

	const allMailboxes = await getMailboxes.call(this, accountId);

	const labels: IDataObject[] = [];
	for (const mailboxId of Object.keys(mailboxIds)) {
		const mailbox = allMailboxes.find((mb) => mb.id === mailboxId);
		if (mailbox) {
			labels.push({
				id: mailbox.id,
				name: mailbox.name,
				role: mailbox.role || null,
				totalEmails: mailbox.totalEmails,
				unreadEmails: mailbox.unreadEmails,
			});
		} else {
			labels.push({ id: mailboxId, name: null, role: null });
		}
	}

	return labels;
}

/**
 * Delete emails
 */
export async function deleteEmails(
	this: IExecuteFunctions,
	accountId: string,
	emailIds: string[],
): Promise<IDataObject> {
	const response = await jmapApiRequest.call(this, [
		['Email/set', { accountId, destroy: emailIds }, 'c1'],
	]);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Email/set') {
		return methodResponse[1] as IDataObject;
	}

	throw new Error('Failed to delete emails');
}

/**
 * Get threads
 */
export async function getThreads(
	this: IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions,
	accountId: string,
	ids: string[],
): Promise<IDataObject[]> {
	const response = await jmapApiRequest.call(this, [['Thread/get', { accountId, ids }, 'c1']]);

	const methodResponse = response.methodResponses[0];
	if (methodResponse[0] === 'Thread/get') {
		return (methodResponse[1] as IDataObject).list as IDataObject[];
	}

	throw new Error('Failed to get threads');
}

/**
 * Download an attachment blob
 */
export async function downloadBlob(
	this: IExecuteFunctions,
	accountId: string,
	blobId: string,
	name: string,
	type: string,
): Promise<Buffer> {
	const session = await getJmapSession.call(this);
	const authType = getAuthType(this);

	let downloadUrl = session.downloadUrl
		.replace('{accountId}', accountId)
		.replace('{blobId}', blobId)
		.replace('{name}', encodeURIComponent(name))
		.replace('{type}', encodeURIComponent(type));

	if (authType === 'jmapOAuth2Api') {
		const response = await this.helpers.httpRequestWithAuthentication.call(this, 'jmapOAuth2Api', {
			method: 'GET',
			url: downloadUrl,
			encoding: 'arraybuffer',
		} as IHttpRequestOptions);
		return Buffer.from(response as ArrayBuffer);
	} else {
		const credentials = await this.getCredentials('jmapApi');
		const authMethod = (credentials.authMethod as string) || 'basicAuth';

		const headers: Record<string, string> = {};

		if (authMethod === 'basicAuth') {
			const authString = Buffer.from(
				`${credentials.email as string}:${credentials.password as string}`,
			).toString('base64');
			headers.Authorization = `Basic ${authString}`;
		} else if (authMethod === 'bearerToken') {
			headers.Authorization = `Bearer ${credentials.accessToken as string}`;
		}

		const options: IHttpRequestOptions = {
			method: 'GET' as IHttpRequestMethods,
			url: downloadUrl,
			headers,
			encoding: 'arraybuffer',
		};

		const response = await this.helpers.httpRequest(options);
		return Buffer.from(response as ArrayBuffer);
	}
}

/**
 * Interface for attachment options
 */
export interface IAttachmentOptions {
	includeInline?: boolean;
	mimeTypeFilter?: string;
}

/**
 * Interface for attachment metadata from JMAP
 */
interface IJmapAttachment {
	blobId: string;
	type: string;
	name: string;
	size: number;
	cid?: string;
	isInline?: boolean;
	partId?: string;
}

/**
 * Check if a MIME type matches a filter pattern
 */
function matchesMimeType(mimeType: string, filter: string): boolean {
	const normalizedMime = mimeType.toLowerCase();
	const normalizedFilter = filter.toLowerCase().trim();

	if (normalizedFilter.endsWith('/*')) {
		const prefix = normalizedFilter.slice(0, -1);
		return normalizedMime.startsWith(prefix);
	}

	return normalizedMime === normalizedFilter;
}

/**
 * Get attachments from an email and return them as binary data.
 * Each attachment is returned as a separate item with binary data in the 'file' field.
 * To extract archives (ZIP, tar.gz), chain with the n8n Compression node.
 */
export async function getAttachments(
	this: IExecuteFunctions,
	accountId: string,
	emailId: string,
	options: IAttachmentOptions = {},
): Promise<INodeExecutionData[]> {
	const { includeInline = false, mimeTypeFilter = '' } = options;

	// Get email with attachments metadata
	const emails = await getEmails.call(this, accountId, [emailId], ['id', 'subject', 'attachments']);

	if (emails.length === 0) {
		throw new Error(`Email with ID ${emailId} not found`);
	}

	const email = emails[0];
	const attachments = (email.attachments as IJmapAttachment[]) || [];

	if (attachments.length === 0) {
		return [];
	}

	// Parse MIME type filters
	const mimeFilters = mimeTypeFilter
		? mimeTypeFilter
				.split(',')
				.map((f) => f.trim())
				.filter((f) => f)
		: [];

	const results: INodeExecutionData[] = [];
	let attachmentIndex = 0;

	for (const attachment of attachments) {
		// Filter by inline status
		// An attachment is considered inline if:
		// - isInline is explicitly true, OR
		// - it has a cid (Content-ID) which is used for inline images in HTML
		const isInlineAttachment =
			attachment.isInline === true || (attachment.cid !== undefined && attachment.cid !== null);
		if (isInlineAttachment && !includeInline) {
			continue;
		}

		// Filter by MIME type
		if (mimeFilters.length > 0) {
			const matches = mimeFilters.some((filter) => matchesMimeType(attachment.type, filter));
			if (!matches) {
				continue;
			}
		}

		// Download the attachment
		const buffer = await downloadBlob.call(
			this,
			accountId,
			attachment.blobId,
			attachment.name,
			attachment.type,
		);

		// Prepare binary data for n8n
		const binaryData: IBinaryData = await this.helpers.prepareBinaryData(
			buffer,
			attachment.name,
			attachment.type,
		);

		results.push({
			json: {
				emailId: email.id,
				emailSubject: email.subject,
				attachmentIndex,
				fileName: attachment.name,
				mimeType: attachment.type,
				fileSize: attachment.size,
				isInline: isInlineAttachment,
				cid: attachment.cid || null,
			},
			binary: {
				file: binaryData,
			},
		});
		attachmentIndex++;
	}

	return results;
}
