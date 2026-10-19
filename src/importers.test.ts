import { describe, expect, it } from 'vitest';
import sourceV5 from '../tests/fixtures/source-insomnia-v5.yaml?raw';
import {
  exportCurl,
  exportInsomnia,
  exportYaml,
  importContent,
  importCurl,
  mergeImport,
  validateWorkspace,
} from './importers';
import { emptyWorkspace, newCollection, newRequest, requestEnvironment } from './types';

describe('Insomnia migration', () => {
  it('imports the original repository v5 roundtrip fixture', () => {
    const result = importContent(sourceV5);
    expect(result.workspace.collections[0].name).toBe('Imported from Try in Insomnia');
    expect(result.workspace.requests).toHaveLength(2);
    expect(result.workspace.requests[0].parameters[0]).toEqual(
      expect.objectContaining({ name: 'origin', value: 'YYZ' }),
    );
    expect(result.workspace.requests[1].parameters[0].value).toBe('BOARDING');
  });
  it('imports v4 hierarchy, environments, authentication and disabled entries', () => {
    const result = importContent(
      JSON.stringify({
        __export_format: 4,
        resources: [
          { _type: 'workspace', _id: 'wrk_a', name: 'API' },
          {
            _type: 'request_group',
            _id: 'fld_a',
            parentId: 'wrk_a',
            name: 'Users',
            environment: { id: 123 },
          },
          {
            _type: 'environment',
            _id: 'env_base',
            parentId: 'wrk_a',
            name: 'Base',
            data: { host: 'http://localhost' },
          },
          {
            _type: 'environment',
            _id: 'env_dev',
            parentId: 'env_base',
            name: 'Dev',
            data: { host: 'http://dev' },
          },
          {
            _type: 'request',
            _id: 'req_a',
            parentId: 'fld_a',
            name: 'GET user',
            url: '{{ _.host }}/users/{{ id }}',
            method: 'GET',
            headers: [{ name: 'X-Disabled', value: 'ignored', disabled: true }],
            authentication: { type: 'bearer', token: 'abc' },
          },
        ],
      }),
    );
    const { workspace: w } = result,
      r = w.requests[0];
    expect(w.collections[0].name).toBe('API');
    expect(r.folderId).toBe(w.folders[0].id);
    expect(r.headers[0].disabled).toBe(true);
    expect(r.authentication.token).toBe('abc');
    expect(requestEnvironment(w, r, w.environments[0].id)).toEqual({ host: 'http://dev', id: 123 });
    expect(result.warnings).toEqual([]);
  });
  it('preserves unsupported resources and warns instead of dropping them', () => {
    const source = {
      _type: 'socket_io_request',
      _id: 'sio_a',
      parentId: 'wrk_a',
      name: 'Events',
      url: 'ws://localhost',
    };
    const result = importContent(
      JSON.stringify({ resources: [{ _type: 'workspace', _id: 'wrk_a', name: 'API' }, source] }),
    );
    expect(result.workspace.unmigrated).toContainEqual(source);
    expect(result.warnings[0]).toContain('socket_io_request');
    expect(importContent(exportYaml(result.workspace)).workspace.unmigrated).toContainEqual(source);
  });
  it('imports real v5 nested collection syntax', () => {
    const result = importContent(`type: collection.insomnia.rest/5.0
name: V5 API
environments:
  data: { host: 'http://localhost' }
  subEnvironments:
    - name: Development
      data: { host: 'http://localhost:8080' }
collection:
  - name: Folder
    meta: {id: fld_a}
    children:
      - name: Echo
        meta: {id: req_a}
        url: '{{ _.host }}/echo'
        method: POST
        body: {mimeType: application/json, text: '{}'}
        scripts: {afterResponse: 'console.log("done")'}
      - name: Chat
        meta: {id: ws-req_a}
        url: ws://localhost:9000
`);
    expect(result.workspace.requests.map((r) => r.protocol)).toEqual(['http', 'websocket']);
    expect(result.workspace.requests[0].afterResponseScript).toContain('done');
    expect(result.workspace.environments[0].name).toBe('Development');
  });
  it('round trips requests through native JSON and Insomnia v4 export', () => {
    const w = emptyWorkspace(),
      c = newCollection('API'),
      r = newRequest(c.id);
    w.collections.push(c);
    r.name = 'Body';
    r.body = { text: '{"a":1}', mimeType: 'application/json', params: [], fileName: '' };
    r.settings.followRedirects = false;
    w.requests.push(r);
    expect(importContent(JSON.stringify(w)).workspace).toEqual(w);
    const imported = importContent(exportInsomnia(w)).workspace.requests[0];
    expect(imported.body).toEqual(r.body);
    expect(imported.settings.followRedirects).toBe(false);
  });
  it('remaps all IDs when importing the same collection twice', () => {
    const incoming = importContent(
      JSON.stringify({
        resources: [
          { _type: 'workspace', _id: 'w', name: 'API' },
          { _type: 'request_group', _id: 'f', parentId: 'w', name: 'Folder' },
          { _type: 'request', _id: 'r', parentId: 'f', name: 'Req', url: 'http://localhost' },
        ],
      }),
    ).workspace;
    const merged = mergeImport(incoming, incoming);
    expect(new Set(merged.requests.map((r) => r.id)).size).toBe(2);
    expect(merged.requests[1].folderId).toBe(merged.folders[1].id);
    expect(merged.requests[1].collectionId).toBe(merged.collections[1].id);
  });
  it('rejects malformed backups and folder cycles before replacing local data', () => {
    expect(() => validateWorkspace({ version: 1, collections: [] })).toThrow();
    const w = emptyWorkspace(),
      c = newCollection();
    w.collections.push(c);
    w.folders.push({
      id: 'a',
      name: 'A',
      parentId: 'a',
      collectionId: c.id,
      environment: {},
      authentication: {},
    });
    expect(() => validateWorkspace(w)).toThrow('循环');
  });
});

