import { parse, stringify } from 'yaml';
import {
  defaultSettings,
  emptyWorkspace,
  id,
  newCollection,
  newRequest,
  pair,
  type ApiRequest,
  type Collection,
  type JsonObject,
  type Pair,
  type Protocol,
  type Workspace,
} from './types';

const obj = (v: unknown): JsonObject =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
const pairs = (v: unknown): Pair[] =>
  arr(v).map((v) => {
    const p = obj(v);
    return {
      ...pair(str(p.name ?? p.key), str(p.value)),
      disabled: p.disabled === true,
      type: str(p.type),
      fileName: str(p.fileName ?? p.src),
    };
  });
export interface ImportResult {
  workspace: Workspace;
  warnings: string[];
}

export function validateWorkspace(value: unknown): Workspace {
  const w = obj(value);
  if (
    w.version !== 1 ||
    !['collections', 'requests', 'folders', 'environments', 'unmigrated'].every((key) =>
      Array.isArray(w[key]),
    )
  )
    throw new Error('不是有效的 Insomnia Local 工作区文件。');
  const allIds = new Set<string>();
  for (const group of ['collections', 'requests', 'folders', 'environments'])
    for (const item of arr(w[group])) {
      const record = obj(item);
      if (
        typeof record.id !== 'string' ||
        !record.id ||
        allIds.has(record.id) ||
        typeof record.name !== 'string'
      )
        throw new Error(`无效或重复的 ${group} ID。`);
      allIds.add(record.id);
    }
  const collections = new Set(arr(w.collections).map((v) => obj(v).id));
  const folders = new Map(arr(w.folders).map((v) => [obj(v).id, obj(v)]));
  const isObject = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);
  for (const item of [...arr(w.collections), ...arr(w.folders)]) {
    if (!isObject(obj(item).environment) || !isObject(obj(item).authentication))
      throw new Error('集合或文件夹的环境/认证结构无效。');
  }
  for (const item of arr(w.environments)) {
    if (!isObject(obj(item).data)) throw new Error('环境必须为 JSON 对象。');
  }
  for (const item of [...arr(w.folders), ...arr(w.requests), ...arr(w.environments)])
    if (!collections.has(obj(item).collectionId)) throw new Error('记录引用了不存在的集合。');
  for (const item of arr(w.folders)) {
    const folder = obj(item);
    let parent = folder.parentId;
    const seen = new Set([folder.id]);
    while (parent != null) {
      const value = folders.get(parent);
      if (!value || seen.has(parent) || value.collectionId !== folder.collectionId)
        throw new Error('文件夹包含循环或无效的父级引用。');
      seen.add(parent);
      parent = value.parentId;
    }
  }
  for (const item of arr(w.requests)) {
    const r = obj(item);
    if (
      !['http', 'graphql', 'websocket', 'grpc'].includes(str(r.protocol)) ||
      typeof r.url !== 'string' ||
      typeof r.method !== 'string' ||
      typeof r.preRequestScript !== 'string' ||
      typeof r.afterResponseScript !== 'string' ||
      typeof r.description !== 'string' ||
      !isObject(r.authentication) ||
      !Array.isArray(r.headers) ||
      !Array.isArray(r.parameters) ||
      !Array.isArray(obj(r.body).params) ||
      typeof obj(r.body).text !== 'string' ||
      typeof obj(r.settings).timeoutMs !== 'number' ||
      !Number.isFinite(obj(r.settings).timeoutMs) ||
      !Array.isArray(obj(r.grpc).includeDirs)
    )
      throw new Error('请求结构不完整或协议不受支持。');
    for (const item of [...arr(r.headers), ...arr(r.parameters), ...arr(obj(r.body).params)]) {
      if (
        typeof obj(item).name !== 'string' ||
        typeof obj(item).value !== 'string' ||
        typeof obj(item).disabled !== 'boolean'
      )
        throw new Error('请求参数或请求头结构无效。');
    }
    if (r.folderId != null && folders.get(r.folderId)?.collectionId !== r.collectionId)
      throw new Error('请求引用了无效的文件夹。');
  }
  return structuredClone(value) as Workspace;
}

