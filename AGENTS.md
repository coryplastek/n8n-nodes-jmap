# AGENTS.md - Coding Guidelines for n8n-nodes-jmap

This file provides guidelines for AI agents working on this n8n community node package for JMAP email protocol integration.

## Build/Lint/Format Commands

```bash
# Build the project (compiles TypeScript + copies SVG icons)
npm run build

# Development mode with watch
npm run dev

# Format code with Prettier
npm run format

# Lint TypeScript files
npm run lint

# Lint and auto-fix issues
npm run lintfix

# Pre-publish (build + lint)
npm run prepublishOnly
```

**Note:** This project does not have tests configured yet. Test files should be added to a `test/` directory following n8n node testing patterns.

## Project Structure

```
credentials/          # Credential type definitions
  JmapApi.credentials.ts
  JmapOAuth2Api.credentials.ts
nodes/               # Node implementations
  Jmap/
    Jmap.node.ts           # Main action node
    JmapTrigger.node.ts    # Polling trigger node
    GenericFunctions.ts    # Shared JMAP utilities
    jmap.svg              # Node icon
dist/                # Compiled output (gitignored)
```

## Code Style Guidelines

### TypeScript Configuration

- **Target:** ES2019 with CommonJS modules
- **Strict mode:** Enabled (no implicit any, strict null checks, etc.)
- **Output:** `./dist` directory
- **Declaration files:** Generated (.d.ts)

### Formatting (Prettier)

- Use tabs for indentation (tabWidth: 2)
- Single quotes for strings
- Trailing commas on all multi-line constructs
- Print width: 100 characters
- Run `npm run format` before committing

### Naming Conventions

- **Classes:** PascalCase (e.g., `Jmap`, `JmapApi`, `JmapOAuth2Api`)
- **Interfaces:** PascalCase with `I` prefix (e.g., `IJmapSession`, `IJmapAccount`, `IJmapRequest`)
- **Types:** PascalCase with `I` prefix for interfaces
- **Functions/Variables:** camelCase (e.g., `getPrimaryAccountId`, `serverUrl`)
- **Constants:** UPPER_SNAKE_CASE (e.g., `JMAP_CAPABILITIES`, `CORE`, `MAIL`)
- **File names:** PascalCase matching the main export (e.g., `Jmap.node.ts`)

### Imports

- Use `import type` for type-only imports
- Group imports: external libs first, then internal modules
- Import from `n8n-workflow` for all n8n types:
  ```typescript
  import type { IExecuteFunctions, INodeType } from 'n8n-workflow';
  import { NodeApiError, NodeOperationError } from 'n8n-workflow';
  ```

### Error Handling

- Use `NodeApiError` for API-related errors
- Use `NodeOperationError` for operation/validation errors
- Always include descriptive error messages
- Wrap credential retrieval in try-catch when optional

### Node Implementation Patterns

#### Node Class Structure

```typescript
export class MyNode implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'My Node',
		name: 'myNode',
		icon: 'file:myNode.svg',
		group: ['transform'],
		version: 1,
		usableAsTool: true, // Enable for AI agents
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		// ... rest of description
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		// Implementation
	}
}
```

#### Credential Class Structure

```typescript
export class MyApi implements ICredentialType {
	name = 'myApi';
	displayName = 'My API';
	documentationUrl = 'https://docs.example.com';
	properties: INodeProperties[] = [
		// Credential fields
	];
	test: ICredentialTestRequest = {
		// Test request config
	};
}
```

### JMAP-Specific Patterns

- Use capability constants from `JMAP_CAPABILITIES` object
- Handle both OAuth2 and Basic Auth credential types
- Remove trailing slashes from URLs: `url.replace(/\/$/, '')`
- Use JMAP method call format: `[methodName, arguments, callId]`
- Support primary account resolution via `getPrimaryAccountId()`

### Documentation

- Add JSDoc comments for public functions and interfaces
- Include documentation URLs in credentials
- Describe parameters with `description` field in node properties

### ESLint Rules

- No unused variables (except those prefixed with `_`)
- TypeScript parser with project references
- Ignored paths: `dist/`, `node_modules/`, config files

## Important Notes

- This is an **n8n community node package** - follow n8n node conventions
- Nodes must be registered in `package.json` under `n8n.nodes`
- Credentials must be registered in `package.json` under `n8n.credentials`
- SVG icons are copied to `dist/` via gulp during build
- The package exports compiled JS from `dist/` only
- Maintain compatibility with JMAP RFC 8620/8621 standards
- Support multiple JMAP servers (Apache James, Twake Mail, Fastmail, Stalwart)
