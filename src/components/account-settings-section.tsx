import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { openUrl } from "@tauri-apps/plugin-opener"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { AlertCircle, CheckCircle2, ChevronDown, Copy, GripVertical, Plus, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { SettingsPluginState } from "@/hooks/app/use-settings-plugin-list"
import type { AuthCredentialField, AuthCredentialFieldType, AuthStrategy } from "@/lib/plugin-types"
import {
  loadAccountOrderByPlugin,
  saveAccountOrderByPlugin,
  type AccountOrderByPlugin,
} from "@/lib/settings"
import { cn } from "@/lib/utils"
import {
  cancelAccountAuth,
  clearAccountCredentials,
  createAccount,
  deleteAccount,
  finishAccountAuth,
  hasAccountCredentials,
  listAccounts,
  setAccountCredentials,
  startAccountAuth,
  updateAccount,
  type AccountRecord,
} from "@/lib/accounts"

type AccountSession = {
  requestId: string
  url: string
  userCode?: string | null
  status: "pending" | "error"
  message?: string
}

type AccountSettingsSectionProps = {
  plugins: SettingsPluginState[]
  onAccountChanged: (pluginId: string) => void
  onAccountOrderChanged?: (order: AccountOrderByPlugin) => void
  onPluginEnabledChange: (pluginId: string, enabled: boolean) => void
}

type ToastState = { kind: "success" | "error"; text: string } | null

type SortableAccountCardProps = {
  accountId: string
  className?: string
  children: (props: { dragAttributes: Record<string, unknown>; dragListeners: Record<string, unknown> }) => ReactNode
}

function defaultStrategy(plugin: SettingsPluginState): AuthStrategy | null {
  const strategies = plugin.auth?.strategies ?? []
  if (strategies.length === 0) return null
  return strategies.find((strategy) => strategy.id === plugin.auth?.defaultStrategyId) ?? strategies[0]
}

function credentialTemplate(strategy: AuthStrategy): string {
  if (strategy.credentialTemplate) return JSON.stringify(strategy.credentialTemplate, null, 2)
  if (strategy.fields.length > 0) {
    return JSON.stringify(
      Object.fromEntries(strategy.fields.map((field) => [field.name, field.placeholder ?? ""])),
      null,
      2
    )
  }
  return JSON.stringify({ type: strategy.id }, null, 2)
}

function parseCredentialsInput(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error("Credential JSON is required")
  const parsed = JSON.parse(trimmed) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Credentials must be a JSON object")
  }
  return parsed as Record<string, unknown>
}

function isAuthFlow(strategy: AuthStrategy): boolean {
  return ["oauthPkce", "deviceCode", "browserCookie"].includes(strategy.kind)
}

function usesFieldCredentialForm(strategy: AuthStrategy): boolean {
  return !isAuthFlow(strategy) && strategy.fields.length > 0
}

type FieldDraftByAccount = Record<string, Record<string, string>>

function credentialFieldType(field: AuthCredentialField): AuthCredentialFieldType {
  if (field.fieldType) return field.fieldType
  if (field.options && field.options.length > 0) return "segmented"
  if (field.secret) return "password"
  return "text"
}

function fieldDefaultValue(field: AuthCredentialField): string {
  if (credentialFieldType(field) === "checkbox") return field.defaultValue === "true" ? "true" : "false"
  return field.defaultValue ?? field.options?.[0]?.value ?? ""
}

function fieldDraftValue(drafts: FieldDraftByAccount, accountId: string, field: AuthCredentialField): string {
  return drafts[accountId]?.[field.name] ?? fieldDefaultValue(field)
}

function buildFieldCredentials(accountId: string, strategy: AuthStrategy, drafts: FieldDraftByAccount): Record<string, unknown> {
  const credentials: Record<string, unknown> = { type: strategy.id }
  for (const field of strategy.fields) {
    const fieldType = credentialFieldType(field)
    if (fieldType === "checkbox") {
      credentials[field.name] = fieldDraftValue(drafts, accountId, field) === "true"
      continue
    }

    const value = fieldDraftValue(drafts, accountId, field).trim()
    if (!value) {
      if (field.required) throw new Error(`${field.label} is required`)
      continue
    }
    credentials[field.name] = value
  }
  return credentials
}

function FieldDescription({ description }: { description?: string | null }) {
  if (!description) return null
  return <p className="text-[11px] text-muted-foreground">{description}</p>
}