export function mergeImport(current: Workspace, incoming: Workspace): Workspace {
  const ids = new Map<string, string>();
  for (const record of [
    ...incoming.collections,
    ...incoming.folders,
    ...incoming.requests,
    ...incoming.environments,
  ])
    ids.set(record.id, id());
  return {
    ...current,
    collections: [...current.collections, ...incoming.collections.map((c) => ({ ...c, id: ids.get(c.id)! }))],
    folders: [
      ...current.folders,
      ...incoming.folders.map((f) => ({
        ...f,
        id: ids.get(f.id)!,
        collectionId: ids.get(f.collectionId)!,
        parentId: f.parentId ? (ids.get(f.parentId) ?? null) : null,
      })),
    ],
    requests: [
      ...current.requests,
      ...incoming.requests.map((r) => ({
        ...r,
        id: ids.get(r.id)!,
        collectionId: ids.get(r.collectionId)!,
        folderId: r.folderId ? (ids.get(r.folderId) ?? null) : null,
      })),
    ],
    environments: [
      ...current.environments,
      ...incoming.environments.map((e) => ({
        ...e,
        id: ids.get(e.id)!,
        collectionId: ids.get(e.collectionId)!,
      })),
    ],
    unmigrated: [...current.unmigrated, ...incoming.unmigrated],
  };
}

