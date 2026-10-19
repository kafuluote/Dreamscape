import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ApiRequest, JsonObject, Preferences, ResponseData, SocketEvent, Workspace } from './types';

export const desktop = isTauri();
export const call = <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
  desktop
    ? invoke<T>(command, args)
    : Promise.reject(new Error('请使用桌面版本运行此功能：npm run dev。浏览器仅用于界面预览。'));
export async function load(): Promise<{ workspace: Workspace | null; preferences: Preferences | null }> {
  return desktop ? call('load_workspace') : { workspace: null, preferences: null };
}
export const save = (workspace: Workspace) => call<void>('save_workspace', { workspace });
export const savePreferences = (preferences: Preferences) => call<void>('save_preferences', { preferences });
export const execute = (operationId: string, request: ApiRequest, environment: JsonObject) =>
  call<{ response: ResponseData; environment: JsonObject }>('execute_request', {
    operationId,
    request,
    environment,
  });
export const pickPath = (kind: string) => call<string | null>('choose_path', { kind });
export const onSocket = (handler: (event: SocketEvent) => void) =>
  listen<SocketEvent>('socket-event', (event) => handler(event.payload));