describe('other formats', () => {
  it('exports form values, query parameters and API keys without dropping them', () => {
    const r = newRequest('c');
    r.method = 'POST';
    r.url = 'http://localhost/echo#unused';
    r.parameters = [{ name: 'q', value: 'a b', disabled: false }];
    r.authentication = { type: 'apikey', key: 'X-Key', value: 'secret' };
    r.body.mimeType = 'application/x-www-form-urlencoded';
    r.body.params = [{ name: 'name', value: "O'Reilly", disabled: false }];
    const text = exportCurl(r);
    const restored = importCurl(text, 'c');
    expect(restored.url).toBe('http://localhost/echo?q=a+b');
    expect(restored.headers).toContainEqual(expect.objectContaining({ name: 'X-Key', value: 'secret' }));
    expect(restored.body.params[0].value).toBe("O'Reilly");
  });
  it('imports Postman raw URL without doubling query parameters', () => {
    const w = importContent(
      JSON.stringify({
        info: { name: 'Postman' },
        variable: [{ key: 'host', value: 'localhost' }],
        item: [
          {
            name: 'Echo',
            request: {
              method: 'POST',
              url: {
                raw: 'http://{{host}}/echo?q=1',
                query: [
                  { key: 'q', value: '1' },
                  { key: 'skip', value: '2', disabled: true },
                ],
              },
              body: { mode: 'raw', raw: '{"ok":true}', options: { raw: { language: 'json' } } },
              auth: { type: 'bearer', bearer: [{ key: 'token', value: 'secret' }] },
            },
          },
        ],
      }),
    ).workspace;
    expect(w.requests[0].url).toBe('http://{{host}}/echo');
    expect(w.requests[0].parameters).toHaveLength(2);
    expect(w.requests[0].authentication.token).toBe('secret');
    expect(w.requests[0].body.mimeType).toBe('application/json');
  });
  it('imports OpenAPI path variables and request examples', () => {
    const w = importContent(`openapi: 3.0.3
info: {title: Pet API, version: '1'}
servers: [{url: 'http://localhost:9000'}]
paths:
  /pets/{petId}:
    get:
      summary: Fetch pet
      parameters: [{name: petId, in: path, example: '7'}]
`).workspace;
    expect(w.requests[0].url).toBe('{{ _.base_url }}/pets/{{ petId }}');
    expect(w.collections[0].environment.petId).toBe('7');
  });
  it('parses quoted cURL JSON without executing shell expressions', () => {
    const r = importCurl(
      `curl 'http://localhost/echo' -X POST -H 'Content-Type: application/json' --data-raw '{"name":"a b","literal":"$(do-not-run)"}' -u 'alice:p:a:ss'`,
      'collection',
    );
    expect(r.method).toBe('POST');
    expect(r.body.text).toContain('$(do-not-run)');
    expect(r.authentication).toEqual({ type: 'basic', username: 'alice', password: 'p:a:ss' });
    expect(() => importCurl('curl http://localhost --unknown', 'c')).toThrow('尚不支持');
    expect(() => importCurl("curl 'unclosed", 'c')).toThrow('引号');
  });
  it('imports form-encoded cURL without losing its body', () => {
    const r = importCurl("curl http://localhost --data 'name=a+b&value=x%26y'", 'c');
    expect(r.body.params.map((p) => [p.name, p.value])).toEqual([
      ['name', 'a b'],
      ['value', 'x&y'],
    ]);
  });
});