export function importContent(text: string, name = '导入的集合'): ImportResult {
  if (text.trimStart().startsWith('curl ')) {
    const w = emptyWorkspace(),
      c = newCollection(name);
    w.collections.push(c);
    w.requests.push(importCurl(text, c.id));
    return { workspace: w, warnings: [] };
  }
  const data: unknown = parse(text, { maxAliasCount: 50 });
  const root = obj(data);
  if (root.version === 1 && root.collections) return { workspace: validateWorkspace(data), warnings: [] };
  const workspace = emptyWorkspace();
  const warnings: string[] = [];
  const archive = (item: unknown, reason: string) => {
    workspace.unmigrated.push(item);
    warnings.push(reason);
  };
  function insomniaRequest(
    record: JsonObject,
    collection: Collection,
    folderId: string | null,
    protocol?: Protocol,
  ) {
    const r = newRequest(
      collection.id,
      protocol ?? (obj(record.body).mimeType === 'application/graphql' ? 'graphql' : 'http'),
      folderId,
    );
    r.name = str(record.name, '导入的请求');
    r.url = str(record.url);
    r.method = str(record.method, protocol === 'graphql' ? 'POST' : 'GET');
    r.headers = pairs(record.headers ?? record.metadata);
    r.parameters = pairs(record.parameters);
    const body = obj(record.body);
    r.body = {
      mimeType: str(body.mimeType),
      text: str(body.text),
      params: pairs(body.params),
      fileName: str(body.fileName),
    };
    r.authentication = Object.keys(obj(record.authentication)).length
      ? obj(record.authentication)
      : { type: 'none' };
    const settings = obj(record.settings),
      cookies = obj(settings.cookies);
    r.settings.followRedirects = (settings.followRedirects ?? record.settingFollowRedirects) !== 'off';
    r.settings.sendCookies = (cookies.send ?? record.settingSendCookies) !== false;
    r.settings.storeCookies = (cookies.store ?? record.settingStoreCookies) !== false;
    r.description = str(record.description ?? obj(record.meta).description);
    r.preRequestScript = str(record.preRequestScript ?? obj(record.scripts).preRequest);
    r.afterResponseScript = str(record.afterResponseScript ?? obj(record.scripts).afterResponse);
    r.grpc.method = str(record.protoMethodName).replace(/^\//, '');
    r.grpc.protoFile = str(record.protoFile);
    r.source = record;
    workspace.requests.push(r);
    if (
      r.authentication.type &&
      !['none', 'inherit', 'basic', 'bearer', 'apikey', 'oauth2'].includes(str(r.authentication.type))
    )
      warnings.push(`${r.name}：认证 ${r.authentication.type} 需要插件或手动配置请求头。`);
    if (r.protocol === 'grpc' && !r.grpc.method)
      warnings.push(`${r.name}：请重新选择 proto 文件或通过服务反射选择方法。`);
  }
  if (Array.isArray(root.resources)) {
    const resources = root.resources.map(obj),
      byId = new Map(resources.map((r) => [str(r._id), r]));
    const collections = new Map<string, Collection>();
    const folderIds = new Map<string, string>();
    for (const r of resources.filter((r) => r._type === 'workspace')) {
      const c = newCollection(str(r.name, name));
      c.description = str(r.description);
      collections.set(str(r._id), c);
      workspace.collections.push(c);
    }
    if (!collections.size) {
      const c = newCollection(name);
      collections.set('__default', c);
      workspace.collections.push(c);
    }
    const findCollection = (r: JsonObject): Collection => {
      const seen = new Set<string>();
      let parent = str(r.parentId);
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        if (collections.has(parent)) return collections.get(parent)!;
        parent = str(byId.get(parent)?.parentId);
      }
      return workspace.collections[0];
    };
    resources.filter((r) => r._type === 'request_group').forEach((r) => folderIds.set(str(r._id), id()));
    for (const r of resources) {
      const c = findCollection(r);
      if (r._type === 'request_group') {
        workspace.folders.push({
          id: folderIds.get(str(r._id))!,
          collectionId: c.id,
          parentId: folderIds.get(str(r.parentId)) ?? null,
          name: str(r.name, '文件夹'),
          environment: obj(r.environment),
          authentication: obj(r.authentication),
        });
        if (r.preRequestScript || r.afterResponseScript)
          archive(r, `${str(r.name)}：文件夹脚本保留在未迁移数据中，请移至请求脚本。`);
      } else if (['request', 'grpc_request', 'websocket_request'].includes(str(r._type))) {
        insomniaRequest(
          r,
          c,
          folderIds.get(str(r.parentId)) ?? null,
          r._type === 'grpc_request' ? 'grpc' : r._type === 'websocket_request' ? 'websocket' : undefined,
        );
      } else if (r._type === 'environment') {
        if (collections.has(str(r.parentId))) c.environment = obj(r.data);
        else
          workspace.environments.push({
            id: id(),
            collectionId: c.id,
            name: str(r.name, '环境'),
            data: obj(r.data),
          });
      } else if (!['workspace', 'request_group'].includes(str(r._type)))
        archive(r, `保留未迁移资源：${str(r._type)} ${str(r.name)}`);
    }
  } else if (str(root.type).includes('insomnia.rest/5')) {
    const importV5 = (data: JsonObject) => {
      const c = newCollection(str(data.name, name));
      c.description = str(obj(data.meta).description);
      workspace.collections.push(c);
      const environments = obj(data.environments);
      c.environment = obj(environments.data);
      for (const e of arr(environments.subEnvironments).map(obj))
        workspace.environments.push({
          id: id(),
          collectionId: c.id,
          name: str(e.name, '环境'),
          data: obj(e.data),
        });
      function visit(items: unknown[], parent: string | null) {
        for (const item of items) {
          const r = obj(item),
            meta = obj(r.meta);
          const key = str(meta.id);
          if (Array.isArray(r.children)) {
            const folderId = id();
            workspace.folders.push({
              id: folderId,
              collectionId: c.id,
              parentId: parent,
              name: str(r.name, '文件夹'),
              environment: obj(r.environment),
              authentication: obj(r.authentication),
            });
            if (r.scripts) archive(r, `${str(r.name)}：文件夹脚本请移至请求脚本。`);
            visit(r.children, folderId);
          } else if (key.startsWith('sio') || key.startsWith('mcp') || r.type === 'socketio')
            archive(r, `${str(r.name)}：Socket.IO/MCP 尚未迁移。`);
          else
            insomniaRequest(
              r,
              c,
              parent,
              key.startsWith('greq') ? 'grpc' : key.startsWith('ws') ? 'websocket' : undefined,
            );
        }
      }
      visit(arr(data.collection), null);
      if (data.cookieJar) archive(data.cookieJar, '旧 Cookie Jar 已保留；新会话使用独立 Cookie Jar。');
      if (data.spec) archive(data.spec, '设计文档已保留；可将 OpenAPI 单独导入为请求。');
    };
    if (Array.isArray(root.collection)) importV5(root);
    else if (Array.isArray(root.collections)) root.collections.map(obj).forEach(importV5);
    else throw new Error('该 Insomnia v5 文件不包含可导入的集合。');
  } else if (root.info && Array.isArray(root.item)) {
    const c = newCollection(str(obj(root.info).name, name));
    workspace.collections.push(c);
    const variables = (items: unknown[]) =>
      Object.fromEntries(
        items
          .map(obj)
          .filter((v) => !v.disabled)
          .map((v) => [str(v.key), v.value]),
      );
    c.environment = variables(arr(root.variable));
    function auth(value: unknown): JsonObject {
      const a = obj(value);
      if (!a.type || a.type === 'noauth') return { type: 'none' };
      return {
        type: a.type,
        ...Object.fromEntries(
          arr(a[str(a.type)])
            .map(obj)
            .map((v) => [str(v.key), v.value]),
        ),
      };
    }
    c.authentication = auth(root.auth);
    function visit(items: unknown[], parent: string | null) {
      for (const item of items.map(obj)) {
        if (Array.isArray(item.item)) {
          const folderId = id();
          workspace.folders.push({
            id: folderId,
            collectionId: c.id,
            parentId: parent,
            name: str(item.name, '文件夹'),
            environment: variables(arr(item.variable)),
            authentication: item.auth ? auth(item.auth) : { type: 'inherit' },
          });
          visit(item.item, folderId);
          continue;
        }
        const source = typeof item.request === 'string' ? { url: item.request } : obj(item.request),
          r = newRequest(c.id, 'http', parent);
        r.name = str(item.name, '请求');
        r.method = str(source.method, 'GET');
        const url = obj(source.url);
        r.url = typeof source.url === 'string' ? source.url : str(url.raw);
        r.headers = pairs(source.header);
        // raw URLs already include enabled query parameters; rebuilding avoids duplicates and preserves disabled rows.
        if (Array.isArray(url.query)) {
          r.url = r.url.split('?')[0];
          r.parameters = pairs(url.query);
        }
        r.authentication = source.auth ? auth(source.auth) : { type: 'inherit' };
        const body = obj(source.body);
        const mode = str(body.mode);
        if (mode === 'raw') {
          r.body.text = str(body.raw);
          r.body.mimeType =
            obj(obj(body.options).raw).language === 'json' ? 'application/json' : 'text/plain';
        }
        if (mode === 'urlencoded' || mode === 'formdata') {
          r.body.mimeType =
            mode === 'urlencoded' ? 'application/x-www-form-urlencoded' : 'multipart/form-data';
          r.body.params = pairs(body[mode]);
        }
        if (mode === 'graphql') {
          r.protocol = 'graphql';
          r.body.mimeType = 'application/graphql';
          const g = obj(body.graphql);
          r.body.text = JSON.stringify(
            {
              query: g.query,
              variables:
                typeof g.variables === 'string' ? JSON.parse(g.variables || '{}') : (g.variables ?? {}),
            },
            null,
            2,
          );
        }
        if (mode === 'file') {
          r.body.mimeType = 'application/octet-stream';
          r.body.fileName = str(obj(body.file).src);
        }
        r.description = str(source.description ?? obj(source.description).content);
        r.source = item;
        workspace.requests.push(r);
        if (item.event || root.event) archive(item, `${r.name}：Postman pm.* 脚本需要手动改为 insomnia.*。`);
      }
    }
    visit(root.item, null);
  } else if (root.openapi || root.swagger) {
    const c = newCollection(str(obj(root.info).title, name));
    workspace.collections.push(c);
    const firstServer = obj(arr(root.servers)[0]);
    c.environment = {
      base_url: str(
        firstServer.url,
        root.host
          ? `${str(arr(root.schemes)[0], 'https')}://${str(root.host)}${str(root.basePath)}`
          : 'http://localhost:3000',
      ),
    };
    const resolve = (value: unknown) => {
      const v = obj(value);
      if (str(v.$ref).startsWith('#/'))
        return str(v.$ref)
          .slice(2)
          .split('/')
          .reduce((node: JsonObject, key) => obj(node[key.replace(/~1/g, '/').replace(/~0/g, '~')]), root);
      return v;
    };
    for (const [path, entries] of Object.entries(obj(root.paths)))
      for (const [method, value] of Object.entries(obj(entries))) {
        if (!['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(method)) continue;
        const operation = obj(value),
          r = newRequest(c.id);
        r.method = method.toUpperCase();
        r.name = str(operation.summary ?? operation.operationId, `${r.method} ${path}`);
        r.url = `{{ _.base_url }}${path.replace(/\{([^}]+)\}/g, '{{ $1 }}')}`;
        r.description = str(operation.description);
        for (const item of [...arr(obj(entries).parameters), ...arr(operation.parameters)]) {
          const p = resolve(item),
            value = str(p.example ?? obj(p.schema).default);
          if (p.in === 'query') r.parameters.push(pair(str(p.name), value));
          if (p.in === 'header') r.headers.push(pair(str(p.name), value));
          if (p.in === 'path') c.environment[str(p.name)] = value;
        }
        const content = obj(resolve(operation.requestBody).content);
        const mime = Object.keys(content)[0];
        if (mime) {
          r.body.mimeType = mime;
          const media = obj(content[mime]);
          r.body.text = JSON.stringify(media.example ?? obj(resolve(media.schema)).example ?? {}, null, 2);
        }
        r.source = operation;
        workspace.requests.push(r);
      }
    archive(root, 'OpenAPI 原文已保留；复杂 schema、外部 $ref 和 security 方案需进一步配置。');
  } else if (Array.isArray(obj(root.log).entries)) {
    const c = newCollection(name);
    workspace.collections.push(c);
    for (const entry of arr(obj(root.log).entries).map(obj)) {
      const source = obj(entry.request),
        r = newRequest(c.id);
      r.url = str(source.url);
      r.name = r.url;
      r.method = str(source.method, 'GET');
      r.headers = pairs(source.headers);
      const body = obj(source.postData);
      r.body = {
        mimeType: str(body.mimeType),
        text: str(body.text),
        params: pairs(body.params),
        fileName: '',
      };
      workspace.requests.push(r);
    }
  } else throw new Error('支持 Insomnia v4/v5、Postman v2、OpenAPI、HAR、cURL 和 Insomnia Local 工作区。');
  if (!workspace.collections.length) throw new Error('文件中没有可导入的集合。');
  return { workspace: validateWorkspace(workspace), warnings: [...new Set(warnings)] };
}

export function exportInsomnia(workspace: Workspace): string {
  const resources: JsonObject[] = [];
  for (const c of workspace.collections) {
    resources.push({
      _id: c.id,
      _type: 'workspace',
      parentId: null,
      name: c.name,
      description: c.description,
      scope: 'collection',
    });
    resources.push({
      _id: `env_${c.id}`,
      _type: 'environment',
      parentId: c.id,
      name: 'Base Environment',
      data: c.environment,
    });
  }
  for (const e of workspace.environments)
    resources.push({
      _id: e.id,
      _type: 'environment',
      parentId: `env_${e.collectionId}`,
      name: e.name,
      data: e.data,
    });
  for (const f of workspace.folders)
    resources.push({
      _id: f.id,
      _type: 'request_group',
      parentId: f.parentId ?? f.collectionId,
      name: f.name,
      environment: f.environment,
      authentication: f.authentication,
    });
  for (const r of workspace.requests)
    resources.push({
      ...obj(r.source),
      _id: r.id,
      _type:
        r.protocol === 'grpc' ? 'grpc_request' : r.protocol === 'websocket' ? 'websocket_request' : 'request',
      parentId: r.folderId ?? r.collectionId,
      name: r.name,
      url: r.url,
      method: r.method,
      body: r.body,
      headers: r.headers,
      parameters: r.parameters,
      authentication: r.authentication,
      description: r.description,
      preRequestScript: r.preRequestScript,
      afterResponseScript: r.afterResponseScript,
      protoMethodName: r.grpc.method,
      protoFile: r.grpc.protoFile,
      settingFollowRedirects: r.settings.followRedirects ? 'on' : 'off',
      settingSendCookies: r.settings.sendCookies,
      settingStoreCookies: r.settings.storeCookies,
    });
  return JSON.stringify(
    {
      _type: 'export',
      __export_format: 4,
      __export_date: new Date().toISOString(),
      __export_source: 'insomnia-local:0.1.0',
      resources,
    },
    null,
    2,
  );
}

export function exportYaml(workspace: Workspace): string {
  return stringify(workspace);
}

export function tokenizeCurl(source: string): string[] {
  const tokens: string[] = [];
  let token = '',
    quote = '',
    active = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\' && quote !== "'") {
      const next = source[++i];
      if (next === '\r' && source[i + 1] === '\n') {
        i++;
        continue;
      }
      if (next === '\n') continue;
      if (next === undefined) throw new Error('cURL 中存在不完整转义。');
      token += next;
      active = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      else token += c;
      active = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      active = true;
    } else if (/\s/.test(c)) {
      if (active) {
        tokens.push(token);
        token = '';
        active = false;
      }
    } else {
      token += c;
      active = true;
    }
  }
  if (quote) throw new Error('cURL 引号未闭合。');
  if (active) tokens.push(token);
  return tokens;
}
export function importCurl(source: string, collectionId: string): ApiRequest {
  const tokens = tokenizeCurl(source);
  if (tokens.shift() !== 'curl') throw new Error('请输入 curl 命令。');
  const request = newRequest(collectionId);
  request.name = '从 cURL 导入';
  let explicitMethod = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const value = () => {
      const v = tokens[++i];
      if (v === undefined) throw new Error(`${token} 缺少参数。`);
      return v;
    };
    if (token === '-X' || token === '--request') {
      request.method = value();
      explicitMethod = true;
    } else if (token === '-H' || token === '--header') {
      const v = value(),
        colon = v.indexOf(':');
      if (colon < 1) throw new Error('无效的 cURL 请求头。');
      request.headers.push(pair(v.slice(0, colon), v.slice(colon + 1).trimStart()));
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--json'].includes(token)) {
      const v = value();
      if (!explicitMethod) request.method = 'POST';
      if (v.startsWith('@') && token !== '--data-raw') {
        request.body.fileName = v.slice(1);
        request.body.mimeType = 'application/octet-stream';
      } else {
        request.body.text += (request.body.text ? '&' : '') + v;
        request.body.mimeType = token === '--json' ? 'application/json' : 'application/x-www-form-urlencoded';
      }
    } else if (token === '-u' || token === '--user') {
      const [username, ...password] = value().split(':');
      request.authentication = { type: 'basic', username, password: password.join(':') };
    } else if (token === '--url') request.url = value();
    else if (token === '-k' || token === '--insecure') request.settings.validateCertificates = false;
    else if (token === '-I' || token === '--head') {
      request.method = 'HEAD';
      explicitMethod = true;
    } else if (['-L', '--location', '-s', '--silent', '--compressed'].includes(token)) continue;
    else if (token === '--max-time') {
      const timeout = Number(value());
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('cURL 超时必须为正数。');
      request.settings.timeoutMs = timeout * 1000;
    } else if (token.startsWith('-'))
      throw new Error(`尚不支持 cURL 选项 ${token}；请先移除此选项并手动配置。`);
    else request.url = token;
  }
  if (!request.url) throw new Error('cURL 命令缺少 URL。');
  const mime = request.headers.find((h) => h.name.toLowerCase() === 'content-type');
  if (mime) request.body.mimeType = mime.value;
  // Keep raw form bodies as text; the native engine otherwise serializes body.params.
  if (
    request.body.mimeType === 'application/x-www-form-urlencoded' &&
    request.body.text &&
    !request.body.fileName
  ) {
    request.body.params = Array.from(new URLSearchParams(request.body.text), ([name, value]) =>
      pair(name, value),
    );
  }
  return request;
}
export function exportCurl(r: ApiRequest): string {
  if (!['http', 'graphql'].includes(r.protocol)) throw new Error('cURL 导出仅适用于 HTTP / GraphQL 请求。');
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const params = r.parameters.filter((p) => !p.disabled && p.name).map((p) => [p.name, p.value]);
  const auth = r.authentication.disabled ? { type: 'none' } : r.authentication;
  if (auth.type === 'apikey' && auth.addTo === 'query')
    params.push([String(auth.key ?? ''), String(auth.value ?? '')]);
  const query = new URLSearchParams(params).toString();
  const baseUrl = r.url.split('#')[0];
  const url = query ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${query}` : baseUrl;
  const parts = ['curl', '--request', quote(r.method), '--url', quote(url)];
  if (r.settings.followRedirects) parts.push('--location');
  if (!r.settings.validateCertificates) parts.push('--insecure');
  parts.push('--max-time', String(r.settings.timeoutMs / 1000));
  for (const h of r.headers.filter((h) => !h.disabled && h.name))
    parts.push('--header', quote(`${h.name}: ${h.value}`));
  if (auth.type === 'bearer')
    parts.push('--header', quote(`Authorization: ${auth.prefix || 'Bearer'} ${auth.token ?? ''}`));
  if (auth.type === 'oauth2')
    parts.push('--header', quote(`Authorization: Bearer ${auth.accessToken ?? ''}`));
  if (auth.type === 'basic') parts.push('--user', quote(`${auth.username ?? ''}:${auth.password ?? ''}`));
  if (auth.type === 'apikey' && auth.addTo !== 'query')
    parts.push('--header', quote(`${auth.key ?? ''}: ${auth.value ?? ''}`));
  const mime = r.body.mimeType;
  if (
    mime &&
    mime !== 'multipart/form-data' &&
    !r.headers.some((h) => !h.disabled && h.name.toLowerCase() === 'content-type')
  )
    parts.push(
      '--header',
      quote(`Content-Type: ${mime === 'application/graphql' ? 'application/json' : mime}`),
    );
  if (mime === 'multipart/form-data') {
    for (const p of r.body.params.filter((p) => !p.disabled && p.name))
      parts.push(
        p.type === 'file' ? '--form' : '--form-string',
        quote(`${p.name}=${p.type === 'file' ? '@' + p.fileName : p.value}`),
      );
  } else if (mime === 'application/x-www-form-urlencoded') {
    const body = new URLSearchParams(
      r.body.params.filter((p) => !p.disabled && p.name).map((p) => [p.name, p.value]),
    ).toString();
    parts.push('--data-raw', quote(body));
  } else if (r.body.fileName) parts.push('--data-binary', quote('@' + r.body.fileName));
  else if (r.body.text) parts.push('--data-raw', quote(r.body.text));
  return parts.join(' ');
}

export { defaultSettings };
