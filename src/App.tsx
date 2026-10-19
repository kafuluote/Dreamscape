import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  Moon,
  Plus,
  Search,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Settings2,
  GitBranch,
  Puzzle,
  Upload,
  Download,
  Send,
  Square,
  X,
  Copy,
  Trash2,
  Play,
  Check,
  Circle,
  ExternalLink,
  Globe,
  Braces,
  Pencil,
  AlertTriangle,
  Database,
  Cable,
  Code2,
} from 'lucide-react';
import * as api from './api';
import {
  CodeEditor,
  ConfirmDialog,
  IconButton,
  JsonEditor,
  Modal,
  NameDialog,
  ResponsePanel,
  SocketPanel,
} from './components';
import RequestEditor from './RequestEditor';
import {
  exportCurl,
  exportInsomnia,
  exportYaml,
  importContent,
  importCurl,
  mergeImport,
  validateWorkspace,
} from './importers';
import {
  defaultPreferences,
  effectiveRequest,
  id,
  initialWorkspace,
  newCollection,
  newRequest,
  requestEnvironment,
  type ApiRequest,
  type Environment,
  type Folder as RequestFolder,
  type JsonObject,
  type Plugin,
  type Preferences,
  type Protocol,
  type ResponseData,
  type SocketEvent,
  type Workspace,
} from './types';

type Dialog =
  'environment' | 'settings' | 'plugins' | 'git' | 'import' | 'export' | 'runner' | 'about' | null;
type SaveState = 'loading' | 'saving' | 'saved' | 'error';
type SocketState = { id: string; status: 'connecting' | 'open' | 'closed' };