function authLabel(strategy?: AuthStrategy | null): string {
  if (!strategy) return "Auth"
  return strategy.label || strategy.id
}

function timestampLabel(value?: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)
}

function accountStatus(account: AccountRecord, hasCredentials: boolean) {
  if (!account.enabled) {
    return { dotClass: "bg-zinc-400", label: "Disabled", detail: "Excluded from refresh" }
  }
  if (account.lastError?.trim()) {
    return { dotClass: "bg-red-500", label: "Fetch error", detail: account.lastError }
  }
  if (account.lastFetchAt) {
    const formatted = timestampLabel(account.lastFetchAt)
    return { dotClass: "bg-emerald-500", label: "Fetched", detail: formatted ? `Last fetch: ${formatted}` : "Fetched" }
  }
  if (hasCredentials) {
    return { dotClass: "bg-amber-500", label: "Waiting", detail: "Credentials set, waiting for first fetch" }
  }
  return { dotClass: "bg-zinc-400", label: "Missing credentials", detail: "Credentials are not configured" }
}

function SortableAccountCard({ accountId, className, children }: SortableAccountCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: accountId })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div ref={setNodeRef} style={style} className={cn(className, isDragging && "opacity-70")}>
      {children({
        dragAttributes: attributes as unknown as Record<string, unknown>,
        dragListeners: listeners as unknown as Record<string, unknown>,
      })}
    </div>
  )
}

