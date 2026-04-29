import { invoke } from "@tauri-apps/api/core"

export type AccountRecord = {
  id: string
  pluginId: string
  enabled: boolean
  authStrategyId?: string | null
  label: string
  settings: unknown
  createdAt: string
  updatedAt: string
  lastFetchAt?: string | null
  lastError?: string | null
}

export type CreateAccountInput = {
  pluginId: string
  authStrategyId?: string
  label?: string
  settings?: unknown
}

export type UpdateAccountInput = {
  authStrategyId?: string
  enabled?: boolean
  label?: string
  settings?: unknown
  clearLastError?: boolean
}

export type AccountAuthStartResponse = {
  requestId: string
  url: string
  redirectUri: string
  userCode?: string | null
}

export function listAccounts(): Promise<AccountRecord[]> {
  return invoke<AccountRecord[]>("list_accounts")
}

export function createAccount(input: CreateAccountInput): Promise<AccountRecord> {
  return invoke<AccountRecord>("create_account", { input })
}

export function updateAccount(accountId: string, input: UpdateAccountInput): Promise<AccountRecord> {
  return invoke<AccountRecord>("update_account", { accountId, input })
}

export function deleteAccount(accountId: string): Promise<AccountRecord | null> {
  return invoke<AccountRecord | null>("delete_account", { accountId })
}

export function hasAccountCredentials(accountId: string): Promise<boolean> {
  return invoke<boolean>("has_account_credentials", { accountId })
}

export function setAccountCredentials(
  accountId: string,
  credentials: Record<string, unknown>
): Promise<void> {
  return invoke("set_account_credentials", { accountId, credentials })
}

export function clearAccountCredentials(accountId: string): Promise<void> {
  return invoke("clear_account_credentials", { accountId })
}

export function startAccountAuth(pluginId: string, accountId: string): Promise<AccountAuthStartResponse> {
  return invoke<AccountAuthStartResponse>("start_account_auth", { pluginId, accountId })
}

export function finishAccountAuth(requestId: string, timeoutMs?: number): Promise<void> {
  return invoke("finish_account_auth", { requestId, timeoutMs })
}

export function cancelAccountAuth(requestId: string): Promise<boolean> {
  return invoke<boolean>("cancel_account_auth", { requestId })
}