function applyEnvironment(
  workspace: Workspace,
  collectionId: string,
  environmentId: string | undefined,
  before: JsonObject,
  after: JsonObject,
): Workspace {
  const changes = Object.keys(after).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  const removed = Object.keys(before).filter((key) => !(key in after));
  if (!changes.length && !removed.length) return workspace;
  const apply = (data: JsonObject) => {
    const result = { ...data };
    changes.forEach((key) => (result[key] = after[key]));
    removed.forEach((key) => delete result[key]);
    return result;
  };
  return environmentId
    ? {
        ...workspace,
        environments: workspace.environments.map((e) =>
          e.id === environmentId ? { ...e, data: apply(e.data) } : e,
        ),
      }
    : {
        ...workspace,
        collections: workspace.collections.map((c) =>
          c.id === collectionId ? { ...c, environment: apply(c.environment) } : c,
        ),
      };
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>(initialWorkspace),
    [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [loaded, setLoaded] = useState(false),
    [loadError, setLoadError] = useState(''),
    [saveState, setSaveState] = useState<SaveState>('loading');
  const [collectionId, setCollectionId] = useState(''),
    [selectedId, setSelectedId] = useState(''),
    [tabs, setTabs] = useState<string[]>([]);
  const [search, setSearch] = useState(''),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(null),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const [naming, setNaming] = useState<{
    title: string;
    initial?: string;
    save: (name: string) => void;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    body: ReactNode;
    run: () => void;
  } | null>(null);
  const [responses, setResponses] = useState<Record<string, ResponseData>>({}),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState<Record<string, string>>({}),
    [history, setHistory] = useState<ResponseData[]>([]);
  const [sockets, setSockets] = useState<Record<string, SocketState>>({}),
    [socketEvents, setSocketEvents] = useState<Record<string, SocketEvent[]>>({}),
    [liveGrpc, setLiveGrpc] = useState<Record<string, string[]>>({});
  const [runnerRunning, setRunnerRunning] = useState(false),
    [runnerLog, setRunnerLog] = useState<string[]>([]);
  const socketsRef = useRef(sockets),
    busyRef = useRef(busy),
    workspaceRef = useRef(workspace),
    preferencesRef = useRef(preferences),
    saveQueue = useRef(Promise.resolve()),
    saveRevision = useRef(0),
    runnerCancelled = useRef(false);
  socketsRef.current = sockets;
  busyRef.current = busy;
  workspaceRef.current = workspace;
  preferencesRef.current = preferences;
  const onError = useCallback(
    (value: unknown) => setError(value instanceof Error ? value.message : String(value)),
    [],
  );
  const collection = workspace.collections.find((c) => c.id === collectionId);
  const selected = workspace.requests.find((r) => r.id === selectedId);
  const environmentId = preferences.environmentIds[collectionId];
  const environment = selected ? requestEnvironment(workspace, selected, environmentId) : {};

  useEffect(() => {
    let disposed = false;
    void api
      .load()
      .then((result) => {
        if (disposed) return;
        const w = result.workspace ? validateWorkspace(result.workspace) : initialWorkspace();
        const p = { ...defaultPreferences(), ...result.preferences };
        setWorkspace(w);
        setPreferences(p);
        const c = w.collections.find((c) => c.id === p.activeCollectionId) ?? w.collections[0];
        setCollectionId(c?.id ?? '');
        const r = w.requests.find((r) => r.collectionId === c?.id);
        setSelectedId(r?.id ?? '');
        setTabs(r ? [r.id] : []);
        setLoaded(true);
        setSaveState('saved');
      })
      .catch((value) => {
        if (!disposed) setLoadError(String(value));
      });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    if (!loaded || !api.desktop) return;
    const revision = ++saveRevision.current;
    setSaveState('saving');
    saveQueue.current = saveQueue.current
      .catch(() => {})
      .then(async () => {
        await api.save(workspace);
        await api.savePreferences(preferences);
      })
      .then(
        () => {
          if (revision === saveRevision.current) setSaveState('saved');
        },
        (reason) => {
          setSaveState('error');
          onError(`本地保存失败：${String(reason)}`);
        },
      );
  }, [workspace, preferences, loaded, onError]);
  useEffect(() => {
    if (!loaded || !api.desktop) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          await saveQueue.current;
          // Flush the latest refs, including edits made just before the close event.
          await api.save(workspaceRef.current);
          await api.savePreferences(preferencesRef.current);
          await getCurrentWindow().destroy();
        } catch (error) {
          onError(`关闭前保存失败，窗口已保留：${String(error)}`);
        }
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else cleanup = unlisten;
      })
      .catch(onError);
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [loaded, onError]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!api.desktop) return;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    void api
      .onSocket((event) => {
        const entry = Object.entries(socketsRef.current).find(
          ([, socket]) => socket.id === event.connectionId,
        );
        if (!entry) return;
        const [requestId] = entry;
        if (event.kind === 'open' || event.kind === 'close')
          setSockets((current) => ({
            ...current,
            [requestId]: { id: event.connectionId, status: event.kind === 'open' ? 'open' : 'closed' },
          }));
        setSocketEvents((current) => ({
          ...current,
          [requestId]: [...(current[requestId] ?? []), event].slice(-500),
        }));
      })
      .then((cleanup) => {
        if (disposed) cleanup();
        else cleanups.push(cleanup);
      })
      .catch(onError);
    void listen<{ operationId: string; message: unknown }>('grpc-message', (event) => {
      const requestId = Object.keys(busyRef.current).find(
        (id) => busyRef.current[id] === event.payload.operationId,
      );
      if (requestId)
        setLiveGrpc((current) => ({
          ...current,
          [requestId]: [...(current[requestId] ?? []), JSON.stringify(event.payload.message, null, 2)].slice(
            -100,
          ),
        }));
    })
      .then((cleanup) => {
        if (disposed) cleanup();
        else cleanups.push(cleanup);
      })
      .catch(onError);
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [onError]);

  const openRequest = useCallback((request: ApiRequest) => {
    setSelectedId(request.id);
    setCollectionId(request.collectionId);
    setTabs((current) => (current.includes(request.id) ? current : [...current, request.id]));
    setHistory([]);
  }, []);
  const updateRequest = (patch: Partial<ApiRequest>) =>
    setWorkspace((current) => ({
      ...current,
      requests: current.requests.map((r) => (r.id === selectedId ? { ...r, ...patch } : r)),
    }));
  const addRequest = useCallback(
    (protocol: Protocol = 'http', folderId: string | null = null) => {
      if (!collectionId) return;
      const request = newRequest(collectionId, protocol, folderId);
      setWorkspace((current) => ({ ...current, requests: [...current.requests, request] }));
      openRequest(request);
    },
    [collectionId, openRequest],
  );
  const runRequest = useCallback(async (request: ApiRequest): Promise<ResponseData> => {
    if (busyRef.current[request.id]) throw new Error('此请求正在执行。');
    const operationId = id();
    busyRef.current = { ...busyRef.current, [request.id]: operationId };
    setBusy({ ...busyRef.current });
    setErrors((current) => ({ ...current, [request.id]: '' }));
    setLiveGrpc((current) => ({ ...current, [request.id]: [] }));
    const w = workspaceRef.current,
      p = preferencesRef.current,
      envId = p.environmentIds[request.collectionId],
      env = requestEnvironment(w, request, envId);
    try {
      await saveQueue.current;
      await api.savePreferences(p);
      const result = await api.execute(operationId, effectiveRequest(w, request), env);
      setResponses((current) => ({ ...current, [request.id]: result.response }));
      setWorkspace((current) =>
        applyEnvironment(current, request.collectionId, envId, env, result.environment),
      );
      return result.response;
    } catch (error) {
      setErrors((current) => ({ ...current, [request.id]: String(error) }));
      throw error;
    } finally {
      delete busyRef.current[request.id];
      setBusy({ ...busyRef.current });
    }
  }, []);
  const toggleSocket = useCallback(async (request: ApiRequest) => {
    const socket = socketsRef.current[request.id];
    if (socket?.status === 'connecting') return;
    if (socket?.status === 'open') {
      await api.call('websocket_send', { connectionId: socket.id, data: '', close: true });
      return;
    }
    const connectionId = id();
    const next = { ...socketsRef.current, [request.id]: { id: connectionId, status: 'connecting' as const } };
    socketsRef.current = next;
    setSockets(next);
    try {
      await api.call('websocket_connect', {
        connectionId,
        request: effectiveRequest(workspaceRef.current, request),
        environment: requestEnvironment(
          workspaceRef.current,
          request,
          preferencesRef.current.environmentIds[request.collectionId],
        ),
      });
    } catch (error) {
      setSockets((current) => ({ ...current, [request.id]: { id: connectionId, status: 'closed' } }));
      throw error;
    }
  }, []);
  const sendSelected = useCallback(() => {
    if (!selected) return;
    if (selected.protocol === 'websocket') {
      void toggleSocket(selected).catch(onError);
    } else if (busyRef.current[selected.id]) {
      void api.call('cancel_request', { operationId: busyRef.current[selected.id] }).catch(onError);
    } else {
      void runRequest(selected).catch(() => {});
    }
  }, [selected, toggleSocket, onError, runRequest]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !dialog) {
        event.preventDefault();
        sendSelected();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n' && !dialog) {
        event.preventDefault();
        addRequest();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [sendSelected, addRequest, dialog]);

  const newCollectionDialog = () =>
    setNaming({
      title: '新建集合',
      save: (name) => {
        const c = newCollection(name);
        setWorkspace((current) => ({ ...current, collections: [...current.collections, c] }));
        setCollectionId(c.id);
        setSelectedId('');
      },
    });
  const folderDialog = (parentId: string | null = null) =>
    setNaming({
      title: '新建文件夹',
      save: (name) =>
        setWorkspace((current) => ({
          ...current,
          folders: [
            ...current.folders,
            { id: id(), collectionId, parentId, name, environment: {}, authentication: { type: 'inherit' } },
          ],
        })),
    });
  const deleteRequest = (request: ApiRequest) =>
    setConfirmation({
      title: '删除请求',
      body: `删除“${request.name}”？该操作不能撤销。`,
      run: () => {
        const socket = socketsRef.current[request.id];
        if (socket?.status === 'open')
          void api.call('websocket_send', { connectionId: socket.id, data: '', close: true }).catch(onError);
        setWorkspace((current) => ({
          ...current,
          requests: current.requests.filter((r) => r.id !== request.id),
        }));
        setTabs((current) => current.filter((id) => id !== request.id));
        if (selectedId === request.id) setSelectedId('');
      },
    });
  const deleteFolder = (folder: RequestFolder) =>
    setConfirmation({
      title: '删除文件夹',
      body: `删除“${folder.name}”及其中的全部请求？`,
      run: () => {
        const ids = new Set([folder.id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const item of workspaceRef.current.folders)
            if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) {
              ids.add(item.id);
              changed = true;
            }
        }
        setWorkspace((current) => ({
          ...current,
          folders: current.folders.filter((f) => !ids.has(f.id)),
          requests: current.requests.filter((r) => !r.folderId || !ids.has(r.folderId)),
        }));
      },
    });
  const collectionRequests = workspace.requests.filter((r) => r.collectionId === collectionId),
    filtered = collectionRequests.filter((r) =>
      `${r.name} ${r.url} ${r.method}`.toLowerCase().includes(search.toLowerCase()),
    );
  const methodLabel = (request: ApiRequest) =>
    request.protocol === 'websocket'
      ? 'WS'
      : request.protocol === 'grpc'
        ? 'RPC'
        : request.protocol === 'graphql'
          ? 'GQL'
          : request.method;
  const requestItem = (r: ApiRequest) => (
    <div key={r.id} className={`request-row ${selectedId === r.id ? 'active' : ''}`}>
      <button className="request-link" onClick={() => openRequest(r)} title={r.url}>
        <span className={`method method-${methodLabel(r).toLowerCase()}`}>{methodLabel(r)}</span>
        <span>{r.name}</span>
        {busy[r.id] && <span className="spinner tiny" />}
      </button>
      <IconButton
        label={`复制 ${r.name}`}
        onClick={() => {
          const copy = { ...structuredClone(r), id: id(), name: `${r.name} 副本` };
          setWorkspace((current) => ({ ...current, requests: [...current.requests, copy] }));
          openRequest(copy);
        }}
      >
        <Copy size={12} />
      </IconButton>
    </div>
  );
  const folderTree = (parentId: string | null, depth = 0): ReactNode =>
    depth > 30
      ? null
      : workspace.folders
          .filter((f) => f.collectionId === collectionId && f.parentId === parentId)
          .map((folder) => (
            <div className="folder-group" key={folder.id}>
              <div className="folder-row">
                <button
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(folder.id)) next.delete(folder.id);
                      else next.add(folder.id);
                      return next;
                    })
                  }
                >
                  {collapsed.has(folder.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  <Folder size={14} />
                  <span>{folder.name}</span>
                </button>
                <IconButton
                  label={`在 ${folder.name} 中新建请求`}
                  onClick={() => addRequest('http', folder.id)}
                >
                  <Plus size={13} />
                </IconButton>
                <IconButton
                  label={`重命名 ${folder.name}`}
                  onClick={() =>
                    setNaming({
                      title: '重命名文件夹',
                      initial: folder.name,
                      save: (name) =>
                        setWorkspace((current) => ({
                          ...current,
                          folders: current.folders.map((f) => (f.id === folder.id ? { ...f, name } : f)),
                        })),
                    })
                  }
                >
                  <Pencil size={12} />
                </IconButton>
                <IconButton label={`删除 ${folder.name}`} onClick={() => deleteFolder(folder)}>
                  <Trash2 size={12} />
                </IconButton>
              </div>
              {!collapsed.has(folder.id) && (
                <div className="folder-children">
                  {folderTree(folder.id, depth + 1)}
                  {filtered.filter((r) => r.folderId === folder.id).map(requestItem)}
                </div>
              )}
            </div>
          ));
  const acceptImport = (text: string, name?: string) => {
    const result = importContent(text, name);
    const merged = mergeImport(workspaceRef.current, result.workspace);
    const imported = merged.collections[workspaceRef.current.collections.length];
    setWorkspace(merged);
    setCollectionId(imported.id);
    const request = merged.requests.find((r) => r.collectionId === imported.id);
    if (request) openRequest(request);
    setNotice(`已导入 ${result.workspace.requests.length} 个请求。`);
    return result.warnings;
  };
  const runCollection = async () => {
    runnerCancelled.current = false;
    setRunnerRunning(true);
    setRunnerLog([]);
    for (const request of collectionRequests) {
      if (runnerCancelled.current) break;
      if (request.protocol === 'websocket') {
        setRunnerLog((current) => [...current, `跳过 ${request.name}：请在编辑器中建立 WebSocket 长连接。`]);
        continue;
      }
      try {
        const result = await runRequest(request);
        const failed =
          (result.protocol === 'http' && result.status >= 400) ||
          result.logs.some((log) => /^(FAIL |Plugin\/script:)/.test(log));
        setRunnerLog((current) => [
          ...current,
          `${failed ? 'FAIL' : 'PASS'}  ${request.name} · ${result.status} · ${result.elapsedMs} ms`,
          ...result.logs,
        ]);
      } catch (error) {
        setRunnerLog((current) => [...current, `FAIL  ${request.name} · ${String(error)}`]);
      }
    }
    setRunnerRunning(false);
  };

  if (loadError)
    return (
      <main className="boot-screen">
        <AlertTriangle size={32} />
        <h1>本地工作区加载失败</h1>
        <p>为保护现有数据，已停止自动保存。</p>
        <pre>{loadError}</pre>
        <button onClick={() => location.reload()}>重试</button>
      </main>
    );
  if (!loaded)
    return (
      <main className="boot-screen">
        <Moon size={38} />
        <span className="spinner" />
        <p>正在加载本地工作区…</p>
      </main>
    );
  return (
    <div className="app-shell">
      <nav className="rail" aria-label="应用导航">
        <button className="brand" title="Insomnia Local" onClick={() => setDialog('about')}>
          <Moon size={26} fill="currentColor" />
        </button>
        <div className="rail-top">
          <IconButton label="请求集合" className="rail-active" onClick={() => setDialog(null)}>
            <Braces size={21} />
          </IconButton>
          <IconButton label="环境变量" onClick={() => setDialog('environment')}>
            <Globe size={20} />
          </IconButton>
          <IconButton label="集合运行器" onClick={() => setDialog('runner')}>
            <Play size={20} />
          </IconButton>
          <IconButton label="Git 同步" onClick={() => setDialog('git')}>
            <GitBranch size={20} />
          </IconButton>
        </div>
        <div className="rail-bottom">
          <IconButton label="插件" onClick={() => setDialog('plugins')}>
            <Puzzle size={20} />
          </IconButton>
          <IconButton label="设置" onClick={() => setDialog('settings')}>
            <Settings2 size={20} />
          </IconButton>
          <span className="local-avatar" title="本地工作区，无需帐号">
            L
          </span>
        </div>
      </nav>
      <aside className="sidebar">
        <header className="workspace-header">
          <div className="eyebrow">PERSONAL WORKSPACE</div>
          <div className="workspace-name">
            <span>本地工作区</span>
            <span className="local-badge">
              <Circle size={6} fill="currentColor" />
              LOCAL
            </span>
          </div>
          <div className="collection-select">
            <select
              aria-label="当前集合"
              value={collectionId}
              onChange={(event) => {
                const value = event.target.value;
                setCollectionId(value);
                setPreferences((current) => ({ ...current, activeCollectionId: value }));
                setSelectedId(workspace.requests.find((r) => r.collectionId === value)?.id ?? '');
              }}
            >
              {workspace.collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              {!workspace.collections.length && <option value="">没有集合</option>}
            </select>
            <IconButton label="新建集合" onClick={newCollectionDialog}>
              <Plus size={16} />
            </IconButton>
            {collection && (
              <IconButton
                label="重命名集合"
                onClick={() =>
                  setNaming({
                    title: '重命名集合',
                    initial: collection.name,
                    save: (name) =>
                      setWorkspace((current) => ({
                        ...current,
                        collections: current.collections.map((c) =>
                          c.id === collectionId ? { ...c, name } : c,
                        ),
                      })),
                  })
                }
              >
                <Pencil size={13} />
              </IconButton>
            )}
          </div>
        </header>
        <div className="sidebar-search">
          <Search size={15} />
          <input
            aria-label="搜索请求"
            placeholder="搜索请求…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <kbd>/</kbd>
        </div>
        <div className="sidebar-section-title">
          <span>
            COLLECTION <small>{collectionRequests.length}</small>
          </span>
          <div>
            <IconButton label="新建文件夹" onClick={() => folderDialog()} disabled={!collection}>
              <FolderPlus size={16} />
            </IconButton>
            <IconButton label="新建请求" onClick={() => addRequest()} disabled={!collection}>
              <Plus size={17} />
            </IconButton>
          </div>
        </div>
        <div className="request-tree">
          {search ? (
            filtered.map(requestItem)
          ) : (
            <>
              {folderTree(null)}
              {filtered.filter((r) => !r.folderId).map(requestItem)}
            </>
          )}
          {!filtered.length && (
            <div className="sidebar-empty">
              {search ? '没有匹配的请求' : '创建请求，开始构建你的集合。'}
              <button className="text-button" onClick={collection ? () => addRequest() : newCollectionDialog}>
                <Plus size={14} />
                {collection ? '新建请求' : '新建集合'}
              </button>
            </div>
          )}
        </div>
        <div className="sidebar-actions">
          <button onClick={() => setDialog('import')}>
            <Upload size={15} />
            导入
          </button>
          <button onClick={() => setDialog('export')}>
            <Download size={15} />
            导出
          </button>
        </div>
        <div className="sidebar-footer">
          <Database size={13} />
          <span>数据保存在此设备</span>
          <span className={saveState === 'error' ? 'text-danger' : 'save-dot'} title={saveState} />
        </div>
      </aside>
      <main className="main">
        <header className="main-header">
          <div className="breadcrumb">
            <Folder size={14} />
            <span>{collection?.name ?? '工作区'}</span>
            <ChevronRight size={13} />
            <span>{selected?.name ?? '概览'}</span>
          </div>
          <div className="header-tools">
            <div className="environment-switch">
              <Circle size={7} fill="currentColor" />
              <select
                aria-label="当前环境"
                value={environmentId ?? ''}
                onChange={(event) =>
                  setPreferences((current) => ({
                    ...current,
                    environmentIds: { ...current.environmentIds, [collectionId]: event.target.value },
                  }))
                }
              >
                <option value="">基础环境</option>
                {workspace.environments
                  .filter((e) => e.collectionId === collectionId)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
              </select>
              <IconButton label="编辑环境" onClick={() => setDialog('environment')}>
                <Settings2 size={14} />
              </IconButton>
            </div>
          </div>
        </header>
        <div className="request-tabs">
          {tabs
            .map((tabId) => workspace.requests.find((r) => r.id === tabId))
            .filter((r): r is ApiRequest => Boolean(r))
            .map((r) => (
              <div key={r.id} className={selectedId === r.id ? 'selected' : ''}>
                <button onClick={() => openRequest(r)}>
                  <span className={`method method-${methodLabel(r).toLowerCase()}`}>{methodLabel(r)}</span>
                  {r.name}
                </button>
                <IconButton
                  label={`关闭 ${r.name} 标签`}
                  onClick={() => {
                    setTabs((current) => current.filter((item) => item !== r.id));
                    if (selectedId === r.id) setSelectedId(tabs.find((item) => item !== r.id) ?? '');
                  }}
                >
                  <X size={12} />
                </IconButton>
              </div>
            ))}
          <IconButton label="添加请求标签" onClick={() => addRequest()} disabled={!collection}>
            <Plus size={16} />
          </IconButton>
        </div>
        {selected ? (
          <div className="request-workspace">
            <div className="request-title">
              <input
                aria-label="请求名称"
                value={selected.name}
                onChange={(event) => updateRequest({ name: event.target.value })}
              />
              <div>
                <select
                  aria-label="请求所属文件夹"
                  value={selected.folderId ?? ''}
                  onChange={(event) => updateRequest({ folderId: event.target.value || null })}
                >
                  <option value="">集合根目录</option>
                  {workspace.folders
                    .filter((f) => f.collectionId === selected.collectionId)
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
                <IconButton
                  label="复制为 cURL"
                  disabled={!['http', 'graphql'].includes(selected.protocol)}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(exportCurl(selected))
                      .then(() => setNotice('已复制 cURL 命令。'))
                      .catch(onError);
                  }}
                >
                  <Code2 size={16} />
                </IconButton>
                <IconButton label="删除当前请求" onClick={() => deleteRequest(selected)}>
                  <Trash2 size={16} />
                </IconButton>
              </div>
            </div>
            <div className="url-bar">
              <select
                className="protocol-select"
                aria-label="请求协议"
                value={selected.protocol}
                onChange={(event) => {
                  const protocol = event.target.value as Protocol;
                  updateRequest({
                    protocol,
                    ...(protocol === 'graphql'
                      ? { method: 'POST', body: { ...selected.body, mimeType: 'application/graphql' } }
                      : {}),
                  });
                }}
              >
                <option value="http">HTTP</option>
                <option value="graphql">GraphQL</option>
                <option value="websocket">WebSocket</option>
                <option value="grpc">gRPC</option>
              </select>
              {['http', 'graphql'].includes(selected.protocol) && (
                <select
                  className={`method-select method-${selected.method.toLowerCase()}`}
                  aria-label="HTTP 方法"
                  value={selected.method}
                  onChange={(event) => updateRequest({ method: event.target.value })}
                >
                  {[
                    ...new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', selected.method]),
                  ].map((method) => (
                    <option key={method}>{method}</option>
                  ))}
                </select>
              )}
              <input
                aria-label="请求 URL"
                placeholder={
                  selected.protocol === 'grpc'
                    ? 'localhost:50051'
                    : selected.protocol === 'websocket'
                      ? 'wss://example.com/socket'
                      : 'https://api.example.com/users'
                }
                value={selected.url}
                onChange={(event) => updateRequest({ url: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') sendSelected();
                }}
              />
              <button
                className={`send-button ${busy[selected.id] ? 'cancel' : ''}`}
                onClick={sendSelected}
                disabled={sockets[selected.id]?.status === 'connecting'}
              >
                {selected.protocol === 'websocket' ? (
                  <>
                    <Cable size={16} />
                    {sockets[selected.id]?.status === 'open'
                      ? '断开'
                      : sockets[selected.id]?.status === 'connecting'
                        ? '连接中'
                        : '连接'}
                  </>
                ) : busy[selected.id] ? (
                  <>
                    <Square size={14} />
                    取消
                  </>
                ) : (
                  <>
                    <Send size={15} />
                    发送
                  </>
                )}
              </button>
            </div>
            <RequestEditor
              key={selected.id}
              request={selected}
              onChange={updateRequest}
              environment={environment}
              onError={onError}
              scriptsEnabled={preferences.scriptsEnabled}
            />
            {selected.protocol === 'websocket' ? (
              <SocketPanel
                events={socketEvents[selected.id] ?? []}
                connected={sockets[selected.id]?.status === 'open'}
                onError={onError}
                onSend={async (data) => {
                  await api.call('websocket_send', {
                    connectionId: sockets[selected.id]?.id,
                    data,
                    close: false,
                  });
                  setSocketEvents((current) => ({
                    ...current,
                    [selected.id]: [
                      ...(current[selected.id] ?? []),
                      { connectionId: sockets[selected.id].id, kind: 'sent', data, timestamp: Date.now() },
                    ].slice(-500) as SocketEvent[],
                  }));
                }}
              />
            ) : (
              <>
                {selected.protocol === 'grpc' &&
                  busy[selected.id] &&
                  (liveGrpc[selected.id]?.length ?? 0) > 0 && (
                    <div className="grpc-live">
                      <span>流式响应 · {liveGrpc[selected.id].length} 条</span>
                      <pre>{liveGrpc[selected.id].slice(-3).join('\n')}</pre>
                    </div>
                  )}
                <ResponsePanel
                  key={`response-${selected.id}`}
                  response={responses[selected.id]}
                  busy={Boolean(busy[selected.id])}
                  error={errors[selected.id]}
                  history={history}
                  onHistory={() => {
                    void api
                      .call<ResponseData[]>('request_history', { requestId: selected.id })
                      .then(setHistory)
                      .catch(onError);
                  }}
                  onSelect={(response) =>
                    setResponses((current) => ({ ...current, [selected.id]: response }))
                  }
                  onError={onError}
                />
              </>
            )}
          </div>
        ) : (
          <div className="welcome">
            <div className="welcome-mark">
              <Moon size={40} fill="currentColor" />
            </div>
            <span className="eyebrow">YOUR APIS. YOUR WORKSPACE.</span>
            <h1>从一个请求开始。</h1>
            <p>
              一个专注、本地、无需帐号的 API 工作区。
              <br />
              发送请求，理解响应，让每次调试更简单。
            </p>
            <div>
              <button className="primary" onClick={collection ? () => addRequest() : newCollectionDialog}>
                <Plus size={16} />
                {collection ? '新建请求' : '新建集合'}
              </button>
              <button onClick={() => setDialog('import')}>
                <Upload size={16} />
                导入现有集合
              </button>
            </div>
            <div className="protocol-cards">
              {(
                [
                  ['http', 'HTTP / REST', Globe],
                  ['graphql', 'GraphQL', Braces],
                  ['websocket', 'WebSocket', Cable],
                  ['grpc', 'gRPC', Code2],
                ] as const
              ).map(([protocol, label, Icon]) => (
                <button key={protocol} onClick={() => addRequest(protocol)} disabled={!collection}>
                  <Icon size={20} />
                  <span>{label}</span>
                  <ExternalLink size={12} />
                </button>
              ))}
            </div>
          </div>
        )}
        <footer className="statusbar">
          <span>
            <Circle size={6} fill="currentColor" />
            本地模式
          </span>
          <span>
            {api.desktop
              ? saveState === 'saving'
                ? '正在保存…'
                : saveState === 'error'
                  ? '保存失败'
                  : saveState === 'saved'
                    ? '所有更改已保存'
                    : '加载中'
              : '浏览器预览 · 数据不保存'}
          </span>
          <span className="status-right">
            Rust + Tauri <span className="separator">|</span> Ctrl + Enter 发送请求
          </span>
        </footer>
      </main>
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {error && (
        <div className="error-toast" role="alert">
          <AlertTriangle size={18} />
          <span>{error}</span>
          <IconButton label="关闭错误提示" onClick={() => setError('')}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      {naming && (
        <NameDialog
          title={naming.title}
          initial={naming.initial}
          onSave={naming.save}
          onClose={() => setNaming(null)}
        />
      )}{' '}
      {confirmation && (
        <ConfirmDialog
          title={confirmation.title}
          onConfirm={confirmation.run}
          onClose={() => setConfirmation(null)}
        >
          {confirmation.body}
        </ConfirmDialog>
      )}
      {dialog === 'environment' && (
        <EnvironmentDialog
          workspace={workspace}
          collectionId={collectionId}
          setWorkspace={setWorkspace}
          onClose={() => setDialog(null)}
        />
      )}
      {(dialog === 'settings' || dialog === 'plugins') && (
        <SettingsDialog
          preferences={preferences}
          onChange={setPreferences}
          pluginsOnly={dialog === 'plugins'}
          onClose={() => setDialog(null)}
          onError={onError}
          onNotice={setNotice}
          onConfirm={setConfirmation}
        />
      )}
      {dialog === 'import' && (
        <ImportDialog
          onImport={acceptImport}
          onClose={() => setDialog(null)}
          onError={onError}
          onCurl={(text) => {
            if (!collectionId) throw new Error('请先创建集合。');
            const r = importCurl(text, collectionId);
            setWorkspace((current) => ({ ...current, requests: [...current.requests, r] }));
            openRequest(r);
          }}
        />
      )}
      {dialog === 'export' && (
        <ExportDialog
          workspace={workspace}
          onClose={() => setDialog(null)}
          onError={onError}
          onNotice={setNotice}
        />
      )}
      {dialog === 'git' && (
        <GitDialog
          workspace={workspace}
          directory={preferences.gitDirectory}
          onDirectory={(gitDirectory) => setPreferences((current) => ({ ...current, gitDirectory }))}
          onClose={() => setDialog(null)}
          onError={onError}
          onLoad={(value) => {
            const w = validateWorkspace(value);
            setConfirmation({
              title: '载入 Git 工作区',
              body: `将当前工作区替换为 Git 快照中的 ${w.collections.length} 个集合、${w.requests.length} 个请求。请先导出需要保留的本地数据。`,
              run: () => {
                setWorkspace(w);
                setCollectionId(w.collections[0]?.id ?? '');
                setSelectedId(w.requests[0]?.id ?? '');
                setTabs(w.requests[0] ? [w.requests[0].id] : []);
                setNotice('已载入 Git 工作区。');
              },
            });
          }}
        />
      )}
      {dialog === 'runner' && (
        <Modal
          title="集合运行器"
          subtitle={`按顺序执行 ${collection?.name ?? '当前集合'} 中的请求。请求会真实发送到目标接口。`}
          wide
          onClose={() => setDialog(null)}
        >
          <div className="runner-actions">
            <button
              className="primary"
              disabled={runnerRunning || !collectionRequests.length}
              onClick={() => {
                void runCollection();
              }}
            >
              <Play size={15} />
              运行 {collectionRequests.length} 个请求
            </button>
            {runnerRunning && (
              <button
                onClick={() => {
                  runnerCancelled.current = true;
                  Object.values(busyRef.current).forEach((operationId) => {
                    void api.call('cancel_request', { operationId }).catch(onError);
                  });
                }}
              >
                停止运行
              </button>
            )}
          </div>
          <pre className="runner-log">{runnerLog.join('\n') || '运行结果和脚本测试将在这里显示。'}</pre>
        </Modal>
      )}
      {dialog === 'about' && <AboutDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function EnvironmentDialog({
  workspace,
  collectionId,
  setWorkspace,
  onClose,
}: {
  workspace: Workspace;
  collectionId: string;
  setWorkspace: React.Dispatch<React.SetStateAction<Workspace>>;
  onClose: () => void;
}) {
  const [target, setTarget] = useState('base');
  const collection = workspace.collections.find((c) => c.id === collectionId);
  const selected = workspace.environments.find((e) => e.id === target);
  const folder = workspace.folders.find((f) => f.id === target);
  if (!collection)
    return (
      <Modal title="环境变量" onClose={onClose}>
        <p>请先创建一个集合。</p>
      </Modal>
    );
  const update = (value: JsonObject) =>
    setWorkspace((current) =>
      selected
        ? {
            ...current,
            environments: current.environments.map((e) => (e.id === target ? { ...e, data: value } : e)),
          }
        : folder
          ? {
              ...current,
              folders: current.folders.map((f) => (f.id === target ? { ...f, environment: value } : f)),
            }
          : {
              ...current,
              collections: current.collections.map((c) =>
                c.id === collectionId ? { ...c, environment: value } : c,
              ),
            },
    );
  return (
    <Modal
      title="环境变量"
      subtitle="使用 {{ _.variable }} 引用。覆盖顺序：基础环境 → 子环境 → 文件夹。"
      wide
      onClose={onClose}
    >
      <div className="environment-layout">
        <nav>
          <button className={target === 'base' ? 'active' : ''} onClick={() => setTarget('base')}>
            <Globe size={15} />
            基础环境
          </button>
          {workspace.environments
            .filter((e) => e.collectionId === collectionId)
            .map((e) => (
              <button key={e.id} className={target === e.id ? 'active' : ''} onClick={() => setTarget(e.id)}>
                {e.name}
              </button>
            ))}
          <button
            onClick={() => {
              const e: Environment = { id: id(), collectionId, name: '新环境', data: {} };
              setWorkspace((current) => ({ ...current, environments: [...current.environments, e] }));
              setTarget(e.id);
            }}
          >
            <Plus size={14} />
            添加子环境
          </button>
          {workspace.folders
            .filter((f) => f.collectionId === collectionId)
            .map((f) => (
              <button key={f.id} className={target === f.id ? 'active' : ''} onClick={() => setTarget(f.id)}>
                <Folder size={13} />
                {f.name}
              </button>
            ))}
        </nav>
        <div className="environment-editor">
          {selected && (
            <div className="environment-name">
              <input
                aria-label="环境名称"
                value={selected.name}
                onChange={(event) =>
                  setWorkspace((current) => ({
                    ...current,
                    environments: current.environments.map((e) =>
                      e.id === target ? { ...e, name: event.target.value } : e,
                    ),
                  }))
                }
              />
              <IconButton
                label="删除子环境"
                onClick={() => {
                  setWorkspace((current) => ({
                    ...current,
                    environments: current.environments.filter((e) => e.id !== target),
                  }));
                  setTarget('base');
                }}
              >
                <Trash2 size={15} />
              </IconButton>
            </div>
          )}
          <JsonEditor
            key={target}
            label="环境 JSON"
            value={selected?.data ?? folder?.environment ?? collection.environment}
            onChange={update}
          />
          <p className="hint">普通环境变量按原文保存在本机数据库和导出文件中。</p>
        </div>
      </div>
    </Modal>
  );
}

function SettingsDialog({
  preferences,
  onChange,
  pluginsOnly,
  onClose,
  onError,
  onNotice,
  onConfirm,
}: {
  preferences: Preferences;
  onChange: React.Dispatch<React.SetStateAction<Preferences>>;
  pluginsOnly: boolean;
  onClose: () => void;
  onError: (error: unknown) => void;
  onNotice: (message: string) => void;
  onConfirm: (value: { title: string; body: ReactNode; run: () => void }) => void;
}) {
  return (
    <Modal
      title={pluginsOnly ? '本地插件' : '设置'}
      subtitle="无需帐号。插件和请求脚本使用本机 Node.js。"
      wide
      onClose={onClose}
    >
      <div className="settings-section">
        <h3>脚本与插件运行时</h3>
        <label className="field-label">
          Node.js 可执行文件
          <input
            value={preferences.nodePath}
            placeholder="留空使用 PATH 中的 node"
            onChange={(event) => onChange((current) => ({ ...current, nodePath: event.target.value }))}
          />
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={preferences.scriptsEnabled}
            onChange={(event) =>
              onChange((current) => ({ ...current, scriptsEnabled: event.target.checked }))
            }
          />
          启用可信请求脚本
        </label>
        <p className="hint">脚本和插件具有本机 Node.js 权限，请仅启用你信任的代码。每次执行上限 15 秒。</p>
      </div>
      <div className="settings-section">
        <div className="section-heading">
          <h3>
            已安装插件 <span className="count">{preferences.plugins.length}</span>
          </h3>
          <button
            onClick={() => {
              void api
                .pickPath('folder')
                .then(async (directory) => {
                  if (!directory) return;
                  const plugin = await api.call<Plugin>('inspect_plugin', { directory });
                  onChange((current) => ({
                    ...current,
                    plugins: [...current.plugins.filter((p) => p.path !== directory), plugin],
                  }));
                })
                .catch(onError);
            }}
          >
            <Plus size={15} />
            添加插件目录
          </button>
        </div>
        {preferences.plugins.length ? (
          preferences.plugins.map((plugin) => (
            <div className="plugin-row" key={plugin.path}>
              <Puzzle size={21} />
              <div>
                <strong>{plugin.name}</strong>
                <small>
                  v{plugin.version} · {plugin.path}
                </small>
                <p>{plugin.description}</p>
              </div>
              <label className="check-field">
                <input
                  type="checkbox"
                  aria-label={`启用 ${plugin.name}`}
                  checked={plugin.enabled}
                  onChange={(event) =>
                    onChange((current) => ({
                      ...current,
                      plugins: current.plugins.map((p) =>
                        p.path === plugin.path ? { ...p, enabled: event.target.checked } : p,
                      ),
                    }))
                  }
                />
                启用
              </label>
              <IconButton
                label={`移除 ${plugin.name}`}
                onClick={() =>
                  onChange((current) => ({
                    ...current,
                    plugins: current.plugins.filter((p) => p.path !== plugin.path),
                  }))
                }
              >
                <X size={16} />
              </IconButton>
            </div>
          ))
        ) : (
          <p className="hint">
            选择包含 package.json 的插件目录。支持 requestHooks、responseHooks 和 context.store；不包含
            Electron 界面扩展。
          </p>
        )}
      </div>
      {!pluginsOnly && (
        <div className="settings-section">
          <h3>本地数据</h3>
          <div className="button-row">
            <button
              onClick={() => {
                void api
                  .call('clear_cookies')
                  .then(() => onNotice('会话 Cookie 已清空。'))
                  .catch(onError);
              }}
            >
              清空会话 Cookie
            </button>
            <button
              onClick={() =>
                onConfirm({
                  title: '清空响应历史',
                  body: '将删除本机保存的全部响应历史，集合和请求会保留。',
                  run: () => {
                    void api
                      .call('clear_history')
                      .then(() => onNotice('响应历史已清空。'))
                      .catch(onError);
                  },
                })
              }
            >
              清空响应历史
            </button>
          </div>
          <p className="hint">
            Cookie 按集合隔离，仅在当前应用会话中保存。最近 200 条响应保存在 SQLite，总量限制 100 MiB。
          </p>
        </div>
      )}
    </Modal>
  );
}

function ImportDialog({
  onImport,
  onClose,
  onError,
  onCurl,
}: {
  onImport: (text: string, name?: string) => string[];
  onClose: () => void;
  onError: (error: unknown) => void;
  onCurl: (text: string) => void;
}) {
  const [text, setText] = useState(''),
    [warnings, setWarnings] = useState<string[] | null>(null);
  const importText = (text: string, name?: string) => {
    try {
      const issues = onImport(text, name);
      setWarnings(issues);
    } catch (error) {
      onError(error);
    }
  };
  return (
    <Modal
      title="导入到本地工作区"
      subtitle="Insomnia v4/v5 · Postman · OpenAPI · HAR · cURL · 本地备份"
      wide
      onClose={onClose}
    >
      {warnings ? (
        <>
          <div className="success-banner">
            <Check size={18} />
            导入完成
          </div>
          {warnings.length ? (
            <>
              <p>以下内容需要适配，原始资源保留在本地备份中：</p>
              <ul className="import-warnings">
                {warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>集合与请求已添加到工作区。</p>
          )}
          <footer>
            <button className="primary" onClick={onClose}>
              完成
            </button>
          </footer>
        </>
      ) : (
        <>
          <button
            className="file-drop"
            onClick={() => {
              void api
                .call<{ name: string; contents: string } | null>('import_file')
                .then((file) => {
                  if (file) importText(file.contents, file.name);
                })
                .catch(onError);
            }}
          >
            <Upload size={28} />
            <strong>选择导出文件</strong>
            <span>JSON、YAML、HAR · 最大 64 MiB</span>
          </button>
          <div className="divider-label">或粘贴内容</div>
          <CodeEditor
            label="导入内容"
            value={text}
            onChange={setText}
            placeholder="粘贴集合 JSON / YAML，或 curl 命令"
          />
          <footer>
            <button onClick={onClose}>取消</button>
            <button
              className="primary"
              disabled={!text.trim()}
              onClick={() => {
                if (text.trimStart().startsWith('curl ')) {
                  try {
                    onCurl(text);
                    setWarnings([]);
                  } catch (error) {
                    onError(error);
                  }
                } else importText(text);
              }}
            >
              导入
            </button>
          </footer>
        </>
      )}
    </Modal>
  );
}

function ExportDialog({
  workspace,
  onClose,
  onError,
  onNotice,
}: {
  workspace: Workspace;
  onClose: () => void;
  onError: (error: unknown) => void;
  onNotice: (message: string) => void;
}) {
  const [format, setFormat] = useState('local');
  return (
    <Modal title="导出工作区" onClose={onClose}>
      <p>
        {workspace.collections.length} 个集合 · {workspace.requests.length} 个请求 ·{' '}
        {workspace.environments.length} 个子环境
      </p>
      <label className="field-label">
        文件格式
        <select value={format} onChange={(event) => setFormat(event.target.value)}>
          <option value="local">Insomnia Local JSON（完整备份）</option>
          <option value="yaml">Insomnia Local YAML（完整备份）</option>
          <option value="insomnia">Insomnia v4 JSON（兼容格式）</option>
        </select>
      </label>
      <p className="hint">导出包含环境变量和接口认证信息。完整备份还包含未迁移的原始资源。</p>
      {format === 'insomnia' && workspace.unmigrated.length > 0 && (
        <p className="warning-banner">
          兼容格式不含 {workspace.unmigrated.length} 个未迁移资源；请另存完整备份。
        </p>
      )}
      <footer>
        <button onClick={onClose}>取消</button>
        <button
          className="primary"
          onClick={() => {
            void api
              .call<string | null>('export_file', {
                name:
                  format === 'yaml'
                    ? 'insomnia-local.yaml'
                    : format === 'insomnia'
                      ? 'insomnia-export.json'
                      : 'insomnia-local.json',
                contents:
                  format === 'insomnia'
                    ? exportInsomnia(workspace)
                    : format === 'yaml'
                      ? exportYaml(workspace)
                      : JSON.stringify(workspace, null, 2),
                binary: false,
              })
              .then((path) => {
                if (path) {
                  onNotice(`已导出到 ${path}`);
                  onClose();
                }
              })
              .catch(onError);
          }}
        >
          <Download size={15} />
          导出文件
        </button>
      </footer>
    </Modal>
  );
}

function GitDialog({
  workspace,
  directory,
  onDirectory,
  onClose,
  onError,
  onLoad,
}: {
  workspace: Workspace;
  directory: string;
  onDirectory: (path: string) => void;
  onClose: () => void;
  onError: (error: unknown) => void;
  onLoad: (workspace: unknown) => void;
}) {
  const [message, setMessage] = useState('Update API workspace'),
    [status, setStatus] = useState('选择现有 Git 仓库目录，或初始化空目录。'),
    [busy, setBusy] = useState(false);
  const action = async (action: string) => {
    setBusy(true);
    try {
      const result = await api.call<{ status: string; snapshot?: unknown }>('git_operation', {
        directory,
        action,
        message,
        snapshot: action === 'commit' ? workspace : null,
      });
      setStatus(result.status || '工作区干净。');
      if (result.snapshot) onLoad(result.snapshot);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Git 同步" subtitle="使用系统 Git 与已有凭据，无需 Insomnia 帐号。" wide onClose={onClose}>
      <label className="field-label">
        仓库目录
        <div className="input-with-button">
          <input value={directory} onChange={(event) => onDirectory(event.target.value)} />
          <button
            onClick={() => {
              void api
                .pickPath('folder')
                .then((path) => {
                  if (path) onDirectory(path);
                })
                .catch(onError);
            }}
          >
            选择目录
          </button>
        </div>
      </label>
      <div className="button-row">
        {[
          ['init', '初始化'],
          ['status', '刷新状态'],
          ['read', '载入快照'],
          ['pull', '拉取'],
          ['push', '推送'],
        ].map(([key, label]) => (
          <button
            key={key}
            disabled={busy || !directory}
            onClick={() => {
              void action(key);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <pre className="git-status">{busy ? 'Git 操作进行中…' : status}</pre>
      <label className="field-label">
        提交说明
        <input value={message} onChange={(event) => setMessage(event.target.value)} />
      </label>
      <button
        className="primary"
        disabled={busy || !directory || !message.trim()}
        onClick={() => {
          void action('commit');
        }}
      >
        <GitBranch size={15} />
        保存快照并提交
      </button>
      <p className="hint">
        仅提交 insomnia-local.json。快照包含环境变量和接口凭据，请使用合适的私有仓库。首次使用请在终端配置
        remote、上游分支和 Git 身份；拉取只允许 fast-forward。
      </p>
    </Modal>
  );
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<{ version: string; dataDirectory: string; engine: string } | null>(null);
  useEffect(() => {
    if (api.desktop)
      void api
        .call<typeof info>('app_info')
        .then(setInfo)
        .catch(() => {});
  }, []);
  return (
    <Modal title="Insomnia Local" subtitle="Rust + Tauri 重构 · 本地优先 · 无帐号" onClose={onClose}>
      <div className="about-logo">
        <Moon size={46} fill="currentColor" />
      </div>
      <p>HTTP / GraphQL、WebSocket、动态 gRPC、本地集合、环境变量、响应历史、脚本钩子和 Git 快照。</p>
      <p className="hint">
        兼容范围与原版差异见项目 README.md / MIGRATION.md。云协作、Electron 专用插件和 Socket.IO/MCP
        尚未迁移。
      </p>
      {info && (
        <div className="about-info">
          <span>版本 {info.version}</span>
          <span>{info.engine}</span>
          <code>{info.dataDirectory}</code>
        </div>
      )}
      <p className="hint">独立社区重构项目，与 Kong 官方发行版无关联。</p>
    </Modal>
  );
}
