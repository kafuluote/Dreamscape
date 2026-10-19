import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Plus,
  Trash2,
  X,
  FolderOpen,
  Copy,
  Download,
  Braces,
  Clock3,
  ArrowDownLeft,
  ArrowUpRight,
  Circle,
  Check,
  AlertCircle,
} from 'lucide-react';
import { call, pickPath } from './api';
import { pair, type Pair, type ResponseData, type SocketEvent } from './types';

export function IconButton({
  label,
  children,
  onClick,
  disabled = false,
  className = '',
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`modal ${wide ? 'wide' : ''}`}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <IconButton label="关闭" onClick={onClose}>
          <X size={19} />
        </IconButton>
      </header>
      <div className="modal-content">{children}</div>
    </dialog>
  );
}
export function NameDialog({
  title,
  initial = '',
  onSave,
  onClose,
}: {
  title: string;
  initial?: string;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) {
            onSave(name.trim());
            onClose();
          }
        }}
      >
        <label className="field-label">
          名称
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="输入名称"
            required
          />
        </label>
        <footer>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={!name.trim()}>
            保存
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function ConfirmDialog({
  title,
  children,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <p>{children}</p>
      <footer>
        <button onClick={onClose}>取消</button>
        <button
          className="danger"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          确认
        </button>
      </footer>
    </Modal>
  );
}
export function CodeEditor({
  value,
  onChange,
  label,
  placeholder,
  readOnly = false,
  small = false,
}: {
  value: string;
  onChange?: (value: string) => void;
  label: string;
  placeholder?: string;
  readOnly?: boolean;
  small?: boolean;
}) {
  return (
    <textarea
      className={`code-editor ${small ? 'small' : ''}`}
      spellCheck={false}
      aria-label={label}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      readOnly={readOnly}
      placeholder={placeholder}
      onKeyDown={(event) => {
        if (event.key === 'Tab' && !readOnly) {
          event.preventDefault();
          const target = event.currentTarget,
            start = target.selectionStart,
            end = target.selectionEnd;
          onChange?.(value.slice(0, start) + '  ' + value.slice(end));
          requestAnimationFrame(() => {
            target.selectionStart = target.selectionEnd = start + 2;
          });
        }
      }}
    />
  );
}
export function PairEditor({
  values,
  onChange,
  form = false,
  onError,
}: {
  values: Pair[];
  onChange: (values: Pair[]) => void;
  form?: boolean;
  onError: (error: unknown) => void;
}) {
  const update = (index: number, patch: Partial<Pair>) =>
    onChange(values.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  return (
    <div className="pair-editor">
      <div className="pair-head">
        <span />
        <span>名称</span>
        <span>值</span>
        <span />
      </div>
      {values.map((item, index) => (
        <div className={`pair-row ${item.disabled ? 'disabled-row' : ''}`} key={index}>
          <input
            type="checkbox"
            aria-label={`启用第 ${index + 1} 项`}
            checked={!item.disabled}
            onChange={(event) => update(index, { disabled: !event.target.checked })}
          />
          <input
            aria-label={`第 ${index + 1} 项名称`}
            value={item.name}
            placeholder="名称"
            onChange={(event) => update(index, { name: event.target.value })}
          />
          <div className="pair-value">
            {form && (
              <select
                aria-label={`第 ${index + 1} 项类型`}
                value={item.type || 'text'}
                onChange={(event) => update(index, { type: event.target.value })}
              >
                <option value="text">文本</option>
                <option value="file">文件</option>
              </select>
            )}
            <input
              aria-label={`第 ${index + 1} 项值`}
              value={item.type === 'file' ? item.fileName || '' : item.value}
              placeholder="值 · 支持 {{ _.variable }}"
              onChange={(event) =>
                update(
                  index,
                  item.type === 'file' ? { fileName: event.target.value } : { value: event.target.value },
                )
              }
            />
            {item.type === 'file' && (
              <IconButton
                label="选择上传文件"
                onClick={() => {
                  void pickPath('file')
                    .then((path) => {
                      if (path) update(index, { fileName: path });
                    })
                    .catch(onError);
                }}
              >
                <FolderOpen size={15} />
              </IconButton>
            )}
          </div>
          <IconButton
            label={`删除第 ${index + 1} 项`}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          >
            <Trash2 size={14} />
          </IconButton>
        </div>
      ))}
      <button className="text-button add-row" onClick={() => onChange([...values, pair()])}>
        <Plus size={14} />
        添加一项
      </button>
      {!values.length && <p className="hint empty-hint">没有配置项。添加后可通过复选框临时禁用。</p>}
    </div>
  );
}
export function JsonEditor({
  value,
  onChange,
  label,
}: {
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  label: string;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState('');
  return (
    <>
      <CodeEditor
        label={label}
        value={text}
        onChange={(text) => {
          setText(text);
          try {
            const data: unknown = JSON.parse(text);
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('请输入 JSON 对象');
            setError('');
            onChange(data as Record<string, unknown>);
          } catch (error) {
            setError(String(error));
          }
        }}
      />
      {error && <p className="inline-error">{error}（此编辑尚未保存）</p>}
    </>
  );
}
export function EmptyState({
  children,
  title,
  icon = <Braces size={31} />,
}: {
  children: ReactNode;
  title: string;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-symbol">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
export function formatBytes(size: number): string {
  return size < 1024
    ? `${size} B`
    : size < 1048576
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1048576).toFixed(1)} MB`;
}

export function ResponsePanel({
  response,
  busy,
  error,
  history,
  onHistory,
  onSelect,
  onError,
}: {
  response?: ResponseData;
  busy: boolean;
  error?: string;
  history: ResponseData[];
  onHistory: () => void;
  onSelect: (response: ResponseData) => void;
  onError: (error: unknown) => void;
}) {
  const [tab, setTab] = useState('body');
  const [formatted, setFormatted] = useState(true);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      .writeText(response?.body || '')
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(onError);
  };
  return (
    <section className="response-panel">
      <header className="response-heading">
        <div className="section-label">响应 {busy && <span className="spinner" />}</div>
        {response && (
          <div className="response-stats">
            <span
              className={`status ${response.protocol === 'grpc' || response.status < 400 ? 'success' : 'failure'}`}
            >
              <Circle size={7} fill="currentColor" />
              {response.status} {response.statusText}
            </span>
            <span>
              <Clock3 size={13} />
              {response.elapsedMs} ms
            </span>
            <span>{formatBytes(response.size)}</span>
          </div>
        )}
      </header>
      <div className="tab-bar">
        <div className="tabs">
          {[
            ['body', '响应体'],
            ['headers', `响应头${response ? ` (${response.headers.length})` : ''}`],
            ['history', '历史'],
            ['logs', '日志 / 测试'],
          ].map(([key, name]) => (
            <button
              key={key}
              className={tab === key ? 'active' : ''}
              onClick={() => {
                setTab(key);
                if (key === 'history') onHistory();
              }}
            >
              {name}
            </button>
          ))}
        </div>
        {response && (
          <div className="response-tools">
            <IconButton label="复制响应" onClick={copy}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </IconButton>
            <IconButton
              label="保存原始响应"
              onClick={() => {
                void call('export_file', {
                  name: 'response.bin',
                  contents: response.bodyBase64,
                  binary: true,
                }).catch(onError);
              }}
            >
              <Download size={15} />
            </IconButton>
          </div>
        )}
      </div>
      {error && (
        <div className="request-error" role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}
      {response?.truncated && (
        <div className="warning-banner">响应超过大小上限，当前显示及下载内容已截断。</div>
      )}
      <div className="response-content">
        {tab === 'history' ? (
          <div className="history-list">
            {history.length ? (
              history.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    onSelect(item);
                    setTab('body');
                  }}
                >
                  <span className={item.status < 400 ? 'text-success' : 'text-danger'}>
                    {item.status} {item.statusText}
                  </span>
                  <span>{new Date(item.timestamp).toLocaleString()}</span>
                  <span>{item.elapsedMs} ms</span>
                  <span>{formatBytes(item.size)}</span>
                </button>
              ))
            ) : (
              <EmptyState title="没有历史记录" icon={<Clock3 size={28} />}>
                发送请求后，响应会保存在本机。
              </EmptyState>
            )}
          </div>
        ) : !response ? (
          <EmptyState title={busy ? '请求进行中…' : '等待一个响应'}>
            点击发送或按 <kbd>Ctrl</kbd> + <kbd>Enter</kbd> 开始调试你的 API。
          </EmptyState>
        ) : tab === 'headers' ? (
          <div className="read-table">
            {response.headers.map((p, i) => (
              <div key={i}>
                <strong>{p.name}</strong>
                <code>{p.value}</code>
              </div>
            ))}
          </div>
        ) : tab === 'logs' ? (
          <pre className="logs">{response.logs.join('\n') || '本次请求没有脚本或插件日志。'}</pre>
        ) : (
          <>
            <div className="body-toolbar">
              <button className={formatted ? 'selected' : ''} onClick={() => setFormatted(true)}>
                格式化
              </button>
              <button className={!formatted ? 'selected' : ''} onClick={() => setFormatted(false)}>
                原始
              </button>
              <span>
                {response.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ||
                  response.protocol.toUpperCase()}
              </span>
            </div>
            <pre className="response-body">{formatted ? pretty(response.body) : response.body}</pre>
          </>
        )}
      </div>
    </section>
  );
}

export function SocketPanel({
  events,
  onSend,
  connected,
  onError,
}: {
  events: SocketEvent[];
  onSend: (value: string) => Promise<void>;
  connected: boolean;
  onError: (error: unknown) => void;
}) {
  const [message, setMessage] = useState('');
  return (
    <section className="response-panel socket-panel">
      <header className="response-heading">
        <span className="section-label">
          WebSocket 消息 <span className="count">{events.length}</span>
        </span>
        <span className={connected ? 'text-success' : 'muted'}>{connected ? '已连接' : '未连接'}</span>
      </header>
      <div className="socket-messages">
        {events.length ? (
          events.map((event, i) => (
            <div className={`socket-message ${event.kind}`} key={i}>
              {event.kind === 'sent' ? <ArrowUpRight size={16} /> : <ArrowDownLeft size={16} />}
              <div>
                <span>
                  {event.kind} · {new Date(event.timestamp).toLocaleTimeString()}
                </span>
                <pre>
                  {event.data ||
                    (event.kind === 'open' ? '连接已建立' : event.kind === 'close' ? '连接已关闭' : '')}
                </pre>
              </div>
            </div>
          ))
        ) : (
          <EmptyState title="建立实时连接">连接后，在这里发送和接收 WebSocket 消息。</EmptyState>
        )}
      </div>
      <form
        className="socket-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void onSend(message).catch(onError);
        }}
      >
        <textarea
          aria-label="WebSocket 消息"
          placeholder='输入消息，例如 {"hello": "world"}'
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <button className="primary" disabled={!connected}>
          发送消息
        </button>
      </form>
    </section>
  );
}
