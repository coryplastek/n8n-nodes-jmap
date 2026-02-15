# Implementation Plan: Fix JMAP Endpoint Discovery for Fastmail Compatibility

**Repository:** `coryplastek/n8n-nodes-jmap` (forked from `mmaudet/n8n-nodes-jmap`)  
**Date:** 2026-02-15  
**Author:** GitHub Copilot  

---

## Table of Contents

1. [Problem Summary](#problem-summary)
2. [Architecture Changes](#architecture-changes)
3. [Files to Modify](#files-to-modify)
4. [Detailed Implementation](#detailed-implementation)
5. [Testing Plan](#testing-plan)
6. [Backwards Compatibility](#backwards-compatibility)

---

## Problem Summary

The current implementation has two fundamental issues that prevent it from working with Fastmail and other RFC-compliant JMAP servers:

| Current Behavior | RFC-Compliant Behavior |
|-----------------|------------------------|
| Session: `GET ${serverUrl}/session` | Discover via `/.well-known/jmap` or configurable session URL |
| API calls: `POST ${serverUrl}` | Use `session.apiUrl` from the session response |

### Why This Breaks Fastmail

Fastmail's JMAP endpoints:
- **Session URL:** `https://api.fastmail.com/jmap/session`
- **API URL:** `https://api.fastmail.com/jmap/api/`

The current code assumes:
- Session is at `${serverUrl}/session`
- API is at `${serverUrl}`

**No single base URL satisfies both patterns:**

| If serverUrl is... | Session becomes | API becomes | Result |
|---|---|---|---|
| `https://api.fastmail.com/jmap` | `GET /jmap/session` ✅ | `POST /jmap` ❌ |
| `https://api.fastmail.com/jmap/api` | `GET /jmap/api/session` ❌ | `POST /jmap/api` ✅ |

---

## Architecture Changes

### Core Concept: Session-Driven Endpoint Discovery

Per [RFC 8620](https://datatracker.ietf.org/doc/html/rfc8620), the correct JMAP flow is:

```
1. GET /.well-known/jmap (or configured session URL)
   ↓ (follow redirects)
2. Receive Session object containing:
   - apiUrl (for JMAP method calls)
   - downloadUrl (for blob downloads)
   - uploadUrl (for blob uploads)
   - accounts, capabilities, etc.
   ↓
3. POST to session.apiUrl for all JMAP method calls
```

### Session Caching Strategy

To avoid fetching the session on every API call, we'll implement per-execution caching:

```typescript
// Module-level cache (cleared between n8n executions)
let sessionCache: Map<string, IJmapSession> = new Map();
```

The cache is keyed by `${serverUrl}::${authType}` to handle multiple credentials.

---

## Files to Modify

| File | Change Type | Description |
|------|-------------|-------------|
| `credentials/JmapApi.credentials.ts` | Minor | Update URL field description, fix credential test |
| `credentials/JmapOAuth2Api.credentials.ts` | Minor | Update URL field description |
| `nodes/Jmap/GenericFunctions.ts` | **Major** | Session discovery, caching, use `session.apiUrl` |
| `nodes/Jmap/Jmap.node.ts` | Minor | Add cache clearing at execution start |
| `nodes/Jmap/JmapTrigger.node.ts` | Minor | Add cache clearing at poll start |

---

## Detailed Implementation

### 1. `credentials/JmapApi.credentials.ts`

#### 1.1 Update URL Field Description

```typescript
{
  displayName: 'JMAP Server URL',
  name: 'serverUrl',
  type: 'string',
  default: '',
  placeholder: 'https://api.fastmail.com',
  description: 'The JMAP server base URL. The node will automatically discover endpoints via /.well-known/jmap. For Fastmail, use https://api.fastmail.com',
  required: true,
},
```

#### 1.2 Fix Credential Test for Bearer Token

The current test only works with Basic Auth. Add conditional logic:

```typescript
test: ICredentialTestRequest = {
  request: {
    baseURL: '={{$credentials.serverUrl}}',
    url: '/.well-known/jmap',
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: '={{$credentials.authMethod === "bearerToken" ? "Bearer " + $credentials.accessToken : undefined}}',
    },
    auth: '={{$credentials.authMethod === "basicAuth" ? { username: $credentials.email, password: $credentials.password } : undefined}}',
    followRedirects: true,
  },
};
```

**Note:** n8n's credential test has limitations. A more robust approach may require a custom test function.

---

### 2. `credentials/JmapOAuth2Api.credentials.ts`

Update the `jmapServerUrl` field description similarly:

```typescript
{
  displayName: 'JMAP Server URL',
  name: 'jmapServerUrl',
  type: 'string',
  default: '',
  required: true,
  placeholder: 'https://api.fastmail.com',
  description: 'The JMAP server base URL. Endpoints will be discovered automatically via /.well-known/jmap',
},
```

---

### 3. `nodes/Jmap/GenericFunctions.ts` (Major Changes)

This is the core file requiring significant changes.

#### 3.1 Add Session Caching Infrastructure

Add after the interface definitions (around line 42):

```typescript
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
```

#### 3.2 Add Low-Level Authenticated Request Function

Replace or refactor `makeJmapRequest` to be a cleaner authenticated HTTP helper:

```typescript
/**
 * Make an authenticated HTTP request to any URL.
 * This is the low-level function that handles auth headers.
 * 
 * @param context - The n8n execution context
 * @param method - HTTP method (GET, POST, etc.)
 * @param url - Full URL to request
 * @param body - Optional request body
 * @param followRedirects - Whether to follow HTTP redirects (default: true)
 */
async function makeAuthenticatedRequest(
  context: IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions,
  method: IHttpRequestMethods,
  url: string,
  body?: IDataObject,
  followRedirects: boolean = true,
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

  // n8n's httpRequest follows redirects by default
  // Add explicit redirect handling if needed

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
```

#### 3.3 Rewrite `getJmapSession()` with Discovery

Replace the existing `getJmapSession` function:

```typescript
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
    `${baseUrl}/.well-known/jmap`,  // RFC 8620 standard
    `${baseUrl}/jmap/session`,       // Fastmail pattern
    `${baseUrl}/session`,            // Simple pattern
  ];

  let lastError: Error | null = null;
  
  for (const sessionUrl of sessionUrls) {
    try {
      const response = await makeAuthenticatedRequest(
        this,
        'GET',
        sessionUrl,
        undefined,
        true, // followRedirects
      );
      
      // Validate it's a proper JMAP session response
      const session = response as unknown as IJmapSession;
      
      if (session.apiUrl && session.accounts) {
        // Valid session - cache and return
        sessionCache.set(cacheKey, session);
        return session;
      }
      
      // Response didn't look like a valid session, try next URL
      lastError = new Error(`Invalid session response from ${sessionUrl}: missing apiUrl or accounts`);
    } catch (error) {
      lastError = error as Error;
      // Continue to next URL
    }
  }

  // All URLs failed
  throw new NodeApiError(this.getNode(), (lastError || new Error('Unknown error')) as JsonObject, {
    message: `Failed to discover JMAP session. Tried: ${sessionUrls.join(', ')}. ` +
             `Please ensure your JMAP Server URL points to a JMAP-compliant server. ` +
             `For Fastmail, use: https://api.fastmail.com`,
  });
}
```

#### 3.4 Rewrite `jmapApiRequest()` to Use Session API URL

Replace the existing `jmapApiRequest` function:

```typescript
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
      session.apiUrl,  // <-- This is the key fix!
      body as unknown as IDataObject,
    );
    return response as unknown as IJmapResponse;
  } catch (error) {
    throw new NodeApiError(this.getNode(), error as JsonObject, {
      message: `JMAP API request failed. API URL: ${session.apiUrl}`,
    });
  }
}
```

#### 3.5 Update `downloadBlob()` to Use Session URLs

The existing `downloadBlob` function already uses `session.downloadUrl`, which is correct. No changes needed, but verify it works with the new session discovery.

#### 3.6 Remove or Deprecate Old `makeJmapRequest()`

The old `makeJmapRequest` function that built URLs from `serverUrl` should be removed or marked as deprecated. All calls should go through either:
- `makeAuthenticatedRequest()` for raw HTTP requests
- `jmapApiRequest()` for JMAP method calls

---

### 4. `nodes/Jmap/Jmap.node.ts`

Add cache clearing at the start of the `execute()` method:

```typescript
import {
  // ... existing imports
} from 'n8n-workflow';

import {
  getPrimaryAccountId,
  getMailboxes,
  // ... other imports
  clearSessionCache,  // <-- Add this import
} from './GenericFunctions';

export class Jmap implements INodeType {
  // ... existing code

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    // Clear session cache at start of each execution
    // This ensures fresh endpoint discovery for each workflow run
    clearSessionCache();
    
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];
    // ... rest of existing code
  }
}
```

---

### 5. `nodes/Jmap/JmapTrigger.node.ts`

Add cache clearing at the start of the `poll()` method:

```typescript
import {
  // ... existing imports
} from 'n8n-workflow';

