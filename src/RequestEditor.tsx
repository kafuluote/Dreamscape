import { useState } from 'react';
import { FolderOpen, RefreshCw, Braces } from 'lucide-react';
import { call, pickPath } from './api';
import { CodeEditor, IconButton, PairEditor, pretty } from './components';
import type { ApiRequest, GrpcMethod, JsonObject } from './types';

export default function RequestEditor({
  request,
  onChange,
  environment,
  onError,
  scriptsEnabled,
}: {
  request: ApiRequest;
  onChange: (patch: Partial<ApiRequest>) => void;
  environment: JsonObject;
  onError: (error: unknown) => void;
  scriptsEnabled: boolean;
}) {
  const [tab, setTab] = useState('parameters'),
    [methods, setMethods] = useState<GrpcMethod[]>([]),
    [discovering, setDiscovering] = useState(false),
    [tokenLoading, setTokenLoading] = useState(false);
  const auth = request.authentication;
  const setAuth = (patch: JsonObject) => onChange({ authentication: { ...auth, ...patch } });
  const authField = (key: string, label: string, secret = false) => (
    <label className="field-label" key={key}>
      {label}
      <input
        type={secret ? 'password' : 'text'}
        value={String(auth[key] ?? '')}
        onChange={(event) => setAuth({ [key]: event.target.value })}
        autoComplete="off"
        placeholder={secret ? '••••••••' : '支持 {{ _.variable }}'}
      />
    </label>
  );
  const discover = async () => {
    setDiscovering(true);
    try {
      setMethods(await call('grpc_methods', { request, environment }));
    } catch (error) {
      onError(error);
    } finally {
      setDiscovering(false);
    }
  };
  return (
    <section className="request-editor">
      {request.protocol === 'grpc' && (
        <div className="grpc-controls">
          <div className="input-with-button">
            <input
              aria-label="Proto 文件"
              placeholder="留空使用服务反射，或选择 .proto 文件"
              value={request.grpc.protoFile}
              onChange={(event) => onChange({ grpc: { ...request.grpc, protoFile: event.target.value } })}
            />
            <IconButton
              label="选择 proto 文件"
              onClick={() => {
                void pickPath('proto')
                  .then((path) => {
                    if (path) onChange({ grpc: { ...request.grpc, protoFile: path } });
                  })
                  .catch(onError);
              }}
            >
              <FolderOpen size={15} />
            </IconButton>
          </div>
          <div className="grpc-method">
            <input
              aria-label="gRPC 方法"
              list="grpc-methods"
              placeholder="package.Service/Method"
              value={request.grpc.method}
              onChange={(event) => onChange({ grpc: { ...request.grpc, method: event.target.value } })}
            />
            <datalist id="grpc-methods">
              {methods.map((method) => (
                <option key={method.name} value={method.name}>
                  {method.clientStreaming ? '客户端流 ' : ''}
                  {method.serverStreaming ? '服务端流' : ''}
                </option>
              ))}
            </datalist>
            <button
              disabled={discovering}
              onClick={() => {
                void discover();
              }}
            >
              <RefreshCw size={14} className={discovering ? 'spin' : ''} />
              发现方法
            </button>
          </div>
        </div>
      )}
      <div className="tabs editor-tabs">
        {[
          ['parameters', `参数${request.parameters.length ? ` (${request.parameters.length})` : ''}`],
          [
            'headers',
            `${request.protocol === 'grpc' ? 'Metadata' : '请求头'}${request.headers.length ? ` (${request.headers.length})` : ''}`,
          ],
          ['body', '请求体'],
          ['auth', '认证'],
          ['scripts', '脚本'],
          ['settings', '设置'],
        ].map(([key, label]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="editor-content">
        {tab === 'parameters' ? (
          <PairEditor
            values={request.parameters}
            onChange={(parameters) => onChange({ parameters })}
            onError={onError}
          />
        ) : tab === 'headers' ? (
          <PairEditor
            values={request.headers}
            onChange={(headers) => onChange({ headers })}
            onError={onError}
          />
        ) : tab === 'body' ? (
          <div className="body-editor">
            <div className="body-type">
              <select
                aria-label="请求体类型"
                value={request.body.mimeType}
                onChange={(event) => onChange({ body: { ...request.body, mimeType: event.target.value } })}
              >
                <option value="">无 / 原始文本</option>
                <option value="application/json">JSON</option>
                <option value="application/graphql">GraphQL (JSON envelope)</option>
                <option value="text/plain">Text</option>
                <option value="application/xml">XML</option>
                <option value="application/x-www-form-urlencoded">Form URL Encoded</option>
                <option value="multipart/form-data">Multipart Form</option>
                <option value="application/octet-stream">Binary</option>
                {request.body.mimeType &&
                  ![
                    'application/json',
                    'application/graphql',
                    'text/plain',
                    'application/xml',
                    'application/x-www-form-urlencoded',
                    'multipart/form-data',
                    'application/octet-stream',
                  ].includes(request.body.mimeType) && <option>{request.body.mimeType}</option>}
              </select>
              <button
                className="text-button"
                onClick={() => onChange({ body: { ...request.body, text: pretty(request.body.text) } })}
              >
                <Braces size={14} />
                格式化
              </button>
              {request.protocol === 'grpc' && <span className="hint">流式入参可输入 JSON 数组</span>}
            </div>
            {['application/x-www-form-urlencoded', 'multipart/form-data'].includes(request.body.mimeType) ? (
              <PairEditor
                values={request.body.params}
                onChange={(params) => onChange({ body: { ...request.body, params } })}
                form={request.body.mimeType === 'multipart/form-data'}
                onError={onError}
              />
            ) : request.body.mimeType === 'application/octet-stream' ? (
              <div className="form-fields">
                <label className="field-label">
                  请求体文件
                  <div className="input-with-button">
                    <input
                      value={request.body.fileName}
                      onChange={(event) =>
                        onChange({ body: { ...request.body, fileName: event.target.value } })
                      }
                    />
                    <IconButton
                      label="选择请求体文件"
                      onClick={() => {
                        void pickPath('file')
                          .then((path) => {
                            if (path) onChange({ body: { ...request.body, fileName: path } });
                          })
                          .catch(onError);
                      }}
                    >
                      <FolderOpen size={16} />
                    </IconButton>
                  </div>
                </label>
              </div>
            ) : (
              <CodeEditor
                label="请求体"
                value={request.body.text}
                onChange={(text) => onChange({ body: { ...request.body, text } })}
                placeholder={request.protocol === 'grpc' ? '{}' : '输入请求体，支持 {{ _.variable }}'}
              />
            )}
          </div>
        ) : tab === 'auth' ? (
          <div className="form-fields auth-fields">
            <label className="field-label">
              接口认证
              <select
                value={String(auth.type || 'none')}
                onChange={(event) => setAuth({ type: event.target.value })}
              >
                <option value="none">无认证</option>
                <option value="inherit">继承文件夹 / 集合</option>
                <option value="basic">Basic Auth</option>
                <option value="bearer">Bearer Token</option>
                <option value="apikey">API Key</option>
                <option value="oauth2">OAuth 2.0</option>
                {Boolean(auth.type) &&
                  !['none', 'inherit', 'basic', 'bearer', 'apikey', 'oauth2'].includes(String(auth.type)) && (
                    <option value={String(auth.type)}>待适配：{String(auth.type)}</option>
                  )}
              </select>
            </label>
            {auth.type === 'basic' && (
              <>
                {authField('username', '用户名')}
                {authField('password', '密码', true)}
              </>
            )}
            {auth.type === 'bearer' && (
              <>
                {authField('token', 'Token', true)}
                {authField('prefix', '前缀（默认 Bearer）')}
              </>
            )}
            {auth.type === 'apikey' && (
              <>
                {authField('key', 'Key')}
                {authField('value', 'Value', true)}
                <label className="field-label">
                  添加到
                  <select
                    value={String(auth.addTo || 'header')}
                    onChange={(event) => setAuth({ addTo: event.target.value })}
                  >
                    <option value="header">请求头</option>
                    <option value="query">查询参数</option>
                  </select>
                </label>
              </>
            )}
            {auth.type === 'oauth2' && (
              <>
                <label className="field-label">
                  授权方式
                  <select
                    value={String(auth.grantType || 'client_credentials')}
                    onChange={(event) => setAuth({ grantType: event.target.value })}
                  >
                    <option value="client_credentials">Client Credentials</option>
                    <option value="password">Password</option>
                    <option value="refresh_token">Refresh Token</option>
                  </select>
                </label>
                {authField('accessTokenUrl', 'Token URL')}
                {authField('clientId', 'Client ID')}
                {authField('clientSecret', 'Client Secret', true)}
                {authField('scope', 'Scope')}
                {auth.grantType === 'password' && (
                  <>
                    {authField('username', '用户名')}
                    {authField('password', '密码', true)}
                  </>
                )}
                {auth.grantType === 'refresh_token' && authField('refreshToken', 'Refresh Token', true)}
                {authField('accessToken', 'Access Token', true)}
                <button
                  disabled={tokenLoading}
                  onClick={() => {
                    setTokenLoading(true);
                    void call<JsonObject>('oauth_token', {
                      request: {
                        ...request,
                        authentication: { ...auth, grantType: auth.grantType || 'client_credentials' },
                      },
                      environment,
                    })
                      .then((token) => {
                        if (typeof token.access_token !== 'string')
                          throw new Error('Token 端点未返回 access_token');
                        setAuth({
                          accessToken: token.access_token,
                          refreshToken: token.refresh_token ?? auth.refreshToken ?? '',
                        });
                      })
                      .catch(onError)
                      .finally(() => setTokenLoading(false));
                  }}
                >
                  {tokenLoading ? '获取中…' : '获取 Access Token'}
                </button>
                <p className="hint">浏览器授权流程可在外部完成后粘贴 Token。</p>
              </>
            )}
            {(!auth.type || auth.type === 'none') && (
              <p className="hint">请求不会自动添加认证信息。应用本身无需帐号。</p>
            )}
          </div>
        ) : tab === 'scripts' ? (
          <div className="script-editors">
            {!scriptsEnabled && (
              <div className="warning-banner">脚本尚未启用。审核脚本内容后，在设置中启用可信脚本。</div>
            )}
            <label>请求前脚本</label>
            <CodeEditor
              small
              label="请求前脚本"
              value={request.preRequestScript}
              onChange={(preRequestScript) => onChange({ preRequestScript })}
              placeholder="insomnia.environment.set('timestamp', Date.now());"
            />
            <label>响应后脚本 / 测试</label>
            <CodeEditor
              small
              label="响应后脚本"
              value={request.afterResponseScript}
              onChange={(afterResponseScript) => onChange({ afterResponseScript })}
              placeholder="insomnia.test('status', () => insomnia.expect(insomnia.response.code).to.equal(200));"
            />
          </div>
        ) : (
          <div className="form-fields settings-fields">
            <label className="field-label">
              请求超时（毫秒）
              <input
                type="number"
                min="100"
                max="600000"
                value={request.settings.timeoutMs}
                onChange={(event) =>
                  onChange({
                    settings: { ...request.settings, timeoutMs: Number(event.target.value) || 30000 },
                  })
                }
              />
            </label>
            <label className="field-label">
              最大响应大小（MiB）
              <input
                type="number"
                min="1"
                max="100"
                value={request.settings.maxResponseMb}
                onChange={(event) =>
                  onChange({
                    settings: { ...request.settings, maxResponseMb: Number(event.target.value) || 10 },
                  })
                }
              />
            </label>
            {(['followRedirects', 'validateCertificates', 'sendCookies', 'storeCookies'] as const).map(
              (key, index) => (
                <label className="check-field" key={key}>
                  <input
                    type="checkbox"
                    checked={request.settings[key]}
                    onChange={(event) =>
                      onChange({ settings: { ...request.settings, [key]: event.target.checked } })
                    }
                  />
                  {['跟随 HTTP 重定向', '校验 TLS 证书', '发送 Cookie', '保存 Cookie'][index]}
                </label>
              ),
            )}
            {!request.settings.validateCertificates && (
              <p className="hint text-danger">HTTP TLS 证书校验已关闭，仅用于受控的测试环境。</p>
            )}
            <label className="field-label">
              HTTP 代理
              <input
                placeholder="http://127.0.0.1:7890（留空使用系统配置）"
                value={request.settings.proxy}
                onChange={(event) =>
                  onChange({ settings: { ...request.settings, proxy: event.target.value } })
                }
              />
            </label>
            {request.protocol === 'grpc' && (
              <label className="field-label">
                Proto include 目录（每行一个）
                <textarea
                  value={request.grpc.includeDirs.join('\n')}
                  onChange={(event) =>
                    onChange({
                      grpc: { ...request.grpc, includeDirs: event.target.value.split('\n').filter(Boolean) },
                    })
                  }
                />
              </label>
            )}
            <label className="field-label">
              备注
              <textarea
                value={request.description}
                onChange={(event) => onChange({ description: event.target.value })}
              />
            </label>
          </div>
        )}
      </div>
    </section>
  );
}