export function AccountSettingsSection({
  plugins,
  onAccountChanged,
  onAccountOrderChanged,
  onPluginEnabledChange,
}: AccountSettingsSectionProps) {
  const [accounts, setAccounts] = useState<AccountRecord[]>([])
  const [credentialsById, setCredentialsById] = useState<Record<string, boolean>>({})
  const [accountOrderByPlugin, setAccountOrderByPlugin] = useState<AccountOrderByPlugin>({})
  const [createPickerPluginId, setCreatePickerPluginId] = useState<string | null>(null)
  const [expandedById, setExpandedById] = useState<Record<string, boolean>>({})
  const [draftById, setDraftById] = useState<Record<string, string>>({})
  const [fieldDraftById, setFieldDraftById] = useState<FieldDraftByAccount>({})
  const [labelDraftById, setLabelDraftById] = useState<Record<string, string>>({})
  const [sessionById, setSessionById] = useState<Record<string, AccountSession | undefined>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastState>(null)
  const [message, setMessage] = useState<string | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const showToast = (kind: "success" | "error", text: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    setToast({ kind, text })
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null)
      toastTimerRef.current = null
    }, 3200)
  }

  const reload = async () => {
    const rows = await listAccounts()
    const entries = await Promise.all(
      rows.map(async (account) => {
        try {
          return [account.id, await hasAccountCredentials(account.id)] as const
        } catch {
          return [account.id, false] as const
        }
      })
    )
    setAccounts(rows)
    setCredentialsById(Object.fromEntries(entries))
  }

  useEffect(() => {
    let mounted = true
    Promise.all([reload(), loadAccountOrderByPlugin()])
      .then(([, order]) => {
        if (mounted) {
          setAccountOrderByPlugin(order)
          onAccountOrderChanged?.(order)
        }
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))

    return () => {
      mounted = false
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    }
  }, [onAccountOrderChanged])

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key)
    setMessage(null)
    try {
      await task()
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setMessage(text)
      showToast("error", text)
    } finally {
      setBusy(null)
    }
  }

  const accountsByPlugin = useMemo(() => {
    const grouped = new Map<string, AccountRecord[]>()
    for (const account of accounts) {
      const list = grouped.get(account.pluginId) ?? []
      list.push(account)
      grouped.set(account.pluginId, list)
    }
    for (const [pluginId, list] of grouped.entries()) {
      const order = accountOrderByPlugin[pluginId] ?? []
      if (order.length === 0) continue
      const orderIndex = new Map(order.map((accountId, index) => [accountId, index]))
      list.sort((left, right) => {
        const leftIndex = orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER
        const rightIndex = orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER
        return leftIndex - rightIndex || left.createdAt.localeCompare(right.createdAt)
      })
    }
    return grouped
  }, [accounts, accountOrderByPlugin])

  const createPluginAccount = async (plugin: SettingsPluginState, strategy: AuthStrategy) => {
    await createAccount({ pluginId: plugin.id, authStrategyId: strategy.id })
    await reload()
    setCreatePickerPluginId(null)
    showToast("success", `${plugin.name} account created`)
  }

  const saveCredentials = async (plugin: SettingsPluginState, account: AccountRecord, strategy: AuthStrategy) => {
    const parsed = parseCredentialsInput(draftById[account.id] ?? "")
    await setAccountCredentials(account.id, { type: strategy.id, ...parsed })
    setDraftById((previous) => ({ ...previous, [account.id]: "" }))
    await reload()
    onAccountChanged(plugin.id)
    showToast("success", `${plugin.name} credentials saved`)
  }

  const saveFieldCredentials = async (plugin: SettingsPluginState, account: AccountRecord, strategy: AuthStrategy) => {
    await setAccountCredentials(account.id, buildFieldCredentials(account.id, strategy, fieldDraftById))
    setFieldDraftById((previous) => ({ ...previous, [account.id]: {} }))
    await reload()
    onAccountChanged(plugin.id)
    showToast("success", `${plugin.name} credentials saved`)
  }

  const startAuth = async (plugin: SettingsPluginState, account: AccountRecord, strategy: AuthStrategy) => {
    const started = await startAccountAuth(plugin.id, account.id)
    setSessionById((previous) => ({
      ...previous,
      [account.id]: { requestId: started.requestId, url: started.url, userCode: started.userCode, status: "pending" },
    }))
    if (started.url && strategy.kind !== "browserCookie") openUrl(started.url).catch(console.error)
    finishAccountAuth(started.requestId, 180_000)
      .then(async () => {
        setSessionById((previous) => ({ ...previous, [account.id]: undefined }))
        await reload()
        onAccountChanged(plugin.id)
        showToast("success", `${plugin.name} auth connected`)
      })
      .catch((error) => {
        setSessionById((previous) => ({
          ...previous,
          [account.id]: {
            requestId: started.requestId,
            url: started.url,
            userCode: started.userCode,
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        }))
      })
  }

  const handleAccountDragEnd = (pluginId: string, orderedIds: string[], event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = orderedIds.indexOf(String(active.id))
    const newIndex = orderedIds.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const nextOrder = arrayMove(orderedIds, oldIndex, newIndex)
    const next = { ...accountOrderByPlugin, [pluginId]: nextOrder }
    setAccountOrderByPlugin(next)
    onAccountOrderChanged?.(next)
    void saveAccountOrderByPlugin(next).catch((error) => {
      console.error("Failed to save account order:", error)
    })
  }

  const setFieldDraft = (accountId: string, fieldName: string, value: string) => {
    setFieldDraftById((previous) => ({
      ...previous,
      [accountId]: {
        ...(previous[accountId] ?? {}),
        [fieldName]: value,
      },
    }))
  }

  const renderCredentialField = (accountId: string, field: AuthCredentialField) => {
    const value = fieldDraftValue(fieldDraftById, accountId, field)
    const inputId = `credential-${accountId}-${field.name}`
    const fieldType = credentialFieldType(field)

    if (fieldType === "checkbox") {
      return (
        <label key={field.name} className="inline-flex items-center gap-2 rounded-md border bg-background px-2 py-2 text-xs text-muted-foreground">
          <Checkbox
            checked={value === "true"}
            disabled={busy !== null}
            onCheckedChange={(checked) => setFieldDraft(accountId, field.name, checked === true ? "true" : "false")}
          />
          <span>
            {field.label}
            <FieldDescription description={field.description} />
          </span>
        </label>
      )
    }

    if (field.options && field.options.length > 0 && fieldType === "select") {
      return (
        <div key={field.name} className="space-y-1">
          <label htmlFor={inputId} className="block text-xs text-muted-foreground">
            {field.label}
          </label>
          <select
            id={inputId}
            value={value}
            disabled={busy !== null}
            onChange={(event) => setFieldDraft(accountId, field.name, event.target.value)}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <FieldDescription description={field.description} />
        </div>
      )
    }

    if (field.options && field.options.length > 0) {
      return (
        <div key={field.name} className="space-y-1">
          <label className="block text-xs text-muted-foreground">{field.label}</label>
          <Tabs value={value} onValueChange={(nextValue) => setFieldDraft(accountId, field.name, nextValue)}>
            <TabsList className="h-8 w-full">
              {field.options.map((option) => (
                <TabsTrigger key={option.value} value={option.value} className="text-xs" disabled={busy !== null}>
                  {option.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <FieldDescription description={field.description} />
        </div>
      )
    }

    if (fieldType === "textarea") {
      return (
        <div key={field.name} className="space-y-1 sm:col-span-2">
          <label htmlFor={inputId} className="block text-xs text-muted-foreground">
            {field.label}
            {field.required ? "" : " (optional)"}
          </label>
          <textarea
            id={inputId}
            value={value}
            onChange={(event) => setFieldDraft(accountId, field.name, event.target.value)}
            className="min-h-20 w-full rounded-md border border-input bg-background px-2 py-2 text-xs"
            placeholder={field.placeholder ?? field.label}
          />
          <FieldDescription description={field.description} />
        </div>
      )
    }

    return (
      <div key={field.name} className="space-y-1">
        <label htmlFor={inputId} className="block text-xs text-muted-foreground">
          {field.label}
          {field.required ? "" : " (optional)"}
        </label>
        <input
          id={inputId}
          type={fieldType === "password" ? "password" : "text"}
          value={value}
          onChange={(event) => setFieldDraft(accountId, field.name, event.target.value)}
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
          placeholder={field.placeholder ?? field.label}
          autoComplete="off"
        />
        <FieldDescription description={field.description} />
      </div>
    )
  }

  if (plugins.length === 0) return null

  return (
    <section>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold mb-0">Accounts</h3>
          <p className="text-sm text-muted-foreground mb-2">Manage accounts and credentials.</p>
        </div>
        <Button type="button" variant="outline" size="xs" disabled={busy !== null} onClick={() => run("reload", reload)}>
          <RefreshCw className="size-3" />
          Reload
        </Button>
      </div>

      {message && <p className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{message}</p>}

      <div className="space-y-2">
        {plugins.map((plugin) => {
          const strategies = plugin.auth?.strategies ?? []
          const supportsAccounts = strategies.length > 0
          const fallbackStrategy = defaultStrategy(plugin)
          const pluginAccounts = accountsByPlugin.get(plugin.id) ?? []
          const orderedIds = pluginAccounts.map((account) => account.id)
          const pickerOpen = createPickerPluginId === plugin.id

          return (
            <div key={plugin.id} className={cn("rounded-lg border bg-muted/50 p-2 space-y-2", !plugin.enabled && "opacity-75")}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium leading-none">{plugin.name}</p>
                </div>
                <div className="flex items-center gap-2">
                  <label className="inline-flex items-center gap-1 text-[11px] text-muted-foreground select-none">
                    <Checkbox
                      checked={plugin.enabled}
                      disabled={busy !== null}
                      onCheckedChange={(checked) => onPluginEnabledChange(plugin.id, checked === true)}
                    />
                    Enabled
                  </label>
                  {supportsAccounts && (
                    <Button
                      type="button"
                      size="xs"
                      disabled={busy !== null}
                      onClick={() => setCreatePickerPluginId((previous) => previous === plugin.id ? null : plugin.id)}
                    >
                      <Plus className="size-3" />
                      Add
                    </Button>
                  )}
                </div>
              </div>

              {supportsAccounts && pickerOpen && (
                <div className="rounded-md border border-dashed bg-background/70 p-2 space-y-2">
                  <p className="text-xs text-muted-foreground">Choose auth for the new account.</p>
                  <div className="flex flex-wrap items-center gap-1">
                    {strategies.map((strategy) => (
                      <Button
                        key={strategy.id}
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => run(`create:${plugin.id}:${strategy.id}`, () => createPluginAccount(plugin, strategy))}
                      >
                        {strategy.label}
                      </Button>
                    ))}
                    <Button type="button" size="xs" variant="ghost" disabled={busy !== null} onClick={() => setCreatePickerPluginId(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {!supportsAccounts ? (
                <p className="px-1 py-1 text-xs text-muted-foreground">No account required.</p>
              ) : pluginAccounts.length === 0 ? (
                <p className="px-1 py-1 text-xs text-muted-foreground">No account configured yet.</p>
              ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => handleAccountDragEnd(plugin.id, orderedIds, event)}>
                  <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
                    <div className="space-y-2">
                      {pluginAccounts.map((account) => {
                        const strategy = strategies.find((candidate) => candidate.id === account.authStrategyId) ?? fallbackStrategy
                        const session = sessionById[account.id]
                        const status = accountStatus(account, Boolean(credentialsById[account.id]))
                        const accountExpanded = expandedById[account.id] === true
                        const labelValue = labelDraftById[account.id] ?? account.label
                        const usesCredentialFields = strategy ? usesFieldCredentialForm(strategy) : false
                        const primaryCredentialFields = strategy?.fields.filter((field) => !field.advanced) ?? []
                        const advancedCredentialFields = strategy?.fields.filter((field) => field.advanced) ?? []
                        return (
                          <SortableAccountCard key={account.id} accountId={account.id} className={cn("rounded-md border bg-card p-2 space-y-2", !account.enabled && "opacity-75")}>
                            {({ dragAttributes, dragListeners }) => (
                              <>
                                <div className="flex items-start justify-between gap-2">
                                  <button
                                    type="button"
                                    className="min-w-0 flex-1 rounded-sm px-1 py-0.5 text-left hover:bg-muted/70"
                                    aria-expanded={accountExpanded}
                                    onClick={() => setExpandedById((previous) => ({ ...previous, [account.id]: !previous[account.id] }))}
                                  >
                                    <div className="flex items-center gap-1.5">
                                      <p className="truncate text-sm font-medium" title={`Account ID: ${account.id}`}>{account.label}</p>
                                      <span className={`inline-block size-2 rounded-full ${status.dotClass}`} title={`${status.label}: ${status.detail}`} />
                                      <ChevronDown className={cn("size-3 text-muted-foreground transition-transform", accountExpanded && "rotate-180")} />
                                    </div>
                                    <p className="mt-0.5 text-xs text-muted-foreground">{authLabel(strategy)}</p>
                                  </button>
                                  <div className="flex flex-col items-end gap-1">
                                    <div className="flex items-center gap-1">
                                      <Button type="button" variant="ghost" size="icon-xs" className="cursor-grab active:cursor-grabbing" disabled={busy !== null} {...dragAttributes} {...dragListeners}>
                                        <GripVertical className="size-3" />
                                        <span className="sr-only">Reorder account</span>
                                      </Button>
                                      <Button type="button" variant="ghost" size="icon-xs" disabled={busy !== null} onClick={() => run(`delete:${account.id}`, async () => {
                                        await deleteAccount(account.id)
                                        const nextOrder = { ...accountOrderByPlugin, [plugin.id]: orderedIds.filter((id) => id !== account.id) }
                                        setAccountOrderByPlugin(nextOrder)
                                        onAccountOrderChanged?.(nextOrder)
                                        await saveAccountOrderByPlugin(nextOrder)
                                        await reload()
                                        onAccountChanged(plugin.id)
                                        showToast("success", `${plugin.name} account removed`)
                                      })}>
                                        <Trash2 className="size-3" />
                                      </Button>
                                    </div>
                                    <label className="inline-flex items-center gap-1 pr-1 text-[11px] text-muted-foreground select-none">
                                      <Checkbox checked={account.enabled} disabled={busy !== null} onCheckedChange={(checked) => run(`enabled:${account.id}`, async () => {
                                        await updateAccount(account.id, { enabled: checked === true })
                                        await reload()
                                        onAccountChanged(plugin.id)
                                      })} />
                                      Enabled
                                    </label>
                                  </div>
                                </div>

                                {accountExpanded && strategy && (
                                  <div className="space-y-2">
                                    <input
                                      value={labelValue}
                                      onChange={(event) => setLabelDraftById((previous) => ({ ...previous, [account.id]: event.target.value }))}
                                      onBlur={(event) => {
                                        const label = event.currentTarget.value.trim()
                                        if (!label || label === account.label) return
                                        run(`label:${account.id}`, async () => {
                                          await updateAccount(account.id, { label })
                                          await reload()
                                        })
                                      }}
                                      className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                                      placeholder="Account label"
                                    />

                                    {isAuthFlow(strategy) ? (
                                      <div className="flex flex-wrap items-center gap-1">
                                        <Button type="button" size="xs" variant={session?.status === "error" ? "destructive" : "outline"} disabled={busy !== null || session?.status === "pending"} onClick={() => run(`auth:${account.id}`, () => startAuth(plugin, account, strategy))}>
                                          {session?.status === "error" ? "Retry auth" : strategy.kind === "browserCookie" ? "Connect in browser" : "Connect OAuth"}
                                        </Button>
                                        {session?.status === "pending" && (
                                          <Button type="button" size="xs" variant="outline" disabled={busy !== null} onClick={() => run(`cancel:${account.id}`, async () => {
                                            await cancelAccountAuth(session.requestId)
                                            setSessionById((previous) => ({ ...previous, [account.id]: undefined }))
                                            showToast("success", `${plugin.name} auth cancelled`)
                                          })}>
                                            Cancel auth
                                          </Button>
                                        )}
                                      </div>
                                    ) : usesCredentialFields ? (
                                      <>
                                        <div className="space-y-2">
                                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                            {primaryCredentialFields.map((field) => renderCredentialField(account.id, field))}
                                          </div>
                                          {advancedCredentialFields.length > 0 && (
                                            <details className="rounded-md border border-dashed bg-muted/30 px-2 py-1">
                                              <summary className="cursor-pointer text-[11px] text-muted-foreground">Advanced fields</summary>
                                              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                                {advancedCredentialFields.map((field) => renderCredentialField(account.id, field))}
                                              </div>
                                            </details>
                                          )}
                                        </div>
                                        <Button type="button" size="xs" disabled={busy !== null} onClick={() => run(`save:${account.id}`, () => saveFieldCredentials(plugin, account, strategy))}>
                                          Save credentials
                                        </Button>
                                      </>
                                    ) : (
                                      <>
                                        <textarea
                                          value={draftById[account.id] ?? ""}
                                          onChange={(event) => setDraftById((previous) => ({ ...previous, [account.id]: event.target.value }))}
                                          className="min-h-28 w-full rounded-md border border-input bg-background px-2 py-2 text-xs font-mono"
                                          placeholder={credentialTemplate(strategy)}
                                        />
                                        <Button type="button" size="xs" disabled={busy !== null} onClick={() => run(`save:${account.id}`, () => saveCredentials(plugin, account, strategy))}>
                                          Save credentials
                                        </Button>
                                      </>
                                    )}

                                    <div className="flex flex-wrap items-center gap-1">
                                      {credentialsById[account.id] && (
                                        <Button type="button" size="xs" variant="outline" disabled={busy !== null} onClick={() => run(`clear:${account.id}`, async () => {
                                          await clearAccountCredentials(account.id)
                                          await reload()
                                          onAccountChanged(plugin.id)
                                          showToast("success", `${plugin.name} credentials cleared`)
                                        })}>
                                          Clear credentials
                                        </Button>
                                      )}
                                    </div>

                                    {isAuthFlow(strategy) && session?.url && (
                                      <div className="rounded-md border border-dashed p-2 text-xs">
                                         <p className="font-medium text-foreground">{session.status === "pending" ? "Auth in progress" : "Auth status"}</p>
                                        {session.userCode && <p className="mt-1 text-muted-foreground">Enter code: <span className="font-mono">{session.userCode}</span></p>}
                                        <p className="mt-1 break-all text-muted-foreground">{session.url}</p>
                                        <div className="mt-1 flex items-center gap-1">
                                          <Button type="button" size="xs" variant="outline" disabled={busy !== null} onClick={() => run(`copy:${account.id}`, async () => {
                                            if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable")
                                            await navigator.clipboard.writeText(session.url)
                                            showToast("success", "OAuth URL copied")
                                          })}>
                                            <Copy className="size-3" />
                                            Copy URL
                                          </Button>
                                        </div>
                                        {session.status === "error" && session.message && <p className="mt-1 break-words text-destructive">{session.message}</p>}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </>
                            )}
                          </SortableAccountCard>
                        )
                      })}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </div>
          )
        })}
      </div>

      {toast && (
        <div className="pointer-events-none fixed right-8 bottom-14 z-50 flex justify-end">
          <div
            role={toast.kind === "error" ? "alert" : "status"}
            aria-live="polite"
            className={cn(
              "pointer-events-auto flex max-w-[20rem] items-start gap-2 rounded-md border px-3 py-2 text-xs shadow-xl backdrop-blur-sm",
              toast.kind === "error" ? "border-rose-300/70 bg-rose-600/95 text-white" : "border-emerald-300/70 bg-emerald-600/95 text-white"
            )}
          >
            {toast.kind === "error" ? <AlertCircle className="mt-0.5 size-3.5 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />}
            <p className="leading-5">{toast.text}</p>
          </div>
        </div>
      )}
    </section>
  )
}
