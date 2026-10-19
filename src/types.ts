export type JsonObject = Record<string, unknown>;
export type Protocol = 'http' | 'graphql' | 'websocket' | 'grpc';
export interface Pair {
  name: string;
  value: string;
  disabled: boolean;
  type?: string;
  fileName?: string;
}
export interface RequestBody {
  mimeType: string;
  text: string;
  params: Pair[];
  fileName: string;
}
export interface RequestSettings {
  timeoutMs: number;
  followRedirects: boolean;
  validateCertificates: boolean;
  sendCookies: boolean;
  storeCookies: boolean;
  proxy: string;
  maxResponseMb: number;
}
export interface ApiRequest {
  id: string;
  collectionId: string;
  folderId: string | null;
  name: string;
  protocol: Protocol;
  method: string;
  url: string;
  parameters: Pair[];
  headers: Pair[];
  body: RequestBody;
  authentication: JsonObject;
  settings: RequestSettings;
  grpc: { protoFile: string; includeDirs: string[]; method: string };
  preRequestScript: string;
  afterResponseScript: string;
  description: string;
  source?: unknown;
}
export interface Collection {
  id: string;
  name: string;
  description: string;
  environment: JsonObject;
  authentication: JsonObject;
}
export interface Folder {
  id: string;
  collectionId: string;
  parentId: string | null;
  name: string;
  environment: JsonObject;
  authentication: JsonObject;
}
export interface Environment {
  id: string;
  collectionId: string;
  name: string;
  data: JsonObject;
}
export interface Workspace {
  version: 1;
  collections: Collection[];
  folders: Folder[];
  requests: ApiRequest[];
  environments: Environment[];
  unmigrated: unknown[];
}
export interface Plugin {
  name: string;
  version: string;
  path: string;
  description: string;
  enabled: boolean;
}
export interface Preferences {
  plugins: Plugin[];
  scriptsEnabled: boolean;
  nodePath: string;
  gitDirectory: string;
  activeCollectionId?: string;
  environmentIds: Record<string, string>;
}
export interface ResponseData {
  id: string;
  requestId: string;
  status: number;
  statusText: string;
  url: string;
  headers: Pair[];
  body: string;
  bodyBase64: string;
  elapsedMs: number;
  size: number;
  timestamp: number;
  truncated: boolean;
  protocol: string;
  logs: string[];
}
export interface SocketEvent {
  connectionId: string;
  kind: 'open' | 'message' | 'binary' | 'close' | 'error' | 'sent';
  data?: string;
  timestamp: number;
}
export interface GrpcMethod {
  name: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  input: string;
  output: string;
}

export const id = () => crypto.randomUUID();
export const pair = (name = '', value = ''): Pair => ({ name, value, disabled: false });
export const defaultSettings = (): RequestSettings => ({
  timeoutMs: 30000,
  followRedirects: true,
  validateCertificates: true,
  sendCookies: true,
  storeCookies: true,
  proxy: '',
  maxResponseMb: 10,
});
export const newCollection = (name = '新建集合'): Collection => ({
  id: id(),
  name,
  description: '',
  environment: {},
  authentication: { type: 'none' },
});
export function newRequest(
  collectionId: string,
  protocol: Protocol = 'http',
  folderId: string | null = null,
): ApiRequest {
  return {
    id: id(),
    collectionId,
    folderId,
    name: '新建请求',
    protocol,
    method: protocol === 'graphql' ? 'POST' : 'GET',
    url: '',
    parameters: [],
    headers: [],
    body: {
      mimeType: protocol === 'graphql' ? 'application/graphql' : '',
      text: protocol === 'graphql' ? '{\n  "query": "query { __typename }",\n  "variables": {}\n}' : '',
      params: [],
      fileName: '',
    },
    authentication: { type: 'none' },
    settings: defaultSettings(),
    grpc: { protoFile: '', includeDirs: [], method: '' },
    preRequestScript: '',
    afterResponseScript: '',
    description: '',
  };
}
export function emptyWorkspace(): Workspace {
  return { version: 1, collections: [], folders: [], requests: [], environments: [], unmigrated: [] };
}
export function initialWorkspace(): Workspace {
  const workspace = emptyWorkspace();
  const collection = newCollection('我的 API');
  collection.environment = { base_url: 'https://httpbin.org' };
  const request = newRequest(collection.id);
  request.name = '第一个请求';
  request.url = '{{ _.base_url }}/get';
  workspace.collections.push(collection);
  workspace.requests.push(request);
  return workspace;
}
export const defaultPreferences = (): Preferences => ({
  plugins: [],
  scriptsEnabled: false,
  nodePath: '',
  gitDirectory: '',
  environmentIds: {},
});

export function folderAncestors(workspace: Workspace, request: ApiRequest): Folder[] {
  const result: Folder[] = [];
  const seen = new Set<string>();
  let folderId = request.folderId;
  while (folderId && !seen.has(folderId)) {
    seen.add(folderId);
    const folder = workspace.folders.find(
      (f) => f.id === folderId && f.collectionId === request.collectionId,
    );
    if (!folder) break;
    result.unshift(folder);
    folderId = folder.parentId;
  }
  return result;
}
export function requestEnvironment(
  workspace: Workspace,
  request: ApiRequest,
  environmentId?: string,
): JsonObject {
  const base = workspace.collections.find((c) => c.id === request.collectionId)?.environment ?? {};
  const sub =
    workspace.environments.find((e) => e.id === environmentId && e.collectionId === request.collectionId)
      ?.data ?? {};
  return Object.assign(
    Object.create(null),
    base,
    sub,
    ...folderAncestors(workspace, request).map((f) => f.environment),
  );
}
export function effectiveRequest(workspace: Workspace, request: ApiRequest): ApiRequest {
  if (request.authentication.type !== 'inherit') return request;
  const parents = [
    workspace.collections.find((c) => c.id === request.collectionId),
    ...folderAncestors(workspace, request),
  ];
  const auth = parents
    .map((p) => p?.authentication)
    .reverse()
    .find((a) => a?.type && a.type !== 'inherit');
  return { ...request, authentication: auth ?? { type: 'none' } };
}