import {
  getPrimaryAccountId,
  getMailboxes,
  queryEmails,
  getEmails,
  clearSessionCache,  // <-- Add this import
} from './GenericFunctions';

export class JmapTrigger implements INodeType {
  // ... existing code

  methods = {
    // ... existing loadOptions
  };

  async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
    // Clear session cache at start of each poll cycle
    clearSessionCache();
    
    // ... rest of existing poll code
  }
}
```

---

## Testing Plan

### Test Cases

#### 1. Fastmail (Primary Target)
```
Server URL: https://api.fastmail.com
Auth Method: Bearer Token
Access Token: <Fastmail API token with urn:ietf:params:jmap:mail scope>

Expected Behavior:
- Discovery tries /.well-known/jmap first
- Follows redirect to /jmap/session
- Obtains session with apiUrl: https://api.fastmail.com/jmap/api/
- All JMAP calls POST to /jmap/api/
```

#### 2. Apache James
```
Server URL: https://james.example.com
Auth Method: Basic Auth

Expected Behavior:
- Discovery finds session at /.well-known/jmap or /session
- Uses returned apiUrl for subsequent calls
```

#### 3. Cyrus IMAP
```
Server URL: https://cyrus.example.com
Auth Method: Basic Auth

Expected Behavior:
- Similar to Apache James
```

#### 4. Stalwart Mail Server
```
Server URL: https://stalwart.example.com
Auth Method: Bearer Token

Expected Behavior:
- Discovery via standard JMAP flow
```

### Test Procedure

1. **Credential Test**
   - Create credential with base URL only
   - Click "Test" button
   - Should show success (or clear error about connectivity)

2. **Trigger Test**
   - Create JMAP Trigger node with "New Email in Mailbox"
   - Select a mailbox from dropdown (this tests session + Mailbox/get)
   - Activate workflow
   - Send test email
   - Verify trigger fires and returns email data

3. **Node Operations Test**
   - Test Email/get, Email/query, Mailbox/get operations
   - Test send email (requires Identity/get + EmailSubmission)
   - Test attachments download

---

## Backwards Compatibility

This change is **backwards compatible** for most users:

| Server Type | Previous Config | New Behavior |
|-------------|-----------------|--------------|
| Standard JMAP (/.well-known) | Any base URL | Works (discovery) |
| Servers with /session | `https://server.com` | Works (fallback) |
| Fastmail | **Broken** | Works (discovery + fallback) |

### Breaking Changes

Users who previously configured workarounds may need to update:
- If someone set `serverUrl` to a specific session path, they should change to base URL only

### Migration Notes

Add to README or release notes:
```markdown
## Migration from v0.2.x to v0.3.0

The JMAP Server URL configuration has changed. You should now provide only the 
base URL of your JMAP server. The node will automatically discover the session 
and API endpoints.

**Before:** `https://api.fastmail.com/jmap` (didn't work)
**After:** `https://api.fastmail.com` (works automatically)

For most users, simply updating to the base URL should fix any connection issues.
```

---

## Implementation Checklist

- [ ] Update `credentials/JmapApi.credentials.ts`
  - [ ] Update URL field description and placeholder
  - [ ] Fix credential test for Bearer Token auth
- [ ] Update `credentials/JmapOAuth2Api.credentials.ts`
  - [ ] Update URL field description
- [ ] Update `nodes/Jmap/GenericFunctions.ts`
  - [ ] Add session cache infrastructure
  - [ ] Add `clearSessionCache()` export
  - [ ] Add `makeAuthenticatedRequest()` helper
  - [ ] Rewrite `getJmapSession()` with discovery
  - [ ] Rewrite `jmapApiRequest()` to use `session.apiUrl`
  - [ ] Remove/deprecate old `makeJmapRequest()`
- [ ] Update `nodes/Jmap/Jmap.node.ts`
  - [ ] Import `clearSessionCache`
  - [ ] Call `clearSessionCache()` at start of `execute()`
- [ ] Update `nodes/Jmap/JmapTrigger.node.ts`
  - [ ] Import `clearSessionCache`
  - [ ] Call `clearSessionCache()` at start of `poll()`
- [ ] Update `README.md`
  - [ ] Document new URL configuration
  - [ ] Add Fastmail-specific instructions
  - [ ] Add migration notes
- [ ] Test with Fastmail
- [ ] Test with at least one other JMAP server
- [ ] Bump version in `package.json`

---

## References

- [RFC 8620 - JMAP Core](https://datatracker.ietf.org/doc/html/rfc8620)
- [RFC 8621 - JMAP Mail](https://datatracker.ietf.org/doc/html/rfc8621)
- [Fastmail JMAP Documentation](https://www.fastmail.com/dev/jmap)
- [jmap.io Specification](https://jmap.io/)